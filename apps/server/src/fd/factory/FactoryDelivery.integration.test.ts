import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  MessageId,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  type FactoryDeliveryId,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkManagement from "../work-management/index.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as Factory from "./index.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";

const projectId = ProjectId.make("project-factory-delivery");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

const owner: WorkManagement.WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthSettingsWriteScope],
  label: "owner",
};

/** Verify commands as Factory runs them: an executable and arguments, never a shell line. */
const node = (script: string): FactoryCommand => ({
  executable: process.execPath,
  args: ["-e", script],
});
const verifyCommands = {
  passes: node("console.log('checks passed')"),
  fails: node("console.log('one check failed'); process.exit(3)"),
  commits: {
    executable: "git",
    args: [
      ...identity,
      "commit",
      "--allow-empty",
      "--no-verify",
      "-m",
      "chore: verify side effect",
    ],
  },
  dirties: node("require('node:fs').writeFileSync('verify-output.txt', 'left behind')"),
} satisfies Record<string, FactoryCommand>;

/**
 * A provider whose turns run until the test ends them. Every turn it is asked to start is
 * recorded, and the test ends one by sending its terminal events, as a provider process would.
 */
const makeFakeProvider = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const providerTurnId = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
  const providerTurn = (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    status: "running" | "completed" | "failed" | "cancelled",
    at: DateTime.Utc,
  ) => ({
    id: providerTurnId(turn),
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" as const },
    ordinal: turn.providerTurnOrdinal,
    status,
    startedAt: at,
    completedAt: status === "running" ? null : at,
  });

  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const { cwd } = input.runtimePolicy;
        if (cwd === null) return yield* Effect.die("A Factory thread runs in its worktree.");
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn(turn, "running", yield* DateTime.now),
              });
            }),
          steerTurn: () => Effect.die("Factory never steers a turn."),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };

  /** Ends the turn the way a provider reports it: the turn's last update, then its terminal. */
  const endTurn = (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    status: "completed" | "failed" | "cancelled",
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: providerTurn(turn, status, now),
      });
      const terminal = {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThread.id,
        providerTurnId: providerTurnId(turn),
        runOrdinal: turn.runOrdinal,
        threadDisposition: "reusable",
      } as const;
      yield* Queue.offer(
        events,
        status === "failed"
          ? {
              ...terminal,
              status,
              failureItemOrdinal: 1,
              failure: {
                class: "provider_error",
                message: "The provider stopped the turn.",
                code: null,
                retryable: false,
              },
            }
          : { ...terminal, status, failure: null },
      );
    });

  /** Posts the turn's final assistant message, as a provider does before the turn ends. */
  const say = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, text: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* Queue.offer(events, {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make(`assistant:${turn.attemptId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
    });

  return { adapter, started, endTurn, say };
});

type FakeProvider = Effect.Success<typeof makeFakeProvider>;

const projectEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

/** A project has no setup script here, and no thread or branch name is generated. */
const noSetupScript = Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
  runForThread: () => Effect.succeed({ status: "no-script" as const }),
});
const noTextGeneration = Layer.mock(TextGeneration.TextGeneration)({});

/** Real worktree creation: the Git workflow over the real git driver and manager. */
const gitWorkflow = GitWorkflow.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(
    GitManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          noTextGeneration,
          noSetupScript,
          ProviderRegistryMock.layer(),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
          }),
        ),
      ),
    ),
  ),
);

const projectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(projectEnrichment, WorkspacePaths.layer, LegacyV1ThreadImporter.layer),
  ),
);

/** Thread launches as the server runs them, with no terminals, clones or Scratch folders. */
const threadLaunch = ThreadLaunch.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorktreeSetupTracker.layer,
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/nowhere" }),
      gitWorkflow,
      noSetupScript,
      noTextGeneration,
      ProviderRegistryMock.layer(),
    ),
  ),
);

/** Work as the server builds it, with its real Markdown source. */
const work = WorkManagement.WorkService.layer.pipe(
  Layer.provide(WorkManagement.layerAdapters),
  Layer.provideMerge(WorkManagement.layerPersistence),
  Layer.provide(Layer.mock(GitHubApi.GitHubApi)({})),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(FetchHttpClient.layer),
  // Markdown sources hold no credential.
  Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
);

/**
 * Factory's reactor over the event sink the orchestrator commits through. `Factory.workerLayer`
 * cannot be used here: it brings the server runtime's own sink, which never sees the replay
 * harness's commits.
 */
const factoryReactor = Layer.effectDiscard(
  Effect.flatMap(FactoryReactor.FactoryReactor, (reactor) => reactor.start),
).pipe(
  Layer.provideMerge(FactoryReactor.layer),
  Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Effect.void)),
);

/**
 * The server's orchestration stack around the fake provider, on one in-memory database, with the
 * project root and T3 home in temp folders. Effects run only when the test drains the worker.
 */
const makeLayer = (input: {
  readonly provider: FakeProvider;
  readonly root: string;
  readonly t3Home: string;
}) => {
  const database = SqlitePersistence.layerMemory;
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "factory-delivery" },
    ProviderAdapterRegistry.layerSingle(input.provider.adapter),
    { databaseLayer: database, runEffectWorker: false },
  );
  return factoryReactor.pipe(
    Layer.provideMerge(Factory.layerLive),
    Layer.provide(ProviderRegistryMock.layer()),
    Layer.provideMerge(work),
    Layer.provideMerge(threadLaunch),
    Layer.provideMerge(projectService),
    Layer.provideMerge(ThreadManagement.layer),
    Layer.provideMerge(orchestration),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        ProjectionStore.layer,
        CommandReceiptStore.layer,
        IdAllocator.layer,
        ProcessRunner.layer,
        GitVcsDriver.layer,
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(input.root, input.t3Home)),
    Layer.provideMerge(VcsProcess.layer),
  );
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

const delivery = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) => service.get(deliveryId)).pipe(
    Effect.map(Option.getOrThrow),
  );

/** Every effect the orchestrator queued, run until none is left. */
const drainOrchestration = Effect.flatMap(EffectWorker.OrchestrationEffectWorkerV2, (worker) =>
  worker.drain(),
);
/** Every thread event the reactor has to hand on, then every Factory effect that followed. */
const drainFactory = Effect.gen(function* () {
  yield* Effect.flatMap(FactoryReactor.FactoryReactor, (reactor) => reactor.drain);
  yield* Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (worker) => worker.drain);
});

const ended: ReadonlyArray<OrchestrationV2RunStatus> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
];

/**
 * The first of `statuses` the event log records for the run, read from the start of the log and
 * awaited when it is not there yet. Callers include the ended statuses, so a run that ends some
 * other way fails the test at once instead of leaving it waiting.
 */
const runReached = (runId: RunId, statuses: ReadonlyArray<OrchestrationV2RunStatus>) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.stream().pipe(
      Stream.map(({ event }) =>
        (event.type === "run.created" || event.type === "run.updated") && event.payload.id === runId
          ? event.payload.status
          : null,
      ),
      Stream.filter(
        (status): status is OrchestrationV2RunStatus =>
          status !== null && statuses.includes(status),
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

const threadProjection = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

/** What a test body runs with: the server layers and the platform. */
type Services = Layer.Success<ReturnType<typeof makeLayer>> | NodeServices.NodeServices;

interface World {
  readonly provider: FakeProvider;
  readonly root: string;
  readonly t3Home: string;
  readonly itemTitle: string;
  /** `git status` of the project root once the item is committed. */
  readonly rootStatus: string;
  readonly evidenceDir: (deliveryId: FactoryDeliveryId) => string;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  /** Starts the delivery and returns it once its author's first turn is running. */
  readonly start: Effect.Effect<
    {
      readonly deliveryId: FactoryDeliveryId;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly worktreePath: string;
    },
    never,
    Services
  >;
  /**
   * Ends the provider turn of `runId` and waits until orchestration has finished the run and
   * Factory has handled its end, including every effect that followed. Returns the run's status.
   */
  readonly endRun: (
    runId: RunId,
    status: "completed" | "failed" | "cancelled",
  ) => Effect.Effect<OrchestrationV2RunStatus, never, Services>;
}

/**
 * A Git project with a committed Markdown Work item and a project verify command, in a server
 * with the fake provider. The item's file is committed before the delivery starts, so the
 * delivery starts from a clean checkout.
 */
const withProject = <A, E>(
  verifyCommand: FactoryCommand,
  body: (world: World) => Effect.Effect<A, E, Services>,
  limits: { readonly maxFixRounds?: number; readonly maxReviewRounds?: number } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const t3Home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-t3-home-" });
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-project-" });
    const root = path.join(parent, "alpha");
    yield* fileSystem.makeDirectory(root);
    const provider = yield* makeFakeProvider;

    return yield* Effect.gen(function* () {
      yield* git(root, ["init", "-b", "main"]);
      yield* fileSystem.writeFileString(path.join(root, "README.md"), "# Alpha\n");
      yield* git(root, ["add", "-A"]);
      yield* git(root, [...identity, "commit", "--no-verify", "-m", "chore: initial commit"]);

      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make("create-project"),
        projectId,
        title: "Alpha",
        workspaceRoot: root,
      });
      const workService = yield* WorkManagement.WorkService.WorkService;
      const source = yield* workService.saveSource(owner, {
        projectId,
        label: "Tasks",
        config: { kind: "markdown", directory: "tasks", autoStart: false },
      });
      const item = yield* workService.createItem(owner, {
        sourceId: source.sourceId,
        title: "Add the export button",
      });
      yield* git(root, ["add", "-A"]);
      yield* git(root, [...identity, "commit", "--no-verify", "-m", "docs: add the export task"]);

      const settings = yield* Factory.FactorySettings.FactorySettings;
      yield* settings.set(
        projectId,
        decodeSettings({ verifyCommand, roles: { author: modelSelection }, limits }),
      );

      const service = yield* Factory.FactoryService.FactoryService;
      const start = Effect.gen(function* () {
        const started = yield* service.start({ itemRef: item.ref });
        yield* drainFactory;
        const { awaiting, worktreePath } = (yield* delivery(started.deliveryId)).state;
        assert.strictEqual(awaiting?.type, "run");
        if (awaiting?.type !== "run" || worktreePath === null) {
          return assert.fail("The author launch did not record its run and worktree.");
        }
        // The launch returns once the worktree is recorded; the run starts once preparation
        // releases it.
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        return {
          deliveryId: started.deliveryId,
          threadId: awaiting.threadId,
          runId: awaiting.runId,
          worktreePath,
        };
      }).pipe(Effect.orDie);

      const endRun: World["endRun"] = (runId, status) =>
        Effect.gen(function* () {
          const turn = provider.started.find((candidate) => candidate.runId === runId);
          if (turn === undefined) return assert.fail(`No provider turn started run ${runId}.`);
          yield* provider.endTurn(turn, status);
          // The ingestor commits the turn's end; what finishes the run after it is a queued effect.
          yield* runReached(runId, ["waiting", ...ended]);
          yield* drainOrchestration;
          const run = (yield* threadProjection(turn.threadId)).runs.find(
            (candidate) => candidate.id === runId,
          );
          yield* drainFactory;
          return run?.status ?? assert.fail(`Run ${runId} is gone.`);
        }).pipe(Effect.orDie);

      const rootStatus = yield* git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return yield* body({
        provider,
        root,
        t3Home,
        itemTitle: item.title,
        rootStatus,
        evidenceDir: (deliveryId) => path.join(t3Home, "userdata", "fd-factory", deliveryId),
        exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
        start,
        endRun,
      });
    }).pipe(Effect.provide(makeLayer({ provider, root, t3Home })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Commits a change in the worktree, as the author agent would during its turn. */
const authorCommits = (worktreePath: string, subject: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(
      path.join(worktreePath, "export.ts"),
      "export const x = 1;\n",
    );
    yield* git(worktreePath, ["add", "-A"]);
    yield* git(worktreePath, [...identity, "commit", "--no-verify", "-m", subject]);
  });

const stateOf = (deliveryId: FactoryDeliveryId) =>
  delivery(deliveryId).pipe(Effect.map((stored: StoredFactoryDelivery) => stored.state));

describe("Factory single-item delivery", () => {
  it.live("launches the author on a new worktree, verifies it, then reviews it in plan mode", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        const path = yield* Path.Path;

        // The author thread works on the delivery branch in a new worktree under T3 home.
        const before = yield* stateOf(author.deliveryId);
        const thread = (yield* threadProjection(author.threadId)).thread;
        assert.strictEqual(thread.worktreePath, author.worktreePath);
        assert.strictEqual(thread.branch, before.branch);
        assert.isTrue(author.worktreePath.startsWith(path.join(world.t3Home, "worktrees")));
        assert.strictEqual(
          yield* git(author.worktreePath, ["branch", "--show-current"]),
          before.branch,
        );
        assert.strictEqual(before.baseline, yield* git(world.root, ["rev-parse", "HEAD"]));
        const [turn] = world.provider.started;
        assert.strictEqual(world.provider.started.length, 1);
        assert.strictEqual(turn?.runId, author.runId);
        assert.strictEqual(turn?.runtimePolicy.cwd, author.worktreePath);
        assert.include(turn?.message.text ?? "", world.itemTitle);

        yield* authorCommits(author.worktreePath, "feat: add the export button");
        assert.strictEqual(yield* world.endRun(author.runId, "completed"), "completed");

        // Verified, so the review began: a reviewer thread works on the same worktree.
        const state = yield* stateOf(author.deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.isNull(state.block);
        const receipt = state.receipts.at(-1);
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(receipt?.code, 0);
        assert.isFalse(receipt?.timedOut);
        assert.strictEqual(
          receipt?.headSha,
          yield* git(author.worktreePath, ["rev-parse", "HEAD"]),
        );
        assert.strictEqual(
          receipt?.tree,
          yield* git(author.worktreePath, ["rev-parse", "HEAD^{tree}"]),
        );

        // Evidence lives under T3 home; the repository and its worktree are untouched by it.
        const evidence = world.evidenceDir(author.deliveryId);
        assert.strictEqual(receipt?.logPath, path.join(evidence, "verify-1.log"));
        const fileSystem = yield* FileSystem.FileSystem;
        assert.include(
          yield* fileSystem.readFileString(path.join(evidence, "verify-1.log")),
          "checks passed",
        );
        assert.deepStrictEqual(
          JSON.parse(yield* fileSystem.readFileString(path.join(evidence, "verify-1.json"))),
          receipt,
        );
        assert.strictEqual(
          yield* git(world.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
          world.rootStatus,
        );
        assert.strictEqual(world.rootStatus, "");
        assert.strictEqual(
          yield* git(author.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );

        // The reviewer is a separate thread in plan mode, prompted with the verified commit.
        const { awaiting } = state;
        if (awaiting?.type !== "run") return assert.fail("The reviewer launch recorded no run.");
        assert.strictEqual(state.threads.reviewer, awaiting.threadId);
        assert.notStrictEqual(awaiting.threadId, author.threadId);
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.strictEqual(world.provider.started.length, 2);
        const review = world.provider.started[1];
        assert.strictEqual(review?.threadId, awaiting.threadId);
        assert.strictEqual(review?.runtimePolicy.cwd, author.worktreePath);
        assert.strictEqual(review?.runtimePolicy.interactionMode, "plan");
        assert.include(review?.message.text ?? "", `${state.baseline}..${receipt?.headSha}`);
        assert.include(review?.message.text ?? "", "factory_submit_review");

        // This provider has no t3 tools: its review arrives in the run's last message.
        if (review === undefined) return;
        yield* world.provider.say(
          review,
          `Reviewed.\n\n\`\`\`json\n${JSON.stringify({
            verdict: "pass",
            findings: [],
            acceptance: [
              {
                criterion: 1,
                status: "verified",
                evidence: "The export module is committed.",
                paths: ["export.ts"],
              },
            ],
            missing_evidence: [],
          })}\n\`\`\``,
        );
        assert.strictEqual(yield* world.endRun(awaiting.runId, "completed"), "completed");

        // Accepted from the fallback; record is not built yet, so the delivery stops there.
        const reviewed = yield* stateOf(author.deliveryId);
        assert.strictEqual(reviewed.stage, "record");
        assert.deepStrictEqual(reviewed.block, { reason: "unsupported_stage", stage: "record" });
        assert.deepStrictEqual(
          reviewed.reviews.map(({ round, source, summary, evidencePath }) => ({
            round,
            source,
            headSha: summary.headSha,
            blocking: summary.blocking,
            evidencePath,
          })),
          [
            {
              round: 1,
              source: "fallback",
              headSha: receipt?.headSha,
              blocking: false,
              evidencePath: path.join(evidence, "review-1.json"),
            },
          ],
        );
        assert.isTrue(yield* world.exists(path.join(evidence, "review-1.json")));
        assert.strictEqual(
          yield* git(author.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
        assert.strictEqual(world.provider.started.length, 2);
      }),
    ),
  );

  it.live("blocks with the failing receipt and its log when verify fails without fix rounds", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "verify");
          assert.deepStrictEqual(state.block, { reason: "verify_failed" });
          const receipt = state.receipts.at(-1);
          assert.strictEqual(state.receipts.length, 1);
          assert.strictEqual(receipt?.code, 3);
          assert.strictEqual(
            receipt?.headSha,
            yield* git(author.worktreePath, ["rev-parse", "HEAD"]),
          );

          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.strictEqual(receipt?.logPath, path.join(evidence, "verify-1.log"));
          assert.include(
            yield* fileSystem.readFileString(path.join(evidence, "verify-1.log")),
            "one check failed",
          );
          assert.isTrue(yield* world.exists(path.join(evidence, "verify-1.json")));
        }),
      // The project allows no fix round, and the delivery keeps the limit it started with.
      { maxFixRounds: 0 },
    ),
  );

  it.live("sends one fix-commit turn on the author thread, then blocks unsettled", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        const noCommit = "No commit was added since the baseline.";

        // The author's turn ends without a commit: the same thread gets one fix-commit turn.
        yield* world.endRun(author.runId, "completed");
        const repairing = yield* stateOf(author.deliveryId);
        assert.strictEqual(repairing.status, "running");
        assert.strictEqual(repairing.stage, "author");
        assert.strictEqual(repairing.fixCommitTurns, 1);
        const { awaiting } = repairing;
        if (awaiting?.type !== "run") return assert.fail("The fix-commit turn started no run.");
        assert.strictEqual(awaiting.threadId, author.threadId);
        assert.notStrictEqual(awaiting.runId, author.runId);

        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.deepStrictEqual(
          world.provider.started.map((turn) => [turn.threadId, turn.runId]),
          [
            [author.threadId, author.runId],
            [author.threadId, awaiting.runId],
          ],
        );
        const fixCommit = world.provider.started[1]?.message.text ?? "";
        assert.include(fixCommit, `- ${noCommit}`);
        assert.include(fixCommit, repairing.branch);

        // That turn leaves no commit either: the delivery blocks without a second repair turn,
        // and nothing is left queued that could start one.
        yield* world.endRun(awaiting.runId, "completed");
        yield* drainOrchestration;
        yield* drainFactory;
        const state = yield* stateOf(author.deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "author");
        assert.deepStrictEqual(state.block, { reason: "unsettled", problems: [noCommit] });
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.deepStrictEqual(state.receipts, []);

        const projection = yield* threadProjection(author.threadId);
        assert.deepStrictEqual(
          projection.runs.map((run) => [run.id, run.status]),
          [
            [author.runId, "completed"],
            [awaiting.runId, "completed"],
          ],
        );
        assert.strictEqual(world.provider.started.length, 2);
        assert.isFalse(yield* world.exists(world.evidenceDir(author.deliveryId)));
      }),
    ),
  );

  it.live.each(["failed", "cancelled"] as const)(
    "blocks naming the author run when it ends %s, and never verifies",
    (status) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          // A commit is there, so only the run's end can keep verify from running.
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          assert.strictEqual(yield* world.endRun(author.runId, status), status);

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "author");
          assert.deepStrictEqual(state.block, {
            reason: "run_ended",
            threadId: author.threadId,
            runId: author.runId,
            runStatus: status,
          });
          assert.deepStrictEqual(state.receipts, []);
          const path = yield* Path.Path;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.log")));
          assert.strictEqual(world.provider.started.length, 1);
        }),
      ),
  );

  it.live.each([
    { command: "commits", refusal: "head_changed" },
    { command: "dirties", refusal: "tree_dirty" },
  ] as const)(
    "refuses the receipt when the verify command $command the tree",
    ({ command, refusal }) =>
      withProject(verifyCommands[command], (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          const authored = yield* git(author.worktreePath, ["rev-parse", "HEAD"]);
          yield* world.endRun(author.runId, "completed");

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "verify");
          assert.deepStrictEqual(state.block, { reason: "receipt_refused", refusals: [refusal] });
          assert.deepStrictEqual(state.receipts, []);

          // The command did run: its log stays as evidence, but no receipt was written.
          const path = yield* Path.Path;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.isTrue(yield* world.exists(path.join(evidence, "verify-1.log")));
          assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.json")));
          const head = yield* git(author.worktreePath, ["rev-parse", "HEAD"]);
          assert.strictEqual(head === authored, refusal === "tree_dirty");
        }),
      ),
  );
});
