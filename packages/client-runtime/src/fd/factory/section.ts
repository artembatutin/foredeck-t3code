import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryRoleExecution,
  FactoryReviewSummary,
  FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef, WorkItemSummary } from "@t3tools/contracts/fd/work-management";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import {
  currentDelivery,
  FACTORY_STAGE_LABELS,
  FACTORY_STATUS_LABELS,
  factoryCapacityNote,
  type FactoryControls,
  factoryControls,
  type FactoryItemFact,
  factoryItemFacts,
  factoryLinkableUrl,
  factoryNeedsYou,
  type FactoryNextAction,
  factoryNextAction,
  factoryPendingActions,
  type FactoryPendingActionsView,
  type FactoryReviewNote,
  factoryReviewNotes,
  factoryTimeline,
  type FactoryTimelineEntry,
} from "./model.ts";

/** Whether this session holds each control's grant where the destination serves Factory. */
export interface FactoryControlPermissions {
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

/** A thread of the delivery, on the environment that owns the delivery. */
export interface FactoryThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** How an attempt's outcome reads at a glance; `active` is one still under way. */
export type FactoryOutcomeTone = "success" | "error" | "warning" | "active" | "neutral";

const OUTCOME_TONES: Record<NonNullable<FactoryTimelineEntry["outcome"]>, FactoryOutcomeTone> = {
  passed: "success",
  failed: "error",
  blocked: "warning",
  cancelled: "neutral",
  unknown: "neutral",
};

export interface FactoryTimelineRow {
  readonly key: string;
  readonly stage: string;
  /** The attempt's number within its stage; null for a server that sends no attempts. */
  readonly round: number | null;
  readonly outcome: string;
  readonly outcomeTone: FactoryOutcomeTone;
  readonly startedAt: string | undefined;
  readonly receipts: ReadonlyArray<FactoryEvidenceLine>;
  readonly reviews: ReadonlyArray<FactoryReviewLine>;
  /** The attempt's thread; null when it has none. */
  readonly thread: FactoryThreadTarget | null;
}

/**
 * A delivery's place in a parent's family, which decides what cancelling it ends: `parent` once
 * its approved plan has child deliveries, `child` for one of those, and `single` otherwise,
 * every delivery from a server from before planning included.
 */
export type FactoryDeliveryFamily = "single" | "parent" | "child";

export const factoryDeliveryFamily = (
  delivery: Pick<FactoryDelivery, "parentId" | "childIds">,
): FactoryDeliveryFamily =>
  delivery.parentId !== undefined ? "child" : delivery.childIds.length > 0 ? "parent" : "single";

/**
 * What cancelling a delivery ends, as every surface's cancel confirmation says it. By owner
 * decision a parent's cancel ends its children that are not approved, and a child's cancel ends
 * its parent and so the parent's other unapproved children; approved children keep their approval.
 */
export const FACTORY_CANCEL_TEXT: Record<FactoryDeliveryFamily, string> = {
  single:
    "Its agents stop what they are working on and the delivery ends. Its branch, worktree and commits stay; delivering the item again starts on a new branch.",
  parent:
    "Its agents stop what they are working on and the delivery ends, and so does each of its child deliveries not yet approved. Approved children keep their approval. The branch, worktree and commits stay; delivering the item again starts on a new branch.",
  child:
    "This delivery is one child of a parent's plan. Cancelling it ends it, its parent and each of the parent's other child deliveries not yet approved, and their agents stop what they are working on. Approved children keep their approval. The shared branch, worktree and commits stay.",
};

/** What a delivery shows of the commit its pull request carries; a gap reads `Not recorded`. */
export interface FactoryReviewEvidence {
  readonly verifiedCommit: string;
  readonly verify: string;
  readonly review: string;
}

/** The next action with what it needs on hand, at the top of the delivery. */
export interface FactoryNextActionView extends FactoryNextAction {
  /** Null without a pull request, or for a URL a link should not open. */
  readonly pullRequestUrl: string | null;
  /** The thread whose changes the owner reviews; null unless it is ready for review. */
  readonly reviewThread: FactoryThreadTarget | null;
  /** What the owner reviews on; null unless it is ready for review. */
  readonly evidence: FactoryReviewEvidence | null;
}

/** One count a delivery shows, or from an older server one of its rounds. */
export interface FactoryCounterLine {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

export interface FactoryCountersView {
  readonly lines: ReadonlyArray<FactoryCounterLine>;
  /** Every verify and review it ran, repairs or not; undefined from an older server. */
  readonly attempts: string | undefined;
  /** What the counts cover; undefined from an older server. */
  readonly scope: string | undefined;
}

const NOT_RECORDED = "Not recorded";

const COUNTED_SCOPES: Record<NonNullable<FactoryDelivery["allowance"]>["counted"], string> = {
  whole_delivery: "Approved in your review for the whole delivery. A resume adds none.",
  since_resume: "Counted since the last resume, which starts them over.",
  unknown: "This build does not know what these counts cover.",
};

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the delivery's counts say. Repair turns and attempts are different things, and each is named
 * for what it counts: one repair and two review attempts reads the same here and in the timeline.
 */
const factoryCounters = (
  delivery: Pick<FactoryDelivery, "allowance" | "rounds">,
): FactoryCountersView => {
  const { allowance, rounds } = delivery;
  if (allowance === undefined) {
    return {
      lines: [
        { key: "fix", label: "Fix rounds", text: `${rounds.fix}` },
        { key: "review", label: "Review rounds", text: `${rounds.review}` },
      ],
      attempts: undefined,
      scope: undefined,
    };
  }
  const line = (
    key: string,
    label: string,
    count: NonNullable<FactoryDelivery["allowance"]>["fixCommitTurns"] | null,
  ) =>
    count === null
      ? []
      : [{ key, label, text: `${count.used} used, ${count.remaining} left of ${count.limit}` }];
  return {
    lines: [
      ...line("fix", "Verification fixes", allowance.verificationFixes),
      ...line("review", "Review follow-ups", allowance.reviewFollowUps),
      ...line("fix-commit", "Fix-commit turns", allowance.fixCommitTurns),
    ],
    attempts: `${counted(allowance.attempts.verify, "verify attempt", "verify attempts")} · ${counted(allowance.attempts.review, "review attempt", "review attempts")}`,
    scope: COUNTED_SCOPES[allowance.counted],
  };
};

const listedControls = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

/**
 * Why a delivery offers no control an owner might look for, or what stands in for it, so no status
 * is a one-way door without saying so. Undefined where its controls say it all.
 */
const factoryControlsNote = (input: {
  readonly delivery: FactoryDelivery;
  readonly connected: boolean;
  readonly permitted: FactoryControlPermissions;
  readonly next: FactoryNextAction;
}): string | undefined => {
  const { delivery, connected, permitted, next } = input;
  const { status } = delivery;
  const model = factoryControls(delivery);
  const accepted = (["stop", "resume", "cancel"] as const).filter((name) => model[name]);
  if (accepted.length === 0) {
    switch (status) {
      case "done":
        return "A finished delivery does not reopen. Delivering the item again, on web or desktop, starts a new one on its own branch.";
      case "cancelled":
        return "A cancelled delivery does not reopen. Delivering the item again, on web or desktop, starts a new one on its own branch.";
      default:
        return "This build cannot read this delivery, so it offers no controls. Update the app to control it.";
    }
  }
  if (!connected) return `Reconnect to ${listedControls(accepted)} this delivery.`;
  const refused = accepted.filter((name) => !permitted[name]);
  if (refused.length > 0) {
    return `This connection is not allowed to ${listedControls(refused)} this delivery.`;
  }
  switch (status) {
    case "queued":
      return "It has not started, so there is nothing to stop yet. Cancel ends it.";
    case "waiting":
      return "It waits on your decision, so there is nothing to stop or resume. Cancel ends it.";
    case "approved":
      return "It is past its last stage, so there is nothing to stop or resume. Cancel ends it.";
    case "pr_open":
      return next.readyForReview
        ? "Merge or close the pull request on its host, and Factory follows either. Cancel stops Factory following it and leaves it open."
        : "It is finishing on its own, so there is nothing to stop or resume. Cancel ends it.";
    default:
      return undefined;
  }
};

const nextActionOf = (
  delivery: FactoryDelivery,
  environmentId: EnvironmentId,
): FactoryNextActionView => {
  const { pullRequest } = delivery;
  const next = factoryNextAction({
    status: delivery.status,
    needsYou: delivery.needsYou,
    child: delivery.parentId !== undefined,
    pullRequest,
    proceeding: delivery.proceeding,
  });
  const receipt = delivery.receipts.at(-1);
  const review = delivery.reviews.at(-1);
  const passed = delivery.receipts.reduce<FactoryVerifyReceiptSummary | undefined>(
    (latest, candidate) => (candidate.code === 0 && !candidate.timedOut ? candidate : latest),
    undefined,
  );
  return {
    ...next,
    pullRequestUrl: factoryLinkableUrl(pullRequest?.url),
    reviewThread:
      next.readyForReview && pullRequest?.threadId !== undefined
        ? { environmentId, threadId: pullRequest.threadId }
        : null,
    evidence: next.readyForReview
      ? {
          verifiedCommit: passed === undefined ? NOT_RECORDED : short(passed.headSha),
          verify: receipt === undefined ? NOT_RECORDED : receiptText(receipt),
          review: review === undefined ? NOT_RECORDED : reviewText(review),
        }
      : null,
  };
};

export interface FactoryDeliveryView {
  readonly deliveryId: FactoryDeliveryId;
  /** What cancelling it ends; see `FACTORY_CANCEL_TEXT`. */
  readonly family: FactoryDeliveryFamily;
  readonly label: string;
  /** What it comes to now, for the top of the delivery. */
  readonly nextAction: FactoryNextActionView;
  /** What it waits on someone for, each with where that is decided. */
  readonly pendingActions: FactoryPendingActionsView;
  /** The item's status, queue priority, assignee and delivery, each labelled as itself. */
  readonly facts: ReadonlyArray<FactoryItemFact>;
  readonly counters: FactoryCountersView;
  /** Why no control is offered, or what stands in for one. */
  readonly controlsNote: string | undefined;
  readonly needsYou: string | undefined;
  /** That it waits for a project assistant slot, which asks nothing of its owner. */
  readonly capacityNote: string | undefined;
  readonly stage: string | undefined;
  readonly rounds: FactoryDelivery["rounds"];
  readonly branch: string | undefined;
  readonly controls: FactoryControls;
  readonly timeline: ReadonlyArray<FactoryTimelineRow>;
  /** The receipts and reviews no attempt of the timeline holds. */
  readonly receipts: ReadonlyArray<FactoryEvidenceLine>;
  readonly reviews: ReadonlyArray<FactoryReviewLine>;
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
 * What a Work item's Factory section shows of the item's current delivery, on every client: null
 * on a server without Factory, before the project's deliveries load, and for an item with no
 * delivery. A control is offered only where the shared controls model allows it, the session
 * holds its grant and the environment is connected; during a reconnect's backoff nothing is
 * offered, though the deliveries read before still show.
 */
export function factoryDeliveryView(input: {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  readonly connected: boolean;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  readonly permitted: FactoryControlPermissions;
  /** The item as this surface read it, fresher than the listing's; the listing's otherwise. */
  readonly item?: {
    readonly status: WorkItemSummary["status"];
    readonly nativeStatus: WorkItemSummary["nativeStatus"];
    readonly assignee: WorkItemSummary["assignee"];
  };
}): FactoryDeliveryView | null {
  if (!input.supported || input.deliveries === null) return null;
  const current = currentDelivery(input.deliveries, input.itemRef);
  if (current === undefined) return null;
  const { connected, permitted } = input;
  const controls = factoryControls(current);
  const timeline = factoryTimeline(current);
  const nextAction = nextActionOf(current, input.environmentId);
  const { item } = input;
  return {
    deliveryId: current.deliveryId,
    family: factoryDeliveryFamily(current),
    label: FACTORY_STATUS_LABELS[current.status],
    nextAction,
    pendingActions: factoryPendingActions(current.pendingActions),
    facts: factoryItemFacts({
      source:
        item === undefined
          ? current.source
          : {
              status: item.status,
              statusName: item.nativeStatus?.name ?? null,
              assignee: item.assignee?.label ?? null,
            },
      queuePriority: current.queuePriority,
      delivery: { status: current.status, stage: current.stage?.name },
    }),
    counters: factoryCounters(current),
    controlsNote: factoryControlsNote({
      delivery: current,
      connected,
      permitted,
      next: nextAction,
    }),
    needsYou: factoryNeedsYou(current),
    capacityNote: factoryCapacityNote(current),
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
      outcomeTone: entry.outcome === null ? "active" : OUTCOME_TONES[entry.outcome],
      startedAt: entry.startedAt,
      receipts: entry.receipts.map(receiptLine),
      reviews: entry.reviews.map(reviewLine),
      thread:
        entry.threadId === undefined
          ? null
          : { environmentId: input.environmentId, threadId: entry.threadId },
    })),
    receipts: timeline.receipts.map(receiptLine),
    reviews: timeline.reviews.map(reviewLine),
  };
}

