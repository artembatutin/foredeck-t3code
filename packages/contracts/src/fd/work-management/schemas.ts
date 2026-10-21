import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../../baseSchemas.ts";
import { ModelSelection } from "../../modelSelection.ts";
import { RuntimeMode } from "../../providerPolicy.ts";

/**
 * Work contracts. Nothing here imports `environment.ts`, `project.ts` or `orchestrationV2.ts`:
 * `environment.ts` imports this feature's index for the capability, so a reverse import would
 * close an ESM cycle that fails at module load. `imports.test.ts` locks that.
 */

/** Source kinds this build understands. A newer server's kinds decode as absent. */
export const WorkSourceKind = Schema.Literals(["markdown", "github", "jira"]);
export type WorkSourceKind = typeof WorkSourceKind.Type;

// Lowercased so a hand-edited uppercase UUID cannot pose as a second identity.
const WorkUuid = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isUUID()),
    SchemaTransformation.transform<string, string>({
      decode: (value) => value.toLowerCase(),
      encode: (value) => value,
    }),
  ),
);

/** Server-minted identity of a configured source; stable across disconnect and restore. */
export const WorkSourceId = WorkUuid.pipe(Schema.brand("WorkSourceId"));
export type WorkSourceId = typeof WorkSourceId.Type;

/**
 * The source's own key for an item: `fd-7k3qa2` (Markdown frontmatter id), `123` (GitHub
 * issue number) or `PROJ-12` (Jira key). Humans and agents type it, so it is short.
 */
export const WorkItemId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
).pipe(Schema.brand("WorkItemId"));
export type WorkItemId = typeof WorkItemId.Type;

/** Canonical item identity. Titles, filenames and URLs are mutable locators. */
export const WorkItemRef = Schema.Struct({ sourceId: WorkSourceId, itemId: WorkItemId });
export type WorkItemRef = typeof WorkItemRef.Type;

/** `<sourceId>:<itemId>`, the one-string form for route params, prompts and tool inputs. */
export const workItemRefString = (ref: WorkItemRef): string => `${ref.sourceId}:${ref.itemId}`;

const decodeWorkItemRef = Schema.decodeUnknownOption(WorkItemRef);

/** The inverse of `workItemRefString`; undefined for anything else. */
export const parseWorkItemRefString = (value: string): WorkItemRef | undefined => {
  const at = value.indexOf(":");
  if (at <= 0) return undefined;
  const decoded = decodeWorkItemRef({ sourceId: value.slice(0, at), itemId: value.slice(at + 1) });
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/**
 * A dedicated child directory of the project root as a normalized POSIX path. The server
 * still resolves it against the canonical root and rejects symlink escapes on every use.
 */
export const WorkProjectDirectory = Schema.String.check(
  Schema.isBetweenLength(1, 1024),
  Schema.makeFilter((value: string) => {
    if (/[\\\p{Cc}]/u.test(value)) return "Use forward slashes and no control characters.";
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      return "Use a directory relative to the project root.";
    }
    for (const segment of value.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        return "Use a normalized path without empty, '.' or '..' segments.";
      }
      if (segment.toLowerCase() === ".git") return "Choose a directory outside Git metadata.";
    }
    return true;
  }),
);
export type WorkProjectDirectory = typeof WorkProjectDirectory.Type;

export const WorkItemTitle = Schema.String.check(
  Schema.isBetweenLength(1, 512),
  Schema.makeFilter(
    (value: string) =>
      (value.trim().length > 0 && !/[\r\n]/.test(value)) || "Use a nonblank single-line title.",
  ),
);
export type WorkItemTitle = typeof WorkItemTitle.Type;

export const WorkSearchText = Schema.String.check(Schema.isMaxLength(2000));

