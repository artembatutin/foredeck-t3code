import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  WorkItemId,
  type WorkItemRef,
  type WorkItemSummary,
  type WorkSourceCapabilities,
  type WorkSourceConfig,
  type WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import { v2PullRequestThread } from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import type { WorkActor } from "../authority.ts";
import {
  WorkInvalid,
  WorkItemNotFound,
  WorkStale,
  WorkUnauthenticated,
  type WorkDomainError,
} from "../errors.ts";
import * as WorkLinkStore from "../persistence/WorkLinkStore.ts";
import * as WorkMigrations from "../persistence/WorkMigrations.ts";
import * as WorkSourceStore from "../persistence/WorkSourceStore.ts";
import {
  layerRegistry,
  type WorkSourceAdapter,
  type WorkSourceItemDetail,
  type WorkSourceRuntime,
} from "../sources/WorkSourceAdapter.ts";
import * as WorkService from "../WorkService.ts";

/**
 * Test doubles for the Work service: an in-memory source adapter that records what it was asked
 * and a harness that stands the service on real stores over an in-memory database.
 */

export const at = "2026-10-21T09:00:00.000Z";

export const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthSettingsWriteScope],
  label: "owner",
};
export const reader: WorkActor = {
  id: "session:reader",
  grants: [AuthWorkReadScope],
  label: "owner",
};
export const agent: WorkActor = {
  id: "thread:thread-1",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "Thread 1",
};

export const markdownConfig = (directory: string): WorkSourceConfig => ({
  kind: "markdown",
  directory,
  autoStart: true,
});

export const jiraConfig = (projectKey: string, email = "me@acme.test"): WorkSourceConfig => ({
  kind: "jira",
  siteUrl: "https://acme.atlassian.net",
  projectKey,
  email,
});

export const projectRow = (
  projectId: ProjectId,
  workspaceRoot: string,
): ProjectStore.ProjectRow => ({
  projectId,
  title: projectId,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
});

