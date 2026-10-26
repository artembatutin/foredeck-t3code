import type { OrchestrationV2RunStatus, RunId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryPlan,
  FactoryPlanTask,
  FactoryReviewDetails,
  FactoryReviewSummary,
  FactoryRole,
  FactoryStageName,
  FactoryTaskRisk,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";

/**
 * The engine's vocabulary: a delivery's pipeline progress, the events the reactor and worker
 * feed it and the effects it asks the worker to carry out. Identity (project, item, timestamps)
 * lives beside this state in the delivery's row, not in it.
 */

export type FactoryTerminalRunStatus = Extract<
  OrchestrationV2RunStatus,
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set<FactoryTerminalRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/**
 * Whether a run has ended. Not imported from `ThreadManagementService`: that module sits on an
 * import cycle and throws while initializing when it is the first of the cycle to load, which a
 * Factory module loaded first makes it. `entry.test.ts` loads each Factory module in a fresh Node
 * process, because Vitest's module runner does not raise that error.
 */
export const isTerminalRunStatus = (
  status: string | undefined,
): status is FactoryTerminalRunStatus => status !== undefined && TERMINAL_RUN_STATUSES.has(status);

/** Where a launched thread works. */
export type FactoryWorkspace =
  /** A new worktree that creates the delivery branch from `baseRef`. */
  | { readonly type: "worktree"; readonly branch: string; readonly baseRef: string }
  | { readonly type: "existing_worktree"; readonly worktreePath: string };

/**
 * Work the worker carries out after the new state is stored. Effects that need the worktree,
 * branch or baseline read them from the delivery they came with.
 */
export type FactoryEffectRequest =
  /**
   * Launch a new thread for the role, starting its first turn with the role's prompt. Set when a
   * resume replays an author launch whose run had already ended: `resumeCheckpoint`, the
   * checkpoint the delivery resumes from, whose branch is settled once the launch is recorded.
   */
  | {
      readonly type: "launch_thread";
      readonly role: FactoryRole;
      readonly workspace: FactoryWorkspace;
      readonly resumeCheckpoint?: FactoryStageName;
    }
  /**
   * One mechanical `fix-commit` follow-up turn asking the thread to repair these problems. A
   * resume's turn names the checkpoint the delivery resumes from.
   */
  | {
      readonly type: "send_fix_commit_turn";
      readonly threadId: ThreadId;
      readonly problems: ReadonlyArray<string>;
      readonly checkpoint?: FactoryStageName;
    }
  /**
   * Read the branch after this run and evaluate the settle rules. A resume's check names the
   * checkpoint, and so does the fix-commit turn it may lead to.
   */
  | {
      readonly type: "check_settle";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly checkpoint?: FactoryStageName;
    }
  /** Run the stage's project command in the worktree. */
  | { readonly type: "run_command"; readonly stage: FactoryStageName }
  /**
   * Judge the plan in the last assistant message of this planner run, for a run that ended
   * without an accepted submission (providers without t3 MCP tools answer in a fenced block).
   */
  | { readonly type: "read_fallback_plan"; readonly threadId: ThreadId; readonly runId: RunId }
  /**
   * A follow-up turn asking the planner to submit its whole plan again: the one turn a round's
   * invalid fallback plan gets, listing its problems, or a resume's turn, which names the
   * checkpoint and the problems of the submission it blocked on, if any.
   */
  | {
      readonly type: "send_plan_retry_turn";
      readonly threadId: ThreadId;
      readonly problems: ReadonlyArray<string>;
      readonly checkpoint?: FactoryStageName;
    }
  /**
   * The owner's replan: a follow-up turn giving the planner the owner's note on the plan it waited
   * on at the gate, and asking for its whole plan again.
   */
  | { readonly type: "send_replan_turn"; readonly threadId: ThreadId; readonly note: string }
  /**
   * Judge the review in the last assistant message of this reviewer run, for a run that ended
   * without an accepted submission (providers without t3 MCP tools answer in a fenced block).
   */
  | { readonly type: "read_fallback_review"; readonly threadId: ThreadId; readonly runId: RunId }
  /** The one follow-up turn asking the reviewer to correct these problems and submit again. */
  | {
      readonly type: "send_review_retry_turn";
      readonly threadId: ThreadId;
      readonly problems: ReadonlyArray<string>;
    }
  /**
   * A repair turn on the author thread: `fix-verify` for the delivery's last receipt, which
   * failed, or `fix-review` for its last accepted review, which blocks. `round` counts that kind
   * of repair for the task, from 1.
   */
  | {
      readonly type: "send_repair_turn";
      readonly kind: FactoryRepairKind;
      readonly threadId: ThreadId;
      readonly round: number;
    }
  /**
   * A later review round as a turn on the existing reviewer thread: the delivery's last receipt
   * against its last accepted review, with the author's fix-review reply as claims to check.
   */
  | {
      readonly type: "send_review_follow_up_turn";
      readonly threadId: ThreadId;
      readonly round: number;
    }
  /**
   * The record gate: approve the delivery's task for the worktree's commit, which must be the one
   * its last receipt verified and its last accepted review judged, on a clean tree.
   */
  | { readonly type: "record_approval" }
  /**
   * The PR stage: push the delivery branch and open its pull request, linked to the author
   * thread, for the commit its task was approved for.
   */
  | { readonly type: "open_pr" }
  /**
   * Follow-through after the delivery's pull request merged: set its Work item done, after every
   * child item for a parent, and remove its worktree when it is clean, keeping the branch.
   */
  | { readonly type: "close_out" }
  /**
   * A parent's approved plan: create the child Work item of each of its tasks that has none yet,
   * in plan order, then store the children's queued deliveries.
   */
  | { readonly type: "create_children" }
  /**
   * Start the parent's child delivery, which is queued, with its task baseline, or leave it as it
   * is when it has started before, as when a resume starts again the child a parent waited on.
   * Answered by `child.started`, after which the parent waits for that child's approval.
   */
  | { readonly type: "start_child"; readonly child: FactoryDeliveryId };

export type FactoryRepairKind = "fix-verify" | "fix-review";

/** The stages whose failures repair rounds answer, and whose fingerprints stop a loop. */
export type FactoryRepairedStage = Extract<FactoryStageName, "verify" | "review">;

/**
 * An issued effect. Its id is unique within the delivery, and the worker's result names it, so
 * a late or repeated result of an earlier effect of the same type is never taken for this one.
 */
export type FactoryEffect = FactoryEffectRequest & { readonly id: number };

export type FactoryLaunchEffect = Extract<FactoryEffect, { readonly type: "launch_thread" }>;

/** The effects that send a turn on an existing thread; each is answered by `turn.started`. */
export type FactoryTurnEffect = Extract<
  FactoryEffect,
  {
    readonly type:
      | "send_fix_commit_turn"
      | "send_plan_retry_turn"
      | "send_replan_turn"
      | "send_review_retry_turn"
      | "send_repair_turn"
      | "send_review_follow_up_turn";
  }
>;

export const isTurnEffect = (effect: FactoryEffect): effect is FactoryTurnEffect =>
  effect.type === "send_fix_commit_turn" ||
  effect.type === "send_plan_retry_turn" ||
  effect.type === "send_replan_turn" ||
  effect.type === "send_review_retry_turn" ||
  effect.type === "send_repair_turn" ||
  effect.type === "send_review_follow_up_turn";

/**
 * What the delivery waits for: the worker's result for one issued effect, the end of one run, or,
 * for a parent, the approval of one child. Only an event that answers it advances the delivery.
 */
export type FactoryAwaiting =
  | { readonly type: "effect"; readonly effect: FactoryEffect }
  | { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId }
  | { readonly type: "child"; readonly deliveryId: FactoryDeliveryId };

/**
 * A settle evaluation. Repairable problems get one fix-commit turn; unrepairable ones (an AI
 * identity on a commit, a worktree that cannot be read) block at once.
 */
export type FactorySettleResult =
  | { readonly status: "settled" }
  | { readonly status: "repairable"; readonly problems: ReadonlyArray<string> }
  | { readonly status: "unrepairable"; readonly problems: ReadonlyArray<string> };

/** Whether a receipt records a run that failed or timed out. */
export const receiptFailed = (receipt: FactoryVerifyReceipt) =>
  receipt.timedOut || receipt.code !== 0;

/** Why the server refused to accept a command run as a receipt. */
export type FactoryReceiptRefusal = "head_changed" | "tree_dirty";

/**
 * A command run's result. `evidencePath` is the receipt's JSON, or the log a refused run left
 * (none when it was refused before running); the worker records it on the stage attempt and the
 * engine ignores it. A failed or timed-out receipt carries its failure fingerprint.
 */
export type FactoryCommandOutcome =
  | {
      readonly type: "receipt";
      readonly receipt: FactoryVerifyReceipt;
      readonly evidencePath?: string;
      readonly fingerprint?: string;
    }
  | {
      readonly type: "refused";
      readonly refusals: ReadonlyArray<FactoryReceiptRefusal>;
      readonly evidencePath?: string;
    };

/** Which path a review came by: the `factory_submit_review` tool, or the fenced-JSON fallback. */
export type FactoryReviewSource = "mcp" | "fallback";

/** A valid review the delivery recorded; `evidencePath` is its `review-<n>.json`. */
export interface FactoryAcceptedReview {
  /** The review round it answers. */
  readonly round: number;
  readonly source: FactoryReviewSource;
  readonly summary: FactoryReviewSummary;
  readonly evidencePath: string;
  /** Set on a blocking review: its failure fingerprint. */
  readonly fingerprint?: string;
  /**
   * What clients see of its findings, criteria and missing evidence, which snapshots add to its
   * summary. Absent on reviews accepted before servers kept them.
   */
  readonly details?: FactoryReviewDetails;
}

/**
 * The server's judgment of one review submission. A valid review, blocking or not, is accepted;
 * an invalid one goes back to the reviewer with its problems; a worktree that no longer holds the
 * verified commit, clean, refuses any review.
 */
export type FactoryReviewJudgment =
  | { readonly type: "accepted"; readonly review: Omit<FactoryAcceptedReview, "round"> }
  | { readonly type: "invalid"; readonly problems: ReadonlyArray<string> }
  | { readonly type: "code_changed"; readonly changes: ReadonlyArray<FactoryReceiptRefusal> };

/** Which path a plan came by: the `factory_submit_plan` tool, or the fenced-JSON fallback. */
export type FactoryPlanSource = "mcp" | "fallback";

/**
 * A valid plan the delivery recorded, with tasks or without: the planner's tasks and note, and
 * `evidencePath`, the plan's evidence file.
 */
export interface FactoryAcceptedPlan extends FactoryPlan {
  /** The plan round it answers. */
  readonly round: number;
  readonly source: FactoryPlanSource;
  readonly evidencePath: string;
}

/**
 * The server's judgment of one plan submission. A valid plan is accepted, whether it has tasks or
 * not; an invalid one goes back to the planner with its problems.
 */
export type FactoryPlanJudgment =
  | { readonly type: "accepted"; readonly plan: Omit<FactoryAcceptedPlan, "round"> }
  | { readonly type: "invalid"; readonly problems: ReadonlyArray<string> };

/** A commit and its tree. */
export interface FactoryCommit {
  readonly headSha: string;
  readonly tree: string;
}

/** How the worktree at record differs from the verified, reviewed commit on a clean tree. */
export type FactoryRecordDifference =
  /** HEAD is not the commit the receipt verified. */
  | "head_changed"
  /** HEAD's tree is not the tree the receipt verified. */
  | "tree_changed"
  /** HEAD is not the commit the accepted review judged. */
  | "not_reviewed"
  /** The worktree has staged, unstaged or untracked changes. */
  | "tree_dirty";

/**
 * A `record_approval` result. `approved` wrote the task's `approval-<taskId>.json`
 * (`evidencePath`, which the worker records on the stage attempt) and set its `lastReviewedSha`;
 * `mismatch` wrote nothing.
 */
export type FactoryRecordOutcome =
  | { readonly type: "approved"; readonly evidencePath: string }
  | {
      readonly type: "mismatch";
      /** The commit the receipt verified. */
      readonly expected: FactoryCommit;
      readonly actual: FactoryCommit & { readonly clean: boolean };
      readonly differences: ReadonlyArray<FactoryRecordDifference>;
    };

/** The delivery's pull request: the one the PR stage opened, or found already open. */
export interface FactoryOpenedPullRequest {
  readonly number: number;
  readonly url: string;
  /** The branch the pull request merges from, the delivery branch as the host names it. */
  readonly headBranch: string;
  /** How it left `open`, once the delivery took its merge or close; absent while it is open. */
  readonly outcome?: FactoryPullRequestOutcome;
}

/** A pull request that is no longer open: merged, or closed without merging. */
export type FactoryPullRequestOutcome = "merged" | "closed";

/**
 * How a delivery follows the feedback on its open pull request, through core's watch on the thread
 * the pull request is linked to (see `followedThread`).
 */
export interface FactoryFollowThrough {
  /**
   * The event-log position of the delivery's first watch command: every wake core queues for its
   * pull request on the followed thread after it is the delivery's, taken once by its run. It never
   * moves, so a wake committed while a later PR stage reads or starts the watch is not passed over.
   */
  readonly watchedAfter: number;
  /** The event-log position up to which the latest PR stage read the thread, or its command's. */
  readonly armedAt: number;
  /**
   * The watch Factory holds, one its own watch command started, by when it started; null when the
   * watch on the pull request is someone else's or there is none. Only Factory's watch is ever
   * ended, and its wakes are what a cancelled delivery still takes, to stop their runs.
   */
  readonly watchStartedAt: string | null;
  /** Where that watch ended, once Factory knows; null while it is on. */
  readonly heldUntil: number | null;
  /**
   * The pull request that watch is on, as its release found it; until then, the one the delivery
   * recorded. A watch on another pull request of the thread can start at the same moment.
   */
  readonly heldPullRequest?: { readonly number: number; readonly url: string };
  /**
   * Every wake of the pull request the delivery took, oldest first: those it adopted as rounds,
   * those pending, notices and ends. Each is taken once, and they are Factory's turns when a
   * cancel stops what its threads run.
   */
  readonly runs: ReadonlyArray<RunId>;
  /**
   * Of `runs`, the feedback that came while the delivery ran a stage or waited on its owner,
   * oldest first: each is adopted once the delivery can take it, before its branch is judged or
   * once its pull request is open again.
   */
  readonly pending: ReadonlyArray<RunId>;
  /**
   * Set when core's watch ended with a wake (it could not read the pull request, it closed, or
   * core stopped after too many comment-only updates): no feedback reaches the delivery any more,
   * so it blocks where it would wait on its pull request, and only a resume starts a watch again.
   */
  readonly watchEnded: boolean;
}

/**
 * What a pull request watch's wake reports, as core committed it: feedback to act on (failed
 * checks, new comments, a conflict), a notice that asks nothing (every check passed), or the end
 * of the watch (core stopped watching it).
 */
export type FactoryWakeKind = "feedback" | "notice" | "ended";

/** What a PR stage found and did about the watch on a single item's pull request. */
export interface FactoryWatchState {
  /** The position of the delivery's first watch command, or this stage's when it is the first. */
  readonly firstAt: number;
  /** The position of this stage's watch command, or of the end of what it read without one. */
  readonly at: number;
  /**
   * Whether this stage started a watch. It starts none while a watch is on, and none over an end
   * core committed that the delivery has not taken.
   */
  readonly armed: boolean;
  /**
   * The watch now on the pull request when it is Factory's: a Factory watch command started it,
   * or the delivery already holds it. Null otherwise.
   */
  readonly held: string | null;
}

/**
 * The thread a delivery's pull request is linked to, where core's watch wakes it with feedback and
 * a follow-through round's turns go: a single item's author thread, or a parent's last child's
 * author thread, as its PR stage reported it. None for a child, whose parent's pull request
 * carries its work, nor for a parent before its PR stage reported one.
 */
export const followedThread = (delivery: FactoryDeliveryState): ThreadId | undefined => {
  switch (delivery.kind) {
    case "single":
      return delivery.threads.author;
    case "parent":
      return delivery.pullRequestThread;
    case "child":
      return undefined;
  }
};

/** The wake runs the delivery took as its own; see `FactoryFollowThrough.runs`. */
export const adoptedRuns = (delivery: FactoryDeliveryState): ReadonlyArray<RunId> =>
  delivery.followThrough?.runs ?? [];

/**
 * What a resume of a stopped or blocked delivery found, read under the delivery's lock right
 * before the engine decides where it picks up.
 */
export interface FactoryResumeCheck {
  /**
   * Threads the delivery recorded that have been deleted since, a parent's `pullRequestThread`
   * included, and the thread of an author or planner launch it never recorded (see
   * `unrecordedAuthorLaunch`) when that was deleted.
   */
  readonly deletedThreads: ReadonlyArray<ThreadId>;
  /** Whether the run of an author launch the delivery never recorded has already ended. */
  readonly unrecordedAuthorRunEnded: boolean;
  /**
   * Whether the run of a parent's planner launch it never recorded (see
   * `unrecordedPlannerLaunch`) has already ended; absent when it has none.
   */
  readonly unrecordedPlannerRunEnded?: boolean;
  /**
   * The worktree once the author has launched, or once a parent recorded the thread its pull
   * request is linked to; null before.
   */
  readonly worktree: {
    readonly settle: FactorySettleResult;
    /** HEAD and its tree; null when they could not be read. */
    readonly commit: FactoryCommit | null;
    /** The commit the delivery's task was last approved for (its `lastReviewedSha`). */
    readonly approvedSha: string | null;
  } | null;
}

/**
 * What the engine folds in. The worker's results name the effect they answer by `effectId`;
 * the reactor's run and thread events name the thread and run they observed.
 */
export type FactoryEvent =
  /**
   * Starts a queued delivery. A parent starts its child with the child's task baseline: where the
   * parent's branch started for its first child, the commit the previous task was approved for
   * after that.
   */
  | { readonly type: "start"; readonly baseline?: string }
  /**
   * The owner's stop after the current step: a running delivery becomes `stopping`, finishes the
   * work of its stage and stops where it would begin the next one.
   */
  | { readonly type: "stop" }
  /**
   * The owner's resume: a stopping delivery runs on (`check` is null, nothing was read); a stopped
   * or blocked one picks up from its checkpoint with what `check` found.
   */
  | { readonly type: "resume"; readonly check: FactoryResumeCheck | null }
  /** The owner's cancel: the delivery ends, whatever it awaits. */
  | { readonly type: "cancel" }
  /**
   * The owner's edit of the plan the delivery waits on at the plan gate, judged before it is
   * stepped: these tasks replace the plan's, and the delivery waits on.
   */
  | { readonly type: "plan.updated"; readonly tasks: ReadonlyArray<FactoryPlanTask> }
  /**
   * The owner's approval of the plan at the gate, judged before it is stepped: the plan is frozen
   * and the parent creates its children.
   */
  | { readonly type: "plan.approved" }
  /** The owner's rejection of the plan at the gate: the delivery ends cancelled. */
  | { readonly type: "plan.rejected" }
  /**
   * The owner's replan at the gate: the planner gets the note in a new plan round, and the next
   * accepted plan waits at the gate in place of this one.
   */
  | { readonly type: "plan.replanned"; readonly note: string }
  /**
   * A `launch_thread` result; `baseline` is HEAD before the thread's first turn. `worktreePath`
   * is null when the launch ended the run before a new worktree was recorded.
   */
  | {
      readonly type: "thread.launched";
      readonly effectId: number;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly worktreePath: string | null;
      readonly baseline: string;
    }
  /**
   * A `send_fix_commit_turn`, `send_plan_retry_turn`, `send_replan_turn`,
   * `send_review_retry_turn`, `send_repair_turn` or `send_review_follow_up_turn` result: the run
   * that turn started on the effect's thread.
   */
  | { readonly type: "turn.started"; readonly effectId: number; readonly runId: RunId }
  | {
      readonly type: "run.finished";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly status: FactoryTerminalRunStatus;
    }
  | { readonly type: "thread.deleted"; readonly threadId: ThreadId }
  /** A `check_settle` result. */
  | {
      readonly type: "settle.checked";
      readonly effectId: number;
      readonly result: FactorySettleResult;
    }
  /** A `run_command` result. */
  | {
      readonly type: "command.finished";
      readonly effectId: number;
      readonly outcome: FactoryCommandOutcome;
    }
  /**
   * A planner's `factory_submit_plan` call, judged while its run is going. It names the plan round
   * and the planner run it was made in.
   */
  | {
      readonly type: "plan.submitted";
      readonly round: number;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly judgment: FactoryPlanJudgment;
    }
  /** A `read_fallback_plan` result. */
  | {
      readonly type: "plan.read";
      readonly effectId: number;
      readonly judgment: FactoryPlanJudgment;
    }
  /**
   * A reviewer's `factory_submit_review` call, judged while its run is going. It names the round
   * and the reviewer run it was made in.
   */
  | {
      readonly type: "review.submitted";
      readonly round: number;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly judgment: FactoryReviewJudgment;
    }
  /** A `read_fallback_review` result. */
  | {
      readonly type: "review.read";
      readonly effectId: number;
      readonly judgment: FactoryReviewJudgment;
    }
  /** A `record_approval` result. */
  | {
      readonly type: "approval.recorded";
      readonly effectId: number;
      readonly outcome: FactoryRecordOutcome;
    }
  /**
   * An `open_pr` result. `pullRequestThread` is the thread a parent's pull request is linked to,
   * its last child's author's; a single item's is its author's. `watch` is what the worker found
   * and did about the watch on the pull request there (see `FactoryWatchState`); absent when it
   * watches none. `watchFailure` is set instead when the watch could not start: the pull request
   * is published all the same, so it is recorded; the text is bounded and safe to show.
   */
  | {
      readonly type: "pr.opened";
      readonly effectId: number;
      readonly pullRequest: FactoryOpenedPullRequest;
      readonly pullRequestThread?: ThreadId;
      readonly watch?: FactoryWatchState;
      readonly watchFailure?: string;
    }
  /**
   * Factory's watch on pull request `number`/`url`, which started at `startedAt`, ended at
   * event-log position `at`, its first watch command being at `firstAt`, as a release of the
   * watch found. Taken in any status: a cancelled delivery then knows which wakes its watch sent,
   * even when its PR stage's result was lost before the pull request was recorded. `threadId` is
   * the thread that watch was on, which a parent whose PR stage result was lost never recorded
   * (see `pullRequestThread`); the release reads it from Factory's watch command.
   */
  | {
      readonly type: "watch.ended";
      readonly startedAt: string;
      readonly at: number;
      readonly firstAt: number;
      readonly number: number;
      readonly url: string;
      readonly threadId?: ThreadId;
    }
  /** The release of Factory's watch is done: it was ended, or found gone or someone else's. */
  | { readonly type: "watch.released" }
  /**
   * A pull request watch's wake, as core queued it on the thread a delivery's pull request is
   * linked to: the wake's run, what it reports, the pull request it reports on by number and URL,
   * the event-log position of the run's creation, the watch that sent it (null for the end that
   * removed it) and the position of the link update its command made.
   */
  | {
      readonly type: "pr.feedback";
      readonly kind: FactoryWakeKind;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly number: number;
      readonly url: string;
      readonly sequence: number;
      readonly watchStartedAt: string | null;
      readonly linkSequence: number;
    }
  /**
   * A pull request left `open`, as core's pull request sync stored it on the thread the delivery's
   * pull request is linked to; it names that pull request by number and URL.
   */
  | {
      readonly type: "pr.merged" | "pr.closed";
      readonly number: number;
      readonly url: string;
    }
  /** A `close_out` result: the items are done and the worktree is removed, or kept. */
  | { readonly type: "closed_out"; readonly effectId: number }
  /** A merged parent's close-out finished: its approved child is done with it. */
  | { readonly type: "parent.done" }
  /** A `create_children` result: the child deliveries, in plan order. */
  | {
      readonly type: "children.created";
      readonly effectId: number;
      readonly children: ReadonlyArray<FactoryDeliveryId>;
    }
  /**
   * A `start_child` result: the child runs, or ran before. For the parent's first child, its
   * baseline, which is where the parent's branch started.
   */
  | { readonly type: "child.started"; readonly effectId: number; readonly baseline?: string }
  /** A parent's child reports that it ended approved at record. */
  | { readonly type: "child.approved"; readonly deliveryId: FactoryDeliveryId }
  /** The worker could not carry out the effect; `detail` is bounded and safe to show. */
  | { readonly type: "effect.failed"; readonly effectId: number; readonly detail: string };

/** The events the reactor observes on a thread; they name the thread, not the delivery. */
export type FactoryThreadEvent = Extract<
  FactoryEvent,
  { readonly type: "run.finished" | "thread.deleted" }
>;

export type FactoryBlock =
  /** The awaited run ended without completing. */
  | {
      readonly reason: "run_ended";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runStatus: Exclude<FactoryTerminalRunStatus, "completed">;
    }
  | { readonly reason: "thread_deleted"; readonly threadId: ThreadId }
  | { readonly reason: "effect_failed"; readonly effect: FactoryEffect; readonly detail: string }
  | { readonly reason: "unsettled"; readonly problems: ReadonlyArray<string> }
  /**
   * The command ran and failed or timed out with no fix round left, or in a parent's integrate,
   * which has none; its receipt is the last in `receipts`.
   */
  | { readonly reason: "verify_failed" }
  /** The stage failed exactly as it failed before on this task: same failure, same tree. */
  | { readonly reason: "repeated_failure"; readonly stage: FactoryRepairedStage }
  | { readonly reason: "receipt_refused"; readonly refusals: ReadonlyArray<FactoryReceiptRefusal> }
  /** The pipeline reached a stage kind this server cannot run. */
  | { readonly reason: "unsupported_stage"; readonly stage: FactoryStageName }
  /**
   * The round's accepted review blocks the commit with no review round left, or a parent's
   * integrate review blocks its branch, which has none; its full text is in its evidence.
   */
  | { readonly reason: "review_changes_required"; readonly summary: FactoryReviewSummary }
  /** A review was submitted after HEAD moved from the verified receipt or the tree got dirty. */
  | { readonly reason: "code_changed"; readonly changes: ReadonlyArray<FactoryReceiptRefusal> }
  /**
   * The plan or review submission after the one corrected retry was invalid too; these are its
   * problems.
   */
  | { readonly reason: "invalid_submission"; readonly problems: ReadonlyArray<string> }
  /** The round's accepted plan has no tasks: planning ended with the planner's note, if any. */
  | { readonly reason: "plan_empty"; readonly note: string | null }
  /** Core's watch of the open pull request ended, so its feedback no longer reaches Factory. */
  | { readonly reason: "watch_ended" }
  /** At record, the worktree no longer held the verified, reviewed commit on a clean tree. */
  | {
      readonly reason: "record_mismatch";
      readonly expected: FactoryCommit;
      readonly actual: FactoryCommit & { readonly clean: boolean };
      readonly differences: ReadonlyArray<FactoryRecordDifference>;
    };

/** How many repair rounds of each kind a task may spend. */
export interface FactoryRoundLimits {
  readonly maxFixRounds: number;
  readonly maxReviewRounds: number;
}

/**
 * The project settings' default limits, for a delivery stored without its own. A literal, since
 * the engine imports only types; `engine.repair.test.ts` holds it to the settings schema's.
 */
export const defaultRoundLimits: FactoryRoundLimits = { maxFixRounds: 2, maxReviewRounds: 2 };

/**
 * A single item is its delivery's one task. A parent first plans its tasks, which wait at the
 * plan gate for the owner's approval; each approved task becomes a child, which runs like a single
 * item on the parent's branch and worktree but ends approved at record, since the parent's one
 * pull request carries its work.
 */
export type FactoryDeliveryKind = "single" | "parent" | "child";

export interface FactoryDeliveryState {
  readonly kind: FactoryDeliveryKind;
  readonly status: FactoryDeliveryStatus;
  /** Null until the delivery starts; afterwards the current (or last) stage. */
  readonly stage: FactoryStageName | null;
  readonly branch: string;
  readonly baseRef: string;
  /** Recorded by the first thread launch, or set at creation to share a worktree. */
  readonly worktreePath: string | null;
  /**
   * The task baseline; settle checks require it to be an ancestor of HEAD and judge only the
   * commits after it. Set once: HEAD before a single item's author's first turn, where a parent's
   * planner launch created its branch (or, for a parent stored before planner launches recorded
   * it, the start of a child it takes, before it takes any child's approval), or a child's,
   * assigned by its parent at its start.
   */
  readonly baseline: string | null;
  /** The latest thread of each role. */
  readonly threads: Partial<Readonly<Record<FactoryRole, ThreadId>>>;
  /**
   * The current task's author launch, recorded when it is issued. Its thread and checkout derive
   * from its id, so a launch whose result was lost can be found again, whatever happened after.
   */
  readonly authorLaunch: FactoryLaunchEffect | null;
  /** A parent's planner launch, recorded when it is issued, for the reason `authorLaunch` is. */
  readonly plannerLaunch: FactoryLaunchEffect | null;
  readonly awaiting: FactoryAwaiting | null;
  /** Fix-commit turns spent on the current task's settle problems since it started or resumed. */
  readonly fixCommitTurns: number;
  /** Effects issued so far; the next effect's id is one more. */
  readonly effectsIssued: number;
  readonly receipts: ReadonlyArray<FactoryVerifyReceipt>;
  /** The current (or last) review round, from 1; 0 before the first review. */
  readonly reviewRound: number;
  /**
   * Invalid submissions in the current plan or review round; the first earns one corrected retry.
   */
  readonly invalidSubmissions: number;
  /** Accepted reviews, oldest first; at most one per round. */
  readonly reviews: ReadonlyArray<FactoryAcceptedReview>;
  /** The project's limits when the delivery started, so a settings change never moves a loop. */
  readonly limits: FactoryRoundLimits;
  /** The task's risk; a single item's is normal. Turns of a high-risk task escalate effort. */
  readonly risk: FactoryTaskRisk;
  /**
   * The broadest runtime mode the delivery's threads launch with, set by whoever started it: each
   * launch takes the narrower of this and the project's default at that moment. Absent when the
   * start set none; its threads then launch with the project's default.
   */
  readonly runtimeModeCeiling?: RuntimeMode;
  /**
   * Repair rounds spent on the current task since it started or resumed: fix-verify turns
   * (`fix`), fix-review turns (`review`).
   */
  readonly rounds: { readonly fix: number; readonly review: number };
  /**
   * Failure fingerprints of the current task's failed verifies and blocking reviews since it
   * started or resumed, oldest first.
   */
  readonly fingerprints: ReadonlyArray<string>;
  /** The author's latest fix-review run; the next review round reads its reply as claims. */
  readonly reviewResponse: { readonly threadId: ThreadId; readonly runId: RunId } | null;
  /** A parent's current (or last) plan round, from 1; 0 before planning, and for a single item. */
  readonly planRound: number;
  /**
   * The latest accepted plan, at most one per plan round. A parent waiting at `approve_plan`
   * waits on this one's tasks.
   */
  readonly plan: FactoryAcceptedPlan | null;
  /** Set once the owner approves a parent's plan, which freezes it as its tasks. */
  readonly planApproved: boolean;
  /** A parent's child deliveries in plan order, once they are created; none before. */
  readonly children: ReadonlyArray<FactoryDeliveryId>;
  /**
   * The children that reported their approval, in the order they did. A parent starts the first
   * of its children not among them, one at a time.
   */
  readonly approvedChildren: ReadonlyArray<FactoryDeliveryId>;
  /** Set once the PR stage has opened the delivery's pull request. */
  readonly pullRequest: FactoryOpenedPullRequest | null;
  /**
   * A parent's: the thread its PR stage linked its pull request to, its last child's author's.
   * It has no author thread of its own, so its pull request's feedback wakes there, and its
   * follow-through rounds' turns go there. Absent until the PR stage reports it, or a cancel's
   * release finds it in the PR stage's watch command when that stage's result was lost; for single
   * items (theirs is their author's) and children; and for parents stored before it was recorded.
   */
  readonly pullRequestThread?: ThreadId;
  /**
   * Set once the PR stage has started a watch on the pull request; absent before, for children,
   * and for deliveries whose pull request opened before follow-through rounds existed, whose
   * feedback nothing adopts.
   */
  readonly followThrough?: FactoryFollowThrough;
  /**
   * Set by a cancel while the watch a Factory watch command started may still be on, to wake the
   * followed thread to new work: the worker ends it and takes the wakes it sent, then clears this;
   * the boot sweep finishes it when a stop came first.
   */
  readonly releaseWatch?: true;
  /** Set while the delivery is blocked. */
  readonly block: FactoryBlock | null;
  /**
   * Set while the delivery is stopped, and kept when a resume blocks it before it moved on: the
   * stage it would have begun when it stopped, where a resume picks up. Null for deliveries a
   * server stopped before checkpoints were recorded.
   */
  readonly checkpoint: FactoryStageName | null;
}

/**
 * Whether the delivery runs its stages: `running`, or `stopping`, which the owner asked to stop
 * after its step. A stopping delivery takes every event a running one does and stops only where it
 * would begin its next stage.
 */
export const runsStages = (delivery: FactoryDeliveryState) =>
  delivery.status === "running" || delivery.status === "stopping";

/**
 * Whether the server moves the delivery on by itself: while it runs its stages, once approved,
 * while it opens its pull request, and with it open, while it closes out its merge. A delivery in
 * any other status waits for its owner (or, with its pull request open, for the pull request), so
 * no worker result is coming for an effect it still names. An approved child has nothing left to
 * run: its parent's pull request carries its work.
 */
export const isProceeding = (delivery: FactoryDeliveryState) =>
  runsStages(delivery) ||
  (delivery.status === "approved" && delivery.kind !== "child") ||
  (delivery.status === "pr_open" && delivery.awaiting !== null);

/** Done and cancelled deliveries never change again. */
export const isTerminal = (delivery: FactoryDeliveryState) =>
  delivery.status === "done" || delivery.status === "cancelled";

/** The result of one engine step: the new state and the effects to carry out, in order. */
export interface FactoryAdvance {
  readonly delivery: FactoryDeliveryState;
  readonly effects: ReadonlyArray<FactoryEffect>;
}

/** Issues one effect: numbers it and makes the delivery await its result. */
export const issue = (
  delivery: FactoryDeliveryState,
  request: FactoryEffectRequest,
): FactoryAdvance => {
  const effect = { ...request, id: delivery.effectsIssued + 1 };
  return {
    delivery: { ...delivery, effectsIssued: effect.id, awaiting: { type: "effect", effect } },
    effects: [effect],
  };
};

/** Blocks the delivery for `block`: it awaits nothing until its owner acts. */
export const blocked = (delivery: FactoryDeliveryState, block: FactoryBlock): FactoryAdvance => ({
  delivery: { ...delivery, status: "blocked", awaiting: null, block },
  effects: [],
});

export const queuedDeliveryState = (input: {
  /** Single when absent. */
  readonly kind?: FactoryDeliveryKind;
  readonly branch: string;
  readonly baseRef: string;
  readonly worktreePath?: string;
  /** The project's limits; the settings defaults when absent. */
  readonly limits?: FactoryRoundLimits;
  readonly risk?: FactoryTaskRisk;
  readonly runtimeModeCeiling?: RuntimeMode;
}): FactoryDeliveryState => ({
  kind: input.kind ?? "single",
  status: "queued",
  stage: null,
  branch: input.branch,
  baseRef: input.baseRef,
  worktreePath: input.worktreePath ?? null,
  baseline: null,
  threads: {},
  authorLaunch: null,
  plannerLaunch: null,
  awaiting: null,
  fixCommitTurns: 0,
  effectsIssued: 0,
  receipts: [],
  reviewRound: 0,
  invalidSubmissions: 0,
  reviews: [],
  limits: input.limits ?? defaultRoundLimits,
  risk: input.risk ?? "normal",
  ...(input.runtimeModeCeiling === undefined
    ? {}
    : { runtimeModeCeiling: input.runtimeModeCeiling }),
  rounds: { fix: 0, review: 0 },
  fingerprints: [],
  reviewResponse: null,
  planRound: 0,
  plan: null,
  planApproved: false,
  children: [],
  approvedChildren: [],
  pullRequest: null,
  block: null,
  checkpoint: null,
});

/**
 * The author launch of a delivery that has issued one but never recorded its result. A launch can
 * go through and its result still be lost (a failed read, a restart), so this is no proof that
 * nothing ran: launches derive their thread, command and message ids from the effect's id, and
 * issuing it again replays a launch that went through rather than starting a second author on
 * the branch it created. Rows stored before launches were recorded name it only in their block.
 */
export const unrecordedAuthorLaunch = (
  delivery: FactoryDeliveryState,
): FactoryLaunchEffect | undefined => {
  if (delivery.threads.author !== undefined) return undefined;
  if (delivery.authorLaunch !== null) return delivery.authorLaunch;
  const { block } = delivery;
  return block?.reason === "effect_failed" &&
    block.effect.type === "launch_thread" &&
    block.effect.role === "author"
    ? block.effect
    : undefined;
};

/**
 * A parent's planner launch that it issued but never recorded; see `unrecordedAuthorLaunch`.
 * Planner launches were recorded from the first parent delivery on, so no block names one alone.
 */
export const unrecordedPlannerLaunch = (
  delivery: FactoryDeliveryState,
): FactoryLaunchEffect | undefined =>
  delivery.threads.planner === undefined ? (delivery.plannerLaunch ?? undefined) : undefined;

/** The accepted plan of the current plan round, once there is one. */
export const acceptedPlan = (delivery: FactoryDeliveryState) => {
  const { plan } = delivery;
  return plan !== null && plan.round === delivery.planRound ? plan : undefined;
};

/**
 * The plan a parent waits on at the plan gate for its owner: the current round's accepted plan,
 * which has tasks, from its planner thread. Undefined for a delivery in any other state, which
 * takes no plan action.
 */
export const planAtGate = (delivery: FactoryDeliveryState) => {
  if (delivery.status !== "waiting" || delivery.stage !== "approve_plan") return undefined;
  const plan = acceptedPlan(delivery);
  return plan !== undefined && plan.tasks.length > 0 && delivery.threads.planner !== undefined
    ? plan
    : undefined;
};

/** The first of a parent's children that has not reported its approval; none once every one has. */
export const nextChild = (delivery: FactoryDeliveryState) =>
  delivery.children.find((child) => !delivery.approvedChildren.includes(child));

/** The accepted review of the current round, once there is one. */
export const acceptedReview = (delivery: FactoryDeliveryState) => {
  const last = delivery.reviews.at(-1);
  return last !== undefined && last.round === delivery.reviewRound ? last : undefined;
};
