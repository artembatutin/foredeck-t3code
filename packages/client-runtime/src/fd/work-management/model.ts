import {
  AuthWorkReadScope,
  type EnvironmentId,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import {
  parseWorkItemRefString,
  type WorkItemRef,
  type WorkItemSummary,
  type WorkManagementSupport,
  workItemRefString,
  workManagementSupport,
  type WorkThreadLink,
} from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

/**
 * Pure Work presentation rules shared by web and mobile, so both surfaces agree on what Ready
 * means, what a linked thread is doing and how an item is handed to an agent.
 */

/** The Work an environment's server advertises, or undefined. */
export const workSupport = (
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): WorkManagementSupport | undefined =>
  serverConfig === null || serverConfig === undefined
    ? undefined
    : workManagementSupport(serverConfig.environment.capabilities);

/** The scope a session needs to see Work at all; without it the surfaces ask to re-pair. */
export const WORK_READ_SCOPE = AuthWorkReadScope;

/** The thread fields Work reads; the clients' thread shell satisfies it. */
export interface WorkThreadShell {
  readonly id: ThreadId;
  readonly title: string;
  readonly latestRun: { readonly status: string } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly settledAt: string | null;
  readonly archivedAt: string | null;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

export type WorkRunState = "working" | "needs-input" | "idle" | "settled" | "archived" | "missing";

/** What a linked thread is doing now, from its live shell. */
export const runStateOf = (shell: WorkThreadShell | null | undefined): WorkRunState => {
  if (shell === null || shell === undefined) return "missing";
  if (shell.settledAt !== null) return "settled";
  if (shell.archivedAt !== null) return "archived";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needs-input";
  return shell.latestRun !== null && ACTIVE_RUN_STATUSES.has(shell.latestRun.status)
    ? "working"
    : "idle";
};

export const RUN_STATE_LABELS: Record<WorkRunState, string> = {
  working: "Working",
  "needs-input": "Needs input",
  idle: "Idle",
  settled: "Settled",
  archived: "Archived",
  missing: "Unavailable",
};

const isOpen = (state: WorkRunState) =>
  state === "working" || state === "needs-input" || state === "idle";

export type WorkView = "ready" | "active" | "all" | "done";

export const WORK_VIEWS: ReadonlyArray<{ readonly value: WorkView; readonly label: string }> = [
  { value: "ready", label: "Ready" },
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
  { value: "done", label: "Done" },
];

/**
 * Which views an item belongs to. Ready is an unblocked todo nobody is working on; Active has an
 * open linked thread; Done is finished or cancelled.
 */
export const itemInView = (
  view: WorkView,
  item: Pick<WorkItemSummary, "status" | "blocked">,
  states: ReadonlyArray<WorkRunState>,
): boolean => {
  const active = states.some(isOpen);
  switch (view) {
    case "all":
      return true;
    case "done":
      return item.status === "done" || item.status === "cancelled";
    case "active":
      return active;
    case "ready":
      return item.status === "todo" && !item.blocked && !active;
  }
};

/** Links grouped by thread, for badges that look a thread up without a request per row. */
export const linksByThread = (
  links: ReadonlyArray<WorkThreadLink>,
): ReadonlyMap<ThreadId, ReadonlyArray<WorkThreadLink>> => {
  const grouped = new Map<ThreadId, Array<WorkThreadLink>>();
  for (const link of links) {
    const list = grouped.get(link.threadId);
    if (list === undefined) grouped.set(link.threadId, [link]);
    else list.push(link);
  }
  return grouped;
};

/** Links grouped by item reference string. */
export const linksByItem = (
  links: ReadonlyArray<WorkThreadLink>,
): ReadonlyMap<string, ReadonlyArray<WorkThreadLink>> => {
  const grouped = new Map<string, Array<WorkThreadLink>>();
  for (const link of links) {
    const key = workItemRefString(link.ref);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [link]);
    else list.push(link);
  }
  return grouped;
};

/** The text "Add to prompt" writes, naming the item for both the owner and the agent. */
export const workItemReferenceText = (
  item: Pick<WorkItemSummary, "ref" | "key" | "title" | "url"> & { readonly locator?: string },
): string => {
  const where = item.url ?? item.locator;
  return `Work item ${item.key}: ${item.title}${where === undefined || where === null ? "" : ` (${where})`} — read it with work_read ${workItemRefString(item.ref)}`;
};

/**
 * Whether the item changed since the thread was started from it. The snapshot's revision is the
 * item as the thread first saw it.
 */
export const changedSinceLink = (
  link: Pick<WorkThreadLink, "snapshot">,
  item: Pick<WorkItemSummary, "revision">,
): boolean => link.snapshot.revision !== item.revision;

/**
 * The reverse prompts a linked item offers. "Back to todo?" undoes an automatic start whose run
 * failed or stopped; "Mark done?" follows a run that completed while the item is still open.
 */
export const linkPrompts = (
  link: Pick<WorkThreadLink, "snapshot" | "run">,
  item: Pick<WorkItemSummary, "status">,
): { readonly backToTodo: boolean; readonly markDone: boolean } => {
  const runStatus = link.run?.status;
  return {
    backToTodo:
      link.snapshot.autoStarted &&
      item.status === "in_progress" &&
      (runStatus === "failed" || runStatus === "cancelled" || runStatus === "interrupted"),
    markDone:
      runStatus === "completed" && (item.status === "todo" || item.status === "in_progress"),
  };
};

/** Route params for one item on mobile and in links: the environment, project and reference. */
export interface WorkItemRouteParams {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sourceId: string;
  readonly itemId: string;
}

export const workItemRouteParams = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly ref: WorkItemRef;
}): WorkItemRouteParams => ({
  environmentId: input.environmentId,
  projectId: input.projectId,
  sourceId: input.ref.sourceId,
  itemId: input.ref.itemId,
});