/** What one role of a delivery runs on, each part said for what it is. */
export interface FactoryRoleExecutionLine {
  readonly key: string;
  readonly label: string;
  /** What it actually asks for: its latest turn's request, or its launch's before it has one. */
  readonly requested: string;
  /** Where that comes from: `Reviewed`, or `Read now` for a delivery without a review. */
  readonly binding: string;
  /** What the review bound, which a request can differ from; undefined without a review. */
  readonly reviewed: string | undefined;
  /** What the provider itself reported, or `Not reported`, never the request read back. */
  readonly acknowledged: string;
}

export interface FactoryExecutionView {
  readonly roles: ReadonlyArray<FactoryRoleExecutionLine>;
  /** What the labels promise, and what they do not. */
  readonly note: string;
}

const NOT_REPORTED = "Not reported";

const ROLE_LABELS: Record<FactoryRoleExecution["role"], string> = {
  planner: "Planner",
  author: "Author",
  reviewer: "Reviewer",
  unknown: "Role",
};

const BINDING_LABELS: Record<FactoryRoleExecution["binding"], string> = {
  reviewed: "Reviewed",
  read_now: "Read now",
  unknown: "Unknown",
};

const selectionText = ({ instanceId, model, options }: ModelSelection): string => {
  const values = (options ?? []).map(
    ({ id, value }) => `${id}: ${typeof value === "string" ? value : value ? "on" : "off"}`,
  );
  return [instanceId, model, ...(values.length === 0 ? ["provider defaults"] : values)].join(" · ");
};

