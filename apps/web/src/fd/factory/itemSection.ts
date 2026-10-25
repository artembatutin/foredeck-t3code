import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  currentDelivery,
  FACTORY_STAGE_LABELS,
  FACTORY_STATUS_LABELS,
  type FactoryControls,
  factoryControls,
  factoryNeedsYou,
  type FactoryReviewNote,
  factoryReviewNotes,
  factoryTimeline,
  type FactoryTimelineEntry,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryReviewSummary,
  FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { buildThreadRouteParams } from "../../threadRoutes";
import { deliveriesWithStarted, factoryDeliverable, type FactoryStartedDelivery } from "./deliver";

/** Whether this session holds each command's grant where the destination serves Factory. */
export interface FactoryItemPermissions {
  readonly start: boolean;
  readonly stop: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
}

const OUTCOME_LABELS: Record<NonNullable<FactoryTimelineEntry["outcome"]>, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** A receipt or review of an attempt, as one line. */
export interface FactoryEvidenceLine {
  readonly key: string;
  readonly text: string;
}

/** A review's line, with what it raised listed under it as plain text. */
export interface FactoryReviewLine extends FactoryEvidenceLine {
  readonly notes: ReadonlyArray<FactoryReviewNote>;
  /** How many entries the server left out; undefined when it left none out. */
  readonly omitted: string | undefined;
}

export interface FactoryTimelineRow {
  readonly key: string;
  readonly stage: string;
  /** The attempt's number within its stage; null for a server that sends no attempts. */
  readonly round: number | null;
  readonly outcome: string;
  readonly startedAt: string | undefined;
  readonly receipts: ReadonlyArray<FactoryEvidenceLine>;
  readonly reviews: ReadonlyArray<FactoryReviewLine>;
  /** Route params of the attempt's thread; null when it has none. */
  readonly thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}

export interface FactoryDeliveryView {
  readonly deliveryId: FactoryDeliveryId;
  readonly label: string;
  readonly needsYou: string | undefined;
  readonly stage: string | undefined;
  readonly rounds: FactoryDelivery["rounds"];
  readonly branch: string | undefined;
  readonly controls: FactoryControls;
  readonly timeline: ReadonlyArray<FactoryTimelineRow>;
  /** The receipts and reviews no attempt of the timeline holds. */
  readonly receipts: ReadonlyArray<FactoryEvidenceLine>;
  readonly reviews: ReadonlyArray<FactoryReviewLine>;
}

export interface FactoryItemSectionView {
  readonly deliver: boolean;
  readonly delivery: FactoryDeliveryView | null;
}

const short = (sha: string) => sha.slice(0, 7);

export const receiptText = (receipt: FactoryVerifyReceiptSummary): string => {
  const result = receipt.timedOut
    ? "Timed out"
    : receipt.code === 0
      ? "Passed"
      : receipt.code === null
        ? "Ended without an exit code"
        : `Failed with exit code ${receipt.code}`;
  return `${result} on ${short(receipt.headSha)} in ${formatDuration(receipt.durationMs)}`;
};

export const reviewText = (review: FactoryReviewSummary): string => {
  const verdict = review.verdict === "pass" ? "Pass" : "Changes required";
  const { high, medium, low } = review.findings;
  return `${verdict}${review.blocking ? ", blocking" : ""} on ${short(review.headSha)}: ${high} high, ${medium} medium, ${low} low`;
};

const receiptLine = (receipt: FactoryVerifyReceiptSummary): FactoryEvidenceLine => ({
  key: `${receipt.finishedAt}:${receipt.headSha}`,
  text: receiptText(receipt),
});

const reviewLine = (review: FactoryReviewSummary): FactoryReviewLine => ({
  key: `${review.reviewedAt}:${review.headSha}`,
  text: reviewText(review),
  ...factoryReviewNotes(review),
});

/**
 * What a Work item's Factory section shows, or null when it shows nothing: on a server without
 * Factory, before the project's deliveries load, and for an item with no delivery the session
 * cannot start. Deliver follows `factoryDeliverable`, the rule every Deliver entry point shares.
 * Nothing is offered while the environment is not connected, as during a reconnect's backoff,
 * though the deliveries read before still show.
 */
export function factoryItemSection(input: {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  readonly connected: boolean;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  /** Every delivery a start in this session returned, counted until the list holds it. */
  readonly started: ReadonlyArray<FactoryStartedDelivery>;
  readonly permitted: FactoryItemPermissions;
}): FactoryItemSectionView | null {
  const deliveries = deliveriesWithStarted(input);
  if (!input.supported || deliveries === null) return null;
  const { connected, permitted } = input;
  const current = currentDelivery(deliveries, input.itemRef);
  const deliver = factoryDeliverable({ ...input, startPermitted: permitted.start });
  if (current === undefined) return deliver ? { deliver, delivery: null } : null;

  const controls = factoryControls(current);
  const timeline = factoryTimeline(current);
  return {
    deliver,
    delivery: {
      deliveryId: current.deliveryId,
      label: FACTORY_STATUS_LABELS[current.status],
      needsYou: factoryNeedsYou(current),
      stage: current.stage === undefined ? undefined : FACTORY_STAGE_LABELS[current.stage.name],
      rounds: current.rounds,
      branch: current.branch,
      controls: {
        stop: connected && controls.stop && permitted.stop,
        resume: connected && controls.resume && permitted.resume,
        cancel: connected && controls.cancel && permitted.cancel,
      },
      timeline: timeline.entries.map((entry, index) => ({
        key: `${entry.stage}:${entry.round ?? "-"}:${entry.startedAt ?? "-"}:${index}`,
        stage: FACTORY_STAGE_LABELS[entry.stage],
        round: entry.round,
        outcome:
          entry.outcome === null
            ? entry.round === null
              ? "Current stage"
              : "In progress"
            : OUTCOME_LABELS[entry.outcome],
        startedAt: entry.startedAt,
        receipts: entry.receipts.map(receiptLine),
        reviews: entry.reviews.map(reviewLine),
        thread:
          entry.threadId === undefined
            ? null
            : buildThreadRouteParams(scopeThreadRef(input.environmentId, entry.threadId)),
      })),
      receipts: timeline.receipts.map(receiptLine),
      reviews: timeline.reviews.map(reviewLine),
    },
  };
}

/**
 * The delivery an open cancel confirmation cancels: the one it was opened for, while that is
 * still the item's current delivery and still offers cancel. Otherwise null, and the
 * confirmation closes, so confirming never cancels a delivery that replaced it, or one this
 * session can no longer cancel.
 */
export const cancelConfirmationTarget = (
  view: FactoryItemSectionView | null,
  openedFor: FactoryDeliveryId | null,
): FactoryDeliveryId | null =>
  openedFor !== null && view?.delivery?.deliveryId === openedFor && view.delivery.controls.cancel
    ? openedFor
    : null;
