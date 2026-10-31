import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

function delegatedCompletionText(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}

export function currentDelegatedCompletionDelivery(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    // Every task of it was acknowledged while its steer waited: nothing is left to report.
    delivery.taskIds.length === 0 ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    (alreadyDispatched && !isUndeliveredMailboxSteer(projection, completion.messageId))
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  completion: NonNullable<
    ProviderContinuationRequests.ProviderContinuationRequest["delegatedCompletion"]
  >,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

const nativeRetryKey = (
  request: ProviderContinuationRequests.ProviderContinuationRequest,
  messageId: string,
): string => `native:${request.threadId}:${request.providerThreadId}:${messageId}`;

/**
 * Drains ProviderContinuationRequests and dispatches an internal
 * message.dispatch per request so the wake turn buffered by the adapter is
 * ingested as a normal run. Delegated completions are durable mailbox offers:
 * the orchestrator selects native steering or queued delivery under its thread
 * lock. Adapter-buffered continuations still queue behind active work.
 *
 * Each turn first asks the automatic turn gate. A completion it holds back
 * stays open on its cohort for a later offer. A native wake's buffered output
 * lives only in its adapter, so the gate may keep its dispatch to run later; a
 * wake the gate could not decide is offered again under the same message id.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const retryAttempts = yield* Ref.make(new Map<string, number>());

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    const dropArchived = (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
          threadId: request.threadId,
          providerThreadId: request.providerThreadId,
        });
        // No continuation turn will start to clear the adapter's sticky offer.
        if (request.clearIfCurrent !== undefined) {
          yield* request.clearIfCurrent();
        } else if (request.dispatchIfCurrent !== undefined) {
          // Backward compatibility for request producers without an explicit
          // drop callback.
          yield* request.dispatchIfCurrent(Effect.void);
        }
      });

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequests.ProviderContinuationRequest) {
        const projection = yield* threads.getThreadRecords(
          request.threadId,
          ["messages", "runs", "providerTurns"],
          {
            messageIds:
              request.delegatedCompletion === undefined
                ? []
                : [request.delegatedCompletion.messageId],
          },
        );
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          if (request.delegatedCompletion !== undefined) {
            yield* clearRetryAttempt(
              delegatedCompletionRetryKey(request, request.delegatedCompletion),
            );
          }
          yield* dropArchived(request);
          return;
        }
        if (request.delegatedCompletion !== undefined) {
          const retryKey = delegatedCompletionRetryKey(request, request.delegatedCompletion);
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            yield* clearRetryAttempt(retryKey);
            return;
          }
          const commandId = yield* ids.allocate.command({
            fixtureName: "delegated-completion",
            commandName: "dispatch",
          });
          const dispatch = threads
            .dispatch({
              type: "message.dispatch",
              commandId,
              threadId: request.threadId,
              messageId: delivery.messageId,
              text: delegatedCompletionText(delivery.taskIds),
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId: request.delegatedCompletion.parentRunId,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            })
            .pipe(
              // The project turned the target instance off between the cohort
              // read above and this dispatch. The finalize that claimed this
              // delivery already wrote the children's results to the parent's
              // history unconditionally, so nothing is lost: acknowledge each
              // task administratively (observedByRunId: null, the same shape
              // task_status uses when no run observed it) to consume this
              // delivery instead of leaving it open to retry. The parent's
              // next turn against an enabled instance reads those results from
              // history the same way any turn does; nothing here re-offers
              // this generation.
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: (error) =>
                  Effect.logInfo(
                    "orchestration-v2.provider-continuation.delegated-completion-disabled",
                    {
                      threadId: request.threadId,
                      projectId: error.projectId,
                      instanceId: error.instanceId,
                    },
                  ).pipe(
                    Effect.andThen(
                      Effect.forEach(
                        delivery.taskIds,
                        (taskId) =>
                          ids.allocate
                            .command({
                              fixtureName: "delegated-completion",
                              commandName: "acknowledge-disabled",
                            })
                            .pipe(
                              Effect.flatMap((ackCommandId) =>
                                threads.dispatch({
                                  type: "delegated_task.completion-delivery.acknowledge",
                                  commandId: ackCommandId,
                                  parentThreadId: request.threadId,
                                  taskId,
                                  observedByRunId: null,
                                }),
                              ),
                            ),
                        { discard: true },
                      ),
                    ),
                    Effect.andThen(
                      request.clearIfCurrent !== undefined
                        ? request.clearIfCurrent()
                        : request.dispatchIfCurrent !== undefined
                          ? request.dispatchIfCurrent(Effect.void)
                          : Effect.void,
                    ),
                  ),
              }),
            );
          // Held back, the delivery stays open on its cohort for a later offer
          // (the boot recovery, an acceptance or a wake-policy change).
          yield* gate.admit(
            {
              kind: "delegated_completion",
              threadId: request.threadId,
              messageId: delivery.messageId,
              key: `${request.delegatedCompletion.parentRunId}:${delivery.generation}:${delivery.messageId}`,
              parentRunId: request.delegatedCompletion.parentRunId,
              generation: delivery.generation,
              providerThreadId: request.providerThreadId,
              driver: request.driver,
              origin: "offer",
            },
            dispatch,
          );
          yield* clearRetryAttempt(retryKey);
          return;
        }
        // The ordinal is display metadata only: allocate.message appends a
        // random UUID, so a stale projection read here cannot collide ids.
        // Allocated once: a re-offer after an undecided consult carries it.
        const messageId =
          request.messageId ??
          (yield* ids.allocate.message({
            threadId: request.threadId,
            ordinal: projection.messages.length + 1,
          }));
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const plainDispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: request.threadId,
          messageId,
          text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
          notification: request.notification ?? {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          // "provider" marks an adapter-buffered wake, which ClaudeAdapterV2
          // detects to attach the buffered CLI output and drop this text. A
          // message_text wake has no buffered output, so it must not carry that
          // marker or the turn settles immediately having prompted nothing.
          creationSource: request.delivery === "message_text" ? "server" : "provider",
        });
        // The adapter's buffered wake has nowhere else to go once the
        // instance is off: drop it rather than warn, since nothing here
        // retries it either way. This catch sits outside dispatchIfCurrent so
        // an adapter that clears its own sticky offer flag on dispatch
        // failure (inside dispatchIfCurrent) observes the raw failure first.
        // Not every adapter self-clears that way, so the explicit callback is
        // called here too; clearIfCurrent implementations are idempotent, so
        // a source that already cleared is unaffected.
        const logInstanceDisabled = (
          error: ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
        ) =>
          Effect.logInfo("orchestration-v2.provider-continuation.instance-disabled", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            projectId: error.projectId,
            instanceId: error.instanceId,
          }).pipe(
            Effect.andThen(
              request.clearIfCurrent !== undefined ? request.clearIfCurrent() : Effect.void,
            ),
          );
        // The gate may run this later, so it checks the thread again first.
        const dispatch = Effect.gen(function* () {
          const current = yield* threads.getThreadRecords(request.threadId, []);
          if (current.thread.archivedAt !== null || current.thread.deletedAt !== null) {
            yield* dropArchived(request);
            return;
          }
          if (request.dispatchIfCurrent === undefined) {
            yield* plainDispatch.pipe(
              Effect.catchTags({
                ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
              }),
            );
            return;
          }
          yield* request.dispatchIfCurrent(plainDispatch).pipe(
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: logInstanceDisabled,
            }),
          );
        });
        const retryKey = nativeRetryKey(request, messageId);
        const clearIfCurrent = request.clearIfCurrent;
        const decided = yield* gate
          .hand(
            {
              kind: "background_wake",
              threadId: request.threadId,
              messageId,
              key: messageId,
              providerThreadId: request.providerThreadId,
              driver: request.driver,
              clearable: clearIfCurrent !== undefined,
            },
            dispatch,
            clearIfCurrent === undefined ? {} : { drop: Effect.suspend(() => clearIfCurrent()) },
          )
          .pipe(
            Effect.as(true),
            // Undecided: the adapter's offer stays as it is, and the same wake
            // is offered again after the next backoff step.
            Effect.catchTags({
              AutomaticTurnDecisionError: (error) =>
                Effect.gen(function* () {
                  const retryDelay = yield* nextRetryDelay(retryKey);
                  yield* Effect.logWarning(
                    "orchestration-v2.provider-continuation.wake-undecided",
                    {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      stage: error.stage,
                      retryDelay,
                    },
                  );
                  yield* Effect.sleep(`${retryDelay} millis`).pipe(
                    Effect.andThen(requests.offer({ ...request, messageId })),
                    Effect.forkScoped,
                  );
                  return false;
                }),
            }),
            Effect.onError(() => clearRetryAttempt(retryKey)),
          );
        if (decided) yield* clearRetryAttempt(retryKey);
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              if (request.delegatedCompletion !== undefined) {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadRecords(
                    request.threadId,
                    ["messages", "runs", "providerTurns"],
                    {
                      messageIds:
                        request.delegatedCompletion === undefined
                          ? []
                          : [request.delegatedCompletion.messageId],
                    },
                  );
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              }
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
