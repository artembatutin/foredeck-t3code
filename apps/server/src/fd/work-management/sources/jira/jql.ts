import type { WorkListQuery, WorkNativeStatus } from "@t3tools/contracts/fd/work-management";

import { jiraCategoryFor } from "../../model/status.ts";

/** Jira project keys: an upper-case letter, then letters, digits or underscores. */
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
/** Issue keys are case-insensitive on Jira; Work stores them upper-cased. */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export const normalizeIssueKey = (key: string) => key.trim().toUpperCase();

/** A JQL string literal: backslashes and double quotes escaped, line breaks flattened. */
export const jqlString = (value: string) =>
  `"${value
    .replace(/[\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;

/** Status category ids, which JQL accepts on every site whatever its language. */
const CATEGORY_IDS = { new: 2, done: 3, indeterminate: 4 } as const;

const categories = (statuses: ReadonlyArray<WorkNativeStatus>) => [
  ...new Set(statuses.map((status) => CATEGORY_IDS[jiraCategoryFor(status)])),
];

/** The search for one page of a project's issues, newest first with a stable tie break. */
export const listJql = (projectKey: string, query: WorkListQuery): string => {
  const clauses = [`project = ${jqlString(projectKey)}`];
  if (query.statuses !== undefined && query.statuses.length > 0) {
    clauses.push(`statusCategory in (${categories(query.statuses).join(", ")})`);
  }
  if (query.assignee === "me") clauses.push("assignee = currentUser()");
  if (query.labels !== undefined && query.labels.length > 0) {
    clauses.push(`labels in (${query.labels.map(jqlString).join(", ")})`);
  }
  const search = query.search?.trim();
  if (search !== undefined && search.length > 0) clauses.push(`text ~ ${jqlString(search)}`);
  return `${clauses.join(" AND ")} ORDER BY updated DESC, key DESC`;
};

/** A search for specific issues, used to refresh linked items in one request. */
export const keysJql = (keys: ReadonlyArray<string>) =>
  `key in (${keys.map((key) => jqlString(normalizeIssueKey(key))).join(", ")})`;
