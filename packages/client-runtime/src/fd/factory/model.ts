import type { ServerConfig, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
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

/**
 * The delivery an item's surfaces show: the one not done or cancelled (the server allows one),
 * otherwise the newest; undefined when the item has none.
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
    if (Date.parse(delivery.createdAt) > Date.parse(current.createdAt)) current = delivery;
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
  readonly receipts: ReadonlyArray<FactoryVerifyReceiptSummary>;
  readonly reviews: ReadonlyArray<FactoryReviewSummary>;
}

const within = (run: FactoryStageRunSummary, at: string) => {
  const time = Date.parse(at);
  return (
    time >= Date.parse(run.startedAt) &&
    (run.finishedAt === undefined || time <= Date.parse(run.finishedAt))
  );
};

/**
 * A delivery's stage attempts in start order. A verify attempt carries the receipts finished
 * within it and a review attempt the reviews judged within it; receipts and reviews older than
 * the snapshot's attempts are left out. A snapshot from a server that sends no attempts reads as
 * its current stage holding every receipt and review.
 */
export const factoryTimeline = (
  delivery: Pick<FactoryDelivery, "stage" | "stageRuns" | "receipts" | "reviews">,
): ReadonlyArray<FactoryTimelineEntry> => {
  if (delivery.stageRuns.length === 0) {
    if (delivery.stage === undefined) return [];
    return [
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
    ];
  }
  // `map` returned a new array; Hermes has no `toSorted`.
  return delivery.stageRuns
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
      receipts:
        run.stage === "verify"
          ? delivery.receipts.filter((receipt) => within(run, receipt.finishedAt))
          : [],
      reviews:
        run.stage === "review"
          ? delivery.reviews.filter((review) => within(run, review.reviewedAt))
          : [],
    }));
};