/**
 * What a delivery's section shows of its roles, on every client: null until one read of the delivery
 * brought them, which a server from before them never does. A provider decides what it runs and bills,
 * so a requested option is only that. An acknowledgement is what a provider said for itself, so it
 * reads `Not reported` where none did, even with the request right beside it.
 */
export const factoryExecutionView = (
  delivery: Pick<FactoryDelivery, "execution">,
): FactoryExecutionView | null => {
  const { execution } = delivery;
  if (execution === undefined || execution.roles.length === 0) return null;
  const bindings = new Set(execution.roles.map(({ binding }) => binding));
  const kept = bindings.has("reviewed")
    ? "Reviewed values stay what you reviewed, whatever the project's settings say later. A high-risk task or a later round can ask for the high-risk effort you reviewed, and a fix-commit turn asks for medium for that turn alone, so a request can differ from them."
    : "It was started without a review, so these are what its latest turn asked for or what its launch would read now, and a settings change can change its next step.";
  return {
    roles: execution.roles.map((entry) => ({
      key: entry.role,
      label: ROLE_LABELS[entry.role],
      requested: selectionText(entry.selection),
      binding: BINDING_LABELS[entry.binding],
      reviewed: entry.reviewed === undefined ? undefined : selectionText(entry.reviewed),
      acknowledged:
        entry.acknowledged === undefined ? NOT_REPORTED : selectionText(entry.acknowledged),
    })),
    note: `${kept} These are requests: the provider decides what it runs and how it bills.`,
  };
};

/**
 * The delivery an open cancel confirmation cancels: the one it was opened for, while that is
 * still the item's current delivery and still offers cancel. Otherwise null, and the
 * confirmation closes, so confirming never cancels a delivery that replaced it, or one this
 * session can no longer cancel.
 */
export const cancelConfirmationTarget = (
  delivery: FactoryDeliveryView | null,
  openedFor: FactoryDeliveryId | null,
): FactoryDeliveryId | null =>
  openedFor !== null && delivery?.deliveryId === openedFor && delivery.controls.cancel
    ? openedFor
    : null;
