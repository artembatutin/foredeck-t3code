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
  isProceeding,
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
 * A parent's child cannot start on the parent's branch: its delivery is not stored, it has no
 * worktree to share, or the task before it records no approved commit to start from.
 */
class FactoryChildStartError extends Schema.TaggedError<FactoryChildStartError>()(
  "FactoryChildStartError",
  {
    child: FactoryDeliveryId,
    reason: Schema.Literals(["missing", "no_worktree", "no_baseline"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return `Factory child delivery ${this.child} is not stored.`;
      case "no_worktree":
        return `Factory child delivery ${this.child} has no worktree to share with its parent.`;
      case "no_baseline":
        return `The task before Factory child delivery ${this.child} records no approved commit.`;
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
 * cancelled parent cancels its children that are not approved. A parent's lock is taken before
 * its children's, never while one of theirs is held.
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
     * the thread, since a delivery keeps its threads after their attempts finish. A delivery whose
     * launch or turn result naming the thread is being stored gets either.
     */
    readonly stepThread: (event: FactoryThreadEvent) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Blocks a delivery that awaits an effect this process never queued, whatever its status: the
     * queue that held it ended with an earlier server process. Nothing is re-run. Any other
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
     * the parent then waits for something else, so the approval is taken once. Any other parent,
     * or delivery, is left as it is. The boot sweep calls this for a parent whose child was
     * approved while no server handed the approval on.
     */
    readonly takeChildApproval: (
      parentId: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Queues every recorded Work comment that is not finished: its transition was stored by a
     * process that stopped before posting it, or died while posting it. The boot sweep calls this.
     */
    readonly postUnfinishedComments: Effect.Effect<void, FactoryStoreError>;
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
 * review round being left, or the approval.
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
    before.stage !== "review"
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
          Effect.map((pullRequest): FactoryEvent => ({
            type: "pr.opened",
            effectId: effect.id,
            pullRequest,
          })),
        );
      case "create_children":
        return children.create(delivery, effect).pipe(
          Effect.map((created): FactoryEvent => ({
            type: "children.created",
            effectId: effect.id,
            children: created,
          })),
        );
      case "start_child":
        return startChild(delivery, effect).pipe(
          Effect.as<FactoryEvent>({ type: "child.started", effectId: effect.id }),
        );
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
      yield* stageRuns.finish({
        ...attemptOf(active),
        outcome: advanced ? (wanting ? "failed" : "passed") : outcomeOf(after),
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
      for (const threadId of new Set(Object.values(before.threads))) {
        if (threadId === undefined) continue;
        yield* interruptCancelled(
          stored,
          threadId === awaited?.threadId ? { threadId, runId: awaited.runId } : { threadId },
        );
      }
      // A parent's children go with it, the one it waits for and those it never started, and
      // stop what their threads run; an approved child keeps its approval.
      for (const childId of before.children) yield* cancelChild(childId);
    }
    return Option.some(stored);
  });

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

  /**
   * Starts the parent's child for `start_child`, under the parent's lock while the parent still
   * awaits the effect: a parent cancelled meanwhile starts none. A child that started before is
   * left as it is. The child works on the parent's worktree and branch, from its task baseline:
   * where the parent's branch started for the first child, and the commit the task before it was
   * approved for after that, so its settle check judges only commits made since.
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
        if (
          current === undefined ||
          awaiting?.type !== "effect" ||
          awaiting.effect.id !== effect.id
        ) {
          return;
        }
        const { child: childId } = effect;
        const refuse = (reason: FactoryChildStartError["reason"]) =>
          new FactoryChildStartError({ child: childId, reason });
        const child = Option.getOrUndefined(yield* deliveries.get(childId));
        if (child === undefined) return yield* refuse("missing");
        if (child.state.status !== "queued") return;
        // Without one, its author's launch would create a worktree and branch of its own.
        if (child.state.worktreePath === null) return yield* refuse("no_worktree");
        const { children } = current.state;
        const previous = children[children.indexOf(childId) - 1];
        // A parent stored before planner launches recorded where its branch started has no
        // baseline: its first child then starts from HEAD before its author's first turn, as a
        // single item does.
        const baseline =
          previous === undefined
            ? current.state.baseline
            : (FactoryChildren.taskOfChild(
                current.deliveryId,
                yield* tasks.listByDelivery(current.deliveryId),
                previous,
              )?.lastReviewedSha ?? (yield* refuse("no_baseline")));
        yield* locks.withLock(
          childId,
          stepLocked(childId, { type: "start", ...(baseline === null ? {} : { baseline }) }),
        );
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

  // A child's approval reaches its parent once the child's lock is released.
  const step: FactoryWorker["Service"]["step"] = (deliveryId, event) =>
    locks
      .withLock(deliveryId, stepLocked(deliveryId, event))
      .pipe(
        Effect.tap((stored) =>
          Option.isSome(stored) &&
          stored.value.parentId !== null &&
          stored.value.state.status === "approved"
            ? takeChildApproval(stored.value.parentId)
            : Effect.void,
        ),
      );

  const stepWith: FactoryWorker["Service"]["stepWith"] = (deliveryId, decide) =>
    locks.withLock(
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
        const { awaiting } = current.value.state;
        // A delivery gets a lane when this process queues its first effect, so with one the
        // awaited effect is still queued or running here, or has already fed its result back.
        if (awaiting?.type !== "effect" || lanes.has(deliveryId)) return current;
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

  return FactoryWorker.of({
    step,
    stepWith,
    stepThread,
    failInterruptedEffect,
    takeChildApproval,
    postUnfinishedComments,
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
