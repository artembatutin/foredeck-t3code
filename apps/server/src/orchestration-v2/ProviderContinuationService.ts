import {
  CommandId,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import type * as Orchestrator from "./Orchestrator.ts";
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
 * Dispatches an internal message.dispatch per ProviderContinuationRequest so adapter-buffered
 * wakes run normally; delegated completions are durable mailbox offers. Each turn asks the
 * automatic turn gate first: held completions stay open for a later offer, native wakes may be
 * kept, and undecided wakes are re-offered under the same message id.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const retryAttempts = yield* Ref.make(new Map<string, number>());
    // Run watches outlive the wake the gate may run later, so they belong to the service.
    const serviceScope = yield* Effect.scope;
    const continuations = yield* KeyedLock.makeRunner<ThreadId>();

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

    const dropArchived = Effect.fn("ProviderContinuationService.dropArchived")(function* (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) {
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

    // Cancelling or stopping a queued continuation ends it unstarted; only the request can release the adapter's wake latch.
    const releaseIfNeverStarted = Effect.fn("ProviderContinuationService.releaseIfNeverStarted")(
      function* (
        request: ProviderContinuationRequests.ProviderContinuationRequest,
        messageId: MessageId,
        dispatched: Orchestrator.OrchestratorV2DispatchResult,
      ) {
        const onRunEndedWithoutStarting = request.onRunEndedWithoutStarting;
        if (onRunEndedWithoutStarting === undefined) return;
        const runId = dispatched.storedEvents.flatMap(({ event }) =>
          event.type === "run.created" && event.payload.userMessageId === messageId
            ? [event.payload.id]
            : [],
        )[0];
        if (runId === undefined) return;
        yield* threads
          .streamStoredEventsFrom({
            threadId: request.threadId,
            afterSequence: dispatched.sequence,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === runId &&
                ThreadManagementService.isTerminalRunStatus(event.payload.status),
            ),
            Stream.runHead,
            Effect.flatMap((ended) =>
              Option.isSome(ended) &&
              ended.value.event.type === "run.updated" &&
              ended.value.event.payload.startedAt === null
                ? onRunEndedWithoutStarting()
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-continuation.run-watch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              }),
            ),
            Effect.forkIn(serviceScope),
          );
      },
    );

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
                              commandName: "dispose-disabled",
                            })
                            .pipe(
                              Effect.flatMap((disposeCommandId) =>
                                threads.dispatch({
                                  type: "delegated_task.completion-delivery.dispose",
                                  commandId: disposeCommandId,
                                  parentThreadId: request.threadId,
                                  taskId,
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
        // Allocated once: a re-offer after an undecided consult carries it.
        const messageId =
          request.messageId ??
          (yield* ids.allocate.message({
            threadId: request.threadId,
            ordinal: projection.messages.length + 1,
          }));
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        const plainDispatch = threads
          .dispatch({
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
            // Only buffered wakes use creationSource "provider"; Claude would drain an empty buffer instead of prompting message_text.
            creationSource: request.delivery === "message_text" ? "server" : "provider",
          })
          .pipe(Effect.tap((dispatched) => releaseIfNeverStarted(request, messageId, dispatched)));
        // Catch after dispatchIfCurrent so adapters see raw failures first; clearIfCurrent is idempotent and covers others.
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
              AutomaticTurnDecisionError: Effect.fn("ProviderContinuationService.wakeUndecided")(
                function* (error: AutomaticTurnGate.AutomaticTurnDecisionError) {
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
                },
              ),
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
              } else if (request.clearIfCurrent !== undefined) {
                yield* request.clearIfCurrent();
              }
            }),
          ),
          // A dispatch can wait on its parent's lock, so only its own thread's later requests queue behind it.
          (handled) => continuations.run(request.threadId, handled),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
