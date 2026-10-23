import type { OrchestrationV2RunStatus, RunId, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDeliveryStatus,
  FactoryRole,
  FactoryStageName,
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

/** Where a launched thread works. */
export type FactoryWorkspace =
  /** A new worktree that creates the delivery branch from `baseRef`. */
  | { readonly type: "worktree"; readonly branch: string; readonly baseRef: string }
  | { readonly type: "existing_worktree"; readonly worktreePath: string };

/** What the delivery waits for. Only an event that answers it advances the delivery. */
export type FactoryAwaiting =
  | { readonly type: "launch"; readonly role: FactoryRole }
  | { readonly type: "turn"; readonly threadId: ThreadId }
  | { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId }
  | { readonly type: "settle"; readonly threadId: ThreadId; readonly runId: RunId }
  | { readonly type: "command"; readonly attempt: number };

/**
 * Work the worker carries out after the new state is stored. Effects that need the worktree,
 * branch or baseline read them from the delivery they came with.
 */
export type FactoryEffect =
  /** Launch a new thread for the role, starting its first turn with the role's prompt. */
  | {
      readonly type: "launch_thread";
      readonly role: FactoryRole;
      readonly workspace: FactoryWorkspace;
    }
  /** One mechanical `fix-commit` follow-up turn asking the thread to repair these problems. */
  | {
      readonly type: "send_fix_commit_turn";
      readonly threadId: ThreadId;
      readonly problems: ReadonlyArray<string>;
    }
  /** Read the branch after this run and evaluate the settle rules. */
  | { readonly type: "check_settle"; readonly threadId: ThreadId; readonly runId: RunId }
  /** Run the stage's project command in the worktree; `attempt` numbers the run. */
  | { readonly type: "run_command"; readonly stage: FactoryStageName; readonly attempt: number };

/**
 * A settle evaluation. Repairable problems get one fix-commit turn; unrepairable ones (an AI
 * identity on a commit, a worktree that cannot be read) block at once.
 */
export type FactorySettleResult =
  | { readonly status: "settled" }
  | { readonly status: "repairable"; readonly problems: ReadonlyArray<string> }
  | { readonly status: "unrepairable"; readonly problems: ReadonlyArray<string> };

/** Why the server refused to accept a command run as a receipt. */
export type FactoryReceiptRefusal = "head_changed" | "tree_dirty";

export type FactoryCommandOutcome =
  | { readonly type: "receipt"; readonly receipt: FactoryVerifyReceipt }
  | { readonly type: "refused"; readonly refusals: ReadonlyArray<FactoryReceiptRefusal> };

export type FactoryEvent =
  | { readonly type: "start" }
  /** The worker launched the awaited thread; `baseline` is HEAD before its first turn. */
  | {
      readonly type: "thread.launched";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly worktreePath: string;
      readonly baseline: string;
    }
  /** The worker queued the awaited follow-up turn. */
  | { readonly type: "turn.started"; readonly threadId: ThreadId; readonly runId: RunId }
  | {
      readonly type: "run.finished";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly status: FactoryTerminalRunStatus;
    }
  | { readonly type: "thread.deleted"; readonly threadId: ThreadId }
  | {
      readonly type: "settle.checked";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly result: FactorySettleResult;
    }
  | {
      readonly type: "command.finished";
      readonly stage: FactoryStageName;
      readonly attempt: number;
      readonly outcome: FactoryCommandOutcome;
    }
  /** The worker could not carry out the awaited effect; `detail` is bounded and safe to show. */
  | {
      readonly type: "effect.failed";
      readonly effect: FactoryEffect["type"];
      readonly detail: string;
    };

export type FactoryBlock =
  /** The awaited run ended without completing. */
  | {
      readonly reason: "run_ended";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runStatus: Exclude<FactoryTerminalRunStatus, "completed">;
    }
  | { readonly reason: "thread_deleted"; readonly threadId: ThreadId }
  | {
      readonly reason: "effect_failed";
      readonly effect: FactoryEffect["type"];
      readonly detail: string;
    }
  | { readonly reason: "unsettled"; readonly problems: ReadonlyArray<string> }
  /** The command ran and failed or timed out; its receipt is the last in `receipts`. */
  | { readonly reason: "verify_failed" }
  | { readonly reason: "receipt_refused"; readonly refusals: ReadonlyArray<FactoryReceiptRefusal> }
  /** The pipeline reached a stage kind this server cannot run. */
  | { readonly reason: "unsupported_stage"; readonly stage: FactoryStageName };

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
  readonly awaiting: FactoryAwaiting | null;
  /** Fix-commit turns spent on the current task's settle problems. */
  readonly fixCommitTurns: number;
  /** Command runs begun, so each result names the run it answers. */
  readonly commandRuns: number;
  readonly receipts: ReadonlyArray<FactoryVerifyReceipt>;
  /** Set while the delivery is blocked. */
  readonly block: FactoryBlock | null;
}

/** The result of one engine step: the new state and the effects to carry out, in order. */
export interface FactoryAdvance {
  readonly delivery: FactoryDeliveryState;
  readonly effects: ReadonlyArray<FactoryEffect>;
}

export const queuedDeliveryState = (input: {
  readonly branch: string;
  readonly baseRef: string;
  readonly worktreePath?: string;
}): FactoryDeliveryState => ({
  status: "queued",
  stage: null,
  branch: input.branch,
  baseRef: input.baseRef,
  worktreePath: input.worktreePath ?? null,
  baseline: null,
  threads: {},
  awaiting: null,
  fixCommitTurns: 0,
  commandRuns: 0,
  receipts: [],
  block: null,
});
