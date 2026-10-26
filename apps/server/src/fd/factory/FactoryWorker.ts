import type { RunId, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  FactoryDeliveryId,
  FactoryStageName,
  type FactoryStageOutcome,
} from "@t3tools/contracts/fd/factory";
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
import * as TxRef from "effect/TxRef";

import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import { readBranchCreation } from "./git/branchStart.ts";
import { readSettle } from "./git/settleCheck.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import * as FactoryWorkCommentStore from "./persistence/FactoryWorkCommentStore.ts";
import { transitionComment } from "./pipeline/comments.ts";
import { advance } from "./pipeline/engine.ts";
import { failureFingerprint } from "./pipeline/fingerprint.ts";
import {
  acceptedPlan,
  acceptedReview,
  adoptedRuns,
  followedThread,
  isProceeding,
  isTerminal,
  isTurnEffect,
  receiptFailed,
} from "./pipeline/state.ts";
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
 * A parent's child cannot start, or its start be taken, on the parent's branch: its delivery is
 * not stored among the parent's children, it has no worktree to share, which commit it starts from
 * cannot be established (the task before it records no approved commit, or the parent recorded no
 * branch start and its branch's reflog does not hold it), or the parent's first child started from
 * a commit other than where the branch started. Nothing was started or taken.
 */
class FactoryChildStartError extends Schema.TaggedError<FactoryChildStartError>()(
  "FactoryChildStartError",
  {
    child: FactoryDeliveryId,
    reason: Schema.Literals(["missing", "no_worktree", "no_baseline", "baseline_mismatch"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return `Factory child delivery ${this.child} is not stored as its parent's child.`;
      case "no_worktree":
        return `Factory child delivery ${this.child} has no worktree to share with its parent.`;
      case "no_baseline":
        return `Factory cannot tell which commit child delivery ${this.child} starts from.`;
      case "baseline_mismatch":
        return `The first child of child delivery ${this.child}'s parent started from a commit other than where the parent's branch started.`;
    }
  }
}

/**
 * Drives deliveries through the pure engine. A step folds one event into the stored delivery,
 * stores the new state with its stage attempts, then queues the effects the engine returned;
 * each effect's result (or failure) is fed back as the delivery's next step. A step that moves
 * the delivery into a status its item announces records that Work comment with the new state and
 * then queues it. A step that approves a parent's plan stores its tasks, in plan order, with the
 * approval. Each step that stores something moves the deliveries' change epoch once it has
 * committed.
 *
 * A parent runs its children one at a time on its branch and worktree: the worker starts the
 * child the parent waits for, and hands the parent each child's approval once it is stored. A
 * cancelled parent cancels its children that are not approved, and a child cancelled on its own
 * cancels its parent, so its unfinished siblings too (owner decision). A parent done once its
 * merged pull request is closed out makes its approved children done. A parent's lock is taken
 * before its children's, never while one of theirs is held.
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
     * that fails steps nothing. Returns the stored result, its newest stage attempts as a
     * snapshot carries them (read under the same lock, so they are that result's and no later
     * step's) and the decision's value; none for an unknown delivery, where `decide` does not
     * run.
     */
    readonly stepWith: <A, E>(
      deliveryId: FactoryDeliveryId,
      decide: (
        delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      ) => Effect.Effect<{ readonly event: FactoryEvent; readonly value: A }, E>,
    ) => Effect.Effect<
      Option.Option<{
        readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
        readonly stageRuns: ReadonlyArray<FactoryStageRunStore.StoredFactoryStageRun>;
        readonly value: A;
      }>,
      E | FactoryStoreError
    >;
    /**
     * Steps the deliveries the event's thread belongs to. A run's end goes to the delivery whose
     * active stage attempt names the thread; a deletion goes to every active delivery that records
     * the thread, since a delivery keeps its threads after their attempts finish, or follows its
     * pull request there (a parent, on its last child's author thread). A delivery whose launch or
     * turn result naming the thread is being stored gets either.
     */
    readonly stepThread: (event: FactoryThreadEvent) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Blocks a delivery that awaits an effect this process never queued, whatever its status: the
     * queue that held it ended with an earlier server process. Nothing is re-run. A child's start
     * is stored before its parent takes the result, though, so a parent awaiting the start of a
     * child that started takes that start, then the child's approval if it is stored. Any other
     * delivery is left as it is; an unknown one returns none.
     */
    readonly failInterruptedEffect: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /**
     * Steps a parent with the approval of the child it waits for, once that child is approved;
     * the parent then waits for something else, so the approval is taken once. A parent without a
     * recorded branch start takes that child's start again first (see `advance`). Any other
     * parent, or delivery, is left as it is. The boot sweep calls this for a parent whose child
     * was approved while no server handed the approval on.
     */
    readonly takeChildApproval: (
      parentId: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Completes what a restart cut short between a parent and its children. A parent's cancel is
     * stored before its children's, and a child's before its parent's, so a child whose parent is
     * cancelled is cancelled, unless approved, and a parent with a cancelled child is cancelled
     * with its unfinished children; each stops what its threads run. A merged parent is done
     * before its children, so an approved child whose parent is done is done. Any other delivery
     * is left as it is. The boot sweep calls this for every delivery that is not done or cancelled.
     */
    readonly finishFamily: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Interrupts a live run on a thread of a cancelled delivery when it carries on a turn Factory
     * sent, or a pull request wake the delivery adopted as a follow-through round. A cancel
     * commits before it interrupts what its threads run, so a server that stopped in between
     * leaves that work to core's restart continuation, which carries it on in a new run the
     * cancelled delivery never takes; a wake run queued behind another run cannot be interrupted
     * before it starts. The owner's own turns on the thread are left alone. A failure is logged,
     * as a cancel's interrupt is. The reactor calls this as such a run goes live, and a cancel for
     * the runs on the threads its delivery no longer records per role.
     */
    readonly stopCancelledRun: (run: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
    /**
     * `stopCancelledRun` for every run live on a thread a Factory launch made; the boot sweep
     * calls this for runs that went live before the reactor was listening.
     */
    readonly stopCancelledRuns: Effect.Effect<void>;
    /**
     * Queues every recorded Work comment that is not finished: its transition was stored by a
     * process that stopped before posting it, or died while posting it. The boot sweep calls this.
     */
    readonly postUnfinishedComments: Effect.Effect<void, FactoryStoreError>;
    /**
     * Releases the pull request watch of each delivery whose state still asks for it (see
     * `releaseWatch` there), cancelled ones included: a process that stopped between storing a
     * cancel and releasing the watch left it on, to wake the author thread to new work, and the
     * wakes it sent meanwhile untaken. The boot sweep calls this.
     */
    readonly releaseWatches: Effect.Effect<void, FactoryStoreError>;
    /**
     * Resolves once every queued effect and every step its result fed back have finished, and
     * every Work comment queued has been posted, has failed or was found finished already.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryWorker") {}

/** An effect to carry out, with the delivery as stored when it was issued. */
interface Job {
  readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
  readonly effect: FactoryEffect;
}

type CommentJob = Parameters<FactoryWorkComments.FactoryWorkComments["Service"]["post"]>[0];

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
    case "read_fallback_plan":
      return "read the plan in the planner's last message";
    case "send_plan_retry_turn":
      return "send the plan retry turn";
    case "send_replan_turn":
      return "send the replan turn";
    case "read_fallback_review":
      return "read the review in the reviewer's last message";
    case "send_review_retry_turn":
      return "send the review retry turn";
    case "send_repair_turn":
      return `send the ${effect.kind} turn`;
    case "send_review_follow_up_turn":
      return "send the review follow-up turn";
    case "record_approval":
      return "record the approval";
    case "open_pr":
      return "open the pull request";
    case "close_out":
      return "close out the merged pull request";
    case "create_children":
      return "create the child items";
    case "start_child":
      return "start the child delivery";
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

/**
 * The `pr.opened` text for a pull request published whose watch could not start: what failed and
 * the failure's tag, never its message (see `failureDetail`).
 */
const watchFailureDetail = (number: number, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  const kind = typeof tag === "string" && SAFE_TAG.test(tag) ? tag : "unexpected error";
  return `Factory opened pull request #${number} but could not watch it for feedback (${kind}).`;
};

/**
 * Whether the delivery's current attempt is still under way in `state`: while it proceeds, and
 * while it waits at the plan gate for its owner.
 */
const attemptOpen = (state: FactoryDeliveryState) =>
  isProceeding(state) || state.status === "waiting";

/** How an attempt ends when its delivery stops running in `state`. */
const outcomeOf = (state: FactoryDeliveryState): FactoryStageOutcome => {
  if (state.status === "blocked") {
    // The stage did its work and judged the commit wanting; any other block is not a verdict.
    const reason = state.block?.reason;
    return reason === "verify_failed" ||
      reason === "review_changes_required" ||
      reason === "repeated_failure"
      ? "failed"
      : "blocked";
  }
  // Stopped where a repair round would begin: the stage judged the commit wanting.
  if (state.status === "stopped" && state.checkpoint === "repair") return "failed";
  return state.status === "cancelled" ? "cancelled" : "passed";
};

/**
 * The evidence of the attempt a step finishes, with a failure's fingerprint: the command's
 * receipt (or log), the plan accepted in the plan round being left, the review accepted in the
 * review or integrate round being left, or the approval.
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
  if (event.type === "approval.recorded") {
    const { outcome } = event;
    return {
      path: outcome.type === "approved" ? outcome.evidencePath : undefined,
      fingerprint: undefined,
    };
  }
  if (before.stage === "plan") {
    const plan =
      event.type === "plan.read" && event.judgment.type === "accepted"
        ? event.judgment.plan
        : acceptedPlan(before);
    return { path: plan?.evidencePath, fingerprint: undefined };
  }
  const review =
    before.stage !== "review" && before.stage !== "integrate"
      ? undefined
      : event.type === "review.read" && event.judgment.type === "accepted"
        ? event.judgment.review
        : acceptedReview(before);
  return { path: review?.evidencePath, fingerprint: review?.fingerprint };
};

const make = Effect.gen(function* () {
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const settings = yield* FactorySettings.FactorySettings;
  const verifyRunner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
  const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
  const plans = yield* FactoryPlanning.FactoryPlanning;
  const reviews = yield* FactoryReview.FactoryReview;
  const records = yield* FactoryRecord.FactoryRecord;
  const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
  const children = yield* FactoryChildren.FactoryChildren;
  const commentStore = yield* FactoryWorkCommentStore.FactoryWorkCommentStore;
  const poster = yield* FactoryWorkComments.FactoryWorkComments;
  const changes = yield* FactoryChanges.FactoryChanges;
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
  // Work comments post on one lane of their own, in the order they were recorded: a slow or
  // failing Work source never holds up a delivery. Each is counted until it is done. The poster
  // claims each before posting it, so one queued twice (live, and by a boot sweep) posts once:
  // the lane runs one at a time, so the second finds the first finished.
  const commentLane = yield* makeDrainableWorker((job: CommentJob) =>
    poster.post(job).pipe(Effect.ensuring(TxRef.update(outstanding, (count) => count - 1))),
  );
  const queueComment = (job: CommentJob) =>
    TxRef.update(outstanding, (count) => count + 1).pipe(Effect.andThen(commentLane.enqueue(job)));

  const checkSettle = (state: FactoryDeliveryState): Effect.Effect<FactorySettleResult> =>
    readSettle(state).pipe(Effect.provideContext(gitContext));

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
      case "read_fallback_plan":
        return plans.judgeFallback(delivery, effect).pipe(
          Effect.map((judgment): FactoryEvent => ({
            type: "plan.read",
            effectId: effect.id,
            judgment,
          })),
        );
      case "send_plan_retry_turn":
        return threads.sendPlanRetryTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_replan_turn":
        return threads.sendReplanTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_review_retry_turn":
        return threads.sendReviewRetryTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_repair_turn":
        return threads.sendRepairTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "send_review_follow_up_turn":
        return threads.sendReviewFollowUpTurn(delivery, effect).pipe(Effect.map(turnStarted));
      case "record_approval":
        return records.record(delivery).pipe(
          Effect.map((outcome): FactoryEvent => ({
            type: "approval.recorded",
            effectId: effect.id,
            outcome,
          })),
        );
      case "open_pr":
        return pullRequests.open(delivery, effect).pipe(
          Effect.map(({ pullRequest, threadId }): FactoryEvent => ({
            type: "pr.opened",
            effectId: effect.id,
            pullRequest,
            pullRequestThread: threadId,
          })),
        );
      case "close_out":
        // Its worktree is removed when the result is fed back (see `closeOutWorktree`).
        return pullRequests
          .closeOutItems(delivery)
          .pipe(Effect.as<FactoryEvent>({ type: "closed_out", effectId: effect.id }));
      case "create_children":
        return children.create(delivery, effect).pipe(
          Effect.map((created): FactoryEvent => ({
            type: "children.created",
            effectId: effect.id,
            children: created,
          })),
        );
      case "start_child":
        return startChild(delivery, effect);
    }
  };

  /**
   * Records the stage attempts a step implies. Leaving a stage finishes its active attempt:
   * failed when the delivery left it for a repair round or the owner sent its plan back from the
   * gate, passed when it advanced otherwise, and by how it stopped proceeding when it did.
   * Entering one appends the next attempt, and the attempt carries the run the delivery now
   * awaits; a resumed delivery enters its stage again, since the attempt it stopped or blocked in
   * has ended. An approved delivery still proceeds: its PR attempt ends when the pull request is
   * open or the delivery blocks. A delivery waiting at the plan gate keeps the gate's attempt
   * open until its owner decides.
   */
  const recordAttempts = Effect.fn("FactoryWorker.recordAttempts")(function* (
    deliveryId: FactoryDeliveryId,
    before: FactoryDeliveryState,
    after: FactoryDeliveryState,
    evidence: ReturnType<typeof evidenceOf>,
  ) {
    const stopped = !attemptOpen(after);
    const advanced = after.stage !== before.stage;
    const entered = advanced || (!attemptOpen(before) && !stopped);
    let active = (yield* stageRuns.listByDelivery(deliveryId)).findLast(
      (run) => run.outcome === null && run.stage === before.stage,
    );
    const attemptOf = (run: FactoryStageRunStore.StoredFactoryStageRun) => ({
      deliveryId,
      stage: run.stage,
      attempt: run.attempt,
    });

    if (active !== undefined && attemptOpen(before) && (advanced || stopped)) {
      const { path, fingerprint } = evidence;
      // A repair round is the stage's verdict that the commit is wanting, and a replan the
      // owner's that the plan is.
      const wanting =
        after.stage === "repair" || (before.stage === "approve_plan" && after.stage === "plan");
      // A pull request that merged or closed during a follow-through round cuts its stage short.
      const superseded =
        before.pullRequest?.outcome === undefined && after.pullRequest?.outcome !== undefined;
      yield* stageRuns.finish({
        ...attemptOf(active),
        outcome: advanced
          ? superseded
            ? "cancelled"
            : wanting
              ? "failed"
              : "passed"
          : outcomeOf(after),
        ...(path === undefined ? {} : { evidencePath: path }),
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      active = undefined;
    }
    if (after.stage !== null && entered) {
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

  /**
   * Interrupts a run of a cancelled delivery, so no agent goes on working in its worktree; the
   * worktree, branch and commits stay. Without a run id, the thread's latest active run. A run
   * that cannot be interrupted is logged and left to its owner: the delivery is cancelled either
   * way, and no event of the run changes it.
   */
  const interruptCancelled = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    run: { readonly threadId: ThreadId; readonly runId?: RunId },
  ) =>
    Effect.suspend(() => threads.interruptRun(delivery, run)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not interrupt a cancelled delivery's run", cause),
      ),
    );

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
    // Only the step that stores a transition announces it, and records its comment with it: a
    // repeated event changes nothing, and a restart posts only what no process has attempted.
    const comment = transitionComment(before, next.delivery);
    // The approval freezes the plan: its tasks are stored with it, so no approved parent lacks
    // them and none is stored twice.
    const approvedTasks =
      !before.planApproved && next.delivery.planApproved ? (next.delivery.plan?.tasks ?? []) : [];
    const recorded = yield* deliveries.update(deliveryId, next.delivery).pipe(
      Effect.flatMap((updated) =>
        Option.isNone(updated)
          ? Effect.succeedNone
          : Effect.forEach(
              approvedTasks,
              (task) => tasks.insert({ deliveryId, taskId: task.id, plan: task }),
              { discard: true },
            ).pipe(
              Effect.andThen(recordAttempts(deliveryId, before, next.delivery, evidence)),
              Effect.andThen(
                comment === undefined
                  ? Effect.succeedNone
                  : Effect.asSome(commentStore.record({ deliveryId, comment })),
              ),
              Effect.map((announced) => Option.some({ delivery: updated.value, announced })),
            ),
      ),
      (write) => changes.transact(write, Option.isSome),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new FactoryStoreError({ operation: "worker.step", cause })),
      }),
    );
    if (Option.isNone(recorded)) return Option.none();
    const { delivery: stored, announced } = recorded.value;
    // Queued only now: an effect never starts before the state that issued it is stored.
    if (next.effects.length > 0) {
      const lane = yield* laneFor(deliveryId);
      for (const effect of next.effects) {
        yield* TxRef.update(outstanding, (count) => count + 1);
        yield* lane.enqueue({ delivery: stored, effect });
      }
    }
    if (Option.isSome(announced)) {
      yield* queueComment({ itemRef: stored.itemRef, comment: announced.value });
    }
    // Cancelled: once the cancel is stored, each of the delivery's threads stops what it still
    // runs, so a run's end finds the delivery cancelled. Not only the run it awaited: a review
    // that blocked on its submissions awaits nothing while the reviewer's turn goes on.
    if (next.delivery.status === "cancelled" && before.status !== "cancelled") {
      const awaited = before.awaiting?.type === "run" ? before.awaiting : undefined;
      const recorded = new Set(Object.values(before.threads));
      for (const threadId of recorded) {
        if (threadId === undefined) continue;
        yield* interruptCancelled(
          stored,
          threadId === awaited?.threadId ? { threadId, runId: awaited.runId } : { threadId },
        );
      }
      yield* stopRetiredRuns(deliveryId, recorded);
      // A parent's children go with it, the one it waits for and those it never started, and
      // stop what their threads run; an approved child keeps its approval.
      for (const childId of before.children) yield* cancelChild(childId);
    }
    // Done once its merged pull request is closed out: the parent's approved children with it.
    if (next.delivery.status === "done" && before.status !== "done") {
      for (const childId of before.children) yield* finishChild(childId);
    }
    // Cancelled, a delivery that took a wake its watch sent stops what that wake runs. One still
    // queued is stopped as it goes live (see `stopCancelledRun`).
    if (
      before.status === "cancelled" &&
      adoptedRuns(next.delivery).length > adoptedRuns(before).length
    ) {
      yield* stopTakenWakes(stored);
    }
    // The watch is to be released (see `releaseWatch` in the state).
    const released =
      next.delivery.releaseWatch === true && before.releaseWatch !== true
        ? yield* releaseWatch(stored)
        : undefined;
    const taken = yield* takeEndedWake(deliveryId, before, next.delivery);
    return taken ?? released ?? Option.some(stored);
  });

  /** Stops the run live on a cancelled delivery's author thread when it is Factory's. */
  const stopTakenWakes = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { author } = delivery.state.threads;
      if (author === undefined) return;
      const runs = yield* Effect.suspend(() => threads.liveRunsOn([author]));
      yield* Effect.forEach(runs, stopCancelledRun, { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not read a cancelled delivery's author thread", cause),
      ),
    );

  /**
   * Releases the watch as the delivery's state asks (see `FactoryPullRequest.release`): ends
   * Factory's watch while it is still that watch, steps where it ended and the wakes core
   * committed, so the cancelled delivery stops the runs its watch set off, then steps that the
   * release is done. A watch someone else started stays. A failure is logged and leaves the
   * release marked, for the next boot sweep. Undefined when nothing was stepped.
   */
  // Annotated: it closes the cycle `stepLocked` → `releaseWatch`.
  const releaseWatch = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ): Effect.Effect<
    Option.Option<FactoryDeliveryStore.StoredFactoryDelivery> | undefined,
    FactoryStoreError
  > =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      if (state.releaseWatch !== true) return undefined;
      const released = yield* Effect.exit(Effect.suspend(() => pullRequests.release(delivery)));
      if (Exit.isFailure(released)) {
        if (Cause.hasInterruptsOnly(released.cause)) return yield* Effect.interrupt;
        yield* Effect.logWarning("factory could not end its pull request watch", released.cause);
        return undefined;
      }
      if (Option.isSome(released.value)) {
        const { startedAt, pullRequest, at, firstAt, wakes } = released.value.value;
        if (at !== null) {
          yield* stepLocked(deliveryId, {
            type: "watch.ended",
            startedAt,
            at,
            firstAt,
            number: pullRequest.number,
            url: pullRequest.url,
          });
        }
        for (const wake of wakes) yield* stepLocked(deliveryId, wake);
      }
      return yield* stepLocked(deliveryId, { type: "watch.released" });
    });

  /**
   * Steps the end of a wake run the step just adopted as a round, when that run has already
   * ended: the step stored the stage attempt naming its thread, and an end committed before that
   * found no attempt to reach. One that ends later reaches it as any run's end does. Undefined
   * when there is nothing to take; a read that fails is logged, and the boot sweep reads the run
   * again.
   */
  // Annotated: it closes the cycle `stepLocked` → `takeEndedWake`.
  const takeEndedWake = (
    deliveryId: FactoryDeliveryId,
    before: FactoryDeliveryState,
    after: FactoryDeliveryState,
  ): Effect.Effect<
    Option.Option<FactoryDeliveryStore.StoredFactoryDelivery> | undefined,
    FactoryStoreError
  > =>
    Effect.gen(function* () {
      const awaited = after.awaiting;
      if (
        awaited?.type !== "run" ||
        !adoptedRuns(after).includes(awaited.runId) ||
        (before.awaiting?.type === "run" && before.awaiting.runId === awaited.runId)
      ) {
        return undefined;
      }
      const ended = yield* Effect.exit(
        Effect.suspend(() => threads.runEnded(awaited.threadId, awaited.runId)),
      );
      if (Exit.isFailure(ended)) {
        if (Cause.hasInterruptsOnly(ended.cause)) return yield* Effect.interrupt;
        yield* Effect.logWarning("factory could not read an adopted wake run", ended.cause);
        return undefined;
      }
      if (Option.isNone(ended.value)) return undefined;
      return yield* stepLocked(deliveryId, {
        type: "run.finished",
        threadId: awaited.threadId,
        runId: awaited.runId,
        status: ended.value.value,
      });
    });

  /**
   * Stops what a cancelled delivery's retired threads still run: those its stage attempts name
   * and no role records any more, such as the integrate reviewer a resume replaced while the turn
   * its invalid submissions blocked went on. Each live run there is stopped as
   * `stopCancelledRun` stops one, so only while it carries on a turn Factory sent: the owner may
   * have taken the thread over since. A failure is logged, as a cancel's interrupt is.
   */
  const stopRetiredRuns = (
    deliveryId: FactoryDeliveryId,
    recorded: ReadonlySet<ThreadId | undefined>,
  ) =>
    Effect.gen(function* () {
      const retired = new Set<ThreadId>();
      for (const { threadId } of yield* stageRuns.listByDelivery(deliveryId)) {
        if (threadId !== null && !recorded.has(threadId)) retired.add(threadId);
      }
      if (retired.size === 0) return;
      const runs = yield* Effect.suspend(() => threads.liveRunsOn([...retired]));
      yield* Effect.forEach(runs, stopCancelledRun, { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              "factory could not read a cancelled delivery's retired threads",
              cause,
            ),
      ),
    );

  /** Cancels a cancelled parent's child, under the child's lock, unless it was approved. */
  // Annotated: it closes the cycle `stepLocked` → `cancelChild`.
  const cancelChild = (childId: FactoryDeliveryId): Effect.Effect<void, FactoryStoreError> =>
    locks.withLock(
      childId,
      Effect.gen(function* () {
        const child = yield* deliveries.get(childId);
        if (Option.isNone(child) || child.value.state.status === "approved") return;
        yield* stepLocked(childId, { type: "cancel" });
      }),
    );

  /** Makes a merged parent's child done, under the child's lock, when it is approved. */
  // Annotated like `cancelChild`: it closes the same cycle.
  const finishChild = (childId: FactoryDeliveryId): Effect.Effect<void, FactoryStoreError> =>
    locks.withLock(childId, stepLocked(childId, { type: "parent.done" }).pipe(Effect.asVoid));

  /**
   * Cancels the parent of a child cancelled on its own, under the parent's lock, unless it is
   * done or cancelled; its cancel cancels its unfinished children.
   */
  const cancelParent = (parentId: FactoryDeliveryId): Effect.Effect<void, FactoryStoreError> =>
    locks.withLock(
      parentId,
      Effect.gen(function* () {
        const parent = yield* deliveries.get(parentId);
        if (Option.isNone(parent) || isTerminal(parent.value.state)) return;
        yield* stepLocked(parentId, { type: "cancel" });
      }),
    );

  /** A `child.started` result, carrying where the parent's branch started when it recorded none. */
  const childStarted = (effectId: number, branchStart: string | null): FactoryEvent =>
    branchStart === null
      ? { type: "child.started", effectId }
      : { type: "child.started", effectId, baseline: branchStart };

  /**
   * Where a parent's branch started, when the parent recorded none: one stored before planner
   * launches recorded it. Read from its branch's reflog, never from the worktree's HEAD, which
   * commits since may have moved. Its first child, once started, must have started there: an
   * earlier server started one from that HEAD, and its settle check and review then missed the
   * commits before it. None for a parent that recorded it. Refused when it cannot be
   * established, or the first child started elsewhere.
   */
  const unrecordedBranchStart = (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    refuse: (reason: FactoryChildStartError["reason"]) => FactoryChildStartError,
  ) =>
    Effect.gen(function* () {
      const { baseline, worktreePath, branch, children } = parent.state;
      if (baseline !== null) return null;
      if (worktreePath === null) return yield* refuse("no_worktree");
      const created = yield* readBranchCreation(worktreePath, branch).pipe(
        Effect.provideContext(gitContext),
      );
      if (Option.isNone(created)) return yield* refuse("no_baseline");
      const [firstId] = children;
      const first =
        firstId === undefined ? undefined : Option.getOrUndefined(yield* deliveries.get(firstId));
      if (
        first !== undefined &&
        first.state.status !== "queued" &&
        first.state.baseline !== created.value
      ) {
        return yield* refuse("baseline_mismatch");
      }
      return created.value;
    });

  /**
   * A child's task baseline: where the parent's branch started (`branchStart` when the parent
   * recorded none) for the first child, and the commit the task before it was approved for after
   * that, so its settle check and review judge only the commits made since.
   */
  const childBaseline = (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    childId: FactoryDeliveryId,
    branchStart: string | null,
    refuse: (reason: FactoryChildStartError["reason"]) => FactoryChildStartError,
  ) =>
    Effect.gen(function* () {
      const { children, baseline } = parent.state;
      const index = children.indexOf(childId);
      if (index < 0) return yield* refuse("missing");
      const previous = children[index - 1];
      if (previous === undefined) {
        return baseline ?? branchStart ?? (yield* refuse("no_baseline"));
      }
      const stored = yield* tasks.listByDelivery(parent.deliveryId);
      const task = FactoryChildren.taskOfChild(parent.deliveryId, stored, previous);
      return task?.lastReviewedSha ?? (yield* refuse("no_baseline"));
    });

  const childRefusal = (childId: FactoryDeliveryId) => (reason: FactoryChildStartError["reason"]) =>
    new FactoryChildStartError({ child: childId, reason });

  /**
   * Carries out `start_child` under the parent's lock while the parent still awaits it: a parent
   * cancelled meanwhile starts none. Starts the child, which is queued, on the parent's worktree
   * and branch from its task baseline (see `childBaseline`), or takes one that started before as
   * it is. Either way a parent without a recorded branch start establishes it first (see
   * `unrecordedBranchStart`). Returns the result to feed back.
   */
  const startChild = (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    effect: Extract<FactoryEffect, { readonly type: "start_child" }>,
  ) =>
    locks.withLock(
      parent.deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(parent.deliveryId));
        const awaiting = current?.state.awaiting;
        // The parent no longer awaits the effect, so the result changes nothing.
        if (
          current === undefined ||
          awaiting?.type !== "effect" ||
          awaiting.effect.id !== effect.id
        ) {
          return childStarted(effect.id, null);
        }
        const { child: childId } = effect;
        const refuse = childRefusal(childId);
        const child = Option.getOrUndefined(yield* deliveries.get(childId));
        if (child === undefined) return yield* refuse("missing");
        const branchStart = yield* unrecordedBranchStart(current, refuse);
        if (child.state.status !== "queued") return childStarted(effect.id, branchStart);
        // Without one, its author's launch would create a worktree and branch of its own.
        if (child.state.worktreePath === null) return yield* refuse("no_worktree");
        const baseline = yield* childBaseline(current, childId, branchStart, refuse);
        yield* locks.withLock(childId, stepLocked(childId, { type: "start", baseline }));
        return childStarted(effect.id, branchStart);
      }),
    );

  /** `takeChildApproval` under the parent's lock. */
  const takeChildApprovalLocked = (parentId: FactoryDeliveryId) =>
    Effect.gen(function* () {
      const awaiting = Option.getOrUndefined(yield* deliveries.get(parentId))?.state.awaiting;
      if (awaiting?.type !== "child") return;
      const child = yield* deliveries.get(awaiting.deliveryId);
      if (Option.isNone(child) || child.value.state.status !== "approved") return;
      yield* stepLocked(parentId, { type: "child.approved", deliveryId: awaiting.deliveryId });
    });

  const takeChildApproval: FactoryWorker["Service"]["takeChildApproval"] = (parentId) =>
    locks.withLock(parentId, takeChildApprovalLocked(parentId));

  /**
   * What a child's stored state asks of its parent, once the child's lock is released (a parent's
   * steps take their children's locks under their own): an approval is handed to the parent, and
   * a cancel cancels the parent with its unfinished children.
   */
  const toParent = ({ parentId, state }: FactoryDeliveryStore.StoredFactoryDelivery) => {
    if (parentId === null) return Effect.void;
    if (state.status === "approved") return takeChildApproval(parentId);
    return state.status === "cancelled" ? cancelParent(parentId) : Effect.void;
  };

  const step: FactoryWorker["Service"]["step"] = (deliveryId, event) =>
    locks
      .withLock(deliveryId, stepLocked(deliveryId, event))
      .pipe(Effect.tap(Option.match({ onNone: () => Effect.void, onSome: toParent })));

  const stepWith: FactoryWorker["Service"]["stepWith"] = (deliveryId, decide) =>
    locks
      .withLock(
        deliveryId,
        Effect.gen(function* () {
          const current = yield* deliveries.get(deliveryId);
          if (Option.isNone(current)) return Option.none();
          const { event, value } = yield* decide(current.value);
          const stored = yield* stepLocked(deliveryId, event);
          if (Option.isNone(stored)) return Option.none();
          // Every write of a delivery's state and attempts after its insert holds its lock, so
          // while this step holds it the attempts read are the stored result's.
          const runs = yield* stageRuns.listNewestByDeliveries({
            deliveryIds: [deliveryId],
            limit: FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
          });
          return Option.some({
            delivery: stored.value,
            stageRuns: runs.get(deliveryId) ?? [],
            value,
          });
        }),
      )
      .pipe(
        Effect.tap(
          Option.match({ onNone: () => Effect.void, onSome: ({ delivery }) => toParent(delivery) }),
        ),
      );

  /**
   * Feeds back a close-out whose items are done: removes the worktree, then stores the result,
   * both under the delivery's lock, and only while the delivery still awaits this close-out. A
   * cancel accepted while the items were set therefore keeps its worktree, and one that comes
   * later finds the delivery done. A removal that fails fails the effect.
   */
  const closeOutWorktree = (job: Job, event: FactoryEvent) => {
    const { deliveryId } = job.delivery;
    return locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(deliveryId));
        const awaiting = current?.state.awaiting;
        if (
          current === undefined ||
          awaiting?.type !== "effect" ||
          awaiting.effect.id !== job.effect.id
        ) {
          // Stale: the engine takes nothing of it.
          return yield* stepLocked(deliveryId, event);
        }
        const removed = yield* Effect.exit(
          Effect.suspend(() => pullRequests.closeOutWorktree(current)),
        );
        if (Exit.isFailure(removed)) {
          if (Cause.hasInterruptsOnly(removed.cause)) return yield* Effect.interrupt;
          return yield* stepLocked(deliveryId, {
            type: "effect.failed",
            effectId: job.effect.id,
            detail: failureDetail(job.effect, removed.cause),
          });
        }
        return yield* stepLocked(deliveryId, event);
      }),
    );
  };

  /**
   * Feeds back an opened pull request: has its watch started on the thread it is linked to (see
   * `FactoryPullRequest.watch`), then stores the result with what that left, and then each wake
   * core committed since the delivery's first watch command, all under the delivery's lock and
   * only while the delivery still awaits this effect. A wake committed later steps the delivery
   * only once the pull request is stored, so none falls in between, and one committed before is
   * taken here, the end of a watch included. A watch core ended is not started again here. A
   * watch that cannot start is reported with the pull request, which is published either way and
   * is recorded.
   */
  const openedPullRequest = (job: Job, event: Extract<FactoryEvent, { type: "pr.opened" }>) => {
    const { deliveryId } = job.delivery;
    const { effect } = job;
    const { pullRequest, pullRequestThread } = event;
    return locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(deliveryId));
        const awaiting = current?.state.awaiting;
        if (
          current === undefined ||
          effect.type !== "open_pr" ||
          awaiting?.type !== "effect" ||
          awaiting.effect.id !== effect.id
        ) {
          // Stale: the engine takes nothing of it.
          return yield* stepLocked(deliveryId, event);
        }
        // `open` always names the thread it linked the pull request to.
        if (pullRequestThread === undefined) return yield* stepLocked(deliveryId, event);
        const watched = yield* Effect.exit(
          Effect.suspend(() => pullRequests.watch(current, effect, pullRequest, pullRequestThread)),
        );
        if (Exit.isFailure(watched)) {
          if (Cause.hasInterruptsOnly(watched.cause)) return yield* Effect.interrupt;
          return yield* stepLocked(deliveryId, {
            ...event,
            watchFailure: watchFailureDetail(pullRequest.number, watched.cause),
          });
        }
        if (Option.isNone(watched.value)) return yield* stepLocked(deliveryId, event);
        const { watch, wakes } = watched.value.value;
        let stored = yield* stepLocked(deliveryId, { ...event, watch });
        for (const wake of wakes) stored = yield* stepLocked(deliveryId, wake);
        return stored;
      }),
    );
  };

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
    if (event.type === "closed_out") return closeOutWorktree(job, event);
    if (event.type === "pr.opened") return openedPullRequest(job, event);
    if (event.type === "child.started") {
      // The child runs from its start on, and its approval may be stored before the parent
      // waits for it; the parent then takes it at once.
      return locks.withLock(
        deliveryId,
        stepLocked(deliveryId, event).pipe(Effect.tap(() => takeChildApprovalLocked(deliveryId))),
      );
    }
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
        if (Option.isNone(ended.value)) {
          // A launch or turn that started after its delivery was cancelled: the delivery took
          // none of it, and its agent must not go on working.
          if (Option.isSome(stored) && stored.value.state.status === "cancelled") {
            yield* interruptCancelled(stored.value, run);
          }
          return stored;
        }
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
        .filter(
          ({ state }) =>
            Object.values(state.threads).includes(event.threadId) ||
            followedThread(state) === event.threadId,
        )
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
        const { awaiting } = current.value.state;
        // A delivery gets a lane when this process queues its first effect, so with one the
        // awaited effect is still queued or running here, or has already fed its result back.
        if (awaiting?.type !== "effect" || lanes.has(deliveryId)) return current;
        // A child's start is stored before its parent's result: one that took place is the
        // result, as the effect itself would take it, and the child's approval stored since
        // follows it.
        const { effect } = awaiting;
        if (effect.type === "start_child") {
          const child = yield* deliveries.get(effect.child);
          if (Option.isSome(child) && child.value.state.status !== "queued") {
            const failed = (tag: string): FactoryEvent => ({
              type: "effect.failed",
              effectId: effect.id,
              detail: `Factory could not ${describeEffect(effect)} (${tag}).`,
            });
            const taken = yield* unrecordedBranchStart(
              current.value,
              childRefusal(effect.child),
            ).pipe(
              Effect.map((branchStart) => childStarted(effect.id, branchStart)),
              Effect.catchTags({
                FactoryChildStartError: (error) => Effect.succeed(failed(error._tag)),
                FactoryBranchStartError: (error) => Effect.succeed(failed(error._tag)),
              }),
            );
            yield* stepLocked(deliveryId, taken);
            if (taken.type === "child.started") yield* takeChildApprovalLocked(deliveryId);
            return yield* deliveries.get(deliveryId);
          }
        }
        return yield* stepLocked(deliveryId, {
          type: "effect.failed",
          effectId: awaiting.effect.id,
          detail: `Factory could not ${describeEffect(awaiting.effect)}: a server restart interrupted it.`,
        });
      }),
    );

  const finishFamily: FactoryWorker["Service"]["finishFamily"] = (deliveryId) =>
    Effect.gen(function* () {
      const delivery = Option.getOrUndefined(yield* deliveries.get(deliveryId));
      if (delivery === undefined || isTerminal(delivery.state)) return;
      if (delivery.parentId !== null) {
        const parent = Option.getOrUndefined(yield* deliveries.get(delivery.parentId));
        if (parent?.state.status === "cancelled") yield* cancelChild(deliveryId);
        if (parent?.state.status === "done") yield* finishChild(deliveryId);
        return;
      }
      for (const childId of delivery.state.children) {
        const child = Option.getOrUndefined(yield* deliveries.get(childId));
        if (child?.state.status === "cancelled") return yield* cancelParent(deliveryId);
      }
    });

  const stopCancelledRun: FactoryWorker["Service"]["stopCancelledRun"] = (run) =>
    Effect.gen(function* () {
      const deliveryId = FactoryThreadEffects.launchDeliveryId(run.threadId);
      if (deliveryId === undefined) return;
      const delivery = Option.getOrUndefined(yield* deliveries.get(deliveryId));
      if (delivery?.state.status !== "cancelled") return;
      const adopted = adoptedRuns(delivery.state);
      if (!(yield* threads.carriesFactoryTurn(run.threadId, run.runId, adopted))) return;
      yield* interruptCancelled(delivery, run);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not stop a cancelled delivery's run", cause),
      ),
    );

  const stopCancelledRuns: FactoryWorker["Service"]["stopCancelledRuns"] = Effect.suspend(
    () => threads.launchedLiveRuns,
  ).pipe(
    Effect.flatMap((runs) => Effect.forEach(runs, stopCancelledRun, { discard: true })),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("factory could not read the live runs of its threads", cause),
    ),
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

  const postUnfinishedComments: FactoryWorker["Service"]["postUnfinishedComments"] = Effect.gen(
    function* () {
      for (const comment of yield* commentStore.listUnfinished()) {
        // Deliveries are never deleted, so every comment's delivery is stored.
        const delivery = yield* deliveries.get(comment.deliveryId);
        if (Option.isSome(delivery)) {
          yield* queueComment({ itemRef: delivery.value.itemRef, comment });
        }
      }
    },
  );

  const releaseWatches: FactoryWorker["Service"]["releaseWatches"] = Effect.gen(function* () {
    for (const { deliveryId } of yield* deliveries.listReleasingWatch()) {
      yield* locks.withLock(
        deliveryId,
        Effect.flatMap(deliveries.get(deliveryId), (current) =>
          Option.isNone(current) ? Effect.void : Effect.asVoid(releaseWatch(current.value)),
        ),
      );
    }
  });

  return FactoryWorker.of({
    step,
    stepWith,
    stepThread,
    failInterruptedEffect,
    takeChildApproval,
    finishFamily,
    stopCancelledRun,
    stopCancelledRuns,
    postUnfinishedComments,
    releaseWatches,
    drain: TxRef.get(outstanding).pipe(
      Effect.flatMap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    ),
  });
});

/** The worker, with the change epoch its steps move; the service shares that one epoch. */
export const layer = Layer.effect(FactoryWorker, make).pipe(
  Layer.provideMerge(FactoryChanges.layer),
);
