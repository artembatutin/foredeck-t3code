import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2RunStatus,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "./pipeline/state.ts";
import type { FactoryAuthorItem } from "./prompts/author.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-1");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
// The id Factory derives for the delivery's first launch effect.
const author = ThreadId.make(`factory-thread:${deliveryId}:1`);
const firstRun = RunId.make("run-1");
const fixRun = RunId.make("run-2");
const branch = "feature/item-7";

const authorModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "author-model",
};
const projectModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-model",
};

const item = {
  ref: itemRef,
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: null,
  locator: "tasks/fd-aaaaaa.md",
  body: "Users can export the current table as CSV.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

/**
 * Everything outside Factory the effects talk to, as the test sets it up and as the fakes record
 * it. The projection holds one thread (the author's) and the runs the test gives a status.
 */
interface World {
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput>;
  readonly runs: Map<RunId, OrchestrationV2RunStatus>;
  /** An author seeded by the test rather than launched through this fake. */
  existingAuthor: boolean;
  worktreePath: string | null;
  workspaceRoot: string;
  projectModel: ModelSelection | null;
  launchFailure: ThreadLaunch.ThreadLaunchError | null;
  sendFailure: Orchestrator.OrchestratorCommandRejectedError | null;
  /** Projection reads that succeed before every later one fails; null never fails. */
  readsUntilFailure: number | null;
  /** Runs inside each launch, standing in for its preparation. */
  onLaunch: Effect.Effect<void> | null;
  /** The author thread's events after the launch, as the test offers them. */
  readonly events: Queue.Queue<OrchestrationV2StoredEvent>;
  /** Completed once the launch subscribes to the thread's events. */
  readonly watching: Deferred.Deferred<void>;
}

// The effects read only these fields of the launch result, the thread records and the send
// result, so the fakes build no more than that.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.suspend(() => {
          world.launches.push(input);
          if (world.launchFailure !== null) return Effect.fail(world.launchFailure);
          const prepare = world.onLaunch ?? Effect.void;
          // The author's launch starts run-1; a later launch (the reviewer's) a run of its own.
          const id =
            world.launches.length === 1
              ? firstRun
              : RunId.make(`run-launch-${world.launches.length}`);
          const runs = [
            { id, userMessageId: input.initialMessage?.messageId, status: "preparing" },
          ];
          return prepare.pipe(
            Effect.as({
              threadId: input.threadId ?? author,
              projection: { runs },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult),
          );
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.suspend(() => {
          world.sends.push(input);
          if (world.sendFailure !== null) return Effect.fail(world.sendFailure);
          return Effect.succeed({
            run: { id: fixRun },
            message: { attachments: [] },
          } as unknown as ThreadManagement.ThreadManagementSendResult);
        }),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () =>
        Stream.unwrap(
          Deferred.succeed(world.watching, undefined).pipe(
            Effect.as(Stream.fromQueue(world.events)),
          ),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((threadId: ThreadId, _fields: unknown, filter?: { runIds?: RunId[] }) =>
        Effect.gen(function* () {
          if (world.launches.length === 0 && !world.existingAuthor && filter === undefined) {
            return yield* new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId });
          }
          if (world.readsUntilFailure === 0) {
            return yield* new ProjectionStore.ProjectionStoreReadError({ threadId });
          }
          if (world.readsUntilFailure !== null) world.readsUntilFailure -= 1;
          const runs = (filter?.runIds ?? []).flatMap((id) => {
            const status = world.runs.get(id);
            return status === undefined ? [] : [{ id, status }];
          });
          return {
            thread: {
              id: threadId,
              worktreePath: world.worktreePath,
              deletedAt: null,
              modelSelection: authorModel,
            },
            runs,
          };
        })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() =>
          Option.some({
            projectId: id,
            title: "Alpha",
            workspaceRoot: world.workspaceRoot,
            defaultModelSelection: world.projectModel,
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
    Layer.mock(WorkService.WorkService)({
      getItem: () => Effect.succeed(item as unknown as WorkItemDetail),
      // FactoryWorkLink.test.ts covers the link on the real Work service.
      linkLaunch: (_input, launch) => launch,
    }),
  );

/** The worker with the real thread effects over the fakes, in-memory SQLite and real git. */
const makeLayer = (world: World) =>
  FactoryWorker.layer.pipe(
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(
      Layer.mergeAll(
        FactoryThreadEffects.layer,
        FactoryReview.layer.pipe(Layer.provide(FactoryEvidence.layer)),
        Layer.mock(FactoryChildren.FactoryChildren)({}),
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        // No delivery here reaches record; FactoryRecord.test.ts covers it.
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
      ),
    ),
    Layer.provide(fakes(world)),
    Layer.provide(ProviderRegistryMock.layer()),
    Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      FactoryVerifyRunner.layer.pipe(
        Layer.provide(FactoryEvidence.layer),
        Layer.provide(ProcessRunner.layer),
      ),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-threads-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const world: World = {
      launches: [],
      sends: [],
      runs: new Map([
        [firstRun, "running"],
        [fixRun, "running"],
      ]),
      existingAuthor: false,
      worktreePath: null,
      workspaceRoot: "/nowhere",
      projectModel: null,
      launchFailure: null,
      sendFailure: null,
      readsUntilFailure: null,
      onLaunch: null,
      events: yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
      watching: yield* Deferred.make<void>(),
    };
    return yield* body(world).pipe(Effect.provide(makeLayer(world)));
  }).pipe(Effect.scoped);

const queued = queuedDeliveryState({ branch, baseRef: "main" });
const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const insert = (state: FactoryDeliveryState = queued) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
    store.insert({ deliveryId, projectId, itemRef, state }),
  );
const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const step = (event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(deliveryId, event));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
);
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`;
});

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const useSettings = (input: { readonly author?: ModelSelection; readonly verify?: string }) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(
      projectId,
      decodeSettings({
        verifyCommand:
          input.verify === undefined
            ? null
            : { executable: process.execPath, args: ["-e", input.verify] },
        roles: { author: input.author ?? null },
      }),
    ),
  );

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });
const commit = (cwd: string, message: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", message]);

/**
 * A project checkout whose HEAD is on a scratch branch ahead of `main`, and a worktree of it on
 * the delivery branch, created from `main` the way a new delivery worktree is. With
 * `worktree: false` only its path is chosen, for a launch to create it.
 */
const makeProject = (world: World, options: { readonly worktree?: boolean } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-threads-root-" });
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-threads-wt-" });
    yield* git(root, ["init", "-b", "main"]);
    yield* fileSystem.writeFileString(path.join(root, "README.md"), "root\n");
    yield* git(root, ["add", "README.md"]);
    yield* commit(root, "chore: root");
    const main = yield* git(root, ["rev-parse", "main"]);
    yield* git(root, ["switch", "-c", "scratch"]);
    yield* commit(root, "chore: scratch");
    const worktree = path.join(parent, "item-7");
    if (options.worktree !== false) {
      yield* git(root, ["worktree", "add", "-b", branch, worktree, "main"]);
    }
    world.workspaceRoot = root;
    return { root, worktree, main };
  });

/** Moves `main` one commit ahead without touching the checkout, as another push would. */
const advanceMain = (root: string) =>
  Effect.gen(function* () {
    const next = yield* git(root, [
      ...ada,
      "commit-tree",
      "main^{tree}",
      "-p",
      "main",
      "-m",
      "chore: upstream change",
    ]);
    yield* git(root, ["update-ref", "refs/heads/main", next]);
    return next;
  });

/**
 * Stands in for a launch's preparation, which runs after Factory resolved the base ref: `main`
 * may move on first, the worktree is created from what `main` names by then (its branch reflog
 * optionally off), and the agent may commit before the launch is reported. Returns the commit
 * the worktree was created at once the launch has run.
 */
const provisionDuringLaunch = (
  world: World,
  project: { readonly root: string; readonly worktree: string },
  options: {
    readonly moveMain: boolean;
    readonly reflog: boolean;
    readonly agentCommits: boolean;
  },
) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<GitVcsDriver.GitVcsDriver>();
    const created = { sha: "" };
    world.onLaunch = Effect.gen(function* () {
      if (options.moveMain) yield* advanceMain(project.root);
      created.sha = yield* git(project.root, ["rev-parse", "main"]);
      yield* git(project.root, [
        ...(options.reflog ? [] : ["-c", "core.logAllRefUpdates=false"]),
        "worktree",
        "add",
        "-b",
        branch,
        project.worktree,
        "main",
      ]);
      world.worktreePath = project.worktree;
      if (options.agentCommits) yield* commit(project.worktree, "feat: agent work");
    }).pipe(Effect.provideContext(services), Effect.orDie);
    return created;
  });

const threadEvent = (type: "thread.metadata-updated" | "run.updated") =>
  // The launch re-reads the projection on these; it reads nothing else from the event.
  ({
    sequence: 1,
    commandId: null,
    event: { type, threadId: author },
  }) as unknown as OrchestrationV2StoredEvent;

const passingVerify = `console.log("all checks passed")`;

describe("FactoryThreadEffects launches", () => {
  it.effect("launches the first author thread on a new worktree and records it", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree, main } = yield* makeProject(world);
        world.worktreePath = worktree;
        // The author profile wins over the project default.
        world.projectModel = projectModel;
        yield* useSettings({ author: authorModel });
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        assert.strictEqual(world.launches.length, 1);
        const [launch] = world.launches;
        assert.strictEqual(launch?.threadId, author);
        assert.deepStrictEqual(launch?.workspaceStrategy, {
          type: "worktree",
          baseRef: "main",
          branch,
        });
        assert.strictEqual(launch?.projectId, projectId);
        assert.deepStrictEqual(launch?.modelSelection, authorModel);
        assert.strictEqual(launch?.interactionMode, "default");
        assert.strictEqual(launch?.title, "fd-aaaaaa: Add the export button");
        const text = launch?.initialMessage?.text ?? "";
        for (const expected of [
          "Work item fd-aaaaaa: Add the export button",
          "Users can export the current table as CSV.",
          `branch \`${branch}\``,
          "Implement only this task",
          "regression tests",
          "Never weaken",
          "Commit with Conventional Commits",
          "leave the worktree clean",
          "Never push, merge, switch branches, edit outside this worktree or rewrite existing commits.",
          "Never name an AI agent, model or provider",
          "no AI attribution",
          "Do not edit `tasks/fd-aaaaaa.md` in this worktree.",
          "maps each acceptance criterion to the committed test paths",
        ]) {
          assert.include(text, expected);
        }

        const state = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.worktreePath, worktree);
        assert.strictEqual(state.threads.author, author);
        // The commit `main` named, not the checkout's HEAD.
        assert.strictEqual(state.baseline, main);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: firstRun });
        const [attempt] = yield* attempts;
        assert.strictEqual(attempt?.runId, firstRun);
      }),
    ),
  );

  it.effect("launches a later thread in the recorded worktree from its HEAD", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree, main } = yield* makeProject(world);
        yield* commit(worktree, "feat: earlier work");
        const head = yield* git(worktree, ["rev-parse", "HEAD"]);
        world.worktreePath = worktree;
        yield* insert(queuedDeliveryState({ branch, baseRef: "main", worktreePath: worktree }));

        yield* step({ type: "start" });
        yield* drain;

        assert.deepStrictEqual(
          world.launches.map((launch) => launch.workspaceStrategy),
          [{ type: "existing_worktree", worktreePath: worktree }],
        );
        const state = yield* stored;
        assert.strictEqual(state.worktreePath, worktree);
        assert.strictEqual(state.baseline, head);
        assert.notStrictEqual(state.baseline, main);
      }),
    ),
  );

  it.effect("uses the project default model without an author profile", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.worktreePath = worktree;
        world.projectModel = projectModel;
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        assert.deepStrictEqual(world.launches[0]?.modelSelection, projectModel);
      }),
    ),
  );

  it.effect("uses the automatic selection without an author profile or project default", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.worktreePath = worktree;
        yield* useSettings({});
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        assert.deepStrictEqual(
          world.launches[0]?.modelSelection,
          getAutoBootstrapThreadModelSelection(),
        );
      }),
    ),
  );

  it.effect("waits for the new worktree to be recorded before reporting the launch", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.runs.set(firstRun, "preparing");
        yield* insert();

        yield* step({ type: "start" });
        yield* Deferred.await(world.watching);
        assert.strictEqual((yield* stored).awaiting?.type, "effect");

        world.worktreePath = worktree;
        yield* Queue.offer(world.events, threadEvent("thread.metadata-updated"));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.worktreePath, worktree);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: firstRun });
      }),
    ),
  );

  it.effect("records a launch whose preparation failed and blocks on its ended run", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { main } = yield* makeProject(world);
        world.runs.set(firstRun, "preparing");
        yield* insert();

        yield* step({ type: "start" });
        yield* Deferred.await(world.watching);
        world.runs.set(firstRun, "failed");
        yield* Queue.offer(world.events, threadEvent("run.updated"));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "run_ended",
          threadId: author,
          runId: firstRun,
          runStatus: "failed",
        });
        assert.strictEqual(state.threads.author, author);
        assert.isNull(state.worktreePath);
        assert.strictEqual(state.baseline, main);
      }),
    ),
  );
});

