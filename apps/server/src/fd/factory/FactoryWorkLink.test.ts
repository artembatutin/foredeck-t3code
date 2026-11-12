import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { type WorkItemRef, workItemScopeChanged } from "@t3tools/contracts/fd/work-management";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as DocumentText from "../../provider/DocumentText.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
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
  readonly threads: Map<ThreadId, OrchestrationV2ThreadShell>;
  /** The author run as the projection reports it. */
  run: { status: OrchestrationV2RunStatus; completedAt: DateTime.Utc | null };
  launchFailure: ThreadLaunch.ThreadLaunchError | null;
  /** Runs inside each launch once it has created the thread, standing in for its preparation. */
  onLaunch: Effect.Effect<void> | null;
  root: string;
  worktree: string;
}

const shellOf = (threadId: ThreadId, activeRunId: RunId | null) =>
  ({
    id: threadId,
    projectId,
    activeRunId,
    latestRunId: runId,
    deletedAt: null,
    settledAt: null,
    archivedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

// The launch creates the thread Factory names and reports its first run; the projection reads
// give Work the thread and its run, and the effects a prepared worktree.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.suspend(() => {
          world.launches.push(input);
          if (world.launchFailure !== null) return Effect.fail(world.launchFailure);
          const { threadId } = input;
          if (threadId === undefined) return Effect.die("Factory names the thread it launches.");
          // A replay of the command finds its thread, as the launch receipt does.
          const resumed = world.threads.has(threadId);
          if (!resumed) world.threads.set(threadId, shellOf(threadId, runId));
          const runs = [
            { id: runId, userMessageId: input.initialMessage?.messageId, status: "preparing" },
          ];
          return (world.onLaunch ?? Effect.void).pipe(
            Effect.as({
              threadId,
              projection: { runs },
              resumed,
            } as unknown as ThreadLaunch.ThreadLaunchResult),
          );
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadEventSequence: () => Effect.succeed(0),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.sync(() => world.threads.get(threadId) ?? null),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.suspend(() => {
          if (!world.threads.has(threadId)) {
            return Effect.fail(
              new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
            );
          }
          return Effect.succeed({
            thread: { id: threadId, worktreePath: world.worktree, deletedAt: null },
            runs: [
              {
                id: runId,
                userMessageId: world.launches.find((launch) => launch.threadId === threadId)
                  ?.initialMessage?.messageId,
                ...world.run,
              },
            ],
          });
        })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
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
            pinnedAt: null,
            archivedAt: null,
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
  Layer.provide(Layer.mock(WorkManagement.WorkGitHubApi)({})),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(FetchHttpClient.layer),
);

/** Work's link sweep; its event tails are never started. */
const reactorLayer = WorkManagement.WorkSyncReactor.layer.pipe(
  Layer.provide(Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({})),
  Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
);

const makeLayer = (world: World) =>
  Layer.mergeAll(FactoryThreadEffects.layer, reactorLayer).pipe(
    Layer.provideMerge(workLayer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(FactorySettings.layer),
    Layer.provide(Factory.layerPersistence),
    Layer.provide(ProviderRegistryMock.layer()),
    Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
    Layer.provideMerge(fakes(world)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
      }),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-work-link-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const world: World = {
      launches: [],
      threads: new Map(),
      run: { status: "running", completedAt: null },
      launchFailure: null,
      onLaunch: null,
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
          scopeFingerprint: WorkManagement.workItemScopeFingerprint(
            yield* Effect.flatMap(WorkManagement.WorkService.WorkService, (work) =>
              work.getItem(owner, { ref: item.ref }),
            ),
          ),
        });
        // Listed with the item's open threads too, and found from the thread.
        assert.deepStrictEqual(yield* listLinks({}), links);
        assert.deepStrictEqual(yield* listLinks({ threadId: launched.threadId }), links);
      }),
    ),
  );

  it.effect("does not read Factory's progress comments as changed requirements", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        yield* launchAuthor(deliveryOf(item.ref));
        const work = yield* WorkManagement.WorkService.WorkService;
        const read = work.getItem(owner, { ref: item.ref });
        const before = yield* read;
        assert.isFalse(workItemScopeChanged(before.links[0]!, before));

        // A real Markdown source keeps the comment in the body's Notes, moving its revision.
        yield* work.addComment(owner, { ref: item.ref, body: "Factory: the verify passed." });
        const commented = yield* read;
        assert.notStrictEqual(commented.revision, before.revision);
        assert.isFalse(workItemScopeChanged(commented.links[0]!, commented));

        yield* work.updateItem(owner, {
          ref: item.ref,
          expectedRevision: commented.revision,
          title: "Add the export and import buttons",
        });
        const edited = yield* read;
        assert.isTrue(workItemScopeChanged(edited.links[0]!, edited));
      }),
    ),
  );

  describe("a Markdown item whose code fence never closes", () => {
    const requirement = "Must write CSV.";

    /** The project's item with that body, and what reads it. */
    const fencedItem = (world: World) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        const work = yield* WorkManagement.WorkService.WorkService;
        yield* work.updateItem(owner, {
          ref: item.ref,
          expectedRevision: item.revision,
          body: ["Export.", "```", requirement, ""].join("\n"),
        });
        return { item, work, read: work.getItem(owner, { ref: item.ref }) };
      });

    it.effect("reads a comment that creates Notes ahead of it as no changed requirement", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { item, work, read } = yield* fencedItem(world);
          yield* launchAuthor(deliveryOf(item.ref));
          const before = yield* read;
          assert.notInclude(before.body, "## Notes");

          yield* work.addComment(owner, { ref: item.ref, body: "Progress." });

          const after = yield* read;
          assert.include(after.body, "## Notes");
          assert.notStrictEqual(after.revision, before.revision);
          assert.isFalse(workItemScopeChanged(after.links[0]!, after));
        }),
      ),
    );

    it.effect("reads an edit inside it as one, for a link made before the comment or after", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { item, work, read } = yield* fencedItem(world);
          yield* launchAuthor(deliveryOf(item.ref));
          yield* work.addComment(owner, { ref: item.ref, body: "Progress." });
          const later = ThreadId.make("thread-linked-later");
          world.threads.set(later, world.threads.values().next().value!);
          yield* work.setLink(owner, { ref: item.ref, threadId: later, action: "link" });
          const commented = yield* read;
          assert.lengthOf(commented.links, 2);
          for (const link of commented.links) {
            assert.isFalse(workItemScopeChanged(link, commented));
          }

          yield* work.updateItem(owner, {
            ref: item.ref,
            expectedRevision: commented.revision,
            body: commented.body.replace(requirement, "Must write CSV and PDF."),
          });

          const edited = yield* read;
          for (const link of edited.links) {
            assert.isTrue(workItemScopeChanged(link, edited));
          }
        }),
      ),
    );
  });

  describe("a Markdown item past the wire's cap", () => {
    const rewrite = (world: World, locator: string, edit: (text: string) => string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(world.root, locator);
        yield* fileSystem.writeFileString(file, edit(yield* fileSystem.readFileString(file)));
        yield* Effect.flatMap(WorkManagement.WorkService.WorkService, (work) =>
          work.refresh(owner, {}),
        );
      });

    it.effect("reads a comment that grows it across the cap as no changed requirement", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const item = yield* makeProject(world);
          const work = yield* WorkManagement.WorkService.WorkService;
          const read = work.getItem(owner, { ref: item.ref });
          yield* work.updateItem(owner, {
            ref: item.ref,
            expectedRevision: item.revision,
            body: "a".repeat(65_000),
          });
          yield* launchAuthor(deliveryOf(item.ref));
          const before = yield* read;
          assert.isFalse(before.bodyTruncated);
          assert.isFalse(workItemScopeChanged(before.links[0]!, before));

          yield* work.addComment(owner, { ref: item.ref, body: "x".repeat(1_000) });

          const after = yield* read;
          assert.isTrue(after.bodyTruncated);
          assert.notStrictEqual(after.revision, before.revision);
          assert.isFalse(workItemScopeChanged(after.links[0]!, after));
          // What judges a capture or a delivery's opening reads the same value.
          assert.strictEqual(
            WorkManagement.workItemScopeFingerprint(after),
            before.links[0]?.snapshot.scopeFingerprint,
          );
        }),
      ),
    );

    it.effect("reads an edit of criteria past the cap as a changed requirement", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const item = yield* makeProject(world);
          const work = yield* WorkManagement.WorkService.WorkService;
          const read = work.getItem(owner, { ref: item.ref });
          const { locator } = yield* read;
          const longNotes = Array.from(
            { length: 40 },
            () => `- 2026-10-20T10:40:00Z (owner) ${"n".repeat(2_000)}`,
          ).join("\n");
          yield* rewrite(
            world,
            locator!,
            (text) =>
              `${text.trimEnd()}\n\n## Notes\n${longNotes}\n\n## Acceptance criteria\n\n1. Writes CSV.\n`,
          );
          yield* launchAuthor(deliveryOf(item.ref));
          const before = yield* read;
          assert.isTrue(before.bodyTruncated);
          assert.notInclude(before.body, "Acceptance criteria");
          assert.isFalse(workItemScopeChanged(before.links[0]!, before));

          // A comment past the cap asks nothing new.
          yield* work.addComment(owner, { ref: item.ref, body: "Progress." });
          const commented = yield* read;
          assert.notStrictEqual(commented.revision, before.revision);
          assert.isFalse(workItemScopeChanged(commented.links[0]!, commented));

          yield* rewrite(world, locator!, (text) =>
            text.replace("1. Writes CSV.", "1. Writes CSV and PDF."),
          );
          const edited = yield* read;
          assert.strictEqual(edited.body, commented.body);
          assert.isTrue(workItemScopeChanged(edited.links[0]!, edited));
        }),
      ),
    );

    it.effect("claims no change for a file it can no longer read cleanly", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const item = yield* makeProject(world);
          const work = yield* WorkManagement.WorkService.WorkService;
          const read = work.getItem(owner, { ref: item.ref });
          const { locator } = yield* read;
          yield* launchAuthor(deliveryOf(item.ref));

          yield* rewrite(world, locator!, (text) =>
            text.replace("status: todo", "status: nonsense"),
          );

          const broken = yield* read;
          assert.isNotNull(broken.invalid);
          assert.notProperty(broken, "scopeFingerprint");
          assert.isFalse(workItemScopeChanged(broken.links[0]!, broken));
        }),
      ),
    );
  });

  it.effect("keeps one link when the same launch effect runs again", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        const delivery = deliveryOf(item.ref);

        const first = yield* launchAuthor(delivery);
        const second = yield* launchAuthor(delivery);

        // One command id and thread id, so the launch replays its thread.
        const once = [`factory-launch:${deliveryId}:1`, `factory-thread:${deliveryId}:1`];
        assert.deepStrictEqual(
          world.launches.map((launch): ReadonlyArray<string | undefined> => [
            launch.commandId,
            launch.threadId,
          ]),
          [once, once],
        );
        assert.strictEqual(second.threadId, first.threadId);
        assert.deepStrictEqual(
          (yield* listLinks({ ref: item.ref })).map((link) => [link.threadId, link.origin]),
          [[first.threadId, "factory"]],
        );
      }),
    ),
  );

  it.effect("records the author run's end when the run ends before the launch returns", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const item = yield* makeProject(world);
        const services = yield* Effect.context<WorkManagement.WorkService.WorkService>();
        const linkedDuringLaunch: Array<ReadonlyArray<ThreadId>> = [];
        // Preparation runs in the background and fails the run before the launch returns, and
        // time moves on before Factory gets the result.
        world.onLaunch = Effect.gen(function* () {
          const links = yield* listLinks({ ref: item.ref });
          linkedDuringLaunch.push(links.map((link) => link.threadId));
          world.run = { status: "failed", completedAt: yield* DateTime.now };
          for (const threadId of world.threads.keys()) {
            world.threads.set(threadId, shellOf(threadId, null));
          }
          yield* TestClock.adjust("1 minute");
        }).pipe(Effect.provideContext(services), Effect.orDie);

        const launched = yield* launchAuthor(deliveryOf(item.ref));

        // The link already existed, so the run's end event finds it too.
        assert.deepStrictEqual(linkedDuringLaunch, [[launched.threadId]]);
        const reactor = yield* WorkManagement.WorkSyncReactor.WorkSyncReactor;
        yield* reactor.sweepLinks;
        yield* reactor.drain;
        const links = yield* listLinks({ ref: item.ref });
        assert.deepStrictEqual(
          links.map((link) => [link.threadId, link.origin, link.run]),
          [[launched.threadId, "factory", { status: "failed", at: "1970-01-01T00:00:00.000Z" }]],
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