/** Per-source configuration. The Jira API token travels separately and is never stored here. */
export const WorkMarkdownSourceConfig = Schema.Struct({
  kind: Schema.Literal("markdown"),
  directory: WorkProjectDirectory,
  /** Mark a `todo` item `in_progress` when a thread is started from it. */
  autoStart: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export const WorkGitHubSourceConfig = Schema.Struct({
  kind: Schema.Literal("github"),
  host: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export const WorkJiraSourceConfig = Schema.Struct({
  kind: Schema.Literal("jira"),
  siteUrl: TrimmedNonEmptyString,
  projectKey: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
});
export const WorkSourceConfig = Schema.Union([
  WorkMarkdownSourceConfig,
  WorkGitHubSourceConfig,
  WorkJiraSourceConfig,
]);
export type WorkSourceConfig = typeof WorkSourceConfig.Type;

export const WorkSourceHealthStatus = Schema.Literals([
  "ok",
  "auth_required",
  "rate_limited",
  "error",
]);
export type WorkSourceHealthStatus = typeof WorkSourceHealthStatus.Type;

export const WorkSourceHealth = Schema.Struct({
  status: WorkSourceHealthStatus,
  message: Schema.optionalKey(Schema.String),
  retryAt: Schema.optionalKey(IsoDateTime),
});
export type WorkSourceHealth = typeof WorkSourceHealth.Type;

const WORK_NATIVE_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;

/** Statuses Work can write. `blocked` is derived from open blockers, never stored. */
export const WorkNativeStatus = Schema.Literals(WORK_NATIVE_STATUSES);
export type WorkNativeStatus = typeof WorkNativeStatus.Type;
export const isWorkNativeStatus = Schema.is(WorkNativeStatus);

/**
 * An item's observed status. A value this build does not know decodes as read-only
 * `unknown`, never as done; check writability with `isWorkNativeStatus`.
 */
export const WorkStatus = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals([...WORK_NATIVE_STATUSES, "unknown"]),
    SchemaTransformation.transform<WorkNativeStatus | "unknown", string>({
      decode: (value) => (isWorkNativeStatus(value) ? value : "unknown"),
      encode: (value) => value,
    }),
  ),
);
export type WorkStatus = typeof WorkStatus.Type;

export const WorkPriority = Schema.Literals(["high", "medium", "low"]);
export type WorkPriority = typeof WorkPriority.Type;

/** A person as the source names them: a GitHub login, a Jira account id, free text for Markdown. */
export const WorkPerson = Schema.Struct({ id: Schema.String, label: Schema.String });
export type WorkPerson = typeof WorkPerson.Type;

export const WorkItemField = Schema.Literals([
  "title",
  "body",
  "priority",
  "labels",
  "assignee",
  "parent",
  "blockedBy",
]);
export type WorkItemField = typeof WorkItemField.Type;

/** What a source can do, declared per adapter rather than probed. Surfaces hide the rest. */
export const WorkSourceCapabilities = Schema.Struct({
  create: Schema.Boolean,
  // Literal sets inside list payloads grow over time; an unknown member drops its entry, never
  // the response.
  statuses: ForwardCompatibleArray(WorkNativeStatus),
  fields: ForwardCompatibleArray(WorkItemField),
  comments: Schema.Literals(["none", "add"]),
  transitions: Schema.Boolean,
  people: Schema.Boolean,
});
export type WorkSourceCapabilities = typeof WorkSourceCapabilities.Type;

export const WorkSourceState = Schema.Literals(["active", "disconnected"]);
export type WorkSourceState = typeof WorkSourceState.Type;

export const WorkSource = Schema.Struct({
  sourceId: WorkSourceId,
  projectId: ProjectId,
  kind: WorkSourceKind,
  /** `<directory>`, `host/owner/name` or `host/PROJECTKEY`: unique among a project's live sources. */
  identity: Schema.String,
  label: TrimmedNonEmptyString,
  config: WorkSourceConfig,
  state: WorkSourceState,
  version: NonNegativeInt,
  credential: Schema.Struct({ configured: Schema.Boolean }),
  capabilities: WorkSourceCapabilities,
  health: WorkSourceHealth,
  updatedAt: IsoDateTime,
});
export type WorkSource = typeof WorkSource.Type;

/** A source of a kind this build cannot read is dropped, not fatal to the list. */
export const WorkSourceList = Schema.Struct({ sources: ForwardCompatibleArray(WorkSource) });
export type WorkSourceList = typeof WorkSourceList.Type;

export const WorkSourcesListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  includeDisconnected: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type WorkSourcesListInput = typeof WorkSourcesListInput.Type;

export const WorkSourceSaveInput = Schema.Struct({
  /** Absent creates (or revives a disconnected source with the same identity). */
  sourceId: Schema.optionalKey(WorkSourceId),
  projectId: ProjectId,
  label: TrimmedNonEmptyString,
  config: WorkSourceConfig,
  /** Write-only: stored on the server, never returned. */
  apiToken: Schema.optionalKey(TrimmedNonEmptyString),
  /** Removes the stored token for every source sharing it. */
  credential: Schema.optionalKey(Schema.Literal("clear")),
  expectedVersion: Schema.optionalKey(NonNegativeInt),
}).check(
  Schema.makeFilter((input) =>
    input.apiToken !== undefined && input.credential !== undefined
      ? "Give a new token or clear the stored one, not both."
      : true,
  ),
);
export type WorkSourceSaveInput = typeof WorkSourceSaveInput.Type;

export const WorkSourceRefInput = Schema.Struct({
  sourceId: WorkSourceId,
  expectedVersion: Schema.optionalKey(NonNegativeInt),
});
export type WorkSourceRefInput = typeof WorkSourceRefInput.Type;

export const WorkSourceTestInput = Schema.Struct({
  projectId: ProjectId,
  /** An existing source whose stored token applies when none is given. */
  sourceId: Schema.optionalKey(WorkSourceId),
  config: WorkSourceConfig,
  apiToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkSourceTestInput = typeof WorkSourceTestInput.Type;

export const WorkSourceTestResult = Schema.Struct({
  ok: Schema.Boolean,
  identity: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
export type WorkSourceTestResult = typeof WorkSourceTestResult.Type;

export const WorkItemSummary = Schema.Struct({
  ref: WorkItemRef,
  kind: WorkSourceKind,
  /** Display key: `fd-7k3qa2`, `#123`, `PROJ-12`. */
  key: Schema.String,
  title: WorkItemTitle,
  status: WorkStatus,
  nativeStatus: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  blocked: Schema.Boolean,
  priority: ForwardCompatibleNullable(WorkPriority),
  labels: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  assignee: Schema.NullOr(WorkPerson),
  parent: Schema.NullOr(WorkItemId),
  blockedBy: Schema.Array(WorkItemId).check(Schema.isMaxLength(50)),
  url: Schema.NullOr(Schema.String),
  /** The source's internal id (GitHub node id, Jira numeric id), when it differs from the key. */
  nativeId: Schema.optionalKey(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
  /** Opaque optimistic-concurrency token; writes carrying a stale one are refused. */
  revision: Schema.String,
  /** Present when the item is read-only because its source record cannot be read. */
  invalid: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
export type WorkItemSummary = typeof WorkItemSummary.Type;

export const WorkComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(WorkPerson),
  body: Schema.String.check(Schema.isMaxLength(16_000)),
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type WorkComment = typeof WorkComment.Type;

export const WorkTransition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  to: WorkStatus,
  toName: Schema.String,
  /** Needs fields beyond a resolution; listed but refused in this build. */
  requiresFields: Schema.Boolean,
});
export type WorkTransition = typeof WorkTransition.Type;

export const WorkThreadMode = Schema.Literals(["scope", "plan", "implement"]);
export type WorkThreadMode = typeof WorkThreadMode.Type;

export const WorkThreadLinkSource = Schema.Literals(["started", "manual", "agent"]);
export type WorkThreadLinkSource = typeof WorkThreadLinkSource.Type;

/** A thread attached to an item. The snapshot is what the thread was started from. */
export const WorkThreadLink = Schema.Struct({
  ref: WorkItemRef,
  threadId: ThreadId,
  source: WorkThreadLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.Struct({
    key: Schema.String,
    title: Schema.String,
    status: WorkStatus,
    url: Schema.NullOr(Schema.String),
    revision: Schema.String,
    mode: ForwardCompatibleOptional(WorkThreadMode),
    /** Work moved the item to `in_progress` on start, so a failed run may offer to undo it. */
    autoStarted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  /** The last terminal run outcome the server saw: the item-side trace of a stop or failure. */
  run: Schema.NullOr(Schema.Struct({ status: Schema.String, at: IsoDateTime })),
});
export type WorkThreadLink = typeof WorkThreadLink.Type;

export const WorkItemChild = Schema.Struct({
  itemId: WorkItemId,
  key: Schema.String,
  title: Schema.String,
  status: WorkStatus,
});
export type WorkItemChild = typeof WorkItemChild.Type;

export const WorkItemDetail = Schema.Struct({
  ...WorkItemSummary.fields,
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  bodyTruncated: Schema.Boolean,
  /** `lossy` when the source's rich text lost content on the way to Markdown. */
  bodyFidelity: Schema.Literals(["exact", "lossy"]),
  /** Bounded by the adapter (`COMMENTS_MAX`); `commentsTruncated` says when it cut. */
  comments: ForwardCompatibleArray(WorkComment),
  commentsTruncated: Schema.Boolean,
  children: ForwardCompatibleArray(WorkItemChild),
  blocking: Schema.Array(WorkItemId),
  links: ForwardCompatibleArray(WorkThreadLink),
  transitions: ForwardCompatibleArray(WorkTransition),
  capabilities: WorkSourceCapabilities,
  /** The Markdown file's project-relative path. */
  locator: Schema.optionalKey(Schema.String),
});
export type WorkItemDetail = typeof WorkItemDetail.Type;

export const WorkItemGetInput = Schema.Struct({ ref: WorkItemRef });
export type WorkItemGetInput = typeof WorkItemGetInput.Type;

export const WorkListQuery = Schema.Struct({
  sourceId: WorkSourceId,
  search: Schema.optionalKey(WorkSearchText),
  statuses: Schema.optionalKey(Schema.Array(WorkNativeStatus)),
  assignee: Schema.optionalKey(Schema.Literals(["me"])),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Opaque continuation from the previous page. */
  cursor: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 2048))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(50)),
  ),
});
export type WorkListQuery = typeof WorkListQuery.Type;

export const WorkListResult = Schema.Struct({
  items: ForwardCompatibleArray(WorkItemSummary),
  nextCursor: Schema.NullOr(Schema.String),
  /** The source could not be read completely (for example past its file cap). */
  stale: Schema.Boolean,
});
export type WorkListResult = typeof WorkListResult.Type;

export const WorkPeopleQuery = Schema.Struct({
  sourceId: WorkSourceId,
  query: Schema.String.check(Schema.isMaxLength(200)),
  /** Narrows to people assignable on this item, where the source distinguishes. */
  itemId: Schema.optionalKey(WorkItemId),
});
export type WorkPeopleQuery = typeof WorkPeopleQuery.Type;

export const WorkPeopleResult = Schema.Struct({ people: Schema.Array(WorkPerson) });
export type WorkPeopleResult = typeof WorkPeopleResult.Type;

/** Stable key a client resends on retry of a non-idempotent write (create, comment). */
const WorkClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const WorkItemCreateInput = Schema.Struct({
  sourceId: WorkSourceId,
  title: WorkItemTitle,
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65_536))),
  priority: Schema.optionalKey(WorkPriority),
  labels: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
  assignee: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(WorkItemId),
  clientRequestId: Schema.optionalKey(WorkClientRequestId),
});
export type WorkItemCreateInput = typeof WorkItemCreateInput.Type;

/** Labels change by add and remove so a concurrent remote edit is not overwritten. */
export const WorkLabelsPatch = Schema.Struct({
  add: Schema.Array(Schema.String),
  remove: Schema.Array(Schema.String),
});
export type WorkLabelsPatch = typeof WorkLabelsPatch.Type;

export const WorkItemPatch = Schema.Struct({
  ref: WorkItemRef,
  /** Required by the service for title and body writes; optional for field writes. */
  expectedRevision: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(WorkItemTitle),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65_536))),
  priority: Schema.optionalKey(Schema.NullOr(WorkPriority)),
  labels: Schema.optionalKey(WorkLabelsPatch),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: Schema.optionalKey(Schema.NullOr(WorkItemId)),
  blockedBy: Schema.optionalKey(Schema.Array(WorkItemId).check(Schema.isMaxLength(50))),
});
export type WorkItemPatch = typeof WorkItemPatch.Type;

