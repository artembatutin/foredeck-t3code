import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkManagement from "../work-management/index.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-1");
const runId = RunId.make("run-1");
const branch = "feature/export-button";

const owner: WorkManagement.WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthSettingsWriteScope],
  label: "owner",
};

/** The first author launch of a new delivery, as the engine issues it. */
const authorLaunch = {
  id: 1,
  type: "launch_thread",
  role: "author",
  workspace: { type: "worktree", branch, baseRef: "main" },
} as const;

/** What the fakes stand in for, as the test sets it up and as they record it. */
interface World {
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  /** The thread each launch command created; a replay gets it back, as its receipt gives it. */
  readonly created: Map<CommandId, ThreadId>;
  readonly threads: Map<ThreadId, OrchestrationV2ThreadShell>;
  launchFailure: ThreadLaunch.ThreadLaunchError | null;
  root: string;
  worktree: string;
}

// The launch creates the thread and reports its first run; the projection reads give Work the
// thread shell and the effects a prepared worktree with the run still going.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.suspend(() => {
          world.launches.push(input);
          if (world.launchFailure !== null) return Effect.fail(world.launchFailure);
          const replayed = world.created.get(input.commandId);
          const threadId = replayed ?? ThreadId.make(`thread-${world.created.size + 1}`);
          world.created.set(input.commandId, threadId);
          world.threads.set(threadId, {
            id: threadId,
            projectId,
            deletedAt: null,
            settledAt: null,
            archivedAt: null,
          } as unknown as OrchestrationV2ThreadShell);
          const runs = [
            { id: runId, userMessageId: input.initialMessage?.messageId, status: "running" },
          ];
          return Effect.succeed({
            threadId,
            projection: { runs },
            resumed: replayed !== undefined,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadEventSequence: () => Effect.succeed(0),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.sync(() => world.threads.get(threadId) ?? null),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.sync(() => ({
          thread: { id: threadId, worktreePath: world.worktree, deletedAt: null },
          runs: [{ id: runId, status: "running" }],
        }))) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() =>
          Option.some({
            projectId: id,
            title: "Alpha",
            workspaceRoot: world.root,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-24T00:00:00.000Z",
            updatedAt: "2026-10-24T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    // Markdown sources hold no credential.
    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  );

/** Work as the server builds it, with its real Markdown source, over the same database. */
const workLayer = WorkManagement.WorkService.layer.pipe(
  Layer.provide(WorkManagement.layerAdapters),
  Layer.provideMerge(WorkManagement.layerPersistence),
  Layer.provide(Layer.mock(GitHubApi.GitHubApi)({})),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(FetchHttpClient.layer),
);

const makeLayer = (world: World) =>
  FactoryThreadEffects.layer.pipe(
    Layer.provideMerge(workLayer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(FactorySettings.layer),
    Layer.provide(Factory.layerPersistence),
    Layer.provideMerge(fakes(world)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-work-link-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const world: World = {
      launches: [],
      created: new Map(),
      threads: new Map(),
      launchFailure: null,
      root: "/nowhere",
      worktree: "/nowhere",
    };
    return body(world).pipe(Effect.provide(makeLayer(world)));
  }).pipe(Effect.scoped);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  );

/**
 * A project checkout on `main` with a Markdown Work source and one item in it, and the
 * delivery's worktree, created from `main` the way the author launch prepares it.
 */
const makeProject = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    world.root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-link-root-" });
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-link-wt-" });
    world.worktree = path.join(parent, "item");
    yield* git(world.root, ["init", "-b", "main"]);
    yield* git(world.root, [
      "-c",
      "user.name=Ada Lovelace",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      "chore: root",
    ]);
    yield* git(world.root, ["worktree", "add", "-b", branch, world.worktree, "main"]);

    const work = yield* WorkManagement.WorkService.WorkService;
    const source = yield* work.saveSource(owner, {
      projectId,
      label: "Tasks",
      config: { kind: "markdown", directory: "tasks", autoStart: false },
    });
    return yield* work.createItem(owner, {
      sourceId: source.sourceId,
      title: "Add the export button",
    });
  });

const deliveryOf = (itemRef: WorkItemRef): StoredFactoryDelivery => ({
  deliveryId,
  projectId,
  itemRef,
  parentId: null,
  state: queuedDeliveryState({ branch, baseRef: "main" }),
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
});

const launchAuthor = (delivery: StoredFactoryDelivery) =>
  Effect.flatMap(FactoryThreadEffects.FactoryThreadEffects, (effects) =>
    effects.launchThread(delivery, authorLaunch),
  );

const listLinks = (
  query: Parameters<WorkManagement.WorkService.WorkService["Service"]["listLinks"]>[1],
) =>
  Effect.flatMap(WorkManagement.WorkService.WorkService, (work) =>
    work.listLinks(owner, query).pipe(Effect.map(({ links }) => links)),
  );

describe("FactoryThreadEffects Work links", () => {
  it.effect("links the author thread to the delivery's item with the Factory origin", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);

        const launched = yield* launchAuthor(deliveryOf(item.ref));

        const links = yield* listLinks({ ref: item.ref });
        assert.deepStrictEqual(
          links.map((link) => [link.ref, link.threadId, link.source, link.origin, link.run]),
          [[item.ref, launched.threadId, "started", "factory", null]],
        );
        assert.deepStrictEqual(links[0]?.snapshot, {
          key: item.key,
          title: "Add the export button",
          status: item.status,
          url: item.url,
          revision: item.revision,
          autoStarted: false,
        });
        // Listed with the item's open threads too, and found from the thread.
        assert.deepStrictEqual(yield* listLinks({}), links);
        assert.deepStrictEqual(yield* listLinks({ threadId: launched.threadId }), links);
      }),
    ),
  );

  it.effect("keeps one link when the same launch effect runs again", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        const delivery = deliveryOf(item.ref);

        const first = yield* launchAuthor(delivery);
        const second = yield* launchAuthor(delivery);

        // One command id, so the launch replays its thread.
        assert.deepStrictEqual(
          world.launches.map((launch) => launch.commandId),
          [`factory-launch:${deliveryId}:1`, `factory-launch:${deliveryId}:1`],
        );
        assert.strictEqual(second.threadId, first.threadId);
        assert.deepStrictEqual(
          (yield* listLinks({ ref: item.ref })).map((link) => [link.threadId, link.origin]),
          [[first.threadId, "factory"]],
        );
      }),
    ),
  );

  it.effect("links nothing when the launch fails before a thread exists", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        world.launchFailure = new ThreadLaunch.ThreadLaunchError({
          operation: "create-thread",
          commandId: CommandId.make(`factory-launch:${deliveryId}:1`),
          projectId,
          cause: "provider unavailable",
        });

        const failure = yield* Effect.flip(launchAuthor(deliveryOf(item.ref)));

        assert.strictEqual(failure._tag, "ThreadLaunchError");
        assert.strictEqual(world.launches.length, 1);
        assert.deepStrictEqual(yield* listLinks({ ref: item.ref }), []);
        assert.deepStrictEqual(yield* listLinks({}), []);
      }),
    ),
  );
});
