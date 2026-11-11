import {
  FACTORY_CAPACITY_WAIT_NOTE,
  type FactoryItemFact,
  factoryItemFacts,
  factoryLinkableUrl,
  type FactoryNextAction,
  factoryNextAction,
  factoryPendingActions,
  type FactoryPendingActionsView,
} from "@t3tools/client-runtime/fd/factory";
import { workItemLinkTarget } from "@t3tools/client-runtime/fd/work-management";
import type { AssistantOverview, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

type Assignment = AssistantOverview["assignments"][number];
type Idea = AssistantOverview["ideas"][number];
type WorkItem = NonNullable<Assignment["workItem"]>;

// Overview assignments are ordered by creation time. A new queued assignment must
// not send the owner to an older conversation for the same idea.
export function ideaAssignment(
  idea: Pick<Assignment, "projectId" | "ideaId">,
  assignments: ReadonlyArray<Assignment>,
): Assignment | undefined {
  return assignments.findLast(
    (item) => item.projectId === idea.projectId && item.ideaId === idea.ideaId,
  );
}

export function availableWorkerThread(
  assignment: Assignment | undefined,
  environmentId: EnvironmentId,
  threads: ReadonlyArray<{ id: ThreadId; environmentId: EnvironmentId }>,
): ThreadId | null {
  // A Factory assignment's thread is the one its delivery awaits, or else its latest author's.
  const threadId = assignment?.factory?.threadId ?? assignment?.threadId;
  // Dispatch records contain a planned ID before launch; the shell confirms it exists.
  return threadId &&
    threads.some((thread) => thread.id === threadId && thread.environmentId === environmentId)
    ? threadId
    : null;
}

/** How far an idea has come: talked about, written down in Work, or being worked on. */
export interface IdeaStage {
  readonly stage: "discussion" | "capturing" | "captured" | "unconfirmed" | "delivery";
  readonly label: string;
  /** What that stage means for workers, which no stage before delivery has started. */
  readonly detail: string;
}

// An assignment in any other state has ended, or was never started.
const DELIVERING = new Set([
  "queued",
  "launching",
  "launch-uncertain",
  "running",
  "needs-input",
  "stopping",
  "stopped",
  "awaiting-verification",
]);

/**
 * The stage an idea's row shows, so a list tells discussion, captured work and active delivery
 * apart without opening each. A capture is only a Work item: it never reads as work under way.
 */
export function ideaStage(idea: Idea, assignment: Assignment | undefined): IdeaStage {
  if (assignment !== undefined && DELIVERING.has(assignment.state)) {
    return {
      stage: "delivery",
      label: "In delivery",
      detail: "A worker was started for this idea. Its progress is under Assignments.",
    };
  }
  const state = idea.capture?.state;
  if (state === undefined) {
    return {
      stage: "discussion",
      label: "Discussion",
      detail:
        "Not captured in Work, and no worker has started. Keep shaping it with the assistant.",
    };
  }
  if (state === "captured") {
    return {
      stage: "captured",
      label: "Captured",
      detail: "Capturing started no worker. Review it to start one.",
    };
  }
  return state === "pending"
    ? {
        stage: "capturing",
        label: "Capturing",
        detail: "Capturing starts no worker.",
      }
    : {
        stage: "unconfirmed",
        label: "Capture unconfirmed",
        detail: "No worker has started.",
      };
}

export type AssignmentAction = "stop" | "resume" | "retry" | "cancel";

const ACTIONS: ReadonlyArray<AssignmentAction> = ["stop", "resume", "retry", "cancel"];

const ordinaryAccepts = (action: AssignmentAction, state: string) =>
  action === "stop"
    ? ["running", "needs-input"].includes(state)
    : action === "resume"
      ? state === "stopped"
      : action === "retry"
        ? state === "failed"
        : [
            "queued",
            "running",
            "needs-input",
            "stopped",
            "failed",
            "awaiting-verification",
          ].includes(state);

/**
 * The server's table for a Factory assignment (`FactoryExecutor.control`). Stop and cancel before a
 * delivery runs are saved as intents. Past that, Factory only stops a running delivery and only
 * resumes one that is stopping, stopped or blocked, and a root stopped before its first start
 * resumes through the queue. Retry needs a root that ended, which a never-claimed assignment lacks,
 * and no review.
 */
const factoryAccepts = (action: AssignmentAction, { state, factory, reviewed }: Assignment) => {
  const status = factory?.status ?? null;
  const ended = status === "done" || status === "cancelled";
  switch (action) {
    case "stop":
      return (
        !ended &&
        (state === "launching" ||
          state === "launch-uncertain" ||
          ((state === "running" || state === "needs-input") && status === "running"))
      );
    case "resume":
      return status === "stopping" || status === "stopped" || status === "blocked"
        ? ["running", "needs-input", "stopping", "stopped"].includes(state)
        : state === "stopped" && factory !== undefined && (status === null || status === "queued");
    case "retry":
      // An attempt run under a review is followed only by a fresh review, never a retry.
      return (
        reviewed !== true && factory !== undefined && (state === "failed" || state === "cancelled")
      );
    case "cancel":
      return (
        !ended &&
        [
          "queued",
          "launching",
          "launch-uncertain",
          "running",
          "needs-input",
          "stopping",
          "stopped",
          "failed",
        ].includes(state)
      );
  }
};

/** The controls an assignment offers: only those its executor's server accepts in its state. */
export const assignmentActions = (item: Assignment): ReadonlyArray<AssignmentAction> =>
  ACTIONS.filter((action) =>
    item.executor === "factory"
      ? factoryAccepts(action, item)
      : ordinaryAccepts(action, item.state),
  );

/** Where a Work item opens: the Work page's item, in the item's own project. */
const workItemTarget = (environmentId: EnvironmentId, projectId: ProjectId, item: WorkItem) =>
  workItemLinkTarget({
    environmentId,
    projectId,
    ref: { sourceId: item.sourceId, itemId: item.itemId },
  });

export type WorkItemTarget = ReturnType<typeof workItemTarget>;

/**
 * What a row is called: the short title the server sends, its Work item's where it is captured,
 * and what an older server sends otherwise. The goal stays whole in the row's own `goal`.
 */
export const portfolioRowTitle = (
  row: { readonly title?: string | undefined; readonly goal: string },
  fallback: string,
) => row.title?.trim() || row.goal || fallback;

const counted = (count: number, one: string, many: string) =>
  count === 0 ? [] : [`${count} automatic ${count === 1 ? one : many}.`];

/** A Factory assignment's row, beyond what every assignment shows. */
export interface FactoryAssignmentRow {
  /**
   * What its delivery comes to now, read from its current state however its assignment's chat
   * reads; null until a delivery row exists.
   */
  readonly nextAction: FactoryNextAction | null;
  /** What it waits on someone for, each with where that is decided. */
  readonly pendingActions: FactoryPendingActionsView;
  /** The item's status, queue priority, assignee and delivery, each labelled as itself. */
  readonly facts: ReadonlyArray<FactoryItemFact>;
  /** Why it is where it is and what to do, as the server wrote it. */
  readonly reasons: ReadonlyArray<string>;
  /** What is waiting, none of which asks anything of the owner. */
  readonly waits: ReadonlyArray<string>;
  /** Each waiting or after-end follow-up in its notice's words, which say what can be done. */
  readonly notices: ReadonlyArray<string>;
  /** Null until its Work item is known. */
  readonly work: WorkItemTarget | null;
  /** Null without a pull request, or for a URL a link should not open. */
  readonly pullRequestUrl: string | null;
  /** Its current attempt runs under the owner's review; never true of one queued without it. */
  readonly reviewed: boolean;
}

/** The row of a Factory assignment; null for any other executor, whose row stays as it was. */
export function factoryAssignmentRow(
  item: Assignment,
  environmentId: EnvironmentId,
): FactoryAssignmentRow | null {
  if (item.executor !== "factory") return null;
  const { factory, workItem } = item;
  const status = factory?.status ?? null;
  const stage = factory?.stage ?? null;
  const needsYou = factory?.needsYou?.trim() ?? "";
  const notice = item.notice.trim();
  // Two follow-ups of one kind on one thread read the same.
  const notices = [...new Set(factory?.notices ?? [])];
  const waiting = factory?.automaticWaits.waiting ?? 0;
  const blocked = factory?.automaticWaits.blocked ?? 0;
  return {
    pendingActions: factoryPendingActions(factory?.pendingActions),
    nextAction:
      status === null
        ? null
        : factoryNextAction({
            status,
            needsYou: factory?.needsYou,
            pullRequest:
              factory?.pullRequestUrl === null || factory?.pullRequestUrl === undefined
                ? undefined
                : factory.pullRequestOutcome === undefined
                  ? {}
                  : { outcome: factory.pullRequestOutcome },
            proceeding: factory?.proceeding,
          }),
    facts: factoryItemFacts({
      source: item.source,
      queuePriority: item.priority,
      delivery: status === null ? null : { status, stage },
    }),
    reasons: [
      // A mirrored note quotes the delivery's reason and adds what to do about it.
      ...(needsYou === "" || notice.includes(needsYou) ? [] : [needsYou]),
      ...(notice === "" || notices.includes(notice) ? [] : [notice]),
    ],
    waits: [
      ...(item.state === "queued" || factory?.capacityWait ? [FACTORY_CAPACITY_WAIT_NOTE] : []),
      ...counted(
        waiting,
        "follow-up is waiting for a project assistant slot",
        "follow-ups are waiting for a project assistant slot",
      ),
      ...counted(
        blocked,
        "follow-up is blocked until what was authorized is restored",
        "follow-ups are blocked until what was authorized is restored",
      ),
      ...counted(
        factory?.endedDispositions ?? 0,
        "follow-up was not done, because the delivery had ended or the server restarted",
        "follow-ups were not done, because the delivery had ended or the server restarted",
      ),
    ],
    notices,
    work: workItem === undefined ? null : workItemTarget(environmentId, item.projectId, workItem),
    pullRequestUrl: factoryLinkableUrl(factory?.pullRequestUrl),
    reviewed: item.reviewed === true,
  };
}

/**
 * An idea's facts, once it is captured: what its Work source says, the assistant's rank, and how
 * its latest assignment's delivery stands. Null for an idea with no capture, which has no item.
 */
export function ideaFacts(
  idea: Idea,
  assignment: Assignment | undefined,
): ReadonlyArray<FactoryItemFact> | null {
  if (idea.capture === undefined) return null;
  const { factory } = assignment ?? {};
  return factoryItemFacts({
    source: idea.source,
    queuePriority: idea.priority,
    delivery:
      factory === undefined || factory.status === null
        ? null
        : { status: factory.status, stage: factory.stage },
  });
}

/** What an idea's row says of its Work capture, and where its item opens. */
export function ideaCaptureRow(idea: Idea, environmentId: EnvironmentId) {
  const { capture } = idea;
  if (capture === undefined) return null;
  const { item, state } = capture;
  const text =
    state === "captured"
      ? `Captured as ${item?.key ?? item?.itemId ?? "a Work item"}.`
      : state === "pending"
        ? "Being captured as a Work item."
        : "Whether this was captured could not be confirmed. Ask the assistant to check.";
  return {
    text,
    work:
      state === "captured" && item !== null
        ? workItemTarget(environmentId, idea.projectId, item)
        : null,
  };
}