describe("FactoryThreadEffects baselines of new worktrees", () => {
  it.effect(
    "records the commit the worktree started at when the base ref moves during launch",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const project = yield* makeProject(world, { worktree: false });
          const created = yield* provisionDuringLaunch(world, project, {
            moveMain: true,
            reflog: true,
            agentCommits: true,
          });
          yield* insert();

          yield* step({ type: "start" });
          yield* drain;

          // The launch still names the base ref; the baseline follows what it named when used.
          assert.deepStrictEqual(world.launches[0]?.workspaceStrategy, {
            type: "worktree",
            baseRef: "main",
            branch,
          });
          const state = yield* stored;
          assert.strictEqual(state.worktreePath, project.worktree);
          assert.strictEqual(state.baseline, created.sha);
          assert.notStrictEqual(state.baseline, project.main);
          assert.notStrictEqual(
            state.baseline,
            yield* git(project.worktree, ["rev-parse", "HEAD"]),
          );
        }),
      ),
  );

  it.effect("keeps the resolved commit without a branch reflog while HEAD has not moved", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const project = yield* makeProject(world, { worktree: false });
        yield* provisionDuringLaunch(world, project, {
          moveMain: false,
          reflog: false,
          agentCommits: false,
        });
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.baseline, project.main);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: firstRun });
      }),
    ),
  );

  it.effect.each([
    { name: "the base ref moved", moveMain: true, reflog: false, agentCommits: false },
    // The branch's reflog then starts at the agent's commit, not at its creation.
    { name: "the agent already committed", moveMain: false, reflog: false, agentCommits: true },
  ] as const)("blocks without a branch reflog once $name", (options) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const project = yield* makeProject(world, { worktree: false });
        yield* provisionDuringLaunch(world, project, options);
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not launch the author thread (FactoryBranchStartError).",
        );
        assert.isNull(state.baseline);
        assert.isNull(state.worktreePath);
        assert.deepStrictEqual(state.threads, {});
      }),
    ),
  );
});

