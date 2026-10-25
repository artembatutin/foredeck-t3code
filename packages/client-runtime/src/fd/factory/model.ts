import type { ServerConfig, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  type FactoryFindingSeverity,
  type FactoryReviewSummary,
  type FactoryStageRunSummary,
  type FactorySupport,
  type FactoryVerifyReceiptSummary,
  factorySupport,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

/**
 * Pure Factory presentation rules shared by web and mobile, so both surfaces agree on what a
 * delivery's status means, when it needs its owner, which controls it offers and how its stage
 * attempts read as a timeline.
 */

/** The Factory an environment's server advertises, or undefined. */
export const serverFactorySupport = (
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): FactorySupport | undefined =>
  serverConfig === null || serverConfig === undefined
    ? undefined
    : factorySupport(serverConfig.environment.capabilities);

export type FactoryStatus = FactoryDelivery["status"];

export const FACTORY_STATUS_LABELS: Record<FactoryStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for you",
  blocked: "Blocked",
  stopping: "Stopping",
  stopped: "Stopped",
  approved: "Approved",
  pr_open: "PR open",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

export type FactoryStage = FactoryStageRunSummary["stage"];

export const FACTORY_STAGE_LABELS: Record<FactoryStage, string> = {
  plan: "Plan",
  approve_plan: "Plan approval",
  author: "Author",
  verify: "Verify",
  review: "Review",
  repair: "Repair",
  record: "Record",
  integrate: "Integrate",
  pr: "Pull request",
  follow_through: "Follow-through",
  unknown: "Unknown stage",
};

const NEEDS_YOU_FALLBACK: Partial<Record<FactoryStatus, string>> = {
  blocked: "Factory blocked this delivery.",
  waiting: "Factory is waiting for your decision.",
};

/**
 * Why a delivery waits on its owner, or undefined when it does not: only a blocked delivery or
 * one waiting at a gate does, with the server's reason when it sent one.
 */
export const factoryNeedsYou = (
  delivery: Pick<FactoryDelivery, "status" | "needsYou">,
): string | undefined => {
  const fallback = NEEDS_YOU_FALLBACK[delivery.status];
  if (fallback === undefined) return undefined;
  return delivery.needsYou?.trim() || fallback;
};

export interface FactoryControls {
  readonly stop: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
}

const isTerminal = (status: FactoryStatus) => status === "done" || status === "cancelled";

const NO_CONTROLS: FactoryControls = { stop: false, resume: false, cancel: false };

/**
 * The controls a delivery offers, as the server's engine accepts them: stop only while running,
 * resume while stopping, stopped or blocked, and cancel until the delivery ends. A delivery this
 * build cannot fully read, with a status or a current stage name or kind it does not know, is
 * read-only and offers none.
 */
export const factoryControls = (
  delivery: Pick<FactoryDelivery, "status" | "stage">,
): FactoryControls => {
  const { status, stage } = delivery;
  if (status === "unknown" || stage?.name === "unknown" || stage?.kind === "unknown") {
    return NO_CONTROLS;
  }
  return {
    stop: status === "running",
    resume: status === "stopping" || status === "stopped" || status === "blocked",
    cancel: !isTerminal(status),
  };
};

/** Whether the server lists `delivery` before `other`: newer first, then the greater id. */
const listsBefore = (delivery: FactoryDelivery, other: FactoryDelivery) => {
  const newer = Date.parse(delivery.createdAt) - Date.parse(other.createdAt);
  return newer === 0 ? delivery.deliveryId > other.deliveryId : newer > 0;
};

/**
 * The delivery an item's surfaces show: the one not done or cancelled (the server allows one),
 * otherwise the newest; undefined when the item has none. Ties go the way the server lists
 * deliveries, so the choice never depends on the order they arrive in.
 */
export const currentDelivery = (
  deliveries: ReadonlyArray<FactoryDelivery>,
  itemRef: WorkItemRef,
): FactoryDelivery | undefined => {
  let current: FactoryDelivery | undefined;
  for (const delivery of deliveries) {
    if (
      delivery.itemRef.sourceId !== itemRef.sourceId ||
      delivery.itemRef.itemId !== itemRef.itemId
    ) {
      continue;
    }
    if (current === undefined) {
      current = delivery;
      continue;
    }
    const active = !isTerminal(delivery.status);
    const currentActive = !isTerminal(current.status);
    if (active !== currentActive) {
      if (active) current = delivery;
      continue;
    }
    if (listsBefore(delivery, current)) current = delivery;
  }
  return current;
};

export interface FactoryTimelineEntry {
  readonly stage: FactoryStage;
  /** The attempt's 1-based number within its stage; null when the server sent no attempts. */
  readonly round: number | null;
  /** Null while the attempt is active, and for a stage reconstructed without attempts. */
  readonly outcome: FactoryStageRunSummary["outcome"];
  readonly threadId: ThreadId | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  /** The receipt the attempt's command produced, as the server names it. */
  readonly receipts: ReadonlyArray<FactoryVerifyReceiptSummary>;
  /** The review the attempt accepted, as the server names it. */
  readonly reviews: ReadonlyArray<FactoryReviewSummary>;
}

export interface FactoryTimeline {
  readonly entries: ReadonlyArray<FactoryTimelineEntry>;
  /**
   * The receipts and reviews no entry holds, oldest first: from a server that does not name the
   * attempt that produced them, while that attempt is active, or once it is older than the
   * snapshot's attempts. Each receipt and review is in exactly one place.
   */
  readonly receipts: ReadonlyArray<FactoryVerifyReceiptSummary>;
  readonly reviews: ReadonlyArray<FactoryReviewSummary>;
}

/** Hands each piece of evidence to the first attempt that names its number, and only to it. */
const claimer = <A extends { readonly number?: number }>(evidence: ReadonlyArray<A>) => {
  const claimed = new Set<number>();
  return {
    claim: (number: number | undefined): ReadonlyArray<A> => {
      if (number === undefined) return [];
      const index = evidence.findIndex(
        (piece, position) => piece.number === number && !claimed.has(position),
      );
      const piece = evidence[index];
      if (piece === undefined) return [];
      claimed.add(index);
      return [piece];
    },
    unclaimed: () => evidence.filter((_, position) => !claimed.has(position)),
  };
};

/**
 * A delivery's stage attempts in start order, each holding the receipt or review the server says
 * it produced. Times never decide it: an attempt can end in the millisecond its successor starts
 * and its receipt finishes, so a time window would show that receipt under both. A snapshot from
 * a server that sends no attempts reads as its current stage holding every receipt and review.
 */
export const factoryTimeline = (
  delivery: Pick<FactoryDelivery, "stage" | "stageRuns" | "receipts" | "reviews">,
): FactoryTimeline => {
  if (delivery.stageRuns.length === 0) {
    if (delivery.stage === undefined) {
      return { entries: [], receipts: delivery.receipts, reviews: delivery.reviews };
    }
    return {
      entries: [
        {
          stage: delivery.stage.name,
          round: null,
          outcome: null,
          threadId: undefined,
          startedAt: undefined,
          finishedAt: undefined,
          receipts: delivery.receipts,
          reviews: delivery.reviews,
        },
      ],
      receipts: [],
      reviews: [],
    };
  }
  const receipts = claimer(delivery.receipts);
  const reviews = claimer(delivery.reviews);
  // `map` returned a new array; Hermes has no `toSorted`.
  const entries = delivery.stageRuns
    .map((run, index) => ({ run, index }))
    .sort(
      (left, right) =>
        Date.parse(left.run.startedAt) - Date.parse(right.run.startedAt) ||
        left.index - right.index,
    )
    .map(({ run }) => ({
      stage: run.stage,
      round: run.attempt,
      outcome: run.outcome,
      threadId: run.threadId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      receipts: receipts.claim(run.receiptNumber),
      reviews: reviews.claim(run.reviewNumber),
    }));
  return { entries, receipts: receipts.unclaimed(), reviews: reviews.unclaimed() };
};

const SEVERITY_LABELS: Record<FactoryFindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** One thing a review raised: a finding, a criterion it did not verify, or missing evidence. */
export interface FactoryReviewNote {
  readonly key: string;
  /** A finding's severity, "Criterion 2 failed", "Criterion 3 untested" or "Missing evidence". */
  readonly label: string;
  /** Whether the reviewer marked the finding required. */
  readonly required: boolean;
  /** Whether it blocks the commit: a finding at a blocking severity, or any other note. */
  readonly blocking: boolean;
  /** Where a finding points, `file:line` or the file alone; undefined for other notes. */
  readonly location: string | undefined;
  /** The reviewer's words as the server bounded them. Plain text: never render it as markup. */
  readonly detail: string;
}

export interface FactoryReviewNotes {
  /** Findings first, as the server ordered them, then criteria, then missing evidence. */
  readonly notes: ReadonlyArray<FactoryReviewNote>;
  /** What the server left out of the lists, as a sentence; undefined when it left none out. */
  readonly omitted: string | undefined;
}

/** "a", "a and b", "a, b and c". */
const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

const more = (count: number, one: string, many: string) =>
  count === 0 ? [] : [`${count} more ${count === 1 ? one : many}`];

/**
 * What a review raised, as both surfaces list it under the review. A review from a server that
 * keeps no details, or one that raised nothing, has no notes.
 */
export const factoryReviewNotes = (review: FactoryReviewSummary): FactoryReviewNotes => {
  const { details } = review;
  if (details === undefined) return { notes: [], omitted: undefined };
  const notes: Array<FactoryReviewNote> = [
    ...details.findings.map((finding) => ({
      key: `finding:${finding.id}`,
      label: SEVERITY_LABELS[finding.severity],
      required: finding.required,
      blocking: finding.blocking,
      location: finding.line === null ? finding.file : `${finding.file}:${finding.line}`,
      detail: finding.detail,
    })),
    ...details.criteria.map((criterion) => ({
      key: `criterion:${criterion.criterion}`,
      label: `Criterion ${criterion.criterion} ${criterion.status}`,
      required: false,
      blocking: true,
      location: undefined,
      detail: criterion.detail,
    })),
    ...details.missingEvidence.map((detail, index) => ({
      key: `missing:${index}`,
      label: "Missing evidence",
      required: false,
      blocking: true,
      location: undefined,
      detail,
    })),
  ];
  const { omitted } = details;
  const left = [
    ...more(omitted.findings, "finding", "findings"),
    ...more(omitted.criteria, "criterion", "criteria"),
    ...more(omitted.missingEvidence, "missing evidence entry", "missing evidence entries"),
  ];
  return { notes, omitted: left.length === 0 ? undefined : `Not shown: ${listed(left)}.` };
};
