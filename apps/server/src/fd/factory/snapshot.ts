import type { ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  type FactoryDelivery,
  type FactoryPlan,
  type FactoryReviewSummary,
  type FactoryStageKind,
  type FactoryStageName,
  type FactoryStageRunSummary,
  type FactoryVerifyReceipt,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";

import type { FactoryDeliveryWithRuns } from "./FactoryService.ts";
import type { StoredFactoryStageRun } from "./persistence/FactoryStageRunStore.ts";
import { standardStages } from "./pipeline/definitions.ts";
import { acceptedPlan } from "./pipeline/state.ts";
import type {
  FactoryAcceptedPlan,
  FactoryAcceptedReview,
  FactoryBlock,
  FactoryDeliveryState,
  FactoryReceiptRefusal,
  FactoryRecordDifference,
} from "./pipeline/state.ts";

/** Repair is a turn on the author thread, so it runs as an agent stage. */
const stageKind = (stage: FactoryStageName): FactoryStageKind =>
  stage === "repair" ? "agent" : standardStages[stage].kind;

// `FactoryEvidence` names a numbered run's files `<prefix>-<n>.<extension>`: a receipt's log and
// JSON share their verify run's number, and an accepted review's JSON has a number of its own.
const RECEIPT_LOG = /(?:^|[\\/])verify-(\d+)\.log$/;
const RECEIPT_JSON = /(?:^|[\\/])verify-(\d+)\.json$/;
const REVIEW_JSON = /(?:^|[\\/])review-(\d+)\.json$/;

/** The run number of an evidence file named as `file` matches; undefined for any other file. */
const evidenceNumber = (path: string | null, file: RegExp): number | undefined => {
  const digits = path === null ? undefined : file.exec(path)?.[1];
  if (digits === undefined) return undefined;
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** A receipt without its command, log path, output hash or settings hash, numbered by its log. */
const receiptSummary = (receipt: FactoryVerifyReceipt): FactoryVerifyReceiptSummary => {
  const number = evidenceNumber(receipt.logPath, RECEIPT_LOG);
  return {
    headSha: receipt.headSha,
    tree: receipt.tree,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    code: receipt.code,
    timedOut: receipt.timedOut,
    durationMs: receipt.durationMs,
    ...(number === undefined ? {} : { number }),
  };
};

/** An accepted review's summary, numbered by its evidence, with the details kept for it. */
const reviewSummary = (review: FactoryAcceptedReview): FactoryReviewSummary => {
  const number = evidenceNumber(review.evidencePath, REVIEW_JSON);
  return {
    ...review.summary,
    ...(number === undefined ? {} : { number }),
    ...(review.details === undefined ? {} : { details: review.details }),
  };
};

/** A recorded plan's tasks and note, without its round, source or evidence path. */
const planSnapshot = ({ tasks, note }: FactoryAcceptedPlan): FactoryPlan => ({
  tasks,
  ...(note === undefined ? {} : { note }),
});

/** The numbers of the receipts and reviews a snapshot carries. */
interface SnapshotEvidence {
  readonly receipts: ReadonlySet<number>;
  readonly reviews: ReadonlySet<number>;
}

const numbersOf = (summaries: ReadonlyArray<{ readonly number?: number }>) =>
  new Set(summaries.flatMap(({ number }) => (number === undefined ? [] : [number])));

/**
 * An attempt without its run id, evidence path or failure fingerprint. It names the receipt or
 * review its recorded evidence is, when the snapshot carries that one: a verify attempt records
 * its receipt's JSON and a review attempt the review it accepted, while a refused run's log, an
 * approval or no evidence at all names nothing.
 */
const stageRunSummary = (
  run: StoredFactoryStageRun,
  evidence: SnapshotEvidence,
): FactoryStageRunSummary => {
  const receiptNumber = evidenceNumber(run.evidencePath, RECEIPT_JSON);
  const reviewNumber = evidenceNumber(run.evidencePath, REVIEW_JSON);
  return {
    stage: run.stage,
    attempt: run.attempt,
    outcome: run.outcome,
    ...(run.threadId === null ? {} : { threadId: run.threadId }),
    startedAt: run.startedAt,
    ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
    ...(receiptNumber !== undefined && evidence.receipts.has(receiptNumber)
      ? { receiptNumber }
      : {}),
    ...(reviewNumber !== undefined && evidence.reviews.has(reviewNumber) ? { reviewNumber } : {}),
  };
};

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
 * facts (roles, statuses, counts, settle and validation problems, an empty plan's note), never a
 * log, a log path or a cause. Effect failure details are the worker's fixed text already.
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
      // A parent verifies only in integrate, which has no fix round.
      return state.kind === "parent"
        ? "Verify of the whole branch failed."
        : "Verify failed with no fix round left.";
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
      const counts = `(${high} high, ${medium} medium, ${low} low)`;
      return state.kind === "parent"
        ? `The review of the whole branch requires changes ${counts}.`
        : `The review requires changes with no review round left ${counts}.`;
    }
    case "code_changed":
      return block.changes.length === 0
        ? "The code changed during review."
        : `The code changed during review: ${listed(block.changes.map((change) => CHECKOUT_CHANGES[change]))}.`;
    case "invalid_submission":
      return firstProblem(
        state.stage === "plan"
          ? "The planner's plan was invalid again"
          : "The reviewer's submission was invalid again",
        block.problems,
      );
    case "plan_empty":
      // The note's lines run together: needsYou is one sentence.
      return block.note === null
        ? "The planner found nothing to plan."
        : `The planner found nothing to plan: ${block.note.replace(/\s+/g, " ")}`;
    case "record_mismatch":
      return `The worktree no longer holds the verified, reviewed commit: ${listed(block.differences.map((difference) => RECORD_DIFFERENCES[difference]))}.`;
  }
};