export const WorkSetStatusInput = Schema.Struct({
  ref: WorkItemRef,
  status: Schema.optionalKey(WorkNativeStatus),
  /** A source-native transition, used when `status` alone is ambiguous. */
  transitionId: Schema.optionalKey(Schema.String),
  expectedRevision: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter((input) =>
    (input.status === undefined) !== (input.transitionId === undefined)
      ? true
      : "Give exactly one of status or transitionId.",
  ),
);
export type WorkSetStatusInput = typeof WorkSetStatusInput.Type;

export const WorkCommentInput = Schema.Struct({
  ref: WorkItemRef,
  body: Schema.String.check(Schema.isBetweenLength(1, 16_000)),
  clientRequestId: Schema.optionalKey(WorkClientRequestId),
});
export type WorkCommentInput = typeof WorkCommentInput.Type;

export const WorkCommentResult = Schema.Struct({ commentId: Schema.NullOr(Schema.String) });
export type WorkCommentResult = typeof WorkCommentResult.Type;

/** At most one selector; none means every open link in the environment, bounded. */
export const WorkLinksQuery = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  ref: Schema.optionalKey(WorkItemRef),
  projectId: Schema.optionalKey(ProjectId),
}).check(
  Schema.makeFilter((query) =>
    [query.threadId, query.ref, query.projectId].filter((value) => value !== undefined).length <= 1
      ? true
      : "Give at most one of threadId, ref or projectId.",
  ),
);
export type WorkLinksQuery = typeof WorkLinksQuery.Type;

