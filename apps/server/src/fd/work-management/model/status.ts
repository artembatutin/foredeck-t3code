import type { WorkNativeStatus, WorkStatus } from "@t3tools/contracts/fd/work-management";

/**
 * Status vocabulary per source kind. Each remote source is mapped through a table in both
 * directions so a status Work cannot express on that source is a visible gap here, not a
 * surprise in an adapter. Markdown stores Work's own statuses and needs no mapping.
 */

export type GitHubState = "open" | "closed";

/** The `state_reason` values GitHub issues report. `reopened` only accompanies `open`. */
export const GITHUB_STATE_REASONS = ["completed", "not_planned", "duplicate", "reopened"] as const;
export type GitHubStateReason = (typeof GITHUB_STATE_REASONS)[number];

/** How a closed issue reads by its reason. A closed issue without one was simply closed. */
const GITHUB_CLOSED_STATUS: Readonly<Record<GitHubStateReason, WorkNativeStatus>> = {
  completed: "done",
  not_planned: "cancelled",
  duplicate: "cancelled",
  reopened: "done",
};

export const fromGitHubState = (
  state: GitHubState,
  stateReason: GitHubStateReason | null | undefined,
): WorkNativeStatus => {
  if (state === "open") return "todo";
  return stateReason === null || stateReason === undefined
    ? "done"
    : GITHUB_CLOSED_STATUS[stateReason];
};

export interface GitHubStateWrite {
  readonly state: GitHubState;
  readonly stateReason: "reopened" | "completed" | "not_planned";
}

/** GitHub issues have no in-progress state, so that status cannot be written there. */
const GITHUB_STATE_WRITE: Readonly<Record<WorkNativeStatus, GitHubStateWrite | undefined>> = {
  todo: { state: "open", stateReason: "reopened" },
  in_progress: undefined,
  done: { state: "closed", stateReason: "completed" },
  cancelled: { state: "closed", stateReason: "not_planned" },
};

export const toGitHubState = (status: WorkNativeStatus): GitHubStateWrite | undefined =>
  GITHUB_STATE_WRITE[status];

export type JiraStatusCategoryKey = "new" | "indeterminate" | "done";

/** Resolution names, compared case-insensitively, that make a `done` category `cancelled`. */
export const JIRA_CANCELLED_RESOLUTIONS = [
  "Won't Do",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Won't Fix",
] as const;

const JIRA_CANCELLED_RESOLUTION_KEYS: ReadonlySet<string> = new Set(
  JIRA_CANCELLED_RESOLUTIONS.map((name) => name.toLowerCase()),
);

/**
 * Jira's own status names are free-form; only the status category is stable across
 * workflows. A category this build does not know reads as `unknown`, never as done.
 */
export const fromJiraStatusCategory = (
  categoryKey: string,
  resolutionName: string | null | undefined,
): WorkStatus => {
  switch (categoryKey) {
    case "new":
      return "todo";
    case "indeterminate":
      return "in_progress";
    case "done":
      return resolutionName !== null &&
        resolutionName !== undefined &&
        JIRA_CANCELLED_RESOLUTION_KEYS.has(resolutionName.toLowerCase())
        ? "cancelled"
        : "done";
    default:
      return "unknown";
  }
};

const JIRA_CATEGORY_FOR: Readonly<Record<WorkNativeStatus, JiraStatusCategoryKey>> = {
  todo: "new",
  in_progress: "indeterminate",
  done: "done",
  cancelled: "done",
};

/** The status category a transition must land in to realize `status`. */
export const jiraCategoryFor = (status: WorkNativeStatus): JiraStatusCategoryKey =>
  JIRA_CATEGORY_FOR[status];

export const MARKDOWN_WRITABLE_STATUSES: ReadonlyArray<WorkNativeStatus> = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
];
export const GITHUB_WRITABLE_STATUSES: ReadonlyArray<WorkNativeStatus> = [
  "todo",
  "done",
  "cancelled",
];
export const JIRA_WRITABLE_STATUSES: ReadonlyArray<WorkNativeStatus> = [
  "todo",
  "in_progress",
  "done",
];

/**
 * Whether an item still counts as open. `unknown` is open: an unrecognized status must not
 * silently release the items it blocks. `blocked` is derived from open blockers with this.
 */
export const isOpenStatus = (status: WorkStatus): boolean =>
  status !== "done" && status !== "cancelled";