/** What a delivery waiting at a gate waits on its owner for. */
const gateReason = (state: FactoryDeliveryState): string => {
  const count = state.plan?.tasks.length ?? 0;
  return count === 0
    ? "A plan awaits your approval."
    : `A plan of ${count} ${count === 1 ? "task" : "tasks"} awaits your approval.`;
};

/**
 * Why a delivery waits on its owner, at the plan gate or blocked; a blocked delivery's Work comment
 * on blocking says the same.
 */
export const needsYou = (state: FactoryDeliveryState): string | undefined => {
  if (state.status !== "blocked" && state.status !== "waiting") return undefined;
  const reason =
    state.status === "waiting"
      ? gateReason(state)
      : state.block === null
        ? "Factory blocked this delivery."
        : blockReason(state, state.block);
  return reason.length > NEEDS_YOU_MAX_LENGTH
    ? `${reason.slice(0, NEEDS_YOU_MAX_LENGTH - 1)}…`
    : reason;
};

/**
 * A delivery as clients see it: its progress, threads and the summaries of its receipts, reviews
 * and newest stage attempts, never their logs or evidence paths. Receipts and reviews carry their
 * evidence numbers, and each attempt names the one it produced; reviews carry the bounded details
 * kept when they were accepted. The current plan round's plan is carried while one is recorded,
 * so a parent waiting at the plan gate shows the plan it waits on. `needsYou` is set only while it
 * waits at the plan gate or is blocked.
 */
export const toFactoryDelivery = (delivery: FactoryDeliveryWithRuns): FactoryDelivery => {
  const { state } = delivery;
  const reason = needsYou(state);
  const plan = acceptedPlan(state);
  const receipts = state.receipts.map(receiptSummary);
  const reviews = state.reviews.map(reviewSummary);
  const evidence = { receipts: numbersOf(receipts), reviews: numbersOf(reviews) };
  return {
    deliveryId: delivery.deliveryId,
    projectId: delivery.projectId,
    itemRef: delivery.itemRef,
    ...(delivery.parentId === null ? {} : { parentId: delivery.parentId }),
    // A parent's children once its approved plan created them; a single item has none.
    childIds: state.children,
    status: state.status,
    ...(state.stage === null ? {} : { stage: { name: state.stage, kind: stageKind(state.stage) } }),
    rounds: state.rounds,
    branch: state.branch,
    ...(state.worktreePath === null ? {} : { worktreePath: state.worktreePath }),
    threads: state.threads,
    receipts,
    reviews,
    // Attempts are appended in start order, so the newest are the last.
    stageRuns: delivery.stageRuns
      .slice(-FACTORY_SNAPSHOT_STAGE_RUNS_MAX)
      .map((run) => stageRunSummary(run, evidence)),
    ...(plan === undefined ? {} : { plan: planSnapshot(plan) }),
    ...(reason === undefined ? {} : { needsYou: reason }),
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
};
