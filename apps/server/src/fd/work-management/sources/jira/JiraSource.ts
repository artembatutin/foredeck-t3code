import type { WorkItemSummary, WorkSourceConfig } from "@t3tools/contracts/fd/work-management";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type WorkDomainError,
  WorkConflict,
  WorkInvalid,
  WorkStale,
  WorkUnauthenticated,
  WorkUnavailable,
  WorkUnsupported,
} from "../../errors.ts";
import { JIRA_WRITABLE_STATUSES, jiraCategoryFor } from "../../model/status.ts";
import type { WorkSourceAdapter, WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import { markdownToAdf } from "./adf.ts";
import * as JiraApi from "./JiraApi.ts";
import {
  CommentCreatedResponse,
  CommentsResponse,
  CreatedResponse,
  IssueResponse,
  IssueTypesResponse,
  MyselfResponse,
  PRIORITY_NAMES,
  ProjectResponse,
  SEARCH_FIELDS,
  SearchResponse,
  ServerInfoResponse,
  toDetail,
  toSummary,
  toTransition,
  TransitionsResponse,
  UsersResponse,
} from "./jiraJson.ts";
import { JIRA_PROJECT_KEY, keysJql, listJql, normalizeIssueKey } from "./jql.ts";

type JiraConfig = Extract<WorkSourceConfig, { readonly kind: "jira" }>;

/** Writes to issues recently written are named in searches so Jira's index catches up. */
const RECONCILE_WINDOW_MS = 2 * 60_000;
const SNAPSHOT_BATCH = 50;
const PREFERRED_TYPES = ["task", "story"];

const decodeSearch = Schema.decodeEffect(SearchResponse);
const decodeIssue = Schema.decodeEffect(IssueResponse);
const decodeComments = Schema.decodeEffect(CommentsResponse);
const decodeTransitions = Schema.decodeEffect(TransitionsResponse);
const decodeUsers = Schema.decodeEffect(UsersResponse);
const decodeCreated = Schema.decodeEffect(CreatedResponse);
const decodeCommentCreated = Schema.decodeEffect(CommentCreatedResponse);
const decodeIssueTypes = Schema.decodeEffect(IssueTypesResponse);
const decodeMyself = Schema.decodeEffect(MyselfResponse);
const decodeProject = Schema.decodeEffect(ProjectResponse);
const decodeServerInfo = Schema.decodeEffect(ServerInfoResponse);

const unexpected = () => new WorkUnavailable({ detail: "Jira answered in an unexpected shape." });

const configOf = (runtime: Pick<WorkSourceRuntime, "config">): JiraConfig => {
  if (runtime.config.kind !== "jira") throw new Error("A Jira source needs a Jira config.");
  return runtime.config;
};

const originOf = (config: JiraConfig) => {
  const site = JiraApi.jiraSiteOrigin(config.siteUrl);
  return "origin" in site ? site.origin : config.siteUrl;
};

export const jiraIdentity = (config: JiraConfig) =>
  `${new URL(originOf(config)).host.toLowerCase()}/${config.projectKey.trim().toUpperCase()}`;

export interface JiraSourceOptions extends JiraApi.JiraApiOptions {
  /** Minimum time between two writes to one issue; Jira limits per-issue write bursts. */
  readonly issueWriteSpacingMs?: number;
}

/** Jira Cloud issues of one project, through an unscoped API token stored on the server. */
export const make = (options: JiraSourceOptions = {}) =>
  Effect.gen(function* () {
    const api = yield* JiraApi.make(options);
    const spacing = options.issueWriteSpacingMs ?? 2_000;
    const issueLocks = new Map<string, Semaphore.Semaphore>();
    const lastIssueWrite = new Map<string, number>();
    /** Issue ids written recently per source, named in searches until the index has them. */
    const recentWrites = new Map<string, Map<string, number>>();

    const credentialOf = (runtime: Pick<WorkSourceRuntime, "config" | "secret">) =>
      runtime.secret === undefined
        ? undefined
        : { email: configOf(runtime).email, token: runtime.secret };

    const call = (runtime: WorkSourceRuntime, request: Omit<JiraApi.JiraRequest, "interactive">) =>
      api.request(configOf(runtime).siteUrl, credentialOf(runtime), {
        ...request,
        interactive: runtime.interactive,
      });

    const remember = (runtime: WorkSourceRuntime, issueId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const writes = recentWrites.get(runtime.sourceId) ?? new Map<string, number>();
          writes.set(issueId, now);
          recentWrites.set(runtime.sourceId, writes);
        }),
      );

    const reconcileIds = (runtime: WorkSourceRuntime) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const writes = recentWrites.get(runtime.sourceId);
          if (writes === undefined) return [];
          for (const [id, at] of writes) if (now - at > RECONCILE_WINDOW_MS) writes.delete(id);
          return [...writes.keys()].map(Number).filter(Number.isSafeInteger);
        }),
      );

    /** Writes to one issue run one at a time and spaced, which also absorbs per-issue limits. */
    const issueWrite = <A>(
      runtime: WorkSourceRuntime,
      key: string,
      effect: Effect.Effect<A, WorkDomainError>,
    ) =>
      Effect.suspend(() => {
        const lockKey = `${runtime.sourceId}\0${key}`;
        let lock = issueLocks.get(lockKey);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          issueLocks.set(lockKey, lock);
        }
        return lock.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const wait = (lastIssueWrite.get(lockKey) ?? 0) + spacing - now;
            if (spacing > 0 && wait > 0) yield* Effect.sleep(Duration.millis(wait));
            return yield* effect.pipe(
              Effect.ensuring(
                Clock.currentTimeMillis.pipe(
                  Effect.map((at) => void lastIssueWrite.set(lockKey, at)),
                ),
              ),
            );
          }),
        );
      });

    const readIssue = (runtime: WorkSourceRuntime, key: string, expand?: string) =>
      call(runtime, {
        operation: "jira.issue",
        path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
        query: { fields: "*navigable,-comment", ...(expand === undefined ? {} : { expand }) },
        itemId: key,
      }).pipe(
        Effect.flatMap((response) => decodeIssue(response.body).pipe(Effect.mapError(unexpected))),
      );

    const detail = (runtime: WorkSourceRuntime, itemId: string) =>
      Effect.gen(function* () {
        const key = normalizeIssueKey(itemId);
        const issue = yield* readIssue(runtime, key, "transitions");
        const comments = yield* call(runtime, {
          operation: "jira.comments",
          path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
          query: { maxResults: "50", orderBy: "-created" },
          itemId: key,
        }).pipe(
          Effect.flatMap((response) =>
            decodeComments(response.body).pipe(Effect.mapError(unexpected)),
          ),
        );
        return toDetail(runtime.sourceId, originOf(configOf(runtime)), issue, comments);
      });

    const summary = (runtime: WorkSourceRuntime, key: string) =>
      readIssue(runtime, key).pipe(
        Effect.map((issue) => toSummary(runtime.sourceId, originOf(configOf(runtime)), issue)),
      );

    const checkRevision = (
      runtime: WorkSourceRuntime,
      key: string,
      expected: string | undefined,
    ) =>
      expected === undefined
        ? Effect.void
        : summary(runtime, key).pipe(
            Effect.flatMap((current) =>
              current.revision === expected
                ? Effect.void
                : Effect.fail(new WorkStale({ itemId: key, current })),
            ),
          );

    const search = (
      runtime: WorkSourceRuntime,
      jql: string,
      limit: number,
      cursor: string | undefined,
    ) =>
      Effect.gen(function* () {
        const reconcileIssues = yield* reconcileIds(runtime);
        const response = yield* call(runtime, {
          operation: "jira.search",
          method: "POST",
          path: "/rest/api/3/search/jql",
          body: {
            jql,
            fields: SEARCH_FIELDS,
            maxResults: limit,
            ...(cursor === undefined ? {} : { nextPageToken: cursor }),
            ...(reconcileIssues.length === 0 ? {} : { reconcileIssues }),
          },
        }).pipe(
          Effect.catchTags({
            // An expired page token is a bad request; the client restarts from the first page.
            WorkInvalid: (error) =>
              cursor === undefined
                ? Effect.fail(error)
                : Effect.fail(new WorkInvalid({ detail: "This page expired; reload the list." })),
          }),
        );
        return yield* decodeSearch(response.body).pipe(Effect.mapError(unexpected));
      });

    const people = (runtime: WorkSourceRuntime, query: string, itemId?: string) =>
      call(runtime, {
        operation: "jira.assignable",
        path: "/rest/api/3/user/assignable/search",
        query: {
          query,
          maxResults: "20",
          ...(itemId === undefined
            ? { project: configOf(runtime).projectKey.toUpperCase() }
            : { issueKey: normalizeIssueKey(itemId) }),
        },
      }).pipe(
        Effect.flatMap((response) => decodeUsers(response.body).pipe(Effect.mapError(unexpected))),
        Effect.map((users) =>
          users.map((user) => ({ id: user.accountId, label: user.displayName ?? user.accountId })),
        ),
      );

    const issueTypeFor = (runtime: WorkSourceRuntime) =>
      call(runtime, {
        operation: "jira.createmeta",
        path: `/rest/api/3/issue/createmeta/${encodeURIComponent(configOf(runtime).projectKey.toUpperCase())}/issuetypes`,
      }).pipe(
        Effect.flatMap((response) =>
          decodeIssueTypes(response.body).pipe(Effect.mapError(unexpected)),
        ),
        Effect.flatMap((types) => {
          const all = [...(types.issueTypes ?? types.values ?? [])].filter(
            (type) => type.subtask !== true,
          );
          const preferred =
            PREFERRED_TYPES.map((name) =>
              all.find((type) => type.name.toLowerCase() === name),
            ).find((type) => type !== undefined) ?? all[0];
          return preferred === undefined
            ? Effect.fail(
                new WorkUnsupported({
                  detail: "This Jira project offers no issue type to create.",
                }),
              )
            : Effect.succeed(preferred.id);
        }),
      );

    /** Applies the unique transition reaching a status, or answers with the choices. */
    const transitionTo = (
      runtime: WorkSourceRuntime,
      key: string,
      input: { status?: string; transitionId?: string },
    ) =>
      Effect.gen(function* () {
        const response = yield* call(runtime, {
          operation: "jira.transitions",
          path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
          query: { expand: "transitions.fields" },
          itemId: key,
        });
        const { transitions } = yield* decodeTransitions(response.body).pipe(
          Effect.mapError(unexpected),
        );
        const chosen =
          input.transitionId !== undefined
            ? transitions.find((transition) => transition.id === input.transitionId)
            : undefined;
        let transition = chosen;
        if (input.transitionId !== undefined && chosen === undefined) {
          return yield* new WorkInvalid({
            detail: "That transition is not available for this issue now.",
          });
        }
        if (transition === undefined) {
          if (input.status === "cancelled") {
            return yield* new WorkUnsupported({
              detail: "Choose the Jira transition that cancels this issue.",
            });
          }
          const category = jiraCategoryFor(input.status as Parameters<typeof jiraCategoryFor>[0]);
          const candidates = transitions.filter(
            (entry) => entry.to?.statusCategory?.key === category,
          );
          if (candidates.length === 0) {
            return yield* new WorkUnsupported({
              detail: "No Jira transition reaches that status from here.",
            });
          }
          if (candidates.length > 1) {
            return yield* new WorkConflict({
              detail: "Several Jira transitions reach that status; choose one.",
              candidates: candidates.map(toTransition),
            });
          }
          transition = candidates[0]!;
        }
        if (toTransition(transition).requiresFields) {
          return yield* new WorkUnsupported({
            detail: `The ${transition.name} transition needs fields Work cannot fill; use Jira.`,
          });
        }
        const resolutionField = transition.fields?.resolution;
        const resolutions = resolutionField?.allowedValues ?? [];
        const resolution =
          resolutionField === undefined
            ? undefined
            : (resolutions.find((value) => value.name === "Done") ?? resolutions[0]);
        yield* call(runtime, {
          operation: "jira.transition",
          method: "POST",
          path: `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
          body: {
            transition: { id: transition.id },
            ...(resolution === undefined
              ? {}
              : {
                  fields: {
                    resolution:
                      resolution.id !== undefined
                        ? { id: resolution.id }
                        : { name: resolution.name },
                  },
                }),
          },
          itemId: key,
        });
      });

    const after = (runtime: WorkSourceRuntime, key: string) =>
      summary(runtime, key).pipe(Effect.tap((item) => remember(runtime, item.nativeId ?? "")));

    const adapter: WorkSourceAdapter = {
      kind: "jira",
      capabilities: {
        create: true,
        statuses: JIRA_WRITABLE_STATUSES,
        fields: ["title", "body", "priority", "labels", "assignee", "parent"],
        comments: "add",
        transitions: true,
        people: true,
      },
      identity: (config) => (config.kind === "jira" ? jiraIdentity(config) : ""),
      test: ({ config, secret }) =>
        Effect.gen(function* () {
          if (config.kind !== "jira")
            return yield* new WorkInvalid({ detail: "Not a Jira source." });
          const projectKey = config.projectKey.trim().toUpperCase();
          if (!JIRA_PROJECT_KEY.test(projectKey)) {
            return yield* new WorkInvalid({ detail: "Enter the Jira project key, such as PROJ." });
          }
          const credential =
            secret === undefined ? undefined : { email: config.email, token: secret };
          const request = (input: Omit<JiraApi.JiraRequest, "interactive">) =>
            api.request(config.siteUrl, credential, { ...input, interactive: true });
          yield* request({ operation: "jira.myself", path: "/rest/api/3/myself" }).pipe(
            Effect.flatMap((response) =>
              decodeMyself(response.body).pipe(Effect.mapError(unexpected)),
            ),
            // A rejected token here is most often a scoped one, which only works through the gateway.
            Effect.catchTags({
              WorkUnauthenticated: (error) =>
                Effect.fail(
                  secret === undefined
                    ? error
                    : new WorkUnauthenticated({ detail: JiraApi.SCOPED_TOKEN_MESSAGE }),
                ),
            }),
          );
          const info = yield* request({
            operation: "jira.serverInfo",
            path: "/rest/api/3/serverInfo",
          }).pipe(
            Effect.flatMap((response) =>
              decodeServerInfo(response.body).pipe(Effect.mapError(unexpected)),
            ),
          );
          if (info.deploymentType !== undefined && info.deploymentType !== "Cloud") {
            return yield* new WorkUnsupported({ detail: "Only Jira Cloud sites are supported." });
          }
          yield* request({
            operation: "jira.project",
            path: `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
          }).pipe(
            Effect.flatMap((response) =>
              decodeProject(response.body).pipe(Effect.mapError(unexpected)),
            ),
          );
          return { identity: jiraIdentity(config) };
        }),
      prepare: () => Effect.void,
      list: (runtime, query) =>
        Effect.gen(function* () {
          const config = configOf(runtime);
          const result = yield* search(
            runtime,
            listJql(config.projectKey.toUpperCase(), query),
            Math.min(query.limit, 50),
            query.cursor,
          );
          const items = result.issues.map((issue) =>
            toSummary(runtime.sourceId, originOf(config), issue),
          );
          const token = result.nextPageToken ?? null;
          // A token that does not move would page forever; stop instead.
          const nextCursor =
            result.isLast === true || token === null || token === query.cursor ? null : token;
          return { items, nextCursor, stale: false };
        }),
      get: detail,
      people: (runtime, query) => people(runtime, query.query, query.itemId),
      create: (runtime, input) =>
        Effect.gen(function* () {
          const config = configOf(runtime);
          const issueType = yield* issueTypeFor(runtime);
          const response = yield* call(runtime, {
            operation: "jira.create",
            method: "POST",
            path: "/rest/api/3/issue",
            body: {
              fields: {
                project: { key: config.projectKey.toUpperCase() },
                issuetype: { id: issueType },
                summary: input.title,
                ...(input.body === undefined ? {} : { description: markdownToAdf(input.body) }),
                ...(input.labels === undefined ? {} : { labels: input.labels }),
                ...(input.priority === undefined
                  ? {}
                  : { priority: { name: PRIORITY_NAMES[input.priority] } }),
                ...(input.parent === undefined
                  ? {}
                  : { parent: { key: normalizeIssueKey(input.parent) } }),
                ...(input.assignee === undefined
                  ? {}
                  : { assignee: { accountId: input.assignee } }),
              },
            },
          });
          const created = yield* decodeCreated(response.body).pipe(Effect.mapError(unexpected));
          yield* remember(runtime, created.id);
          return yield* summary(runtime, normalizeIssueKey(created.key));
        }),
      update: (runtime, patch) => {
        const key = normalizeIssueKey(patch.ref.itemId);
        return issueWrite(
          runtime,
          key,
          Effect.gen(function* () {
            if (patch.blockedBy !== undefined) {
              return yield* new WorkUnsupported({ detail: "Change Jira issue links in Jira." });
            }
            if (patch.body !== undefined) {
              const current = yield* detail(runtime, key);
              if (current.bodyFidelity === "lossy") {
                return yield* new WorkUnsupported({
                  detail: "This description has content Work cannot show; edit it in Jira.",
                });
              }
              if (
                patch.expectedRevision !== undefined &&
                current.revision !== patch.expectedRevision
              ) {
                return yield* new WorkStale({ itemId: key, current: summaryOf(current) });
              }
            } else {
              yield* checkRevision(runtime, key, patch.expectedRevision);
            }
            const fields = {
              ...(patch.title === undefined ? {} : { summary: patch.title }),
              ...(patch.body === undefined ? {} : { description: markdownToAdf(patch.body) }),
              ...(patch.priority === undefined
                ? {}
                : {
                    priority:
                      patch.priority === null ? null : { name: PRIORITY_NAMES[patch.priority] },
                  }),
              ...(patch.parent === undefined
                ? {}
                : {
                    parent: patch.parent === null ? null : { key: normalizeIssueKey(patch.parent) },
                  }),
            };
            const labels =
              patch.labels === undefined
                ? []
                : [
                    ...patch.labels.add.map((label) => ({ add: label })),
                    ...patch.labels.remove.map((label) => ({ remove: label })),
                  ];
            if (Object.keys(fields).length > 0 || labels.length > 0) {
              yield* call(runtime, {
                operation: "jira.update",
                method: "PUT",
                path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
                body: {
                  ...(Object.keys(fields).length === 0 ? {} : { fields }),
                  ...(labels.length === 0 ? {} : { update: { labels } }),
                },
                itemId: key,
              });
            }
            if (patch.assignee !== undefined) {
              yield* call(runtime, {
                operation: "jira.assign",
                method: "PUT",
                path: `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`,
                body: { accountId: patch.assignee },
                itemId: key,
              });
            }
            return yield* after(runtime, key);
          }),
        );
      },
      setStatus: (runtime, input) => {
        const key = normalizeIssueKey(input.ref.itemId);
        return issueWrite(
          runtime,
          key,
          Effect.gen(function* () {
            yield* checkRevision(runtime, key, input.expectedRevision);
            yield* transitionTo(runtime, key, {
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
            });
            return yield* after(runtime, key);
          }),
        );
      },
      comment: (runtime, itemId, body) => {
        const key = normalizeIssueKey(itemId);
        return issueWrite(
          runtime,
          key,
          call(runtime, {
            operation: "jira.comment",
            method: "POST",
            path: `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
            body: { body: markdownToAdf(body) },
            itemId: key,
          }).pipe(
            Effect.flatMap((response) =>
              decodeCommentCreated(response.body).pipe(Effect.mapError(unexpected)),
            ),
            Effect.map((created) => ({ commentId: created.id })),
          ),
        );
      },
      snapshots: (runtime, itemIds) =>
        Effect.gen(function* () {
          const config = configOf(runtime);
          const summaries: Array<WorkItemSummary> = [];
          const keys = itemIds.map(normalizeIssueKey);
          for (let index = 0; index < keys.length; index += SNAPSHOT_BATCH) {
            const batch = keys.slice(index, index + SNAPSHOT_BATCH);
            const result = yield* search(runtime, keysJql(batch), batch.length, undefined);
            summaries.push(
              ...result.issues.map((issue) => toSummary(runtime.sourceId, originOf(config), issue)),
            );
          }
          return summaries;
        }),
    };
    return adapter;
  });

const summaryOf = (detail: ReturnType<typeof toDetail>): WorkItemSummary => {
  const {
    body: _body,
    bodyTruncated: _bodyTruncated,
    bodyFidelity: _bodyFidelity,
    comments: _comments,
    commentsTruncated: _commentsTruncated,
    children: _children,
    blocking: _blocking,
    transitions: _transitions,
    locator: _locator,
    ...summary
  } = detail;
  return summary;
};