describe("FactoryThreadEffects fix-commit turns", () => {
  it.effect("sends one queued turn on the author thread listing each problem", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree, main } = yield* makeProject(world);
        world.existingAuthor = true;
        // Awaiting the settle check (effect 2) after the author's first run.
        yield* insert(
          fold(
            queued,
            { type: "start" },
            {
              type: "thread.launched",
              effectId: 1,
              threadId: author,
              runId: firstRun,
              worktreePath: worktree,
              baseline: main,
            },
            { type: "run.finished", threadId: author, runId: firstRun, status: "completed" },
          ),
        );
        const problems = [
          "Worktree has uncommitted or untracked changes.",
          'Commit 0123456789ab subject is not a Conventional Commit: "updated stuff".',
        ];

        yield* step({
          type: "settle.checked",
          effectId: 2,
          result: { status: "repairable", problems },
        });
        yield* drain;

        assert.strictEqual(world.launches.length, 0);
        assert.strictEqual(world.sends.length, 1);
        const [send] = world.sends;
        assert.strictEqual(send?.threadId, author);
        assert.strictEqual(send?.projectId, projectId);
        assert.strictEqual(send?.mode, "queue");
        for (const problem of problems) assert.include(send?.text ?? "", `- ${problem}`);
        assert.include(send?.text ?? "", `commits after ${main}`);
        const state = yield* stored;
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: fixRun });
      }),
    ),
  );
});

