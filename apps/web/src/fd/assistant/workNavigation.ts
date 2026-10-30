import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  FACTORY_CAPACITY_WAIT_NOTE,
  FACTORY_STAGE_LABELS,
  FACTORY_STATUS_LABELS,
} from "@t3tools/client-runtime/fd/factory";
import { workItemRouteParams } from "@t3tools/client-runtime/fd/work-management";
import type { AssistantOverview, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";

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
 * resumes through the queue. Retry needs a root that ended; a never-claimed assignment has none.
 */
const factoryAccepts = (action: AssignmentAction, { state, factory }: Assignment) => {
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
      return factory !== undefined && (state === "failed" || state === "cancelled");
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
const workItemTarget = (environmentId: EnvironmentId, projectId: ProjectId, item: WorkItem) => {
  const ref = { sourceId: item.sourceId, itemId: item.itemId };
  const params = workItemRouteParams({ environmentId, projectId, ref });
  return {
    to: "/work" as const,
    search: {
      project: scopedProjectKey(scopeProjectRef(params.environmentId, params.projectId)),
      item: workItemRefString(ref),
    },
  };
};

export type WorkItemTarget = ReturnType<typeof workItemTarget>;

const httpUrl = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

const counted = (count: number, one: string, many: string) =>
  count === 0 ? [] : [`${count} automatic ${count === 1 ? one : many}.`];

/** A Factory assignment's row, beyond what every assignment shows. */
export interface FactoryAssignmentRow {
  /** Factory's own status and stage; undefined until a delivery row exists. */
  readonly delivery: string | undefined;
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
    delivery:
      status === null
        ? undefined
        : `Factory: ${FACTORY_STATUS_LABELS[status]}${stage === null ? "" : ` · ${FACTORY_STAGE_LABELS[stage]}`}`,
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
    pullRequestUrl: httpUrl(factory?.pullRequestUrl),
  };
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