export const WorkLinksResult = Schema.Struct({
  links: ForwardCompatibleArray(WorkThreadLink),
  truncated: Schema.Boolean,
});
export type WorkLinksResult = typeof WorkLinksResult.Type;

export const WorkLinkSetInput = Schema.Struct({
  ref: WorkItemRef,
  threadId: ThreadId,
  action: Schema.Literals(["link", "unlink"]),
});
export type WorkLinkSetInput = typeof WorkLinkSetInput.Type;

export const WorkLinkSetResult = Schema.Struct({ linked: Schema.Boolean });
export type WorkLinkSetResult = typeof WorkLinkSetResult.Type;

/** The selectors are hints kept for forward compatibility; the server refreshes every source. */
export const WorkRefreshInput = Schema.Struct({
  sourceId: Schema.optionalKey(WorkSourceId),
  projectId: Schema.optionalKey(ProjectId),
});
export type WorkRefreshInput = typeof WorkRefreshInput.Type;

/** Who started the thread; the MCP path sets `mcp` server-side. */
export const WorkCreationSource = Schema.Literals(["web", "mobile"]);
export type WorkCreationSource = typeof WorkCreationSource.Type;

/** Mapped to the orchestration launch strategy server-side; `baseRef` is always `HEAD`. */
export const WorkWorkspaceStrategy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type WorkWorkspaceStrategy = typeof WorkWorkspaceStrategy.Type;