describe("FactoryThreadEffects runs that ended before their result was stored", () => {
  it.effect("moves a completed launch on through the settle check, once", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        yield* commit(worktree, "feat(server): add the export button");
        world.worktreePath = worktree;
        world.runs.set(firstRun, "completed");
        yield* useSettings({ verify: passingVerify });
        yield* insert();

        // No reactor: the worker itself feeds the run's end.
        yield* step({ type: "start" });
        yield* drain;

        // Verified, then on to review: the reviewer's run is still going.
        const state = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.receipts.length, 1);
        const reviewer = ThreadId.make(`factory-thread:${deliveryId}:4`);
        const reviewRun = RunId.make("run-launch-2");
        assert.deepStrictEqual(state.awaiting, {
          type: "run",
          threadId: reviewer,
          runId: reviewRun,
        });
        assert.deepStrictEqual(
          (yield* attempts).map(({ stage, runId, outcome }) => ({ stage, runId, outcome })),
          [
            { stage: "author", runId: firstRun, outcome: "passed" },
            { stage: "verify", runId: null, outcome: "passed" },
            { stage: "review", runId: reviewRun, outcome: null },
          ],
        );

        const before = yield* rawRow;
        const attemptsBefore = yield* attempts;
        // A write now would move updated_at.
        yield* TestClock.adjust("1 minute");
        yield* step({
          type: "run.finished",
          threadId: author,
          runId: firstRun,
          status: "completed",
        });
        yield* drain;
        assert.deepStrictEqual(yield* rawRow, before);
        assert.deepStrictEqual(yield* attempts, attemptsBefore);
      }),
    ),
  );

  it.effect("checks the branch again when the fix-commit run already completed", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.worktreePath = worktree;
        world.runs.set(firstRun, "completed");
        world.runs.set(fixRun, "completed");
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        // The author added no commit, the one fix-commit turn did not either.
        assert.strictEqual(world.sends.length, 1);
        assert.include(world.sends[0]?.text ?? "", "- No commit was added since the baseline.");
        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "unsettled",
          problems: ["No commit was added since the baseline."],
        });
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.strictEqual(world.launches.length, 1);
      }),
    ),
  );
});