export const threadShell = (
  id: ThreadId,
  projectId: ProjectId,
  overrides: Partial<
    Pick<
      OrchestrationV2ThreadShell,
      "archivedAt" | "settledAt" | "deletedAt" | "activeRunId" | "latestRunId"
    >
  > = {},
): OrchestrationV2ThreadShell => ({
  ...v2PullRequestThread({
    id,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("subscription"), model: "model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  }),
  ...overrides,
});

export const fakeCapabilities = (kind: WorkSourceKind): WorkSourceCapabilities => ({
  create: true,
  statuses: ["todo", "in_progress", "done", "cancelled"],
  fields: ["title", "body", "labels"],
  comments: "add",
  transitions: false,
  people: kind !== "markdown",
});

export const fakeDetail = (
  ref: WorkItemRef,
  kind: WorkSourceKind,
  title: string,
): WorkSourceItemDetail => ({
  ref,
  kind,
  key: ref.itemId,
  title,
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: null,
  labels: [],
  assignee: null,
  parent: null,
  blockedBy: [],
  url: null,
  updatedAt: at,
  revision: "r1",
  invalid: null,
  body: "",
  bodyTruncated: false,
  bodyFidelity: "exact",
  comments: [],
  commentsTruncated: false,
  children: [],
  blocking: [],
  transitions: [],
});

export const summaryOf = (detail: WorkSourceItemDetail): WorkItemSummary => ({
  ref: detail.ref,
  kind: detail.kind,
  key: detail.key,
  title: detail.title,
  status: detail.status,
  nativeStatus: detail.nativeStatus,
  blocked: detail.blocked,
  priority: detail.priority,
  labels: detail.labels,
  assignee: detail.assignee,
  parent: detail.parent,
  blockedBy: detail.blockedBy,
  url: detail.url,
  ...(detail.nativeId === undefined ? {} : { nativeId: detail.nativeId }),
  updatedAt: detail.updatedAt,
  revision: detail.revision,
  invalid: detail.invalid,
});

const identityOf = (config: WorkSourceConfig): string => {
  switch (config.kind) {
    case "markdown":
      return config.directory;
    case "github":
      return `${config.host}/${config.owner}/${config.name}`;
    case "jira":
      return `${config.siteUrl}/${config.projectKey}`;
  }
};

export interface FakeAdapter {
  readonly adapter: WorkSourceAdapter;
  /** Source calls in order: `list`, `get:<itemId>`, `create`, `update`, `setStatus`, `comment`, `snapshots`. */
  readonly calls: ReadonlyArray<string>;
  readonly count: (call: string) => number;
  /** Identities `prepare` ran for. */
  readonly prepared: ReadonlyArray<string>;
  readonly tested: ReadonlyArray<{
    readonly identity: string;
    readonly secret: string | undefined;
  }>;
  readonly comments: ReadonlyArray<{
    readonly itemId: WorkItemId;
    readonly body: string;
    readonly actorId: string;
  }>;
  readonly watchers: { readonly started: number; readonly stopped: number };
  /** While set, every source call (tests included) fails with it. */
  fail: WorkDomainError | null;
  /** While set, `create` reports that it entered and waits to be released. */
  createGate: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
  /** While set, `snapshots` reports that it read and waits to be released before returning. */
  snapshotsGate: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
}

/**
 * An adapter over an in-memory item map. A Markdown directory named `nope` fails `test` as
 * invalid, and a Jira source without a token fails it as unauthenticated.
 */
export const fakeAdapter = (
  kind: WorkSourceKind,
  options: {
    /** Ending the queue ends the watch stream, as a vanished directory would. */
    readonly watch?: Queue.Queue<void, Cause.Done>;
    /** Runs when a watch stream ends, before the stop is counted. */
    readonly onWatchEnd?: Effect.Effect<unknown>;
    /** The id `create` gives its n-th item; `item-<n>` by default. */
    readonly mintId?: (n: number) => string;
  } = {},
): FakeAdapter => {
  const items = new Map<string, WorkSourceItemDetail>();
  const calls: Array<string> = [];
  const prepared: Array<string> = [];
  const tested: Array<{ readonly identity: string; readonly secret: string | undefined }> = [];
  const comments: Array<{
    readonly itemId: WorkItemId;
    readonly body: string;
    readonly actorId: string;
  }> = [];
  const watchers = { started: 0, stopped: 0 };
  const state: {
    fail: WorkDomainError | null;
    createGate: FakeAdapter["createGate"];
    snapshotsGate: FakeAdapter["snapshotsGate"];
  } = {
    fail: null,
    createGate: null,
    snapshotsGate: null,
  };
  let minted = 0;

  const call = <A>(
    name: string,
    run: () => Effect.Effect<A, WorkDomainError>,
  ): Effect.Effect<A, WorkDomainError> =>
    Effect.suspend(() => {
      calls.push(name);
      return state.fail === null ? run() : Effect.fail(state.fail);
    });
  const keyOf = (runtime: WorkSourceRuntime, itemId: string) =>
    `${runtime.identity}\u0000${itemId}`;
  const find = (
    runtime: WorkSourceRuntime,
    itemId: WorkItemId,
  ): Effect.Effect<WorkSourceItemDetail, WorkItemNotFound> => {
    const detail = items.get(keyOf(runtime, itemId));
    return detail === undefined
      ? Effect.fail(new WorkItemNotFound({ itemId }))
      : Effect.succeed(detail);
  };
  /** Refuses a write based on another revision, as every real adapter does. */
  const checked = (
    detail: WorkSourceItemDetail,
    expectedRevision: string | undefined,
  ): Effect.Effect<WorkSourceItemDetail, WorkStale> =>
    expectedRevision === undefined || expectedRevision === detail.revision
      ? Effect.succeed(detail)
      : Effect.fail(new WorkStale({ itemId: detail.ref.itemId, current: summaryOf(detail) }));
  const put = (runtime: WorkSourceRuntime, detail: WorkSourceItemDetail) => {
    items.set(keyOf(runtime, detail.ref.itemId), detail);
    return summaryOf(detail);
  };
  const ownItems = (runtime: WorkSourceRuntime) =>
    [...items.entries()]
      .filter(([key]) => key.startsWith(`${runtime.identity}\u0000`))
      .map(([, detail]) => detail);
  const watchQueue = options.watch;

  const adapter: WorkSourceAdapter = {
    kind,
    capabilities: fakeCapabilities(kind),
    identity: identityOf,
    test: ({ config, secret }) =>
      Effect.suspend((): Effect.Effect<{ readonly identity: string }, WorkDomainError> => {
        const identity = identityOf(config);
        tested.push({ identity, secret });
        if (state.fail !== null) return Effect.fail(state.fail);
        if (config.kind === "markdown" && config.directory === "nope") {
          return Effect.fail(new WorkInvalid({ detail: "That directory cannot hold tasks." }));
        }
        if (config.kind === "jira" && secret === undefined) {
          return Effect.fail(new WorkUnauthenticated({ detail: "Jira needs an API token." }));
        }
        return Effect.succeed({ identity });
      }),
    prepare: (runtime) =>
      Effect.sync(() => {
        prepared.push(runtime.identity);
      }),
    list: (runtime, query) =>
      call("list", () =>
        Effect.succeed({
          items: ownItems(runtime)
            .filter(
              (detail) =>
                query.statuses === undefined ||
                (query.statuses as ReadonlyArray<string>).includes(detail.status),
            )
            .map(summaryOf),
          nextCursor: null,
          stale: false,
        }),
      ),
    get: (runtime, itemId) => call(`get:${itemId}`, () => find(runtime, itemId)),
    people: () => Effect.succeed([]),
    create: (runtime, input) =>
      call("create", () =>
        Effect.gen(function* () {
          const gate = state.createGate;
          if (gate !== null) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          minted += 1;
          const itemId = WorkItemId.make(options.mintId?.(minted) ?? `item-${minted}`);
          return put(runtime, {
            ...fakeDetail({ sourceId: runtime.sourceId, itemId }, kind, input.title),
            body: input.body ?? "",
            labels: input.labels ?? [],
          });
        }),
      ),
    update: (runtime, patch) =>
      call("update", () =>
        find(runtime, patch.ref.itemId).pipe(
          Effect.flatMap((detail) => checked(detail, patch.expectedRevision)),
          Effect.map((detail) =>
            put(runtime, {
              ...detail,
              title: patch.title ?? detail.title,
              body: patch.body ?? detail.body,
              revision: `${detail.revision}+`,
            }),
          ),
        ),
      ),
    setStatus: (runtime, input) =>
      call("setStatus", () =>
        find(runtime, input.ref.itemId).pipe(
          Effect.flatMap((detail) => checked(detail, input.expectedRevision)),
          Effect.map((detail) =>
            put(runtime, {
              ...detail,
              status: input.status ?? detail.status,
              revision: `${detail.revision}+`,
            }),
          ),
        ),
      ),
    comment: (runtime, itemId, body, actor) =>
      call("comment", () =>
        find(runtime, itemId).pipe(
          Effect.map(() => {
            comments.push({ itemId, body, actorId: actor.id });
            return { commentId: `comment-${comments.length}` };
          }),
        ),
      ),
    snapshots: (runtime, itemIds) =>
      call("snapshots", () =>
        Effect.gen(function* () {
          const read = itemIds.flatMap((itemId) => {
            const detail = items.get(keyOf(runtime, itemId));
            return detail === undefined ? [] : [summaryOf(detail)];
          });
          const gate = state.snapshotsGate;
          if (gate !== null) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          return read;
        }),
      ),
    ...(watchQueue === undefined
      ? {}
      : {
          watch: () => {
            watchers.started += 1;
            return Stream.fromQueue(watchQueue).pipe(
              Stream.ensuring(
                (options.onWatchEnd ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      watchers.stopped += 1;
                    }),
                  ),
                ),
              ),
            );
          },
        }),
  };

  return {
    adapter,
    calls,
    count: (name) => calls.filter((call) => call === name).length,
    prepared,
    tested,
    comments,
    watchers,
    get fail() {
      return state.fail;
    },
    set fail(value) {
      state.fail = value;
    },
    get createGate() {
      return state.createGate;
    },
    set createGate(value) {
      state.createGate = value;
    },
    get snapshotsGate() {
      return state.snapshotsGate;
    },
    set snapshotsGate(value) {
      state.snapshotsGate = value;
    },
  };
};