export const WorkStartThreadInput = Schema.Struct({
  ref: WorkItemRef,
  /** Client-minted so a lost response retried with the same id replays the same launch. */
  threadId: Schema.optionalKey(ThreadId),
  creationSource: WorkCreationSource,
  mode: WorkThreadMode.pipe(Schema.withDecodingDefault(Effect.succeed("implement" as const))),
  workspaceStrategy: Schema.optionalKey(WorkWorkspaceStrategy),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /** Appended to the generated prompt. */
  prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
  /** Start another thread even though an open one is already linked. */
  force: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type WorkStartThreadInput = typeof WorkStartThreadInput.Type;

export const WorkStartThreadResult = Schema.Struct({
  threadId: ThreadId,
  /** An open linked thread was returned instead of a new launch. */
  resumed: Schema.Boolean,
});
export type WorkStartThreadResult = typeof WorkStartThreadResult.Type;

const WORK_ERROR_REASONS = [
  "invalid_request",
  "not_found",
  "forbidden",
  "unsupported",
  "stale",
  "conflict",
  "unavailable",
  "unauthenticated",
  "rate_limited",
] as const;
export type WorkErrorReasonValue = (typeof WORK_ERROR_REASONS)[number];
const isWorkErrorReason = Schema.is(Schema.Literals(WORK_ERROR_REASONS));

/**
 * `stale`: the expected revision no longer matches; `current` carries the item as it is now.
 * `conflict`: the request is ambiguous or collides; `candidates` lists transitions to pick from.
 * `unavailable`: the source is disconnected, unreachable, or the reason is one this build
 * does not know (a newer server's reasons decode here rather than failing).
 */
export const WorkErrorReason = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(WORK_ERROR_REASONS),
    SchemaTransformation.transform<WorkErrorReasonValue, string>({
      decode: (value) => (isWorkErrorReason(value) ? value : "unavailable"),
      encode: (value) => value,
    }),
  ),
);
export type WorkErrorReason = typeof WorkErrorReason.Type;

export class WorkError extends Schema.TaggedError<WorkError>()("WorkError", {
  reason: WorkErrorReason,
  message: Schema.String,
  retryAt: Schema.optionalKey(IsoDateTime),
  current: Schema.optionalKey(WorkItemSummary),
  candidates: Schema.optionalKey(Schema.Array(WorkTransition)),
}) {}
