import type { RunId, ThreadId } from "@t3tools/contracts";
import { type FactoryDeliveryId, FactoryStageName } from "@t3tools/contracts/fd/factory";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TxRef from "effect/TxRef";

import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import { readBranchFacts } from "./git/branchFacts.ts";
import { evaluateSettle } from "./git/settle.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { failureFingerprint } from "./pipeline/fingerprint.ts";
import { acceptedReview, isTurnEffect, receiptFailed } from "./pipeline/state.ts";
import type {
  FactoryCommandOutcome,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactorySettleResult,
  FactoryThreadEvent,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import { readLogTail } from "./verify/logTail.ts";

/** The delivery has nothing to run for the stage: only verify has a command, run in the worktree. */
class FactoryStageCommandError extends Schema.TaggedError<FactoryStageCommandError>()(
  "FactoryStageCommandError",
  { stage: FactoryStageName },
) {
  override get message(): string {
    return `Factory has no command to run for stage ${this.stage} of this delivery.`;
  }
}

/**
 * Drives deliveries through the pure engine. A step folds one event into the stored delivery,
 * stores the new state with its stage attempts, then queues the effects the engine returned;
 * each effect's result (or failure) is fed back as the delivery's next step.
 */
export class FactoryWorker extends Context.Service<
  FactoryWorker,
  {
    /**
     * Folds `event` into the stored delivery and queues the returned effects once the result is
     * stored. Steps of one delivery run one at a time. An event the delivery does not await
     * writes nothing; an unknown delivery returns none and nothing runs.
     */
    readonly step: (
      deliveryId: FactoryDeliveryId,
      event: FactoryEvent,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /**
     * Decides an event from the stored delivery, then steps it, both under the delivery's lock:
     * no other step of the delivery runs between what `decide` read and the step. A decision
     * that fails steps nothing. Returns the stored result with the decision's value; none for
     * an unknown delivery, where `decide` does not run.
     */
    readonly stepWith: <A, E>(
      deliveryId: FactoryDeliveryId,
      decide: (
        delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      ) => Effect.Effect<{ readonly event: FactoryEvent; readonly value: A }, E>,
    ) => Effect.Effect<
      Option.Option<{
        readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
        readonly value: A;
      }>,
      E | FactoryStoreError
    >;
    /**
     * Steps the deliveries the event's thread belongs to. A run's end goes to the delivery whose
     * active stage attempt names the thread; a deletion goes to every active delivery that records
     * the thread, since a delivery keeps its threads after their attempts finish. A delivery whose
     * launch or turn result naming the thread is being stored gets either.
     */
    readonly stepThread: (event: FactoryThreadEvent) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Blocks a running delivery that awaits an effect this process never queued: the queue that
     * held it ended with an earlier server process. Nothing is re-run. Any other delivery is left
     * as it is; an unknown one returns none.
     */
    readonly failInterruptedEffect: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /** Resolves once every queued effect and every step its result fed back have finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryWorker") {}

/** An effect to carry out, with the delivery as stored when it was issued. */
interface Job {
  readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
  readonly effect: FactoryEffect;
}

const describeEffect = (effect: FactoryEffect) => {
  switch (effect.type) {
    case "launch_thread":
      return `launch the ${effect.role} thread`;
    case "send_fix_commit_turn":
      return "send the fix-commit turn";
    case "check_settle":
      return "check the branch";
    case "run_command":
      return `run the ${effect.stage} command`;
    case "read_fallback_review":
      return "read the review in the reviewer's last message";
    case "send_review_retry_turn":
      return "send the review retry turn";
    case "send_repair_turn":
      return `send the ${effect.kind} turn`;
    case "send_review_follow_up_turn":
      return "send the review follow-up turn";
  }
};

const SAFE_TAG = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * The `effect.failed` detail: what failed and the failure's tag. Never its message or cause,
 * which can carry command output or provider text.
 */
const failureDetail = (effect: FactoryEffect, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  const kind = typeof tag === "string" && SAFE_TAG.test(tag) ? tag : "unexpected error";
  return `Factory could not ${describeEffect(effect)} (${kind}).`;
};

/** A branch that cannot be read never settles; the problem names only the path and operation. */
const unreadable = (problem: string): FactorySettleResult => ({
  status: "unrepairable",
  problems: [problem],
});

/** How an attempt ends when its delivery stops running in `state`. */
const outcomeOf = (state: FactoryDeliveryState): FactoryStageRunStore.FactoryStageOutcome => {
  if (state.status === "blocked") {
    // The stage did its work and judged the commit wanting; any other block is not a verdict.
    const reason = state.block?.reason;
    return reason === "verify_failed" ||
      reason === "review_changes_required" ||
      reason === "repeated_failure"
      ? "failed"
      : "blocked";
  }
  return state.status === "cancelled" ? "cancelled" : "passed";
};

/**
 * The evidence of the attempt a step finishes, with a failure's fingerprint: the command's
 * receipt (or log), or the review accepted in the review round being left.
 */
const evidenceOf = (
  event: FactoryEvent,
  before: FactoryDeliveryState,
): { readonly path: string | undefined; readonly fingerprint: string | undefined } => {
  if (event.type === "command.finished") {
    const { outcome } = event;
    return {
      path: outcome.evidencePath,
      fingerprint: outcome.type === "receipt" ? outcome.fingerprint : undefined,
    };
  }
  const review =
    before.stage !== "review"
      ? undefined
      : event.type === "review.read" && event.judgment.type === "accepted"
        ? event.judgment.review
        : acceptedReview(before);
  return { path: review?.evidencePath, fingerprint: review?.fingerprint };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  const settings = yield* FactorySettings.FactorySettings;
  const verifyRunner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
  const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
  const reviews = yield* FactoryReview.FactoryReview;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();
  const scope = yield* Effect.scope;
  const locks = yield* KeyedLock.make<FactoryDeliveryId>();
  // One drainable worker per delivery: a delivery's effects run in order, and one delivery's
  // long verify command never holds up another's. Lanes are tiny and bounded by the deliveries
  // stepped since the server started.
  const lanes = new Map<FactoryDeliveryId, DrainableWorker<Job>>();
  // Threads whose launch or turn result is being stored, with their delivery. No attempt names a
  // newly launched thread until that store commits, so a thread event looked up meanwhile is
  // routed by this entry instead, and its step waits for the lock the store holds.
  const storing = new Map<ThreadId, FactoryDeliveryId>();
  // Effects queued or running on any lane, each counted until the step its result fed back has
  // finished. That step queues its follow-ups first, so a chain never reads as idle midway, and
  // a delivery stepped while a drain waits is counted too.
  const outstanding = yield* TxRef.make(0);
  // Runs after every lane's finalizer: effects dropped at shutdown never finish, and a drain
  // must not wait for them.
  yield* Effect.addFinalizer(() => TxRef.set(outstanding, 0));

  const checkSettle = (state: FactoryDeliveryState): Effect.Effect<FactorySettleResult> => {
    const { worktreePath, baseline } = state;
    if (worktreePath === null || baseline === null) {
      return Effect.succeed(unreadable("The delivery has no recorded worktree and baseline."));
    }
    return readBranchFacts({ worktreePath, baselineSha: baseline }).pipe(
      Effect.map((facts): FactorySettleResult => {
        const evaluation = evaluateSettle(facts, state.branch);
        return evaluation.status === "settled"
          ? evaluation
          : {
              status: evaluation.status,
              problems: evaluation.problems.map((problem) => problem.description),
            };
      }),
      Effect.catchTags({
        FactoryWorktreeMissingError: (error) => Effect.succeed(unreadable(error.message)),
        FactoryBranchReadError: (error) => Effect.succeed(unreadable(error.message)),
      }),
      Effect.provideContext(gitContext),
    );
  };

  const runCommand = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    stage: FactoryStageName,
  ) =>
    Effect.gen(function* () {
      const { worktreePath } = delivery.state;
      if (stage !== "verify" || worktreePath === null) {
        return yield* new FactoryStageCommandError({ stage });
      }
      // Read when the command runs, not when the delivery started: a verify command removed
      // since then fails the effect before anything runs.
      const runSettings = yield* settings.requireDeliverySettings(delivery.projectId);
      return yield* verifyRunner.run({
        deliveryId: delivery.deliveryId,
        worktreePath,
        settings: runSettings,
      });
    });

  /** A failed run's outcome with its failure fingerprint: the end of its log, and its tree. */
  const withFingerprint = (outcome: FactoryCommandOutcome) =>
    outcome.type === "receipt" && receiptFailed(outcome.receipt)
      ? readLogTail(outcome.receipt.logPath).pipe(
          Effect.map((tail): FactoryCommandOutcome => ({
            ...outcome,
            fingerprint: failureFingerprint({
              stage: "verify",
              tail,
              tree: outcome.receipt.tree,
            }),
          })),
          Effect.provideContext(gitContext),
        )
      : Effect.succeed(outcome);

  /** Carries out one effect and returns the event that answers it. Every failure is tagged. */
  const execute = ({
    delivery,
    effect,
  }: Job): Effect.Effect<FactoryEvent, { readonly _tag: string }> => {
    const turnStarted = ({ runId }: { readonly runId: RunId }): FactoryEvent => ({
      type: "turn.started",
      effectId: effect.id,
      runId,
    });
    switch (effect.type) {
      case "launch_thread":
        return threads.launchThread(delivery, effect).pipe(
          Effect.map((launch): FactoryEvent => ({
            type: "thread.launched",
            effectId: effect.id,
            ...launch,
          })),
        );
      case "send_fix_commit_turn":
        return threads.sendFixCommitTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "check_settle":
        return checkSettle(delivery.state).pipe(
          Effect.map((result): FactoryEvent => ({
            type: "settle.checked",
            effectId: effect.id,
            result,
          })),
        );
      case "run_command":
        return runCommand(delivery, effect.stage).pipe(
          Effect.flatMap(withFingerprint),
          Effect.map((outcome): FactoryEvent => ({
            type: "command.finished",
            effectId: effect.id,
            outcome,
          })),
        );
      case "read_fallback_review":
        return reviews.judgeFallback(delivery, effect).pipe(
          Effect.map((judgment): FactoryEvent => ({
            type: "review.read",
            effectId: effect.id,
            judgment,
          })),
        );
      case "send_review_retry_turn":
        return threads.sendReviewRetryTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_repair_turn":
        return threads.sendRepairTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_review_follow_up_turn":
        return threads.sendReviewFollowUpTurn(delivery, effect).pipe(Effect.map(turnStarted));
    }
  };

  /**
   * Records the stage attempts a step implies. Leaving a stage finishes its active attempt:
   * failed when the delivery left it for a repair round, passed when it advanced otherwise, and
   * by how it stopped running when it did. Entering one appends the next attempt, and the
   * attempt carries the run the delivery now awaits.
   */
  const recordAttempts = Effect.fn("FactoryWorker.recordAttempts")(function* (
    deliveryId: FactoryDeliveryId,
    before: FactoryDeliveryState,
    after: FactoryDeliveryState,
    evidence: ReturnType<typeof evidenceOf>,
  ) {
    const stopped = after.status !== "running";
    const advanced = after.stage !== before.stage;
    let active = (yield* stageRuns.listByDelivery(deliveryId)).findLast(
      (run) => run.outcome === null && run.stage === before.stage,
    );
    const attemptOf = (run: FactoryStageRunStore.StoredFactoryStageRun) => ({
      deliveryId,
      stage: run.stage,
      attempt: run.attempt,
    });

    if (active !== undefined && before.status === "running" && (advanced || stopped)) {
      const { path, fingerprint } = evidence;
      yield* stageRuns.finish({
        ...attemptOf(active),
        // A repair round is the stage's verdict that the commit is wanting.
        outcome: advanced ? (after.stage === "repair" ? "failed" : "passed") : outcomeOf(after),
        ...(path === undefined ? {} : { evidencePath: path }),
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      active = undefined;
    }
    if (after.stage !== null && advanced) {
      active = yield* stageRuns.append({ deliveryId, stage: after.stage });
      if (stopped) {
        yield* stageRuns.finish({ ...attemptOf(active), outcome: outcomeOf(after) });
        active = undefined;
      }
    }
    const { awaiting } = after;
    if (
      active !== undefined &&
      awaiting?.type === "run" &&
      (before.awaiting?.type !== "run" || before.awaiting.runId !== awaiting.runId)
    ) {
      yield* stageRuns.assignRun({
        ...attemptOf(active),
        threadId: awaiting.threadId,
        runId: awaiting.runId,
      });
    }
  });

  const stepLocked = Effect.fn("FactoryWorker.step")(function* (
    deliveryId: FactoryDeliveryId,
    event: FactoryEvent,
  ) {
    const current = yield* deliveries.get(deliveryId);
    if (Option.isNone(current)) return current;
    const before = current.value.state;
    const next = advance(before, event);
    // The engine hands back the very same state for an event the delivery does not await.
    if (next.delivery === before && next.effects.length === 0) return current;

    const evidence = evidenceOf(event, before);
    const stored = yield* deliveries.update(deliveryId, next.delivery).pipe(
      Effect.tap((updated) =>
        Option.isSome(updated)
          ? recordAttempts(deliveryId, before, next.delivery, evidence)
          : Effect.void,
      ),
      sql.withTransaction,
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new FactoryStoreError({ operation: "worker.step", cause })),
      }),
    );
    // Queued only now: an effect never starts before the state that issued it is stored.
    if (Option.isSome(stored) && next.effects.length > 0) {
      const lane = yield* laneFor(deliveryId);
      for (const effect of next.effects) {
        yield* TxRef.update(outstanding, (count) => count + 1);
        yield* lane.enqueue({ delivery: stored.value, effect });
      }
    }
    return stored;
  });

  const step: FactoryWorker["Service"]["step"] = (deliveryId, event) =>
    locks.withLock(deliveryId, stepLocked(deliveryId, event));

  const stepWith: FactoryWorker["Service"]["stepWith"] = (deliveryId, decide) =>
    locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = yield* deliveries.get(deliveryId);
        if (Option.isNone(current)) return Option.none();
        const { event, value } = yield* decide(current.value);
        const stored = yield* stepLocked(deliveryId, event);
        return Option.map(stored, (delivery) => ({ delivery, value }));
      }),
    );

  /** The run a launch or turn result names; other results name none. */
  const runOf = (effect: FactoryEffect, event: FactoryEvent) => {
    if (event.type === "thread.launched") return { threadId: event.threadId, runId: event.runId };
    if (event.type === "turn.started" && isTurnEffect(effect)) {
      return { threadId: effect.threadId, runId: event.runId };
    }
    return undefined;
  };

  /**
   * Feeds an effect's result back. A launch or turn result names a run that can end before the
   * result is stored, and the run's terminal event then finds the delivery still awaiting the
   * effect and changes nothing. So that run is read under the delivery's lock right before the
   * result is stored: an end the read misses arrives as an event whose step waits for the lock,
   * and an end it sees is fed right after the result. A read that fails fails the effect
   * instead, so the delivery records none of the result rather than wait on a run that ended.
   *
   * The thread is entered in `storing` before the read, so `stepThread` loses no end: one looked
   * up before the entry exists was committed before the read, which sees it (a deletion cancels
   * the thread's active runs in the same commit); one looked up while the entry stands is routed
   * by it; one looked up after finds what the store recorded.
   */
  // Annotated like `step`: it closes the cycle `stepLocked` → lane → `runJob` → `feed`.
  const feed = (job: Job, event: FactoryEvent): ReturnType<FactoryWorker["Service"]["step"]> => {
    const { deliveryId } = job.delivery;
    const run = runOf(job.effect, event);
    if (run === undefined) return step(deliveryId, event);
    return locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        storing.set(run.threadId, deliveryId);
        const ended = yield* Effect.exit(
          Effect.suspend(() => threads.runEnded(run.threadId, run.runId)),
        );
        if (Exit.isFailure(ended)) {
          if (Cause.hasInterruptsOnly(ended.cause)) return yield* Effect.interrupt;
          return yield* stepLocked(deliveryId, {
            type: "effect.failed",
            effectId: job.effect.id,
            detail: failureDetail(job.effect, ended.cause),
          });
        }
        const stored = yield* stepLocked(deliveryId, event);
        if (Option.isNone(ended.value)) return stored;
        return yield* stepLocked(deliveryId, {
          type: "run.finished",
          ...run,
          status: ended.value.value,
        });
      }).pipe(Effect.ensuring(Effect.sync(() => storing.delete(run.threadId)))),
    );
  };

  /** The deliveries `stepThread` steps; see there. */
  const ownersOf = (event: FactoryThreadEvent) =>
    Effect.gen(function* () {
      // The entry first: once it is gone, the store that held it has recorded the thread.
      const storingFor = storing.get(event.threadId);
      if (storingFor !== undefined) return [storingFor];
      if (event.type === "run.finished") {
        const attempt = yield* stageRuns.findActiveByThread(event.threadId);
        return Option.toArray(Option.map(attempt, (run) => run.deliveryId));
      }
      return (yield* deliveries.listActive())
        .filter(({ state }) => Object.values(state.threads).includes(event.threadId))
        .map((delivery) => delivery.deliveryId);
    });

  const stepThread: FactoryWorker["Service"]["stepThread"] = (event) =>
    ownersOf(event).pipe(
      Effect.flatMap((owners) =>
        Effect.forEach(owners, (deliveryId) => step(deliveryId, event), { discard: true }),
      ),
    );

  const failInterruptedEffect: FactoryWorker["Service"]["failInterruptedEffect"] = (deliveryId) =>
    locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = yield* deliveries.get(deliveryId);
        if (Option.isNone(current)) return current;
        const { status, awaiting } = current.value.state;
        // A delivery gets a lane when this process queues its first effect, so with one the
        // awaited effect is still queued or running here, or has already fed its result back.
        if (status !== "running" || awaiting?.type !== "effect" || lanes.has(deliveryId)) {
          return current;
        }
        return yield* stepLocked(deliveryId, {
          type: "effect.failed",
          effectId: awaiting.effect.id,
          detail: `Factory could not ${describeEffect(awaiting.effect)}: a server restart interrupted it.`,
        });
      }),
    );

  /**
   * Runs an effect and feeds its result back. Suspended, so an executor that throws while
   * building its effect fails the effect like any other failure. Interruption (shutdown) feeds
   * nothing.
   */
  const runJob = (job: Job) =>
    Effect.suspend(() => execute(job)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed<FactoryEvent>({
              type: "effect.failed",
              effectId: job.effect.id,
              detail: failureDetail(job.effect, cause),
            }),
      ),
      Effect.flatMap((event) => feed(job, event)),
      Effect.ensuring(TxRef.update(outstanding, (count) => count - 1)),
    );

  // Called only under the delivery's lock, so a delivery never gets two lanes.
  const laneFor = (deliveryId: FactoryDeliveryId) =>
    Effect.suspend(() => {
      const existing = lanes.get(deliveryId);
      if (existing !== undefined) return Effect.succeed(existing);
      return makeDrainableWorker(runJob).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tap((lane) => Effect.sync(() => lanes.set(deliveryId, lane))),
      );
    });

  return FactoryWorker.of({
    step,
    stepWith,
    stepThread,
    failInterruptedEffect,
    drain: TxRef.get(outstanding).pipe(
      Effect.flatMap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    ),
  });
});

export const layer = Layer.effect(FactoryWorker, make);
