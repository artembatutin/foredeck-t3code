import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
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

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "../../../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ServerActivation from "../../../serverActivation.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as WorkManagement from "../../work-management/index.ts";
import * as FactoryReactor from "../FactoryReactor.ts";
import * as Factory from "../index.ts";
import type { StoredFactoryDelivery } from "../persistence/FactoryDeliveryStore.ts";

/**
 * A single-item delivery on the server's real orchestration stack: a Git project with a Markdown
 * Work item, a fake provider whose turns the test ends, and a fake PR service. Integration tests
 * drive the delivery with it and drain every worker; nothing sleeps or polls.
 */

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
export const verifyCommands = {
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
 * A provider whose turns run until the test ends them. Every turn it is asked to start or
 * interrupt is recorded, and the test ends one by sending its terminal events, as a provider
 * process would.
 */
const makeFakeProvider = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const interrupted: Array<ProviderAdapter.ProviderAdapterV2InterruptInput> = [];
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
          // The turn goes on until the test ends it, as a provider still finishing it would.
          interruptTurn: (input) => Effect.sync(() => void interrupted.push(input)),
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

  return { adapter, started, interrupted, endTurn, say };
});

type FakeProvider = Effect.Success<typeof makeFakeProvider>;

/** A stacked action the fake PR service ran, with the worktree's HEAD and branch at the call. */
export interface PullRequestCall {
  readonly input: GitRunStackedActionInput;
  readonly head: string;
  readonly branch: string;
}

/** The pull request the fake PR service opens for any branch. */
export const fakePullRequest = { number: 7, url: "https://github.com/acme/alpha/pull/7" };

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

/**
 * The fake PR service: the Git workflow Factory's PR stage calls. Its stacked action records the
 * call with the worktree's HEAD and branch at that moment, pushes to the project's bare `origin`
 * the way `create_pr` does (the expected commit by its id, tracked as the branch's upstream, or
 * HEAD when given none), and reports the pull request open.
 */
const fakePullRequests = (calls: Array<PullRequestCall>) =>
  Layer.unwrap(
    Effect.map(GitVcsDriver.GitVcsDriver, (git) => {
      const read = (cwd: string, args: ReadonlyArray<string>) =>
        git
          .execute({ operation: "test.pr", cwd, args, timeoutMs: 30_000 })
          .pipe(Effect.map((result) => result.stdout.trim()));
      return Layer.mock(GitWorkflow.GitWorkflowService)({
        runStackedAction: (input) =>
          Effect.gen(function* () {
            const head = yield* read(input.cwd, ["rev-parse", "HEAD"]);
            const branch = yield* read(input.cwd, ["branch", "--show-current"]);
            calls.push({ input, head, branch });
            if (input.expectedHeadSha === undefined) {
              yield* read(input.cwd, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
            } else {
              yield* read(input.cwd, [
                "push",
                "origin",
                `${input.expectedHeadSha}:refs/heads/${branch}`,
              ]);
              yield* read(input.cwd, ["branch", "--set-upstream-to", `origin/${branch}`]);
            }
            return {
              action: input.action,
              branch: { status: "skipped_not_requested" },
              commit: { status: "skipped_not_requested" },
              push: { status: "pushed", branch, setUpstream: true },
              pr: {
                status: "created",
                ...fakePullRequest,
                baseBranch: "main",
                headBranch: branch,
                ...(input.prTitle === undefined ? {} : { title: input.prTitle }),
              },
              toast: { title: "Created pull request", cta: { kind: "none" } },
            } satisfies GitRunStackedActionResult;
          }).pipe(Effect.orDie),
      });
    }),
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
 * project root and T3 home in temp folders. Factory opens pull requests through the fake PR
 * service. Effects run only when the test drains the worker.
 */
const makeLayer = (input: {
  readonly provider: FakeProvider;
  readonly pullRequestCalls: Array<PullRequestCall>;
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
    Layer.provide(fakePullRequests(input.pullRequestCalls)),
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

export const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

const delivery = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) => service.get(deliveryId)).pipe(
    Effect.map(Option.getOrThrow),
  );

/** Every effect the orchestrator queued, run until none is left. */
export const drainOrchestration = Effect.flatMap(
  EffectWorker.OrchestrationEffectWorkerV2,
  (worker) => worker.drain(),
);
/** Every thread event the reactor has to hand on, then every Factory effect that followed. */
export const drainFactory = Effect.gen(function* () {
  yield* Effect.flatMap(FactoryReactor.FactoryReactor, (reactor) => reactor.drain);
  yield* Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (worker) => worker.drain);
});

export const ended: ReadonlyArray<OrchestrationV2RunStatus> = [
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
export const runReached = (runId: RunId, statuses: ReadonlyArray<OrchestrationV2RunStatus>) =>
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

export const threadProjection = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

/** What a test body runs with: the server layers and the platform. */
type Services = Layer.Success<ReturnType<typeof makeLayer>> | NodeServices.NodeServices;

export interface World {
  readonly provider: FakeProvider;
  readonly root: string;
  readonly t3Home: string;
  readonly itemKey: string;
  readonly itemTitle: string;
  /** `git status` of the project root once the item is committed. */
  readonly rootStatus: string;
  /** Every stacked action the fake PR service ran, in order. */
  readonly pullRequestCalls: ReadonlyArray<PullRequestCall>;
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
export const withProject = <A, E>(
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
    const pullRequestCalls: Array<PullRequestCall> = [];

    return yield* Effect.gen(function* () {
      // The project's remote: a bare repository the fake PR service pushes to.
      const origin = path.join(parent, "origin.git");
      yield* git(parent, ["init", "--bare", origin]);
      yield* git(root, ["init", "-b", "main"]);
      yield* git(root, ["remote", "add", "origin", origin]);
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
        itemKey: item.key,
        itemTitle: item.title,
        rootStatus,
        pullRequestCalls,
        evidenceDir: (deliveryId) => path.join(t3Home, "userdata", "fd-factory", deliveryId),
        exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
        start,
        endRun,
      });
    }).pipe(Effect.provide(makeLayer({ provider, pullRequestCalls, root, t3Home })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Commits `export.ts` with `text` in the worktree, as the author agent would during its turn. */
export const authorCommits = (
  worktreePath: string,
  subject: string,
  text = "export const x = 1;\n",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(worktreePath, "export.ts"), text);
    yield* git(worktreePath, ["add", "-A"]);
    yield* git(worktreePath, [...identity, "commit", "--no-verify", "-m", subject]);
  });

export const stateOf = (deliveryId: FactoryDeliveryId) =>
  delivery(deliveryId).pipe(Effect.map((stored: StoredFactoryDelivery) => stored.state));
