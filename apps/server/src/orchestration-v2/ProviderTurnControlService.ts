import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  withMessageSenderNote,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    steerDeclined: Schema.optional(Schema.Boolean),
    /** The provider never confirmed the stop; Force stop is the way out. */
    unresponsive: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly subagent?: {
      readonly id: NodeId;
      readonly nativeTaskId: string;
      readonly requestedAt?: DateTime.Utc;
    };
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<
    void | ProviderAdapter.ProviderAdapterV2SubagentOutcome,
    ProviderTurnControlError
  >;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
    readonly modelSelection?: ModelSelection;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  /** Best effort: a turn that ended or moved sessions picks the selection up when it next starts. */
  readonly applyModelSelection: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<
    void,
    | ProjectionStore.ProjectionStoreV2Error
    | ProviderSessionManager.ProviderSessionManagerV2Error
    | ProviderAdapter.ProviderAdapterV2Error
  >;
  /** Best effort: a provider thread that is no longer live picks the title up when its next turn starts. */
  readonly applyThreadTitle: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<
    void,
    | ProjectionStore.ProjectionStoreV2Error
    | ProviderSessionManager.ProviderSessionManagerV2Error
    | ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  | EventSink.EventSinkV2
  | McpAppModelContext.McpAppModelContext
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const mcpAppModelContext = yield* McpAppModelContext.McpAppModelContext;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

    const interruptDetachedTurn = Effect.fnUntraced(function* (
      threadId: ThreadId,
      providerThread: ProviderAdapter.ProviderAdapterV2InterruptInput["providerThread"],
      providerTurn: OrchestrationV2ProviderTurn,
      recordedSessionId: ProviderSessionId | null | undefined,
    ) {
      const adapter = yield* adapters.get(providerThread.providerInstanceId);
      if (adapter.driver !== providerThread.driver) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: providerThread.driver,
          detail: "The recorded provider execution belongs to a different driver.",
        });
      }
      if (adapter.interruptDetachedTurn !== undefined) {
        const current = yield* projections.getProviderControlContext(threadId, {
          providerThreadId: providerThread.id,
          providerTurnId: providerTurn.id,
          ...(providerTurn.runAttemptId === null ? {} : { attemptId: providerTurn.runAttemptId }),
        });
        const attempt = current.attempt;
        const records =
          attempt === undefined
            ? undefined
            : yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [attempt.runId] });
        const run = records?.runs.find((candidate) => candidate.id === attempt?.runId);
        if (
          current.providerThread === undefined ||
          current.providerThread.providerSessionId !== recordedSessionId ||
          current.providerThread.nativeThreadRef?.nativeId !==
            providerThread.nativeThreadRef?.nativeId ||
          attempt === undefined ||
          run === undefined ||
          run.providerThreadId !== providerThread.id ||
          run.activeAttemptId !== attempt.id ||
          (current.providerThread.lastRunOrdinal !== null &&
            current.providerThread.lastRunOrdinal > run.ordinal) ||
          (attempt.nativeThreadId !== undefined &&
            attempt.nativeThreadId !== providerThread.nativeThreadRef?.nativeId)
        ) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: providerThread.driver,
            detail: "A later provider execution replaced this detached Stop target.",
          });
        }
        yield* adapter.interruptDetachedTurn({ providerThread, providerTurnId: providerTurn.id });
      }
    });

    const load = Effect.fn("ProviderTurnControlService.load")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) {
      const context = yield* projections.getProviderControlContext(input.threadId, input);
      const { providerThread, providerTurn } = context;
      const targetsRecordedSession = providerThread?.providerSessionId === input.providerSessionId;
      const targetsCommittedReplacement =
        input.operation === "restart" &&
        input.replacementProviderSessionId !== undefined &&
        providerThread?.providerSessionId === input.replacementProviderSessionId;
      if (
        providerThread === undefined ||
        providerTurn === undefined ||
        (!targetsRecordedSession && !targetsCommittedReplacement) ||
        providerTurn.providerThreadId !== providerThread.id
      ) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      // A restart-session command commits the replacement binding before its
      // process-bound effect runs. The old live runtime must still receive
      // the interrupt, but only when the projection matches the exact
      // replacement captured by that same durable effect.
      const interruptProviderThread = targetsRecordedSession
        ? providerThread
        : { ...providerThread, providerSessionId: input.providerSessionId };
      const continuingRun =
        input.operation === "steer" &&
        context.run?.status === "running" &&
        context.run.activeAttemptId === providerTurn.runAttemptId;
      if (providerTurn.status !== "running" && !continuingRun) {
        if (input.operation === "steer") {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "steer",
            providerTurnId: input.providerTurnId,
            turnCompleted: providerTurn.status === "completed",
            cause: "The provider turn ended before the steering message was delivered.",
          });
        }
        return {
          context,
          providerThread: interruptProviderThread,
          providerTurn,
          session: Option.none(),
        };
      }
      const session = yield* sessions.get(input.providerSessionId);
      if (Option.isNone(session)) {
        // Remote work can survive release. The caller uses the recorded
        // execution target to stop it through the provider's detached hook.
        if (input.operation === "interrupt" || input.operation === "restart") {
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: `Provider session ${input.providerSessionId} is not active.`,
        });
      }
      return { context, providerThread: interruptProviderThread, providerTurn, session };
    });

    const awaitSettled = Effect.fn("ProviderTurnControlService.awaitSettled")(function* (
      threadId: ThreadId,
      target: ProjectionStore.ProjectionProviderControlTarget,
    ) {
      const isSettled = projections
        .getProviderControlContext(threadId, target)
        .pipe(
          Effect.map(
            ({ providerTurn, attempt }) =>
              providerTurn?.status !== "running" && attempt?.status !== "running",
          ),
        );
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      if (yield* isSettled) return;
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-turn.updated" || event.type === "run-attempt.updated",
        ),
        Stream.mapEffect(() => isSettled),
        Stream.takeUntil((settled) => settled),
        Stream.runDrain,
      );
    });

    return ProviderTurnControlServiceV2.of({
      applyModelSelection: Effect.fn("ProviderTurnControlService.applyModelSelection")(
        function* (input) {
          const { providerThread, providerTurn } = yield* projections.getRunningTurnContext(
            input.threadId,
          );
          if (
            providerThread?.id !== input.providerThreadId ||
            providerThread.providerSessionId !== input.providerSessionId ||
            providerTurn === undefined
          ) {
            return;
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session) || session.value.applyModelSelection === undefined) return;
          yield* session.value.applyModelSelection({
            providerThread,
            modelSelection: input.modelSelection,
          });
        },
      ),
      applyThreadTitle: Effect.fn("ProviderTurnControlService.applyThreadTitle")(function* (input) {
        const { thread, providerThreads } = yield* projections.getThreadRecords(input.threadId, [
          "providerThreads",
        ]);
        const providerThread = providerThreads.find(
          (candidate) => candidate.id === thread.activeProviderThreadId,
        );
        if (!providerThread?.providerSessionId) return;
        const session = yield* sessions.get(providerThread.providerSessionId);
        if (Option.isNone(session) || session.value.applyThreadTitle === undefined) return;
        yield* session.value.applyThreadTitle({ providerThread, title: input.title });
      }),
      interrupt: Effect.fn("ProviderTurnControlService.interrupt")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            if (input.subagent !== undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "No live provider session can confirm this subagent's outcome.",
              });
            }
            yield* interruptDetachedTurn(
              input.threadId,
              loaded.providerThread,
              loaded.providerTurn,
              loaded.context.providerThread?.providerSessionId,
            );
            return;
          }
          if (input.subagent !== undefined) {
            if (session.value.stopSubagent === undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The provider does not support stopping a native subagent.",
              });
            }
            return yield* session.value.stopSubagent({
              providerThread: loaded.providerThread,
              nativeTaskId: input.subagent.nativeTaskId,
              ...(input.subagent.requestedAt === undefined
                ? {}
                : { requestedAt: input.subagent.requestedAt }),
            });
          }
          // Settled turns still reach adapters, which alone know whether background work remains.
          yield* session.value
            .interruptTurn({
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              requestRuntimeRestart: true,
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterInterruptTimeoutError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "interrupt",
                      providerTurnId: input.providerTurnId,
                      unresponsive: true,
                      cause,
                    }),
                  ),
              }),
            );
          if (loaded.providerTurn.status === "running") {
            // Let native terminal ingestion finalize the attempt before the Stop follow-up repairs it.
            const { runAttemptId } = loaded.providerTurn;
            yield* awaitSettled(input.threadId, {
              providerThreadId: input.providerThreadId,
              providerTurnId: input.providerTurnId,
              ...(runAttemptId === null ? {} : { attemptId: runAttemptId }),
            }).pipe(Effect.timeoutOption("2 seconds"));
          }
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "interrupt",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptAndAwaitTerminal: Effect.fn("ProviderTurnControlService.interruptAndAwaitTerminal")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            yield* interruptDetachedTurn(
              input.threadId,
              loaded.providerThread,
              loaded.providerTurn,
              loaded.context.providerThread?.providerSessionId,
            );
            // No live runtime can emit a terminal update after the detached
            // hook succeeds. Let detach/start proceed without polling it.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart proceeding without a live terminal event stream",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Yield through Node's event loop; detached ingestion cannot advance a deterministic Effect clock.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "restart",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      steer: Effect.fn("ProviderTurnControlService.steer")(
        function* (input) {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          const appContext = yield* McpAppModelContext.forProvider(
            mcpAppModelContext,
            input.threadId,
          );
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(appContext.length === 0 ? {} : { appContext }),
              message: {
                messageId: message.id,
                text: withMessageSenderNote(
                  message,
                  projectComposerContextForProvider({
                    text: message.text,
                    records: message.context?.records ?? [],
                  }),
                ),
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catchTags({
                ProviderAdapterSteerDeclinedError: (cause) =>
                  Effect.fail(
                    new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "steer",
                      providerTurnId: input.providerTurnId,
                      steerDeclined: true,
                      cause,
                    }),
                  ),
              }),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (isProviderTurnControlError(cause)) return yield* cause;
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  const status = current.providerTurn?.status;
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: status === "completed",
                    cause,
                  });
                }),
              ),
            );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
