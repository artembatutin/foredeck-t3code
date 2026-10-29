import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Turns off the armed recovery whose resume the automatic turn gate declined for good, under
 * the same identity. The thread keeps its usage-limit failure for its owner to continue.
 */
function limitDisarmCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
): OrchestrationV2Command | null {
  const recovery = thread.limitRecovery;
  if (!recovery) return null;
  return {
    type: "thread.metadata.update",
    commandId: CommandId.make(
      `limit-disarm:${thread.id}:${recovery.runId}:${Date.parse(recovery.resetAt)}`,
    ),
    threadId: thread.id,
    limitRecovery: {
      runId: recovery.runId,
      resetAt: recovery.resetAt,
      autoResume: false,
      snooze: false,
    },
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
  /**
   * Arms a recovery, or presents its resume to the automatic turn gate, keyed by the resume's
   * command. A deferred resume, or one the gate could not decide, dispatches nothing and is
   * presented again on the next sweep.
   */
  const resumeOrArm = Effect.fnUntraced(function* (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    command: OrchestrationV2Command,
  ) {
    if (command.type !== "message.dispatch" || command.usageLimitContinuationOfRunId === undefined)
      return yield* threads.dispatch(command);
    const outcome = yield* gate.admit(
      {
        kind: "usage_limit_resume",
        threadId: command.threadId,
        messageId: command.messageId,
        key: command.commandId,
        usageLimitContinuationOfRunId: command.usageLimitContinuationOfRunId,
      },
      threads.dispatch(command),
    );
    if (outcome._tag === "Ran" || outcome.reason === "deferred") return;
    const disarm = limitDisarmCommand(thread);
    if (disarm !== null) yield* threads.dispatch(disarm);
  });

  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* resumeOrArm(thread, command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