/**
 * The Work service over real stores on an in-memory database, with the project, projection and
 * secret stores replaced by maps the test edits directly.
 */
export const makeHarness = (adapters: ReadonlyArray<WorkSourceAdapter>) => {
  const projects = new Map<ProjectId, ProjectStore.ProjectRow>();
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
  /** Run records by thread, as far as the reactor reads them (id, status, completion). */
  const runs = new Map<
    ThreadId,
    ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "completedAt">>
  >();
  const secrets = new Map<string, string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const persistence = Layer.mergeAll(WorkSourceStore.layer, WorkLinkStore.layer).pipe(
    Layer.provide(WorkMigrations.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const stores = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.sync(() => {
          const project = projects.get(projectId);
          return project === undefined ? Option.none() : Option.some(project);
        }),
      list: (options) =>
        Effect.sync(() =>
          [...projects.values()].filter(
            (project) =>
              options?.projectIds === undefined || options.projectIds.includes(project.projectId),
          ),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
      getThreadRecords: (threadId, _fields, filter) =>
        Effect.sync(
          () =>
            ({
              runs: (runs.get(threadId) ?? []).filter(
                (run) => filter?.runIds === undefined || filter.runIds.includes(run.id),
              ),
            }) as never,
        ),
    }),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) =>
        Effect.sync(() => {
          const value = secrets.get(name);
          return value === undefined ? Option.none() : Option.some(encoder.encode(value));
        }),
      set: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, decoder.decode(value));
        }),
      remove: (name) =>
        Effect.sync(() => {
          secrets.delete(name);
        }),
    }),
  );
  const layer = WorkService.layer.pipe(
    Layer.provide(layerRegistry(adapters)),
    Layer.provideMerge(stores),
    Layer.provideMerge(persistence),
    Layer.provide(NodeServices.layer),
  );
  return { layer, projects, threads, runs, secrets };
};

export type Harness = ReturnType<typeof makeHarness>;