describe("FactoryThreadEffects failures", () => {
  it.effect("blocks a failed launch with a bounded detail and keeps the worktree and threads", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.launchFailure = new ThreadLaunch.ThreadLaunchError({
          operation: "provision-worktree",
          commandId: CommandId.make("factory-launch:delivery-1:1"),
          projectId,
          cause: new ThreadLaunch.ThreadLaunchWorkspaceError({
            detail: "token=hunter2 rejected by the registry",
          }),
        });
        const before = queuedDeliveryState({ branch, baseRef: "main", worktreePath: worktree });
        yield* insert(before);

        yield* step({ type: "start" });
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "existing_worktree", worktreePath: worktree },
          },
          detail: "Factory could not launch the author thread (ThreadLaunchError).",
        });
        assert.notInclude(JSON.stringify(state), "hunter2");
        assert.strictEqual(state.worktreePath, before.worktreePath);
        assert.deepStrictEqual(state.threads, before.threads);
        assert.isNull(state.baseline);
      }),
    ),
  );

  it.effect("blocks a rejected fix-commit dispatch and keeps the author thread", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree, main } = yield* makeProject(world);
        world.existingAuthor = true;
        world.sendFailure = new Orchestrator.OrchestratorCommandRejectedError({
          commandId: CommandId.make("factory-fix-commit:delivery-1:3"),
          commandType: "message.dispatch",
          cause: "token=hunter2",
        });
        const before = fold(
          queued,
          { type: "start" },
          {
            type: "thread.launched",
            effectId: 1,
            threadId: author,
            runId: firstRun,
            worktreePath: worktree,
            baseline: main,
          },
          { type: "run.finished", threadId: author, runId: firstRun, status: "completed" },
        );
        yield* insert(before);

        yield* step({
          type: "settle.checked",
          effectId: 2,
          result: { status: "repairable", problems: ["No commit was added since the baseline."] },
        });
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.block?.reason, "effect_failed");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not send the fix-commit turn (OrchestratorCommandRejectedError).",
        );
        assert.strictEqual(state.worktreePath, before.worktreePath);
        assert.deepStrictEqual(state.threads, before.threads);
      }),
    ),
  );

  it.effect("blocks a launch whose thread projection cannot be read", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* makeProject(world);
        world.readsUntilFailure = 0;
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.block?.reason, "effect_failed");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not launch the author thread (ProjectionStoreReadError).",
        );
        assert.isNull(state.worktreePath);
        assert.deepStrictEqual(state.threads, {});
      }),
    ),
  );

  it.effect("blocks a launch whose ended run cannot be read when its result is stored", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree } = yield* makeProject(world);
        world.worktreePath = worktree;
        world.runs.set(firstRun, "completed");
        // The launch's own workspace read succeeds; the worker's run read after it fails.
        world.readsUntilFailure = 1;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        world.onLaunch = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        yield* insert();

        yield* step({ type: "start" });
        yield* Deferred.await(entered);
        // The run ends while the launch is still running: its event is stale and dropped.
        yield* step({
          type: "run.finished",
          threadId: author,
          runId: firstRun,
          status: "completed",
        });
        assert.strictEqual((yield* stored).awaiting?.type, "effect");
        yield* Deferred.succeed(release, undefined);
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "worktree", branch, baseRef: "main" },
          },
          detail: "Factory could not launch the author thread (ProjectionStoreReadError).",
        });
        assert.isNull(state.awaiting);
        assert.isNull(state.worktreePath);
        assert.isNull(state.baseline);
        assert.deepStrictEqual(state.threads, {});
        assert.deepStrictEqual(
          (yield* attempts).map(({ stage, runId, outcome }) => ({ stage, runId, outcome })),
          [{ stage: "author", runId: null, outcome: "blocked" }],
        );
      }),
    ),
  );

  it.effect("blocks a fix-commit turn whose run cannot be read when its result is stored", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { worktree, main } = yield* makeProject(world);
        world.existingAuthor = true;
        // Selection is read before sending; the subsequent run read fails.
        world.readsUntilFailure = 1;
        const before = fold(
          queued,
          { type: "start" },
          {
            type: "thread.launched",
            effectId: 1,
            threadId: author,
            runId: firstRun,
            worktreePath: worktree,
            baseline: main,
          },
          { type: "run.finished", threadId: author, runId: firstRun, status: "completed" },
        );
        yield* insert(before);

        yield* step({
          type: "settle.checked",
          effectId: 2,
          result: { status: "repairable", problems: ["No commit was added since the baseline."] },
        });
        yield* drain;

        assert.strictEqual(world.sends.length, 1);
        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not send the fix-commit turn (ProjectionStoreReadError).",
        );
        assert.isNull(state.awaiting);
        assert.strictEqual(state.worktreePath, before.worktreePath);
        assert.strictEqual(state.baseline, before.baseline);
        assert.deepStrictEqual(state.threads, before.threads);
      }),
    ),
  );

  it.effect("launches nothing when the base ref names no commit", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* makeProject(world);
        yield* insert(queuedDeliveryState({ branch, baseRef: "no-such-branch" }));

        yield* step({ type: "start" });
        yield* drain;

        assert.strictEqual(world.launches.length, 0);
        const state = yield* stored;
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not launch the author thread (FactoryBaselineError).",
        );
      }),
    ),
  );
});
