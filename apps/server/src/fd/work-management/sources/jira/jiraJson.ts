import {
  type WorkComment,
  WorkItemId,
  type WorkItemSummary,
  type WorkPriority,
  type WorkSourceId,
  type WorkTransition,
} from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BODY_MAX_CHARS, COMMENTS_MAX, truncateText } from "../../model/bounds.ts";
import { fromJiraStatusCategory } from "../../model/status.ts";
import type { WorkSourceItemDetail } from "../WorkSourceAdapter.ts";
import { adfToMarkdown } from "./adf.ts";
import { normalizeIssueKey } from "./jql.ts";

/** The Jira issue JSON Work reads. Every field is optional: workflows and screens hide fields. */

const StatusJson = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  statusCategory: Schema.optional(Schema.Struct({ key: Schema.optional(Schema.String) })),
});

const LinkedIssueJson = Schema.Struct({
  key: Schema.String,
  fields: Schema.optional(Schema.Struct({ status: Schema.optional(StatusJson) })),
});

export const IssueFieldsJson = Schema.Struct({
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(StatusJson)),
  resolution: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
  assignee: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ accountId: Schema.String, displayName: Schema.optional(Schema.String) }),
    ),
  ),
  priority: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) }))),
  parent: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
  updated: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  issuelinks: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
          inwardIssue: Schema.optional(LinkedIssueJson),
          outwardIssue: Schema.optional(LinkedIssueJson),
        }),
      ),
    ),
  ),
  subtasks: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          key: Schema.String,
          fields: Schema.optional(
            Schema.Struct({
              summary: Schema.optional(Schema.String),
              status: Schema.optional(StatusJson),
            }),
          ),
        }),
      ),
    ),
  ),
  description: Schema.optional(Schema.Unknown),
});

const TransitionJson = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  to: Schema.optional(StatusJson),
  fields: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        required: Schema.optional(Schema.Boolean),
        allowedValues: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type TransitionJson = typeof TransitionJson.Type;

export const IssueJson = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: IssueFieldsJson,
  transitions: Schema.optional(Schema.Array(TransitionJson)),
});
export type IssueJson = typeof IssueJson.Type;

export const SearchResponse = Schema.fromJsonString(
  Schema.Struct({
    issues: Schema.Array(IssueJson),
    nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
    isLast: Schema.optional(Schema.Boolean),
  }),
);
export const IssueResponse = Schema.fromJsonString(IssueJson);
export const CommentsResponse = Schema.fromJsonString(
  Schema.Struct({
    startAt: Schema.optional(Schema.Int),
    total: Schema.optional(Schema.Int),
    comments: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              accountId: Schema.optional(Schema.String),
              displayName: Schema.optional(Schema.String),
            }),
          ),
        ),
        body: Schema.optional(Schema.Unknown),
        created: Schema.String,
        updated: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
export const TransitionsResponse = Schema.fromJsonString(
  Schema.Struct({ transitions: Schema.Array(TransitionJson) }),
);
export const UsersResponse = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ accountId: Schema.String, displayName: Schema.optional(Schema.String) }),
  ),
);
export const CreatedResponse = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, key: Schema.String }),
);
export const CommentCreatedResponse = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
export const IssueTypesResponse = Schema.fromJsonString(
  Schema.Struct({
    issueTypes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          subtask: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
    values: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          subtask: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  }),
);
export const MyselfResponse = Schema.fromJsonString(Schema.Struct({ accountId: Schema.String }));
export const ProjectResponse = Schema.fromJsonString(Schema.Struct({ key: Schema.String }));
export const ServerInfoResponse = Schema.fromJsonString(
  Schema.Struct({ deploymentType: Schema.optional(Schema.String) }),
);

/** The fields a search asks for; everything else Jira would send stays on the server. */
export const SEARCH_FIELDS = [
  "summary",
  "status",
  "resolution",
  "assignee",
  "issuetype",
  "priority",
  "parent",
  "updated",
  "created",
  "labels",
  "issuelinks",
] as const;

const PRIORITY_BY_NAME: Readonly<Record<string, WorkPriority>> = {
  highest: "high",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "low",
};

export const PRIORITY_NAMES: Readonly<Record<WorkPriority, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const statusOf = (
  status: typeof StatusJson.Type | null | undefined,
  resolution: string | null | undefined,
) => fromJiraStatusCategory(status?.statusCategory?.key ?? "", resolution);

/** Blocked by an inward "Blocks" link to an issue that is not done. */
const blockersOf = (fields: typeof IssueFieldsJson.Type) =>
  (fields.issuelinks ?? []).flatMap((link) =>
    link.type?.name === "Blocks" &&
    link.inwardIssue !== undefined &&
    link.inwardIssue.fields?.status?.statusCategory?.key !== "done"
      ? [WorkItemId.make(normalizeIssueKey(link.inwardIssue.key))]
      : [],
  );

