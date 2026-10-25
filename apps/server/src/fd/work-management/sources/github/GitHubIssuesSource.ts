import type {
  WorkItemPatch,
  WorkItemSummary,
  WorkListQuery,
  WorkSourceConfig,
} from "@t3tools/contracts/fd/work-management";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  boundedHostMessage,
  WorkForbidden,
  WorkInvalid,
  WorkItemNotFound,
  WorkRateLimited,
  WorkStale,
  WorkUnauthenticated,
  WorkUnavailable,
  WorkUnsupported,
  type WorkDomainError,
} from "../../errors.ts";
import { GITHUB_WRITABLE_STATUSES, toGitHubState } from "../../model/status.ts";
import type { WorkSourceAdapter, WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import {
  AssignableUsersResponse,
  IssueCommentsResponse,
  IssueDetailResponse,
  IssueListResponse,
  IssueSearchResponse,
  IssueSnapshotsResponse,
  IssueSummaryJson,
  RestCommentJson,
  RestIssueJson,
  RestRepositoryJson,
  RestUserJson,
  toComment,
  toDetail,
  toSummary,
} from "./issueJson.ts";
import {
  assignableUsersQuery,
  type IssueFieldSet,
  issueCommentsQuery,
  issueDetailQuery,
  issueSnapshotsQuery,
  listIssuesQuery,
  OPTIONAL_FIELD_NAMES,
  searchIssuesQuery,
} from "./issuesGraphQl.ts";

type GitHubConfig = Extract<WorkSourceConfig, { readonly kind: "github" }>;

const VIEWER_TTL_MS = 10 * 60_000;
const SNAPSHOT_BATCH = 50;
/** Comments per page of a lookup; nested connections stay at 50 or fewer. */
const COMMENTS_PAGE = 50;
const decodeIssueSummary = Schema.decodeUnknownOption(IssueSummaryJson);

const configOf = (runtime: Pick<WorkSourceRuntime, "config">): GitHubConfig => {
  if (runtime.config.kind !== "github") throw new Error("A GitHub source needs a GitHub config.");
  return runtime.config;
};

const repositoryPath = (config: GitHubConfig) =>
  `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`;

const sourceUrl = "Source Control settings";

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const decodeRestIssue = Schema.decodeEffect(RestIssueJson);
const decodeRestComment = Schema.decodeEffect(RestCommentJson);
const decodeRestRepository = Schema.decodeEffect(RestRepositoryJson);
const decodeRestUser = Schema.decodeEffect(RestUserJson);

/** A GitHub failure as Work reports it; messages never carry a token or a response body. */
export const fromGitHubError =
  (subject: { readonly itemId?: string }) =>
  (error: GitHubApi.GitHubApiError | Schema.SchemaError): WorkDomainError => {
    switch (error._tag) {
      case "GitHubApiAuthenticationError":
        return new WorkUnauthenticated({
          detail: `GitHub refused the credential for ${error.host}. Update the token in ${sourceUrl}.`,
        });
      case "GitHubApiRateLimitError":
        return new WorkRateLimited(
          error.retryAt === undefined ? {} : { retryAt: isoAt(error.retryAt) },
        );
      case "SourceControlRateLimitPausedError":
        return new WorkRateLimited({ retryAt: isoAt(error.retryAt) });
      case "GitHubApiNotFoundError":
        return subject.itemId === undefined
          ? new WorkInvalid({
              detail: "GitHub cannot find that repository, or the credential cannot see it.",
            })
          : new WorkItemNotFound({ itemId: subject.itemId });
      case "GitHubApiResponseError":
        if (error.status === 403) {
          return new WorkForbidden({
            detail: `GitHub refused this action. The token in ${sourceUrl} may lack Issues write permission.`,
          });
        }
        if ((error.status === 301 || error.status === 410) && subject.itemId !== undefined) {
          return new WorkItemNotFound({
            itemId: subject.itemId,
            detail: error.status === 301 ? "the issue was transferred" : "the issue was deleted",
          });
        }
        if (error.status === 422) {
          return new WorkInvalid({ detail: boundedHostMessage(error.message) });
        }
        return new WorkUnavailable({ detail: boundedHostMessage(error.message) });
      case "GitHubApiRequestError":
        return new WorkUnavailable({ detail: error.message });
      case "SchemaError":
        return new WorkUnavailable({ detail: "GitHub answered in an unexpected shape." });
      default:
        // Credential lookup failures: no token is configured for the host.
        return new WorkUnauthenticated({
          detail: `No GitHub credential is available. Add a token in ${sourceUrl}.`,
        });
    }
  };

const mentionsOptionalField = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "GitHubApiResponseError" &&
  ((error as { githubErrors?: ReadonlyArray<string> }).githubErrors ?? []).some((message) =>
    OPTIONAL_FIELD_NAMES.some((field) => message.includes(field)),
  );

/** GraphQL search syntax quotes phrases; a quote in the text is dropped rather than escaped. */
const searchTerm = (text: string) => text.replaceAll('"', " ").trim();

/**
 * An issue number written in decimal digits, or undefined. `Number` alone would also read `1e0`
 * or `0x1` as issue 1, a spelling the Work id canonicalization (`model/itemId.ts`) does not
 * share, so two spellings could reach one issue under different locks and links.
 */
const issueNumber = (itemId: string): number | undefined => {
  if (!/^\d+$/.test(itemId)) return undefined;
  const number = Number(itemId);
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
};

export interface GitHubIssuesOptions {
  /** Minimum time between two write requests to one source; GitHub asks for a second. */
  readonly writeSpacingMs?: number;
}

/** GitHub Issues through the server's shared GitHubApi: one credential, quota and pause per host. */
export const make = (options: GitHubIssuesOptions = {}) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi.GitHubApi;
    const writeSpacing = options.writeSpacingMs ?? 1_000;
    /** Hosts known to lack the sub-issue and dependency fields. */
    const basicHosts = new Set<string>();
    const viewers = new Map<string, { readonly login: string; readonly at: number }>();
    const writeLocks = new Map<string, Semaphore.Semaphore>();
    const lastWrite = new Map<string, number>();

    const fieldsFor = (host: string): IssueFieldSet =>
      basicHosts.has(host.toLowerCase()) ? "basic" : "full";

    /** A GraphQL read, retried once with the basic field set when an older server refuses. */
    const graphql = <A>(
      runtime: WorkSourceRuntime,
      operation: string,
      document: (fields: IssueFieldSet) => string,
      variables: Record<string, unknown>,
      schema: Schema.Codec<A, string>,
      itemId?: string,
    ): Effect.Effect<A, WorkDomainError> => {
      const config = configOf(runtime);
      const run = (fields: IssueFieldSet) =>
        api
          .graphql({
            host: config.host,
            operation,
            query: document(fields),
            variables: { owner: config.owner, name: config.name, ...variables },
            allowReserve: runtime.interactive,
          })
          .pipe(Effect.flatMap(Schema.decodeEffect(schema)));
      const fields = fieldsFor(config.host);
      return run(fields).pipe(
        Effect.catchIf(
          (error) => fields === "full" && mentionsOptionalField(error),
          () => {
            basicHosts.add(config.host.toLowerCase());
            return run("basic");
          },
        ),
        Effect.mapError(fromGitHubError(itemId === undefined ? {} : { itemId })),
      );
    };

    const rest = (
      runtime: WorkSourceRuntime,
      input: Omit<GitHubApi.GitHubRestInput, "host">,
      itemId?: string,
    ) =>
      api
        .rest({ host: configOf(runtime).host, allowReserve: runtime.interactive, ...input })
        .pipe(Effect.mapError(fromGitHubError(itemId === undefined ? {} : { itemId })));

    /**
     * Write operations to one source run one at a time, so the spacing `restWrite` keeps between
     * their requests holds even when an update takes several.
     */
    const write = <A, E>(runtime: WorkSourceRuntime, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        let lock = writeLocks.get(runtime.sourceId);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          writeLocks.set(runtime.sourceId, lock);
        }
        return lock.withPermits(1)(effect);
      });

    /** One mutating request, spaced from the source's previous one as GitHub's secondary limits ask. */
    const restWrite = (
      runtime: WorkSourceRuntime,
      input: Omit<GitHubApi.GitHubRestInput, "host">,
      itemId?: string,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const wait =
          (lastWrite.get(runtime.sourceId) ?? Number.NEGATIVE_INFINITY) + writeSpacing - now;
        if (writeSpacing > 0 && wait > 0) yield* Effect.sleep(Duration.millis(wait));
        return yield* rest(runtime, input, itemId).pipe(
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(
              Effect.map((at) => void lastWrite.set(runtime.sourceId, at)),
            ),
          ),
        );
      });

    const viewer = (runtime: WorkSourceRuntime) =>
      Effect.gen(function* () {
        const host = configOf(runtime).host.toLowerCase();
        const { fingerprint } = yield* api
          .credential(host)
          .pipe(Effect.mapError(fromGitHubError({})));
        const key = `${host}\0${fingerprint}`;
        const now = yield* Clock.currentTimeMillis;
        const cached = viewers.get(key);
        if (cached !== undefined && now - cached.at < VIEWER_TTL_MS) return cached.login;
        const response = yield* rest(runtime, { operation: "work.viewer", path: "user" });
        const { login } = yield* decodeRestUser(response.body).pipe(
          Effect.mapError(fromGitHubError({})),
        );
        viewers.set(key, { login, at: now });
        return login;
      });

    const detail = (runtime: WorkSourceRuntime, itemId: string) =>
      Effect.gen(function* () {
        const number = issueNumber(itemId);
        if (number === undefined) return yield* new WorkItemNotFound({ itemId });
        const response = yield* graphql(
          runtime,
          "work.issue",
          issueDetailQuery,
          { number },
          IssueDetailResponse,
          itemId,
        );
        const issue = response.data.repository?.issue;
        if (issue === null || issue === undefined) return yield* new WorkItemNotFound({ itemId });
        return toDetail(runtime.sourceId, issue);
      });

    /** The page of the issue's comments just older than `before`; the newest page for null. */
    const commentsPage = (
      runtime: WorkSourceRuntime,
      itemId: string,
      number: number,
      before: string | null,
    ) =>
      graphql(
        runtime,
        "work.issue.comments",
        () => issueCommentsQuery,
        { number, last: COMMENTS_PAGE, before },
        IssueCommentsResponse,
        itemId,
      );

    /** Fails stale when the issue moved past the revision the caller saw. */
    const checkRevision = (
      runtime: WorkSourceRuntime,
      itemId: string,
      expected: string | undefined,
    ) =>
      expected === undefined
        ? Effect.void
        : detail(runtime, itemId).pipe(
            Effect.flatMap((current) =>
              current.revision === expected
                ? Effect.void
                : Effect.fail(new WorkStale({ itemId, current: summaryOfDetail(current) })),
            ),
          );

    const summaryAfterWrite = (runtime: WorkSourceRuntime, itemId: string) =>
      detail(runtime, itemId).pipe(Effect.map(summaryOfDetail));

    const list = (runtime: WorkSourceRuntime, query: WorkListQuery) =>
      Effect.gen(function* () {
        const config = configOf(runtime);
        const statuses = query.statuses;
        // GitHub has no in-progress state: asking only for it finds nothing.
        if (
          statuses !== undefined &&
          statuses.length > 0 &&
          statuses.every((status) => status === "in_progress")
        ) {
          return { items: [], nextCursor: null, stale: false };
        }
        const wantsOpen = statuses === undefined || statuses.includes("todo");
        const wantsClosed =
          statuses === undefined || statuses.includes("done") || statuses.includes("cancelled");
        const assignee = query.assignee === "me" ? yield* viewer(runtime) : undefined;
        const first = Math.min(query.limit, 50);
        const search = query.search?.trim();
        let page: {
          readonly items: ReadonlyArray<WorkItemSummary>;
          readonly endCursor: string | null;
          readonly hasNext: boolean;
        };
        if (search !== undefined && search.length > 0) {
          const qualifiers = [
            `repo:${config.owner}/${config.name}`,
            "is:issue",
            "sort:updated-desc",
            wantsOpen && !wantsClosed ? "is:open" : !wantsOpen && wantsClosed ? "is:closed" : "",
            ...(query.labels ?? []).map((label) => `label:"${label.replaceAll('"', "")}"`),
            assignee === undefined ? "" : `assignee:${assignee}`,
            searchTerm(search),
          ].filter((part) => part.length > 0);
          const response = yield* graphql(
            runtime,
            "work.issues.search",
            searchIssuesQuery,
            { query: qualifiers.join(" "), first, after: query.cursor ?? null },
            IssueSearchResponse,
          );
          const items = response.data.search.nodes.flatMap((node) => {
            const decoded = decodeIssueSummary(node);
            return Option.isSome(decoded) ? [toSummary(runtime.sourceId, decoded.value)] : [];
          });
          page = {
            items,
            endCursor: response.data.search.pageInfo.endCursor,
            hasNext: response.data.search.pageInfo.hasNextPage,
          };
        } else {
          const response = yield* graphql(
            runtime,
            "work.issues.list",
            listIssuesQuery,
            {
              first,
              after: query.cursor ?? null,
              states: wantsOpen && wantsClosed ? null : wantsOpen ? ["OPEN"] : ["CLOSED"],
              labels: query.labels !== undefined && query.labels.length > 0 ? query.labels : null,
              assignee: assignee ?? null,
            },
            IssueListResponse,
          );
          const repository = response.data.repository;
          if (repository === null) {
            return yield* new WorkInvalid({ detail: "GitHub cannot find this repository." });
          }
          page = {
            items: repository.issues.nodes
              .filter((node) => node !== null)
              .map((node) => toSummary(runtime.sourceId, node)),
            endCursor: repository.issues.pageInfo.endCursor,
            hasNext: repository.issues.pageInfo.hasNextPage,
          };
        }
        // Done and cancelled are both closed on GitHub; their reason tells them apart.
        const items =
          statuses === undefined
            ? page.items
            : page.items.filter(
                (item) =>
                  item.status === "unknown" ||
                  (statuses as ReadonlyArray<string>).includes(item.status),
              );
        return { items, nextCursor: page.hasNext ? page.endCursor : null, stale: false };
      });

    const adapter: WorkSourceAdapter = {
      kind: "github",
      capabilities: {
        create: true,
        statuses: GITHUB_WRITABLE_STATUSES,
        fields: ["title", "body", "labels", "assignee"],
        comments: "add",
        transitions: false,
        people: true,
      },
      identity: (config) =>
        config.kind === "github"
          ? `${config.host}/${config.owner}/${config.name}`.toLowerCase()
          : "",
      test: ({ config }) =>
        Effect.gen(function* () {
          if (config.kind !== "github")
            return yield* new WorkInvalid({ detail: "Not a GitHub source." });
          const response = yield* api
            .rest({
              host: config.host,
              operation: "work.repository",
              path: repositoryPath(config),
              allowReserve: true,
            })
            .pipe(Effect.mapError(fromGitHubError({})));
          const repository = yield* decodeRestRepository(response.body).pipe(
            Effect.mapError(fromGitHubError({})),
          );
          if (repository.has_issues === false) {
            return yield* new WorkInvalid({
              detail: `Issues are turned off for ${repository.full_name}.`,
            });
          }
          return { identity: `${config.host}/${config.owner}/${config.name}`.toLowerCase() };
        }),
      prepare: () => Effect.void,
      list,
      get: detail,
      people: (runtime, query) =>
        graphql(
          runtime,
          "work.assignable",
          () => assignableUsersQuery,
          { query: query.query.length === 0 ? null : query.query },
          AssignableUsersResponse,
        ).pipe(
          Effect.map((response) =>
            (response.data.repository?.assignableUsers.nodes ?? [])
              .filter((node) => node !== null)
              .map((user) => ({ id: user.login, label: user.name ?? user.login })),
          ),
        ),
      create: (runtime, input) =>
        write(
          runtime,
          Effect.gen(function* () {
            const config = configOf(runtime);
            if (input.parent !== undefined || input.priority !== undefined) {
              return yield* new WorkUnsupported({
                detail: "GitHub issues take a title, body, labels and an assignee here.",
              });
            }
            const response = yield* restWrite(runtime, {
              operation: "work.issue.create",
              method: "POST",
              path: `${repositoryPath(config)}/issues`,
              body: {
                title: input.title,
                ...(input.body === undefined ? {} : { body: input.body }),
                ...(input.labels === undefined ? {} : { labels: input.labels }),
                ...(input.assignee === undefined ? {} : { assignees: [input.assignee] }),
              },
            });
            const created = yield* decodeRestIssue(response.body).pipe(
              Effect.mapError(fromGitHubError({})),
            );
            return yield* summaryAfterWrite(runtime, String(created.number));
          }),
        ),
      update: (runtime, patch) =>
        write(
          runtime,
          Effect.gen(function* () {
            const config = configOf(runtime);
            const itemId = patch.ref.itemId;
            if (issueNumber(itemId) === undefined) return yield* new WorkItemNotFound({ itemId });
            const path = `${repositoryPath(config)}/issues/${itemId}`;
            if (
              patch.parent !== undefined ||
              patch.blockedBy !== undefined ||
              patch.priority !== undefined
            ) {
              return yield* new WorkUnsupported({
                detail: "Change parents, blockers and priority on GitHub itself.",
              });
            }
            yield* checkRevision(runtime, itemId, patch.expectedRevision);
            if (patch.title !== undefined || patch.body !== undefined) {
              yield* restWrite(
                runtime,
                {
                  operation: "work.issue.update",
                  method: "PATCH",
                  path,
                  body: {
                    ...(patch.title === undefined ? {} : { title: patch.title }),
                    ...(patch.body === undefined ? {} : { body: patch.body }),
                  },
                },
                itemId,
              );
            }
            yield* applyLabels(runtime, path, itemId, patch.labels);
            if (patch.assignee !== undefined)
              yield* applyAssignee(runtime, path, itemId, patch.assignee);
            return yield* summaryAfterWrite(runtime, itemId);
          }),
        ),
      setStatus: (runtime, input) =>
        write(
          runtime,
          Effect.gen(function* () {
            const itemId = input.ref.itemId;
            if (issueNumber(itemId) === undefined) return yield* new WorkItemNotFound({ itemId });
            if (input.transitionId !== undefined || input.status === undefined) {
              return yield* new WorkUnsupported({ detail: "GitHub issues have no transitions." });
            }
            const target = toGitHubState(input.status);
            if (target === undefined) {
              return yield* new WorkUnsupported({
                detail: "GitHub issues have no in-progress state; a linked thread shows the work.",
              });
            }
            yield* checkRevision(runtime, itemId, input.expectedRevision);
            yield* restWrite(
              runtime,
              {
                operation: "work.issue.status",
                method: "PATCH",
                path: `${repositoryPath(configOf(runtime))}/issues/${itemId}`,
                body: { state: target.state, state_reason: target.stateReason },
              },
              itemId,
            );
            return yield* summaryAfterWrite(runtime, itemId);
          }),
        ),
      comment: (runtime, itemId, body) =>
        write(
          runtime,
          Effect.gen(function* () {
            if (issueNumber(itemId) === undefined) return yield* new WorkItemNotFound({ itemId });
            const response = yield* restWrite(
              runtime,
              {
                operation: "work.issue.comment",
                method: "POST",
                path: `${repositoryPath(configOf(runtime))}/issues/${itemId}/comments`,
                body: { body },
              },
              itemId,
            );
            const created = yield* decodeRestComment(response.body).pipe(
              Effect.mapError(fromGitHubError({ itemId })),
            );
            return { commentId: String(created.id) };
          }),
        ),
      findComment: (runtime, itemId, text) =>
        Effect.gen(function* () {
          const number = issueNumber(itemId);
          if (number === undefined) return yield* new WorkItemNotFound({ itemId });
          // Newest first, so a recent comment ends the walk early; otherwise every page is read.
          let before: string | null = null;
          for (;;) {
            const response: typeof IssueCommentsResponse.Type = yield* commentsPage(
              runtime,
              itemId,
              number,
              before,
            );
            const issue = response.data.repository?.issue;
            if (issue === null || issue === undefined) {
              return yield* new WorkItemNotFound({ itemId });
            }
            const { pageInfo, nodes } = issue.comments;
            const found = nodes.findLast((node) => node !== null && node.body.includes(text));
            if (found !== undefined && found !== null) return Option.some(toComment(found));
            if (!pageInfo.hasPreviousPage) return Option.none();
            // Stopping here would answer for comments never read.
            if (pageInfo.startCursor === null) {
              return yield* new WorkUnavailable({
                detail: "GitHub ended a page of comments without a cursor.",
              });
            }
            before = pageInfo.startCursor;
          }
        }),
      snapshots: (runtime, itemIds) =>
        Effect.gen(function* () {
          const numbers = itemIds
            .map(Number)
            .filter((number) => Number.isSafeInteger(number) && number > 0);
          const summaries: Array<WorkItemSummary> = [];
          for (let index = 0; index < numbers.length; index += SNAPSHOT_BATCH) {
            const batch = numbers.slice(index, index + SNAPSHOT_BATCH);
            const response = yield* graphql(
              runtime,
              "work.issues.snapshots",
              (fields) => issueSnapshotsQuery(fields, batch),
              {},
              IssueSnapshotsResponse,
            );
            for (const issue of Object.values(response.data.repository ?? {})) {
              if (issue !== null) summaries.push(toSummary(runtime.sourceId, issue));
            }
          }
          return summaries;
        }),
    };

    /** Labels change through their add and remove endpoints so a concurrent edit survives. */
    const applyLabels = (
      runtime: WorkSourceRuntime,
      path: string,
      itemId: string,
      labels: WorkItemPatch["labels"],
    ) =>
      Effect.gen(function* () {
        if (labels === undefined) return;
        if (labels.add.length > 0) {
          yield* restWrite(
            runtime,
            {
              operation: "work.issue.labels.add",
              method: "POST",
              path: `${path}/labels`,
              body: { labels: labels.add },
            },
            itemId,
          );
        }
        for (const label of labels.remove) {
          yield* restWrite(
            runtime,
            {
              operation: "work.issue.labels.remove",
              method: "DELETE",
              path: `${path}/labels/${encodeURIComponent(label)}`,
            },
            itemId,
          ).pipe(
            // Removing a label the issue no longer has is already done.
            Effect.catchTags({ WorkItemNotFound: () => Effect.void }),
          );
        }
      });

    /**
     * Work shows one assignee, so setting it removes every other one. The full list is read fresh
     * over REST: summaries only carry the first few, and an issue can have up to ten.
     */
    const applyAssignee = (
      runtime: WorkSourceRuntime,
      path: string,
      itemId: string,
      assignee: string | null,
    ) =>
      Effect.gen(function* () {
        const response = yield* rest(runtime, { operation: "work.issue.assignees", path }, itemId);
        const current = yield* decodeRestIssue(response.body).pipe(
          Effect.mapError(fromGitHubError({ itemId })),
        );
        const previous = (current.assignees ?? []).map((user) => user.login);
        // Logins are case-insensitive on GitHub.
        const target = assignee?.toLowerCase();
        const removed = previous.filter((login) => login.toLowerCase() !== target);
        if (removed.length > 0) {
          yield* restWrite(
            runtime,
            {
              operation: "work.issue.assignees.remove",
              method: "DELETE",
              path: `${path}/assignees`,
              body: { assignees: removed },
            },
            itemId,
          );
        }
        if (assignee !== null && !previous.some((login) => login.toLowerCase() === target)) {
          yield* restWrite(
            runtime,
            {
              operation: "work.issue.assignees.add",
              method: "POST",
              path: `${path}/assignees`,
              body: { assignees: [assignee] },
            },
            itemId,
          );
        }
      });

    return adapter;
  });

const summaryOfDetail = (detail: ReturnType<typeof toDetail>): WorkItemSummary => {
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
