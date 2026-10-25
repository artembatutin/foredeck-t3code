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
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { buildThreadRouteParams } from "../../threadRoutes";

/** Shown when a start is refused because the project has no verify command. */
export const FACTORY_NOT_CONFIGURED_TEXT =
  "Set a verify command in Project settings → Factory before delivering this item.";

const FALLBACK_ERROR_TEXT = "Factory could not complete the request. Try again.";

/**
 * The text a failed Factory command shows: fixed text naming the settings path for a missing
 * verify command, a Factory error's own fixed message otherwise (a newer server's unknown reasons
 * included), and the failure's message for anything else.
 */
export function factoryErrorText(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause)) as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (error !== null && typeof error === "object" && error._tag === "FactoryError") {
    if (error.reason === "not_configured") return FACTORY_NOT_CONFIGURED_TEXT;
    return typeof error.message === "string" && error.message.trim().length > 0
      ? error.message
      : FALLBACK_ERROR_TEXT;
  }
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : FALLBACK_ERROR_TEXT;
}

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

const isActive = (delivery: FactoryDelivery) =>
  delivery.status !== "done" && delivery.status !== "cancelled";

/**
 * What a Work item's Factory section shows, or null when it shows nothing: on a server without
 * Factory, before the project's deliveries load, and for an item with no delivery the session
 * cannot start. Deliver is offered only when no delivery of the item is still open (one with a
 * status this build does not know counts as open). `started` is the delivery a start just
 * returned, counted until the list holds it, so Deliver is not offered again in between. Nothing
 * is offered while the environment is not connected, as during a reconnect's backoff, though the
 * deliveries read before still show.
 */
export function factoryItemSection(input: {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  readonly connected: boolean;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  readonly started: FactoryDelivery | null;
  readonly permitted: FactoryItemPermissions;
}): FactoryItemSectionView | null {
  if (!input.supported || input.deliveries === null) return null;
  const { started } = input;
  const deliveries =
    started === null ||
    input.deliveries.some((delivery) => delivery.deliveryId === started.deliveryId)
      ? input.deliveries
      : [started, ...input.deliveries];
  const { connected, permitted } = input;
  const current = currentDelivery(deliveries, input.itemRef);
  const deliver = connected && permitted.start && (current === undefined || !isActive(current));
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
