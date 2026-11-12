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
import * as FactoryAdmission from "./FactoryAdmission.ts";
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
import { isFactoryPromptOverrideError } from "./prompts/overrides.ts";
import { isFactoryReviewedExecutionRefusedError } from "./reviewedExecution.ts";
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
 * The delivery stopped awaiting its author's launch while the setup command ran, as a cancel does:
 * the launch sends no opening turn, and the delivery takes nothing of its failure.
 */
class FactoryLaunchWithdrawnError extends Schema.TaggedError<FactoryLaunchWithdrawnError>()(
  "FactoryLaunchWithdrawnError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} no longer awaits its author's launch.`;
  }
}

/**
 * A parent's child cannot start (or its start be taken) on the parent's branch: it is not among
 * the parent's children, has no worktree to share, its starting commit cannot be established, or
 * the first child started somewhere other than where the branch started. Nothing was started.
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
 * Drives deliveries through the pure engine: a step stores the new state, then queues its effects,
 * whose results feed back as the next step. A parent runs its children one at a time on its
 * worktree; take a parent's lock before its children's, never while one of theirs is held. Every
 * effect but a close-out runs only once `FactoryAdmission` admits it.
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
     * Decides an event from the stored delivery, then steps it, both under the delivery's lock so
     * no other step runs in between. A failed decision steps nothing. Returns the stored result,
     * its stage attempts read under the same lock, and the decision; none for an unknown delivery.
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
        readonly stageAttempts: FactoryStageRunStore.FactoryStageAttempts;
        readonly value: A;
      }>,
      E | FactoryStoreError
    >;
    /**
     * Steps the deliveries the event's thread belongs to. A run's end goes to the delivery whose
     * active attempt names the thread; a deletion to every active delivery that records or follows
     * it. A delivery storing a launch or turn result naming the thread gets either.
     */
    readonly stepThread: (event: FactoryThreadEvent) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Blocks a delivery awaiting an effect whose job died with an earlier process; nothing re-runs.
     * An effect deferred by admission stays marked for redispatch (marked now if the port still
     * holds it). A parent awaiting a child that started takes that start, then any stored approval.
     */
    readonly failInterruptedEffect: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /**
     * For a delivery blocked on an interrupted `open_pr`, records what the PR stage published (see
     * `FactoryPullRequest.recover`), keeping it blocked. `unknown` when it published but not which
     * pull request, so a resume must not publish again; `none` otherwise. The boot sweep and every
     * resume call this; a failed read changes nothing.
     */
    readonly recoverPullRequest: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<"none" | "unknown" | "recovered", FactoryStoreError>;
    /**
     * Queues the admission-deferred effect `effectId` once, under the delivery's lock, only while
     * it is awaited, marked waiting and no job is in flight; the job asks admission again before it
     * runs. `stale`, changing nothing, otherwise.
     */
    readonly redispatch: (
      deliveryId: FactoryDeliveryId,
      effectId: number,
    ) => Effect.Effect<"dispatched" | "stale", FactoryStoreError>;
    /**
     * Makes sure the awaited effect `effectId` waits marked for admission, under the delivery's
     * lock and never running anything: `deferred` once it is marked, marking it when it has no
     * mark and no job (a mark the worker could not store); `running` while a job of the delivery
     * is in flight; `stale` when the delivery does not await it or is unknown.
     */
    readonly ensureDeferred: (
      deliveryId: FactoryDeliveryId,
      effectId: number,
    ) => Effect.Effect<"deferred" | "running" | "stale", FactoryStoreError>;
    /**
     * How many of the delivery's jobs this process has queued or running (see `Job`), read
     * without the delivery's lock: an effect counts from before it is queued until it ends.
     */
    readonly jobsInFlight: (deliveryId: FactoryDeliveryId) => Effect.Effect<number>;
    /**
     * Steps a parent with the approval of the child it waits for, once; a parent without a recorded
     * branch start takes that child's start again first. The boot sweep calls this for a child
     * approved while no server handed the approval on.
     */
    readonly takeChildApproval: (
      parentId: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Completes a family cancel or close-out a restart cut short: a cancelled parent cancels its
     * children, a cancelled child its parent and unfinished siblings, and a done parent finishes
     * its approved children. The boot sweep calls this for every delivery not done or cancelled.
     */
    readonly finishFamily: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryStoreError>;
    /**
     * Interrupts a cancelled delivery's run carrying a turn Factory sent or a wake it adopted; the
     * owner's own turns stay. Called as such a run goes live, since a restart or queued wake can
     * start one after the cancel committed. A child's author thread is judged for its parent first
     * when the parent's pull request is linked there. Failures are logged.
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
     * cancel and releasing the watch left it on, to wake the thread its pull request is linked to
     * with new work, and the wakes it sent meanwhile untaken. The boot sweep calls this.
     */
    readonly releaseWatches: Effect.Effect<void, FactoryStoreError>;
    /**
     * Resolves once every queued effect and every step its result fed back have finished, and
     * every Work comment queued has been posted, has failed or was found finished already.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryWorker") {}

/**
 * An effect to carry out, with the delivery as stored when it was queued. It counts as in flight
 * for its delivery from before it is queued until `release`, which only its first call does.
 */
interface Job {
  readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
  readonly effect: FactoryEffect;
  readonly release: Effect.Effect<void>;
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

/** A refused effect's detail: what Factory did not do, then the refusal's fixed text. */
const refusalDetail = (effect: FactoryEffect, category: FactoryAdmission.FactoryAdmissionRefusal) =>
  `Factory did not ${describeEffect(effect)}. ${FactoryAdmission.admissionRefusalText[category]}`;

/**
 * The `effect.failed` detail: what failed and the failure's tag. Never a message or cause, which
 * can carry command output or provider text, except fixed-text ones (setup, prompt override,
 * publication, reviewed delivery and host policy refusals). A refused launch opening reads as a
 * refused effect.
 */
const failureDetail = (effect: FactoryEffect, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (FactoryAdmission.isFactoryOpeningRefusedError(error)) {
    return refusalDetail(effect, error.category);
  }
  if (
    FactoryVerifyRunner.isFactorySetupFailedError(error) ||
    FactoryPullRequest.isFactoryPublicationRefusedError(error) ||
    isFactoryPromptOverrideError(error) ||
    isFactoryReviewedExecutionRefusedError(error) ||
    FactoryThreadEffects.isFactoryRuntimeModeRefusedError(error)
  ) {
    return `Factory could not ${describeEffect(effect)}. ${error.message}`;
  }
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  const kind = typeof tag === "string" && SAFE_TAG.test(tag) ? tag : "unexpected error";
  return `Factory could not ${describeEffect(effect)} (${kind}).`;
};

/** What a host policy refused, for the owner to choose among, when that is what failed. */
const hostRefusalOf = (cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (!FactoryThreadEffects.isFactoryRuntimeModeRefusedError(error)) return {};
  const { runtimeMode, provider, driver, detail, choose, alternatives, threadId } = error;
  return {
    hostRefused: {
      runtimeMode,
      provider,
      driver,
      ...(detail === undefined ? {} : { detail }),
      choose,
      alternatives,
      ...(threadId === undefined ? {} : { threadId }),
    },
  };
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
      reason === "repeated_failure" ||
      (state.block?.reason === "allowance_exhausted" && state.block.allowance !== "fix_commit")
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
  const admission = yield* FactoryAdmission.FactoryAdmission;
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
  // Each delivery's jobs, counted from before they are queued until each ends (see `Job`). An
  // awaited effect with none has no job of this process to run it: it waits for admission, or a
  // restart lost its job. Read and changed under the delivery's lock, but for a job's release
  // when it ends after feeding its result back.
  const jobs = new Map<FactoryDeliveryId, number>();
  const inFlight = (deliveryId: FactoryDeliveryId) => jobs.get(deliveryId) ?? 0;

  /** Counts a job of the delivery as in flight, returning the job's `release`. */
  const countJob = (deliveryId: FactoryDeliveryId) =>
    Effect.sync(() => {
      jobs.set(deliveryId, inFlight(deliveryId) + 1);
      let released = false;
      return Effect.sync(() => {
        if (released) return;
        released = true;
        const left = inFlight(deliveryId) - 1;
        if (left > 0) jobs.set(deliveryId, left);
        else jobs.delete(deliveryId);
      });
    });
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

  const runCommand = Effect.fn("FactoryWorker.runCommand")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    stage: FactoryStageName,
  ) {
    const { worktreePath } = delivery.state;
    if (stage !== "verify" || worktreePath === null) {
      return yield* new FactoryStageCommandError({ stage });
    }
    // Read when the command runs, not when the delivery started: a verify command removed
    // since then fails the effect before anything runs. A reviewed delivery runs what its owner
    // reviewed, whatever the settings say now.
    const { reviewedExecution: reviewed } = delivery.state;
    const runSettings = reviewed ?? (yield* settings.requireDeliverySettings(delivery.projectId));
    return yield* verifyRunner.run({
      deliveryId: delivery.deliveryId,
      worktreePath,
      settings: runSettings,
    });
  });

  /**
   * The project's setup command an author launch runs before its opening turn (current settings
   * or the reviewed one, under the verify timeout), then a check that the delivery still awaits
   * the launch, so one cancelled during setup gets no opening turn. None for other launches.
   */
  const openingSetup = Effect.fn("FactoryWorker.openingSetup")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
  ) {
    if (effect.role !== "author") return undefined;
    const { setupCommand, limits } =
      delivery.state.reviewedExecution ?? (yield* settings.get(delivery.projectId));
    if (setupCommand === null) return undefined;
    const { deliveryId } = delivery;
    return (worktreePath: string) =>
      verifyRunner
        .setup({
          deliveryId,
          worktreePath,
          command: setupCommand,
          timeoutMinutes: limits.verifyTimeoutMinutes,
        })
        .pipe(
          Effect.andThen(deliveries.get(deliveryId)),
          Effect.flatMap((current) => {
            const awaiting = Option.getOrUndefined(current)?.state.awaiting;
            return awaiting?.type === "effect" && awaiting.effect.id === effect.id
              ? Effect.void
              : Effect.fail(new FactoryLaunchWithdrawnError({ deliveryId }));
          }),
        );
  });

  /** A failed run's outcome with its failure fingerprint: verify failed on its tree. */
  const withFingerprint = (outcome: FactoryCommandOutcome): FactoryCommandOutcome =>
    outcome.type === "receipt" && receiptFailed(outcome.receipt)
      ? {
          ...outcome,
          fingerprint: failureFingerprint({ stage: "verify", tree: outcome.receipt.tree }),
        }
      : outcome;

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
        return openingSetup(delivery, effect).pipe(
          Effect.flatMap((beforeOpening) => threads.launchThread(delivery, effect, beforeOpening)),
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
          Effect.map(withFingerprint),
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
          Effect.map(({ pullRequest, threadId, publicationFailure }): FactoryEvent => ({
            type: "pr.opened",
            effectId: effect.id,
            pullRequest,
            pullRequestThread: threadId,
            ...(publicationFailure === undefined ? {} : { publicationFailure }),
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
   * Records the stage attempts a step implies: leaving a stage finishes its attempt (failed for a
   * repair round or replan, else passed or as it stopped), entering one appends the next with the
   * awaited run. A resume re-enters its stage. The plan gate's attempt stays open until the owner
   * decides, and an approved delivery's PR attempt until the pull request opens or it blocks.
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

  /**
   * A reviewed delivery's failed effect, saying when its turn never started, read from the durable
   * record: however it failed, from a refusal to a restart that lost its job, nothing else tells
   * the turn that ran from the turn that did not.
   */
  const withUnsentTurn = Effect.fn("FactoryWorker.withUnsentTurn")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    event: FactoryEvent,
  ): Effect.fn.Return<FactoryEvent> {
    const { reviewedExecution, awaiting } = delivery.state;
    if (
      event.type !== "effect.failed" ||
      reviewedExecution === undefined ||
      awaiting?.type !== "effect" ||
      awaiting.effect.id !== event.effectId
    ) {
      return event;
    }
    const sent = yield* threads.chargedTurnSent(delivery, awaiting.effect);
    return sent ? event : { ...event, unsent: true as const };
  });

  const stepLocked = Effect.fn("FactoryWorker.step")(function* (
    deliveryId: FactoryDeliveryId,
    event: FactoryEvent,
  ) {
    const current = yield* deliveries.get(deliveryId);
    if (Option.isNone(current)) return current;
    const before = current.value.state;
    const next = advance(before, yield* withUnsentTurn(current.value, event));
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
    for (const effect of next.effects) {
      yield* queueJob({ delivery: stored, effect, release: yield* countJob(deliveryId) });
    }
    if (Option.isSome(announced)) {
      yield* queueComment({ itemRef: stored.itemRef, comment: announced.value });
    }
    // Cancelled: once the cancel is stored, each of the delivery's threads stops what it still
    // runs, so a run's end finds the delivery cancelled. Not only the run it awaited: a review
    // that blocked on its submissions awaits nothing while the reviewer's turn goes on. A parent's
    // rounds run on its last child's author thread, which only the child records.
    if (next.delivery.status === "cancelled" && before.status !== "cancelled") {
      const awaited = before.awaiting?.type === "run" ? before.awaiting : undefined;
      const recorded = new Set([...Object.values(before.threads), followedThread(before)]);
      for (const threadId of recorded) {
        if (threadId === undefined) continue;
        yield* interruptCancelled(
          stored,
          threadId === awaited?.threadId ? { threadId, runId: awaited.runId } : { threadId },
        );
      }
      yield* stopRetiredRuns(deliveryId, recorded);
      // A parent's children go with it, the one it waits for, those it never started and those
      // approved, and stop what their threads run. An approved child keeps its approval evidence,
      // but no longer holds its item: no pull request will carry its work.
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

  /**
   * Stops the run live on the thread a cancelled delivery's pull request is linked to when it is
   * Factory's (see `followedThread`).
   */
  const stopTakenWakes = Effect.fn("FactoryWorker.stopTakenWakes")(
    function* (delivery: FactoryDeliveryStore.StoredFactoryDelivery) {
      const threadId = followedThread(delivery.state);
      if (threadId === undefined) return;
      const runs = yield* Effect.suspend(() => threads.liveRunsOn([threadId]));
      yield* Effect.forEach(runs, stopCancelledRun, { discard: true });
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(
            "factory could not read the thread a cancelled delivery's pull request is linked to",
            cause,
          ),
    ),
  );

  /**
   * Releases the watch as the delivery's state asks (see `FactoryPullRequest.release`), stepping
   * where it ended and the wakes core committed, then `watch.released`. A watch someone else
   * started stays. A failure is logged and leaves the release marked for the next boot sweep.
   * Undefined when nothing was stepped.
   */
  // Annotated: it closes the cycle `stepLocked` → `releaseWatch`.
  const releaseWatch = Effect.fn("FactoryWorker.releaseWatch")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ): Effect.fn.Return<
    Option.Option<FactoryDeliveryStore.StoredFactoryDelivery> | undefined,
    FactoryStoreError
  > {
    const { deliveryId, state } = delivery;
    if (state.releaseWatch !== true) return undefined;
    const released = yield* Effect.exit(Effect.suspend(() => pullRequests.release(delivery)));
    if (Exit.isFailure(released)) {
      if (Cause.hasInterruptsOnly(released.cause)) return yield* Effect.interrupt;
      yield* Effect.logWarning("factory could not end its pull request watch", released.cause);
      return undefined;
    }
    if (Option.isSome(released.value)) {
      const { threadId, startedAt, pullRequest, at, firstAt, wakes } = released.value.value;
      if (at !== null) {
        yield* stepLocked(deliveryId, {
          type: "watch.ended",
          startedAt,
          at,
          firstAt,
          number: pullRequest.number,
          url: pullRequest.url,
          threadId,
        });
      }
      for (const wake of wakes) yield* stepLocked(deliveryId, wake);
    }
    return yield* stepLocked(deliveryId, { type: "watch.released" });
  });

  /**
   * Steps the end of a wake run the step just adopted, when that run already ended: an end
   * committed before the step stored the attempt naming its thread found nothing to reach.
   * Undefined when there is nothing to take; a failed read is logged and the boot sweep retries.
   */
  // Annotated: it closes the cycle `stepLocked` → `takeEndedWake`.
  const takeEndedWake = Effect.fn("FactoryWorker.takeEndedWake")(function* (
    deliveryId: FactoryDeliveryId,
    before: FactoryDeliveryState,
    after: FactoryDeliveryState,
  ): Effect.fn.Return<
    Option.Option<FactoryDeliveryStore.StoredFactoryDelivery> | undefined,
    FactoryStoreError
  > {
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
   * Stops what a cancelled delivery's retired threads still run (named by its attempts, recorded
   * by no role, e.g. a reviewer a resume replaced). Uses `stopCancelledRun`, so only Factory's
   * turns stop: the owner may have taken the thread over. Failures are logged.
   */
  const stopRetiredRuns = Effect.fn("FactoryWorker.stopRetiredRuns")(
    function* (deliveryId: FactoryDeliveryId, recorded: ReadonlySet<ThreadId | undefined>) {
      const retired = new Set<ThreadId>();
      for (const { threadId } of yield* stageRuns.listByDelivery(deliveryId)) {
        if (threadId !== null && !recorded.has(threadId)) retired.add(threadId);
      }
      if (retired.size === 0) return;
      const runs = yield* Effect.suspend(() => threads.liveRunsOn([...retired]));
      yield* Effect.forEach(runs, stopCancelledRun, { discard: true });
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("factory could not read a cancelled delivery's retired threads", cause),
    ),
  );

  /** Cancels a cancelled parent's child, under the child's lock, approved or not. */
  // Annotated: it closes the cycle `stepLocked` → `cancelChild`.
  const cancelChild = (childId: FactoryDeliveryId): Effect.Effect<void, FactoryStoreError> =>
    locks.withLock(
      childId,
      Effect.gen(function* () {
        const child = yield* deliveries.get(childId);
        if (Option.isNone(child) || isTerminal(child.value.state)) return;
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
   * Where a legacy parent's branch started, read from its reflog, never the worktree's HEAD,
   * which later commits moved. Refused when unknown or when the first child started elsewhere (an
   * older server used HEAD, so its review missed earlier commits). None once recorded.
   */
  const unrecordedBranchStart = Effect.fn("FactoryWorker.unrecordedBranchStart")(function* (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    refuse: (reason: FactoryChildStartError["reason"]) => FactoryChildStartError,
  ) {
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
  const childBaseline = Effect.fn("FactoryWorker.childBaseline")(function* (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    childId: FactoryDeliveryId,
    branchStart: string | null,
    refuse: (reason: FactoryChildStartError["reason"]) => FactoryChildStartError,
  ) {
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
   * Carries out `start_child` under the parent's lock while it still awaits it, so a cancelled
   * parent starts none: starts the queued child from `childBaseline`, or takes an earlier start,
   * after `unrecordedBranchStart`. Returns the result to feed back.
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
  const takeChildApprovalLocked = Effect.fn("FactoryWorker.takeChildApprovalLocked")(function* (
    parentId: FactoryDeliveryId,
  ) {
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
          const totals = yield* stageRuns.attemptTotals([deliveryId]);
          return Option.some({
            delivery: stored.value,
            stageRuns: runs.get(deliveryId) ?? [],
            stageAttempts: totals.get(deliveryId) ?? {},
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
   * Feeds back an opened pull request under the delivery's lock while it still awaits the effect:
   * starts its watch, stores the result, then steps the wakes core committed since the first
   * watch command, so none is lost in between. A noncompliant pull request starts no watch: a
   * resume decides before its feedback may wake an agent.
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
        if (pullRequestThread === undefined || event.publicationFailure !== undefined) {
          return yield* stepLocked(deliveryId, event);
        }
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
   * Feeds an effect's result back. A launch or turn's run can end before the result is stored, so
   * it is entered in `storing` and read under the lock first: an end the read sees is fed after
   * the result, one it misses steps after the lock. A failed read fails the effect rather than
   * wait on a run that ended.
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
  const ownersOf = Effect.fn("FactoryWorker.ownersOf")(function* (event: FactoryThreadEvent) {
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
        const { awaiting, admissionWait } = current.value.state;
        // A job of this process still has the awaited effect queued or running.
        if (awaiting?.type !== "effect" || inFlight(deliveryId) > 0) return current;
        const { effect } = awaiting;
        // Marked, it waits for admission, which a redispatch gives it.
        if (admissionWait?.effectId === effect.id) return current;
        // A child's start is stored before its parent's result: one that took place is the
        // result, as the effect itself would take it, and the child's approval stored since
        // follows it.
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
        // Deferred before the restart, its mark may not have been stored: it waits marked while
        // the admission port still holds its deferral. A close-out is never deferred.
        const deferred =
          effect.type !== "close_out" &&
          (yield* admission
            .deferredDemand({
              root: current.value.parentId ?? deliveryId,
              deliveryId,
              effectId: effect.id,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning(
                      "factory could not read whether an interrupted effect was deferred",
                      cause,
                    ).pipe(Effect.as(false)),
              ),
            ));
        if (deferred) {
          return yield* stepLocked(deliveryId, { type: "admission.deferred", effectId: effect.id });
        }
        return yield* stepLocked(deliveryId, {
          type: "effect.failed",
          effectId: effect.id,
          detail: `Factory could not ${describeEffect(effect)}: a server restart interrupted it.`,
        });
      }),
    );

  const redispatch: FactoryWorker["Service"]["redispatch"] = (deliveryId, effectId) =>
    locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(deliveryId));
        const awaiting = current?.state.awaiting;
        if (
          awaiting?.type !== "effect" ||
          awaiting.effect.id !== effectId ||
          current?.state.admissionWait?.effectId !== effectId ||
          inFlight(deliveryId) > 0
        ) {
          return "stale" as const;
        }
        // Counted before the mark goes, so the effect never reads as unmarked with no job.
        const release = yield* countJob(deliveryId);
        const granted = yield* stepLocked(deliveryId, { type: "admission.granted", effectId }).pipe(
          Effect.onError(() => release),
        );
        if (Option.isNone(granted)) {
          yield* release;
          return "stale" as const;
        }
        yield* queueJob({ delivery: granted.value, effect: awaiting.effect, release });
        return "dispatched" as const;
      }),
    );

  const ensureDeferred: FactoryWorker["Service"]["ensureDeferred"] = (deliveryId, effectId) =>
    locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(deliveryId));
        const awaiting = current?.state.awaiting;
        if (awaiting?.type !== "effect" || awaiting.effect.id !== effectId) {
          return "stale" as const;
        }
        if (inFlight(deliveryId) > 0) return "running" as const;
        if (current?.state.admissionWait?.effectId !== effectId) {
          yield* stepLocked(deliveryId, { type: "admission.deferred", effectId });
        }
        return "deferred" as const;
      }),
    );

  const recoverPullRequest: FactoryWorker["Service"]["recoverPullRequest"] = (deliveryId) =>
    locks.withLock(
      deliveryId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* deliveries.get(deliveryId));
        const block = current?.state.block;
        if (
          current === undefined ||
          current.state.status !== "blocked" ||
          current.state.pullRequest !== null ||
          block?.reason !== "effect_failed" ||
          block.effect.type !== "open_pr"
        ) {
          return "none" as const;
        }
        const effect = block.effect;
        const recovered = yield* Effect.suspend(() => pullRequests.recover(current, effect)).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.fail(
                  new FactoryStoreError({ operation: "worker.recoverPullRequest", cause }),
                ),
          ),
        );
        if (recovered.type !== "recovered") return recovered.type;
        const { pullRequest, threadId, watch, wakes, outcome } = recovered;
        yield* stepLocked(deliveryId, {
          type: "pr.recovered",
          effectId: effect.id,
          pullRequest,
          pullRequestThread: threadId,
          watch,
        });
        for (const wake of wakes) yield* stepLocked(deliveryId, wake);
        // Merged or closed while no result was stored: taken as the link's sync would have been.
        if (outcome !== undefined) {
          yield* stepLocked(deliveryId, {
            type: outcome === "merged" ? "pr.merged" : "pr.closed",
            number: pullRequest.number,
            url: pullRequest.url,
          });
        }
        return "recovered" as const;
      }),
    );

  const finishFamily: FactoryWorker["Service"]["finishFamily"] = Effect.fn(
    "FactoryWorker.finishFamily",
  )(function* (deliveryId) {
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

  const stopCancelledRun: FactoryWorker["Service"]["stopCancelledRun"] = Effect.fn(
    "FactoryWorker.stopCancelledRun",
  )(
    function* (run) {
      const launchedBy = FactoryThreadEffects.launchDeliveryId(run.threadId);
      if (launchedBy === undefined) return;
      const launcher = Option.getOrUndefined(yield* deliveries.get(launchedBy));
      if (launcher === undefined) return;
      // A parent's pull request is linked to its last child's author thread: the wakes and turns
      // of its rounds there are the parent's, not the approved child's the thread id names.
      const parent =
        launcher.parentId === null
          ? undefined
          : Option.getOrUndefined(yield* deliveries.get(launcher.parentId));
      const owners =
        parent !== undefined && followedThread(parent.state) === run.threadId
          ? [parent, launcher]
          : [launcher];
      for (const delivery of owners) {
        if (delivery.state.status !== "cancelled") continue;
        const adopted = adoptedRuns(delivery.state);
        if (!(yield* threads.carriesFactoryTurn(run.threadId, run.runId, adopted))) continue;
        return yield* interruptCancelled(delivery, run);
      }
    },
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
   * What the admission port decides for the job's effect. A close-out is never asked: it only
   * finishes what the owner's merge began.
   */
  const admit = ({ delivery, effect }: Job) =>
    effect.type === "close_out"
      ? Effect.succeed<FactoryAdmission.FactoryAdmissionDecision>({ type: "proceed" })
      : admission.enter({
          root: delivery.parentId ?? delivery.deliveryId,
          deliveryId: delivery.deliveryId,
          effectId: effect.id,
          effectType: effect.type,
          fresh: FactoryAdmission.isFreshEffect(effect.type),
        });

  /** A refused effect's failure: what Factory did not do, then the refusal's fixed text. */
  const refused = (
    effect: FactoryEffect,
    category: FactoryAdmission.FactoryAdmissionRefusal,
  ): FactoryEvent => ({
    type: "effect.failed",
    effectId: effect.id,
    detail: refusalDetail(effect, category),
  });

  /**
   * Leaves the effect waiting for admission: under the lock, steps `admission.deferred` and
   * releases the job. A mark that cannot be stored is logged; `ensureDeferred` marks it later,
   * and only a marked effect is ever redispatched.
   */
  // Annotated: it closes the cycle `stepLocked` → lane → `runJob` → `defer`.
  const defer = (job: Job): Effect.Effect<void> => {
    const { deliveryId } = job.delivery;
    return locks.withLock(
      deliveryId,
      stepLocked(deliveryId, { type: "admission.deferred", effectId: job.effect.id }).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("factory could not mark an effect waiting for admission", cause),
        ),
        Effect.ensuring(job.release),
      ),
    );
  };

  /**
   * Whether a reviewed delivery may run the effect, read as late as can be: a close-out only
   * finishes what the owner's merge began, so like admission it is never asked.
   */
  const reviewedGate = ({ delivery, effect }: Job) =>
    delivery.state.reviewedExecution === undefined || effect.type === "close_out"
      ? Effect.void
      : threads.checkReviewed(delivery, effect);

  /**
   * Runs an effect once admitted (and allowed by a reviewed delivery's review) and feeds back its
   * result; a refusal feeds a failure, a deferral or interruption nothing. Suspended, so an
   * executor that throws while building fails the effect like any other failure.
   */
  const runJob = (job: Job) =>
    Effect.suspend(() => admit(job)).pipe(
      Effect.flatMap((decision) => {
        switch (decision.type) {
          case "proceed":
            return Effect.suspend(() => reviewedGate(job)).pipe(
              Effect.andThen(Effect.suspend(() => execute(job))),
            );
          case "refuse":
            return Effect.succeed(refused(job.effect, decision.category));
          case "defer":
            return Effect.as(defer(job), undefined);
        }
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed<FactoryEvent>({
              type: "effect.failed",
              effectId: job.effect.id,
              detail: failureDetail(job.effect, cause),
              ...hostRefusalOf(cause),
            }),
      ),
      Effect.flatMap((event) => (event === undefined ? Effect.void : feed(job, event))),
      Effect.ensuring(job.release),
      Effect.ensuring(TxRef.update(outstanding, (count) => count - 1)),
    );

  /** Queues a counted job on its delivery's lane; called only under the delivery's lock. */
  const queueJob = Effect.fn("FactoryWorker.queueJob")(function* (job: Job) {
    const lane = yield* laneFor(job.delivery.deliveryId);
    yield* TxRef.update(outstanding, (count) => count + 1);
    yield* lane.enqueue(job);
  });

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
    redispatch,
    ensureDeferred,
    jobsInFlight: Effect.fn("FactoryWorker.jobsInFlight")((deliveryId) =>
      Effect.sync(() => inFlight(deliveryId)),
    ),
    recoverPullRequest,
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
