import type { ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  type FactoryDelivery,
  type FactoryStageKind,
  type FactoryStageName,
  type FactoryStageRunSummary,
  type FactoryVerifyReceipt,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";

import type { FactoryDeliveryWithRuns } from "./FactoryService.ts";
import type { StoredFactoryStageRun } from "./persistence/FactoryStageRunStore.ts";
import { standardStages } from "./pipeline/definitions.ts";
import type {
  FactoryBlock,
  FactoryDeliveryState,
  FactoryReceiptRefusal,
  FactoryRecordDifference,
} from "./pipeline/state.ts";

/** Repair is a turn on the author thread, so it runs as an agent stage. */
const stageKind = (stage: FactoryStageName): FactoryStageKind =>
  stage === "repair" ? "agent" : standardStages[stage].kind;

/** A receipt without its command, log path, output hash or settings hash. */
const receiptSummary = (receipt: FactoryVerifyReceipt): FactoryVerifyReceiptSummary => ({
  headSha: receipt.headSha,
  tree: receipt.tree,
  startedAt: receipt.startedAt,
  finishedAt: receipt.finishedAt,
  code: receipt.code,
  timedOut: receipt.timedOut,
  durationMs: receipt.durationMs,
});

/** An attempt without its run id, evidence path or failure fingerprint. */
const stageRunSummary = (run: StoredFactoryStageRun): FactoryStageRunSummary => ({
  stage: run.stage,
  attempt: run.attempt,
  outcome: run.outcome,
  ...(run.threadId === null ? {} : { threadId: run.threadId }),
  startedAt: run.startedAt,
  ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
});

const NEEDS_YOU_MAX_LENGTH = 280;

const RUN_ENDINGS = {
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
  rolled_back: "was rolled back",
} as const;

const CHECKOUT_CHANGES: Readonly<Record<FactoryReceiptRefusal, string>> = {
  head_changed: "HEAD moved",
  tree_dirty: "the worktree has uncommitted changes",
};

const RECORD_DIFFERENCES: Readonly<Record<FactoryRecordDifference, string>> = {
  head_changed: "HEAD is not the verified commit",
  tree_changed: "HEAD's tree is not the verified tree",
  not_reviewed: "HEAD is not the reviewed commit",
  tree_dirty: "the worktree has uncommitted changes",
};

/** "a", "a and b", "a, b and c". */
const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The first problem and how many more; each is a bounded description built from facts. */
const firstProblem = (lead: string, problems: ReadonlyArray<string>) => {
  const [first] = problems;
  if (first === undefined) return `${lead}.`;
  const head = `${lead}: ${first.replace(/\.$/, "")}`;
  return problems.length === 1 ? `${head}.` : `${head}, and ${problems.length - 1} more.`;
};

const threadLabel = (state: FactoryDeliveryState, threadId: ThreadId) => {
  const role = (["author", "reviewer", "planner"] as const).find(
    (candidate) => state.threads[candidate] === threadId,
  );
  return role === undefined ? "A delivery thread" : `The ${role} thread`;
};

/**
 * Why a blocked delivery waits on its owner, as one sentence: fixed text and the block's bounded
 * facts (roles, statuses, counts, settle and validation problems), never a log, a log path or a
 * cause. Effect failure details are the worker's fixed text already.
 */
const blockReason = (state: FactoryDeliveryState, block: FactoryBlock): string => {
  switch (block.reason) {
    case "run_ended":
      return `${threadLabel(state, block.threadId)}'s run ${RUN_ENDINGS[block.runStatus]}.`;
    case "thread_deleted":
      return `${threadLabel(state, block.threadId)} was deleted.`;
    case "effect_failed":
      return block.detail;
    case "unsettled":
      return firstProblem("The branch does not settle", block.problems);
    case "verify_failed":
      return "Verify failed with no fix round left.";
    case "repeated_failure":
      return block.stage === "verify"
        ? "Verify failed the same way after a repair, so Factory stopped repairing."
        : "The review blocked on the same findings after a repair, so Factory stopped repairing.";
    case "receipt_refused":
      return block.refusals.length === 0
        ? "Factory refused the verify result."
        : `Factory refused the verify result: ${listed(block.refusals.map((refusal) => CHECKOUT_CHANGES[refusal]))}.`;
    case "unsupported_stage":
      return `This server cannot run the ${block.stage} stage.`;
    case "review_changes_required": {
      const { high, medium, low } = block.summary.findings;
      return `The review requires changes with no review round left (${high} high, ${medium} medium, ${low} low).`;
    }
    case "code_changed":
      return block.changes.length === 0
        ? "The code changed during review."
        : `The code changed during review: ${listed(block.changes.map((change) => CHECKOUT_CHANGES[change]))}.`;
    case "invalid_submission":
      return firstProblem("The reviewer's submission was invalid again", block.problems);
    case "record_mismatch":
      return `The worktree no longer holds the verified, reviewed commit: ${listed(block.differences.map((difference) => RECORD_DIFFERENCES[difference]))}.`;
  }
};

/** Why a blocked delivery waits on its owner; its Work comment on blocking says the same. */
export const needsYou = (state: FactoryDeliveryState): string | undefined => {
  if (state.status !== "blocked") return undefined;
  const reason =
    state.block === null ? "Factory blocked this delivery." : blockReason(state, state.block);
  return reason.length > NEEDS_YOU_MAX_LENGTH
    ? `${reason.slice(0, NEEDS_YOU_MAX_LENGTH - 1)}…`
    : reason;
};

/**
 * A delivery as clients see it: its progress, threads and the summaries of its receipts, reviews
 * and newest stage attempts, never their logs or evidence paths. `needsYou` is set only while it
 * is blocked.
 */
export const toFactoryDelivery = (delivery: FactoryDeliveryWithRuns): FactoryDelivery => {
  const { state } = delivery;
  const reason = needsYou(state);
  return {
    deliveryId: delivery.deliveryId,
    projectId: delivery.projectId,
    itemRef: delivery.itemRef,
    ...(delivery.parentId === null ? {} : { parentId: delivery.parentId }),
    // A single item has no children; parents arrive with planning.
    childIds: [],
    status: state.status,
    ...(state.stage === null ? {} : { stage: { name: state.stage, kind: stageKind(state.stage) } }),
    rounds: state.rounds,
    branch: state.branch,
    ...(state.worktreePath === null ? {} : { worktreePath: state.worktreePath }),
    threads: state.threads,
    receipts: state.receipts.map(receiptSummary),
    reviews: state.reviews.map((review) => review.summary),
    // Attempts are appended in start order, so the newest are the last.
    stageRuns: delivery.stageRuns.slice(-FACTORY_SNAPSHOT_STAGE_RUNS_MAX).map(stageRunSummary),
    ...(reason === undefined ? {} : { needsYou: reason }),
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
};