const blockingOf = (fields: typeof IssueFieldsJson.Type) =>
  (fields.issuelinks ?? []).flatMap((link) =>
    link.type?.name === "Blocks" && link.outwardIssue !== undefined
      ? [WorkItemId.make(normalizeIssueKey(link.outwardIssue.key))]
      : [],
  );

export const toSummary = (
  sourceId: WorkSourceId,
  siteOrigin: string,
  issue: IssueJson,
): WorkItemSummary => {
  const key = normalizeIssueKey(issue.key);
  const fields = issue.fields;
  const blockers = blockersOf(fields);
  const updated = fields.updated ?? null;
  const summary = (fields.summary ?? "").replace(/[\r\n]+/g, " ").trim();
  return {
    ref: { sourceId, itemId: WorkItemId.make(key) },
    kind: "jira",
    key,
    title: summary.length === 0 ? key : summary.slice(0, 512),
    status: statusOf(fields.status, fields.resolution?.name),
    nativeStatus:
      fields.status?.name === undefined
        ? null
        : { id: fields.status.id ?? fields.status.name, name: fields.status.name },
    blocked: blockers.length > 0,
    priority: PRIORITY_BY_NAME[(fields.priority?.name ?? "").toLowerCase()] ?? null,
    labels: (fields.labels ?? []).slice(0, 32),
    assignee:
      fields.assignee === null || fields.assignee === undefined
        ? null
        : {
            id: fields.assignee.accountId,
            label: fields.assignee.displayName ?? fields.assignee.accountId,
          },
    parent: fields.parent ? WorkItemId.make(normalizeIssueKey(fields.parent.key)) : null,
    blockedBy: blockers.slice(0, 50),
    url: `${siteOrigin}/browse/${key}`,
    nativeId: issue.id,
    updatedAt: updated === null ? null : normalizeTimestamp(updated),
    revision: updated ?? `${issue.id}`,
    invalid: null,
  };
};

/** Jira writes `2026-10-20T10:00:00.000+0000`; Work's contracts want an ISO instant. */
export const normalizeTimestamp = (value: string): string =>
  Option.match(DateTime.make(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });

/** A transition as Work offers it; one that needs fields beyond a resolution is listed but refused. */
export const toTransition = (transition: TransitionJson): WorkTransition => {
  const required = Object.entries(transition.fields ?? {}).filter(
    ([name, field]) => field.required === true && name !== "resolution",
  );
  return {
    id: transition.id,
    name: transition.name,
    to: statusOf(transition.to, undefined),
    toName: transition.to?.name ?? transition.name,
    requiresFields: required.length > 0,
  };
};

type CommentJson = (typeof CommentsResponse.Type)["comments"][number];

/** A comment's text, as Markdown from its ADF body, whole. */
export const commentText = (comment: CommentJson) => adfToMarkdown(comment.body ?? null).markdown;

export const toComment = (comment: CommentJson): WorkComment => ({
  id: comment.id,
  author:
    comment.author === null || comment.author === undefined
      ? null
      : {
          id: comment.author.accountId ?? "",
          label: comment.author.displayName ?? comment.author.accountId ?? "Unknown",
        },
  body: truncateText(commentText(comment), 16_000).text,
  createdAt: normalizeTimestamp(comment.created),
  updatedAt: comment.updated ? normalizeTimestamp(comment.updated) : null,
});

export const toDetail = (
  sourceId: WorkSourceId,
  siteOrigin: string,
  issue: IssueJson,
  comments: typeof CommentsResponse.Type,
): WorkSourceItemDetail => {
  const body = adfToMarkdown(issue.fields.description ?? null);
  const bounded = truncateText(body.markdown, BODY_MAX_CHARS);
  // Comments arrive newest first; the detail shows them oldest first like every other source.
  const shown: Array<WorkComment> = comments.comments
    .toReversed()
    .slice(-COMMENTS_MAX)
    .map(toComment);
  return {
    ...toSummary(sourceId, siteOrigin, issue),
    body: bounded.text,
    bodyTruncated: bounded.truncated,
    bodyFidelity: body.lossy ? "lossy" : "exact",
    comments: shown,
    commentsTruncated: (comments.total ?? comments.comments.length) > shown.length,
    children: (issue.fields.subtasks ?? []).map((subtask) => ({
      itemId: WorkItemId.make(normalizeIssueKey(subtask.key)),
      key: normalizeIssueKey(subtask.key),
      title: subtask.fields?.summary ?? subtask.key,
      status: statusOf(subtask.fields?.status, undefined),
    })),
    blocking: blockingOf(issue.fields),
    transitions: (issue.transitions ?? []).map(toTransition),
  };
};
