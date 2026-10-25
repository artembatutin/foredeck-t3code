import type { OrchestrationV2RunStatus, RunId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDeliveryStatus,
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
  | { readonly type: "open_pr" };

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
      | "send_review_retry_turn"
      | "send_repair_turn"
      | "send_review_follow_up_turn";
  }
>;

export const isTurnEffect = (effect: FactoryEffect): effect is FactoryTurnEffect =>
  effect.type === "send_fix_commit_turn" ||
  effect.type === "send_review_retry_turn" ||
  effect.type === "send_repair_turn" ||
  effect.type === "send_review_follow_up_turn";

/**
 * What the delivery waits for: the worker's result for one issued effect, or the end of one run.
 * Only an event that answers it advances the delivery.
 */
export type FactoryAwaiting =
  | { readonly type: "effect"; readonly effect: FactoryEffect }
  | { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId };

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
}

/**
 * What a resume of a stopped or blocked delivery found, read under the delivery's lock right
 * before the engine decides where it picks up.
 */
export interface FactoryResumeCheck {
  /**
   * Threads the delivery recorded that have been deleted since, and the thread of an author
   * launch it never recorded (see `unrecordedAuthorLaunch`) when that was deleted.
   */
  readonly deletedThreads: ReadonlyArray<ThreadId>;
  /** Whether the run of an author launch the delivery never recorded has already ended. */
  readonly unrecordedAuthorRunEnded: boolean;
  /** The worktree once the author has launched; null before. */
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
  | { readonly type: "start" }
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
   * A `send_fix_commit_turn`, `send_review_retry_turn`, `send_repair_turn` or
   * `send_review_follow_up_turn` result: the run that turn started on the effect's thread.
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
  /** An `open_pr` result. */
  | {
      readonly type: "pr.opened";
      readonly effectId: number;
      readonly pullRequest: FactoryOpenedPullRequest;
    }
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
   * The command ran and failed or timed out with no fix round left; its receipt is the last in
   * `receipts`.
   */
  | { readonly reason: "verify_failed" }
  /** The stage failed exactly as it failed before on this task: same failure, same tree. */
  | { readonly reason: "repeated_failure"; readonly stage: FactoryRepairedStage }
  | { readonly reason: "receipt_refused"; readonly refusals: ReadonlyArray<FactoryReceiptRefusal> }
  /** The pipeline reached a stage kind this server cannot run. */
  | { readonly reason: "unsupported_stage"; readonly stage: FactoryStageName }
  /**
   * The round's accepted review blocks the commit with no review round left; its full text is in
   * its evidence.
   */
  | { readonly reason: "review_changes_required"; readonly summary: FactoryReviewSummary }
  /** A review was submitted after HEAD moved from the verified receipt or the tree got dirty. */
  | { readonly reason: "code_changed"; readonly changes: ReadonlyArray<FactoryReceiptRefusal> }
  /** The submission after the one corrected retry was invalid too; these are its problems. */
  | { readonly reason: "invalid_submission"; readonly problems: ReadonlyArray<string> }
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

export interface FactoryDeliveryState {
  readonly status: FactoryDeliveryStatus;
  /** Null until the delivery starts; afterwards the current (or last) stage. */
  readonly stage: FactoryStageName | null;
  readonly branch: string;
  readonly baseRef: string;
  /** Recorded by the first thread launch, or set at creation to share a worktree. */
  readonly worktreePath: string | null;
  /** HEAD before the author's first turn; settle checks require it to be an ancestor of HEAD. */
  readonly baseline: string | null;
  /** The latest thread of each role. */
  readonly threads: Partial<Readonly<Record<FactoryRole, ThreadId>>>;
  /**
   * The current task's author launch, recorded when it is issued. Its thread and checkout derive
   * from its id, so a launch whose result was lost can be found again, whatever happened after.
   */
  readonly authorLaunch: FactoryLaunchEffect | null;
  readonly awaiting: FactoryAwaiting | null;
  /** Fix-commit turns spent on the current task's settle problems since it started or resumed. */
  readonly fixCommitTurns: number;
  /** Effects issued so far; the next effect's id is one more. */
  readonly effectsIssued: number;
  readonly receipts: ReadonlyArray<FactoryVerifyReceipt>;
  /** The current (or last) review round, from 1; 0 before the first review. */
  readonly reviewRound: number;
  /** Invalid submissions in the current round; the first earns one corrected retry. */
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
  /** Set once the PR stage has opened the delivery's pull request. */
  readonly pullRequest: FactoryOpenedPullRequest | null;
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
 * Whether the server moves the delivery on by itself: while it runs its stages, and once
 * approved, while it opens its pull request. A delivery in any other status waits for its owner,
 * so no worker result is coming for an effect it still names.
 */
export const isProceeding = (delivery: FactoryDeliveryState) =>
  runsStages(delivery) || delivery.status === "approved";

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
  readonly branch: string;
  readonly baseRef: string;
  readonly worktreePath?: string;
  /** The project's limits; the settings defaults when absent. */
  readonly limits?: FactoryRoundLimits;
  readonly risk?: FactoryTaskRisk;
  readonly runtimeModeCeiling?: RuntimeMode;
}): FactoryDeliveryState => ({
  status: "queued",
  stage: null,
  branch: input.branch,
  baseRef: input.baseRef,
  worktreePath: input.worktreePath ?? null,
  baseline: null,
  threads: {},
  authorLaunch: null,
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

/** The accepted review of the current round, once there is one. */
export const acceptedReview = (delivery: FactoryDeliveryState) => {
  const last = delivery.reviews.at(-1);
  return last !== undefined && last.round === delivery.reviewRound ? last : undefined;
};
