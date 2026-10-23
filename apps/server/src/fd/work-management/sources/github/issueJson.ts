import {
  type WorkComment,
  type WorkItemChild,
  WorkItemId,
  type WorkItemSummary,
  type WorkSourceId,
  type WorkStatus,
} from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import { COMMENTS_MAX, BODY_MAX_CHARS, truncateText } from "../../model/bounds.ts";
import { fromGitHubState, type GitHubStateReason } from "../../model/status.ts";
import type { WorkSourceItemDetail } from "../WorkSourceAdapter.ts";

/**
 * The GitHub issue JSON Work reads, decoded leniently: optional fields an older server omits
 * stay absent instead of failing the read, and enum values GitHub adds later read as unknown.
 */

const Connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(Schema.NullOr(node)) });

const Actor = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

export const IssueSummaryJson = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  updatedAt: Schema.String,
  labels: Schema.optional(Schema.NullOr(Connection(Schema.Struct({ name: Schema.String })))),
  assignees: Schema.optional(Schema.NullOr(Connection(Actor))),
  parent: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Int }))),
  issueDependenciesSummary: Schema.optional(
    Schema.NullOr(Schema.Struct({ totalBlockedBy: Schema.Int })),
  ),
  blockedBy: Schema.optional(
    Schema.NullOr(Connection(Schema.Struct({ number: Schema.Int, state: Schema.String }))),
  ),
});
export type IssueSummaryJson = typeof IssueSummaryJson.Type;

export const IssueDetailJson = Schema.Struct({
  ...IssueSummaryJson.fields,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  subIssues: Schema.optional(
    Schema.NullOr(
      Connection(
        Schema.Struct({
          number: Schema.Int,
          title: Schema.String,
          state: Schema.String,
          stateReason: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  blocking: Schema.optional(Schema.NullOr(Connection(Schema.Struct({ number: Schema.Int })))),
  comments: Schema.Struct({
    totalCount: Schema.Int,
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          body: Schema.String,
          createdAt: Schema.String,
          updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
        }),
      ),
    ),
  }),
});
export type IssueDetailJson = typeof IssueDetailJson.Type;

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

export const IssueListResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(
        Schema.Struct({
          issues: Schema.Struct({
            pageInfo: PageInfo,
            nodes: Schema.Array(Schema.NullOr(IssueSummaryJson)),
          }),
        }),
      ),
    }),
  }),
);

/** Search nodes are a union; anything that is not an issue arrives as an empty object. */
export const IssueSearchResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      search: Schema.Struct({
        pageInfo: PageInfo,
        nodes: Schema.Array(Schema.NullOr(Schema.Unknown)),
      }),
    }),
  }),
);

export const IssueDetailResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(IssueDetailJson) })),
    }),
  }),
);

export const IssueSnapshotsResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(IssueSummaryJson))),
    }),
  }),
);

export const AssignableUsersResponse = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(Schema.Struct({ assignableUsers: Connection(Actor) })),
    }),
  }),
);

/** The REST shapes a write answers with. */
export const RestIssueJson = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Int,
    node_id: Schema.String,
    updated_at: Schema.String,
    pull_request: Schema.optional(Schema.Unknown),
  }),
);
export const RestCommentJson = Schema.fromJsonString(Schema.Struct({ id: Schema.Number }));
export const RestRepositoryJson = Schema.fromJsonString(
  Schema.Struct({
    full_name: Schema.String,
    has_issues: Schema.optional(Schema.Boolean),
    permissions: Schema.optional(Schema.Struct({ push: Schema.optional(Schema.Boolean) })),
  }),
);
export const RestUserJson = Schema.fromJsonString(Schema.Struct({ login: Schema.String }));

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "completed",
  "not_planned",
  "duplicate",
  "reopened",
]);

/** An issue's Work status from GraphQL's upper-case enums. */
export const issueStatus = (state: string, stateReason: string | null | undefined): WorkStatus => {
  const normalizedState = state.toLowerCase();
  if (normalizedState !== "open" && normalizedState !== "closed") return "unknown";
  const reason = stateReason?.toLowerCase();
  return fromGitHubState(
    normalizedState,
    reason !== undefined && KNOWN_REASONS.has(reason) ? (reason as GitHubStateReason) : null,
  );
};

/** `updated_at|node_id`: an edit anywhere on the issue moves it. */
export const issueRevision = (updatedAt: string, nodeId: string) => `${updatedAt}|${nodeId}`;

const nodes = <A>(connection: { readonly nodes: ReadonlyArray<A | null> } | null | undefined) =>
  (connection?.nodes ?? []).filter((node): node is A => node !== null);

const isOpenState = (state: string) => state.toUpperCase() === "OPEN";

export const toSummary = (sourceId: WorkSourceId, issue: IssueSummaryJson): WorkItemSummary => {
  const blockers = nodes(issue.blockedBy);
  const assignee = nodes(issue.assignees)[0];
  return {
    ref: { sourceId, itemId: WorkItemId.make(String(issue.number)) },
    kind: "github",
    key: `#${issue.number}`,
    title:
      issue.title.trim().length === 0
        ? `Issue #${issue.number}`
        : issue.title.replace(/[\r\n]+/g, " ").slice(0, 512),
    status: issueStatus(issue.state, issue.stateReason),
    nativeStatus: null,
    blocked:
      (issue.issueDependenciesSummary?.totalBlockedBy ?? 0) > 0 ||
      blockers.some((blocker) => isOpenState(blocker.state)),
    priority: null,
    labels: nodes(issue.labels)
      .map((label) => label.name)
      .slice(0, 32),
    assignee:
      assignee === undefined
        ? null
        : { id: assignee.login, label: assignee.name ?? assignee.login },
    parent: issue.parent ? WorkItemId.make(String(issue.parent.number)) : null,
    blockedBy: blockers.map((blocker) => WorkItemId.make(String(blocker.number))).slice(0, 50),
    url: issue.url,
    nativeId: issue.id,
    updatedAt: issue.updatedAt,
    revision: issueRevision(issue.updatedAt, issue.id),
    invalid: null,
  };
};

export const toDetail = (sourceId: WorkSourceId, issue: IssueDetailJson): WorkSourceItemDetail => {
  const body = truncateText(issue.body ?? "", BODY_MAX_CHARS);
  const comments: Array<WorkComment> = nodes(issue.comments)
    .slice(-COMMENTS_MAX)
    .map((comment) => ({
      id: comment.id,
      author: comment.author ? { id: comment.author.login, label: comment.author.login } : null,
      body: truncateText(comment.body, 16_000).text,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt ?? null,
    }));
  const children: Array<WorkItemChild> = nodes(issue.subIssues).map((child) => ({
    itemId: WorkItemId.make(String(child.number)),
    key: `#${child.number}`,
    title: child.title,
    status: issueStatus(child.state, child.stateReason),
  }));
  return {
    ...toSummary(sourceId, issue),
    body: body.text,
    bodyTruncated: body.truncated,
    bodyFidelity: "exact",
    comments,
    commentsTruncated: issue.comments.totalCount > comments.length,
    children,
    blocking: nodes(issue.blocking).map((entry) => WorkItemId.make(String(entry.number))),
    transitions: [],
  };
};