export const parseWorkItemRouteRef = (params: {
  readonly sourceId: string;
  readonly itemId: string;
}): WorkItemRef | undefined => parseWorkItemRefString(`${params.sourceId}:${params.itemId}`);

/** List controls a client remembers between visits. */
export const WorkListPreferences = Schema.Struct({
  view: Schema.Literals(["ready", "active", "all", "done"]),
  assignedToMe: Schema.Boolean,
});
export type WorkListPreferences = typeof WorkListPreferences.Type;

export const DEFAULT_WORK_LIST_PREFERENCES: WorkListPreferences = {
  view: "ready",
  assignedToMe: false,
};

const decodePreferences = Schema.decodeUnknownOption(Schema.fromJsonString(WorkListPreferences));

export const readWorkListPreferences = (stored: string | null): WorkListPreferences => {
  if (stored === null) return DEFAULT_WORK_LIST_PREFERENCES;
  const decoded = decodePreferences(stored);
  return decoded._tag === "Some" ? decoded.value : DEFAULT_WORK_LIST_PREFERENCES;
};

export const writeWorkListPreferences = (preferences: WorkListPreferences): string =>
  JSON.stringify(preferences);

/**
 * The workspace a thread started from an item uses unless the owner picks: a worktree where the
 * project starts threads in worktrees and its checkouts are not shared, else the project root.
 * The server resolves the same default again at launch.
 */
export const defaultWorkWorkspace = (input: {
  readonly defaultThreadEnvMode: "local" | "worktree" | null | undefined;
  readonly sharedCheckouts: boolean;
}): "root" | "worktree" =>
  !input.sharedCheckouts && input.defaultThreadEnvMode === "worktree" ? "worktree" : "root";

/** The branch name a worktree start uses, mirrored from the server for the dialog's preview. */
export const workBranchPreview = (
  item: Pick<WorkItemSummary, "kind" | "ref" | "title">,
): string => {
  const slug = item.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const key = item.kind === "github" ? `gh-${item.ref.itemId}` : item.ref.itemId;
  return slug.length === 0 ? `work/${key}` : `work/${key}-${slug}`;
};
