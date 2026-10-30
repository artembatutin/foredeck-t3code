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
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  TurnItemId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  type FactoryDeliveryId,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import type { WorkCommentInput, WorkItemRef } from "@t3tools/contracts/fd/work-management";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as AutomaticTurnGate from "../../../orchestration-v2/AutomaticTurnGate.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "../../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
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
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
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
import { ProjectAssistant } from "../../assistant/index.ts";
import * as AssistantHandoff from "../../assistant-handoff/index.ts";
import { RepositorySet } from "../../multirepo/index.ts";
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
/** The fake provider's instance, which every Factory thread here runs on. */
export const instanceId = ProviderInstanceId.make("codex");
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
  const threadLoads: {
    before?: (() => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>) | undefined;
    ensure?: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"];
    resume?: ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"];
    snapshot?: ProviderAdapter.ProviderAdapterV2SessionRuntime["readThreadSnapshot"];
  } = {};
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
          ensureThread: (ensureInput) =>
            Effect.suspend(() => threadLoads.before?.() ?? Effect.void).pipe(
              Effect.andThen(
                Effect.suspend(
                  () =>
                    threadLoads.ensure?.(ensureInput) ??
                    Effect.succeed({
                      id: ProviderThreadId.make(`provider-thread:${ensureInput.threadId}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: input.providerSessionId,
                      appThreadId: ensureInput.threadId,
                      ownerNodeId: null,
                      nativeThreadRef: {
                        driver,
                        nativeId: `native:${ensureInput.threadId}`,
                        strength: "strong",
                      },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    } satisfies OrchestrationV2ProviderThread),
                ),
              ),
            ),
          resumeThread: (resumeInput) =>
            Effect.suspend(() => threadLoads.before?.() ?? Effect.void).pipe(
              Effect.andThen(
                Effect.suspend(
                  () =>
                    threadLoads.resume?.(resumeInput) ?? Effect.succeed(resumeInput.providerThread),
                ),
              ),
            ),
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
          readThreadSnapshot: (input) =>
            Effect.suspend(() => threadLoads.snapshot?.(input) ?? Effect.die("unused")),
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

  /**
   * Starts a command in the turn that goes on running in the background, as a dev server does:
   * its run can end while the command still runs.
   */
  const startCommand = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, input: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const id = `command:${turn.attemptId}`;
      yield* Queue.offer(events, {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(id),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: turn.providerThread.id,
          providerTurnId: providerTurnId(turn),
          nativeItemRef: { driver, nativeId: id, strength: "strong" },
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input,
        },
      });
    });

  /**
   * Reports a provider-native subagent the turn started, as a provider does: `running` while it
   * works, which it can go on doing after the turn ends, and then `completed`.
   */
  const reportSubagent = (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    status: "running" | "completed",
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const id = `subagent:${turn.attemptId}`;
      yield* Queue.offer(events, {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(id),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: turn.providerThread.id,
          providerTurnId: providerTurnId(turn),
          nativeItemRef: { driver, nativeId: id, strength: "strong" },
          parentItemId: null,
          ordinal: 2,
          status,
          title: "Check the export",
          startedAt: now,
          completedAt: status === "running" ? null : now,
          updatedAt: now,
          type: "subagent",
          subagentId: NodeId.make(id),
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          childThreadId: null,
          prompt: "Check the export.",
          result: status === "running" ? null : "Checked.",
        },
      });
    });

  return { adapter, started, interrupted, threadLoads, endTurn, say, startCommand, reportSubagent };
});

type FakeProvider = Effect.Success<typeof makeFakeProvider>;

/** A stacked action the fake PR service ran, with the worktree's HEAD and branch at the call. */
export interface PullRequestCall {
  readonly input: GitRunStackedActionInput;
  readonly head: string;
  readonly branch: string;
}

/** A command Factory's own services dispatch to the orchestrator. */
export type FactoryDispatch = Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0];

/** An interrupt Factory asks a thread for, as it asks core's thread management. */
export type FactoryInterrupt = Parameters<
  ThreadManagement.ThreadManagementService["Service"]["interruptThread"]
>[0];

/**
 * Core's thread management as Factory's services see it: each interrupt they ask for runs
 * `hooks.beforeInterrupt` first, so a test can refuse it as core would refuse one.
 */
const factoryThreads = (hooks: {
  beforeInterrupt?: ((input: FactoryInterrupt) => Effect.Effect<void>) | undefined;
}) =>
  Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.map(ThreadManagement.ThreadManagementService, (threads) =>
      ThreadManagement.ThreadManagementService.of({
        ...threads,
        interruptThread: (input) =>
          Effect.suspend(() => hooks.beforeInterrupt?.(input) ?? Effect.void).pipe(
            Effect.andThen(threads.interruptThread(input)),
          ),
      }),
    ),
  );

/**
 * The orchestrator as Factory's services see it: each command runs `hooks.before` first, so a
 * test can commit something of the owner's between what Factory read and its command, and each
 * thread shell Factory reads runs `hooks.beforeShell` first, so a test can fail that read.
 */
const factoryOrchestrator = (hooks: {
  before?: ((command: FactoryDispatch) => Effect.Effect<void>) | undefined;
  beforeShell?: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
}) =>
  Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
      Orchestrator.OrchestratorV2.of({
        ...orchestrator,
        dispatch: (command) =>
          Effect.suspend(() => hooks.before?.(command) ?? Effect.void).pipe(
            Effect.andThen(orchestrator.dispatch(command)),
          ),
        getThreadShell: (threadId) =>
          Effect.suspend(() => hooks.beforeShell?.(threadId) ?? Effect.void).pipe(
            Effect.andThen(orchestrator.getThreadShell(threadId)),
          ),
      }),
    ),
  );

/** The process runner, each of whose runs goes through `hooks.around` when set. */
const hookedProcessRunner = (hooks: World["processes"]) =>
  Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.map(ProcessRunner.make(), (runner) =>
      ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.suspend(() => hooks.around?.(input, runner.run) ?? runner.run(input)),
      }),
    ),
  );

/** A comment posted through Work, as the Work service received it. */
export interface CommentCall {
  readonly actor: WorkManagement.WorkActor;
  readonly input: WorkCommentInput;
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
 * The fake PR service: the Git workflow Factory's PR stages call. Its stacked action records the
 * call with the worktree's HEAD and branch at that moment, pushes to the project's bare `origin`
 * the way `create_pr` does (the expected commit by its id, tracked as the branch's upstream, or
 * HEAD when given none), and reports the pull request open. A worktree removal is recorded, then
 * run by the real git driver.
 */
const fakePullRequests = (
  calls: Array<PullRequestCall>,
  removals: Array<VcsRemoveWorktreeInput>,
  hooks: Array<Effect.Effect<void>>,
) =>
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
            for (const hook of hooks.splice(0)) yield* hook;
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
        removeWorktree: (input) =>
          Effect.sync(() => removals.push(input)).pipe(Effect.andThen(git.removeWorktree(input))),
      });
    }),
  );

const projectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(projectEnrichment, WorkspacePaths.layer, LegacyV1ThreadImporter.layer),
  ),
);

/**
 * The project setup script each launch starts in its workspace: none, or what
 * `hooks.runForThread` does when set.
 */
const hookedSetupScripts = (hooks: World["setupScripts"]) =>
  Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
    runForThread: (input) =>
      Effect.suspend(
        () => hooks.runForThread?.(input) ?? Effect.succeed({ status: "no-script" as const }),
      ),
  });

/** Thread launches as the server runs them, with no terminals, clones or Scratch folders. */
const threadLaunch = (setupScripts: World["setupScripts"]) =>
  ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        // No project here is the Scratch project, so no thread gets a folder of its own.
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/nowhere",
          folderForThread: () => Effect.succeedNone,
        }),
        gitWorkflow,
        hookedSetupScripts(setupScripts),
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

type WorkServiceShape = WorkManagement.WorkService.WorkService["Service"];

/** `work`, recording each comment before Work posts it, then wrapped by `wrap`. */
const recordingWork = (
  calls: Array<CommentCall>,
  wrap: (service: WorkServiceShape) => WorkServiceShape,
) =>
  Layer.effect(
    WorkManagement.WorkService.WorkService,
    Effect.map(WorkManagement.WorkService.WorkService, (service) =>
      WorkManagement.WorkService.WorkService.of(
        wrap({
          ...service,
          addComment: (actor, input) =>
            Effect.sync(() => calls.push({ actor, input })).pipe(
              Effect.andThen(service.addComment(actor, input)),
            ),
        }),
      ),
    ),
  ).pipe(Layer.provideMerge(work));

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

/** Factory down between boots: no reactor runs, and draining one is a mistake in the test. */
const downReactor: typeof factoryReactor = Layer.succeed(
  FactoryReactor.FactoryReactor,
  FactoryReactor.FactoryReactor.of({
    start: Effect.die("Factory's reactor starts only inside world.boot."),
    drain: Effect.die("Factory's reactor runs only inside world.boot."),
  }),
);

/**
 * The fake provider's instance as the instance registry holds it. The runtime policy and Factory
 * read only its advertised runtime modes; none advertised means it runs any mode it is given.
 */
const providerInstances = (supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined) => {
  // A test stub: only the snapshot's runtime modes are ever read.
  const snapshot = { instanceId, driver, supportedRuntimeModes } as ServerProvider;
  const instance = {
    instanceId,
    snapshot: { getSnapshot: Effect.succeed(snapshot) },
  } as unknown as ProviderInstance;
  return Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
  });
};

/** What the server's layers are built from. */
interface ServerInput {
  readonly provider: FakeProvider;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly pullRequestCalls: Array<PullRequestCall>;
  readonly worktreeRemovals: Array<VcsRemoveWorktreeInput>;
  readonly publishHooks: Array<Effect.Effect<void>>;
  readonly factoryDispatch: World["factoryDispatch"];
  readonly processes: World["processes"];
  readonly setupScripts: World["setupScripts"];
  readonly commentCalls: Array<CommentCall>;
  readonly wrapWork: (service: WorkServiceShape) => WorkServiceShape;
  readonly manualReactor: boolean;
  readonly admission: typeof Factory.FactoryAdmission.FactoryAdmission.Service | undefined;
  readonly automaticTurnGate: boolean;
  readonly root: string;
  readonly t3Home: string;
  /** The harness's one database, already built: every build of the server shares it. */
  readonly database: Layer.Layer<Layer.Success<typeof SqlitePersistence.layerMemory>>;
}

/** Takes Factory's gate and installs it nowhere: core's producers keep the default inline gate. */
const inertGateInstaller = Layer.succeed(
  AutomaticTurnGate.AutomaticTurnGateInstaller,
  AutomaticTurnGate.AutomaticTurnGateInstaller.of({ install: () => Effect.void }),
);

/**
 * With `on`, the one installable automatic turn gate the server provides beneath its runtime, so
 * core's producers here (restart continuations and the continuation worker's native wakes and
 * delegated completions) consult the gate Factory installs; and the continuation requests queue
 * those offers go through, which the adapters and the worker share. Otherwise Factory installs its
 * gate nowhere.
 */
const automaticTurnGate = (
  on: boolean,
): Layer.Layer<AutomaticTurnGate.AutomaticTurnGateInstaller> =>
  on
    ? Layer.merge(AutomaticTurnGate.layerInstallable, ProviderContinuationRequests.layer)
    : inertGateInstaller;

/**
 * The server's orchestration stack around the fake provider, on the harness's database, with the
 * project root and T3 home in temp folders: everything Factory runs on. Turns run under the
 * server's runtime policy, which runs a mode the provider does not advertise as one it does.
 * Effects run only when the test drains the worker.
 */
const coreLayer = (input: ServerInput) => {
  const { database } = input;
  const serverConfig = ServerConfig.layerTest(input.root, input.t3Home);
  const runtimePolicy = RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(RepositorySet.layerDefault),
    Layer.provide(providerInstances(input.supportedRuntimeModes)),
    Layer.provide(ProjectStore.layer),
    Layer.provide(database),
    Layer.provide(serverConfig),
    Layer.provide(NodeServices.layer),
    // The database is the harness's own, already built, so it never fails this build.
    Layer.orDie,
  );
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "factory-delivery" },
    ProviderAdapterRegistry.layerSingle(input.provider.adapter),
    {
      databaseLayer: database,
      runEffectWorker: false,
      runtimePolicyLayer: runtimePolicy,
      runContinuationWorker: input.automaticTurnGate,
    },
  );
  return recordingWork(input.commentCalls, input.wrapWork).pipe(
    Layer.provideMerge(threadLaunch(input.setupScripts)),
    Layer.provideMerge(projectService),
    Layer.provideMerge(ThreadManagement.layer),
    Layer.provideMerge(orchestration),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        ProjectionStore.layer,
        CommandReceiptStore.layer,
        IdAllocator.layer,
        hookedProcessRunner(input.processes),
        GitVcsDriver.layer,
        // The thread launches' own, which Factory follows a launch without a run on.
        WorktreeSetupTracker.layer,
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(serverConfig),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(automaticTurnGate(input.automaticTurnGate)),
  );
};

/**
 * Factory and its reactor over the core services, opening pull requests through the fake PR
 * service, with the admission port given (Factory's default otherwise).
 */
const factoryLayer = (input: ServerInput) =>
  (input.manualReactor ? downReactor : factoryReactor).pipe(
    Layer.provideMerge(Factory.layerLive),
    Layer.provide(factoryOrchestrator(input.factoryDispatch)),
    Layer.provide(factoryThreads(input.factoryDispatch)),
    Layer.provide(
      fakePullRequests(input.pullRequestCalls, input.worktreeRemovals, input.publishHooks),
    ),
    Layer.provide(ProviderRegistryMock.layer(input.providers)),
    Layer.provide(providerInstances(input.supportedRuntimeModes)),
    Layer.provide(
      input.admission === undefined
        ? Layer.empty
        : Layer.succeed(Factory.FactoryAdmission.FactoryAdmission, input.admission),
    ),
  );

/**
 * The project assistant and its Work capture over the bridge's Work port, as the server composes
 * them. Built and rebuilt with Factory, so a rebuild is a new assistant instance as a new process
 * would be. No tick runs: a test drives the assistant's services itself.
 */
const assistantLayer = ProjectAssistant.layerLive.pipe(
  Layer.provide(AssistantHandoff.layerBackend),
);

/**
 * Core's startup recovery, in the order the server runs it before anything else (see
 * `serverRuntimeStartup`): the provider runtime's recovery, then the orchestrator's delegated
 * tasks.
 */
const recoverCore = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  yield* recovery.recover;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.recoverDelegatedTasks;
}).pipe(
  Effect.provide(ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(EffectOutbox.layer))),
  Effect.orDie,
);

/**
 * The server on the harness's database: the core services, and Factory with the assistant, each
 * built in a scope of its own under `parent`. `restart` closes Factory's, and with
 * `orchestration` the core's too, then builds them anew over the same database, as a new server
 * process would: lanes, locks, jobs, writers, reactors, sessions and every other in-memory state
 * go with the closed scopes. A rebuilt core runs core's startup recovery before Factory is built
 * over it.
 */
const makeServer = (input: ServerInput, parent: Scope.Scope) =>
  Effect.gen(function* () {
    const build = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(parent, "sequential");
        const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope);
        return { scope, context };
      });
    const buildFactory = (core: Context.Context<Layer.Success<ReturnType<typeof coreLayer>>>) =>
      build(
        Layer.merge(factoryLayer(input), assistantLayer).pipe(
          Layer.provide(Layer.succeedContext(core)),
        ),
      );
    let core = yield* build(coreLayer(input));
    let factory = yield* buildFactory(core.context);
    return {
      context: () => Context.merge(core.context, factory.context),
      restart: (orchestration: boolean) =>
        Effect.gen(function* () {
          yield* Scope.close(factory.scope, Exit.void);
          if (orchestration) {
            yield* Scope.close(core.scope, Exit.void);
            core = yield* build(coreLayer(input));
            yield* recoverCore.pipe(Effect.provideContext(core.context));
          }
          factory = yield* buildFactory(core.context);
        }).pipe(Effect.orDie),
    };
  });

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
type Services =
  | Layer.Success<ReturnType<typeof coreLayer>>
  | Layer.Success<ReturnType<typeof factoryLayer>>
  | Layer.Success<typeof assistantLayer>
  | NodeServices.NodeServices;

/** A started delivery whose first thread's (the author's, or a parent's planner's) turn runs. */
interface StartedAuthor {
  readonly deliveryId: FactoryDeliveryId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly worktreePath: string;
}

export interface World {
  readonly provider: FakeProvider;
  readonly projectId: ProjectId;
  readonly root: string;
  readonly t3Home: string;
  readonly itemRef: WorkItemRef;
  readonly itemKey: string;
  readonly itemTitle: string;
  /** `git status` of the project root once the item is committed. */
  readonly rootStatus: string;
  /** Every stacked action the fake PR service ran, in order. */
  readonly pullRequestCalls: ReadonlyArray<PullRequestCall>;
  /** Every worktree removal Factory asked the Git workflow for, in order. */
  readonly worktreeRemovals: ReadonlyArray<VcsRemoveWorktreeInput>;
  /**
   * Effects the fake PR service runs once each, in order, during its next stacked action, while
   * the PR stage awaits its result.
   */
  readonly publishHooks: Array<Effect.Effect<void>>;
  /**
   * Run before each command Factory's services dispatch to the orchestrator (`before`), before
   * each thread shell they read from it (`beforeShell`), and before each interrupt they ask a
   * thread for (`beforeInterrupt`), when set.
   */
  readonly factoryDispatch: {
    before?: ((command: FactoryDispatch) => Effect.Effect<void>) | undefined;
    beforeShell?: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
    beforeInterrupt?: ((input: FactoryInterrupt) => Effect.Effect<void>) | undefined;
  };
  /**
   * Runs each process the server's process runner is asked for, such as a verify or setup
   * command, in its place when set, given the input and the runner's own `run`: a test can hold a
   * command back, change its input or look around once it ended.
   */
  readonly processes: {
    around?:
      | ((
          input: ProcessRunner.ProcessRunInput,
          run: ProcessRunner.ProcessRunner["Service"]["run"],
        ) => ReturnType<ProcessRunner.ProcessRunner["Service"]["run"]>)
      | undefined;
  };
  /**
   * Runs in place of the project setup script a thread launch starts in its workspace, when set;
   * the project has none otherwise.
   */
  readonly setupScripts: {
    runForThread?:
      | ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
      | undefined;
  };
  /** Every comment posted through Work, in order; the item's own source holds them too. */
  readonly commentCalls: ReadonlyArray<CommentCall>;
  readonly evidenceDir: (deliveryId: FactoryDeliveryId) => string;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  /** Starts the delivery and returns it once its author's first turn is running. */
  readonly start: Effect.Effect<StartedAuthor, never, Services>;
  /** `start`, with the start's options; a parent returns once its planner's turn is running. */
  readonly startWith: (options: {
    readonly kind?: "single" | "parent";
    readonly runtimeModeCeiling?: RuntimeMode;
  }) => Effect.Effect<StartedAuthor, never, Services>;
  /** Returns a delivery started some other way (an MCP tool) once its author's turn is running. */
  readonly launched: (
    deliveryId: FactoryDeliveryId,
  ) => Effect.Effect<StartedAuthor, never, Services>;
  /**
   * Runs `body` as a server process that boots Factory: a reactor of its own starts, and its boot
   * sweep and what that set off finish first. With `manualReactor`, Factory's reactor runs only
   * inside a boot, so between two boots it is down while core recovery and the effect worker go
   * on; otherwise one reactor runs throughout, and this runs `body` as it is.
   */
  readonly boot: <A, E>(body: Effect.Effect<A, E, Services>) => Effect.Effect<A, E, Services>;
  /**
   * Runs `body` on a server restarted over the same database: Factory's services (its worker,
   * service and reactor) are closed and built anew, dropping their lanes, locks, jobs and other
   * in-memory state, and with `orchestration` so is the orchestration runtime with every service
   * above it, which runs core's startup recovery first. A rebuilt Factory's reactor runs its boot
   * sweep as any boot does (with `manualReactor`, inside `world.boot`). The services in effect
   * before are closed, so everything that runs after the restart belongs in `body`.
   */
  readonly rebuild: <A, E>(
    body: Effect.Effect<A, E, Services>,
    options?: { readonly orchestration?: boolean },
  ) => Effect.Effect<A, E, Services>;
  /** A fresh core launch service and tracker, closed before returning to inspect shutdown. */
  readonly launchScope: <A, E>(
    body: Effect.Effect<A, E, Services | Scope.Scope>,
  ) => Effect.Effect<A, E, Services>;
  /**
   * Sends the owner's own turn on the thread, as the web client does, and returns its run once
   * the provider has started it.
   */
  readonly ownerTurn: (threadId: ThreadId, text: string) => Effect.Effect<RunId, never, Services>;
  /**
   * Adds a project of the owner's rooted at `root` and starts a thread on it with no worktree of
   * its own, so its turns run in `root`. Returns the thread and its first run once the provider
   * has started it.
   */
  readonly ownerThreadAt: (
    root: string,
    text: string,
  ) => Effect.Effect<{ readonly threadId: ThreadId; readonly runId: RunId }, never, Services>;
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
  options: {
    readonly limits?: { readonly maxFixRounds?: number; readonly maxReviewRounds?: number };
    /** The runtime modes the provider advertises; none, so it runs any, when absent. */
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
    /** Model options Factory can select for its turns. */
    readonly providers?: ReadonlyArray<ServerProvider>;
    /** Wraps the Work service the server runs with, to fail some of its calls. */
    readonly work?: (service: WorkServiceShape) => WorkServiceShape;
    /** Factory's reactor runs only inside `world.boot`; see there. */
    readonly manualReactor?: boolean;
    /** The admission port Factory is built with, rebuilds included; its default otherwise. */
    readonly admission?: typeof Factory.FactoryAdmission.FactoryAdmission.Service;
    /**
     * Gives core's producers the installable automatic turn gate Factory installs, as the server
     * does (see `automaticTurnGate`); without it they run every automatic turn inline.
     */
    readonly automaticTurnGate?: boolean;
  } = {},
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
    const worktreeRemovals: Array<VcsRemoveWorktreeInput> = [];
    const publishHooks: Array<Effect.Effect<void>> = [];
    const factoryDispatch: World["factoryDispatch"] = {};
    const processes: World["processes"] = {};
    const setupScripts: World["setupScripts"] = {};
    const commentCalls: Array<CommentCall> = [];
    const server = yield* makeServer(
      {
        provider,
        supportedRuntimeModes: options.supportedRuntimeModes,
        providers: options.providers,
        pullRequestCalls,
        worktreeRemovals,
        publishHooks,
        factoryDispatch,
        processes,
        setupScripts,
        commentCalls,
        wrapWork: options.work ?? ((service) => service),
        manualReactor: options.manualReactor === true,
        admission: options.admission,
        automaticTurnGate: options.automaticTurnGate === true,
        root,
        t3Home,
        // One database for every build of the server, as a T3 home keeps across restarts.
        database: Layer.succeedContext(yield* Layer.build(SqlitePersistence.layerMemory)),
      },
      yield* Effect.scope,
    );

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
        decodeSettings({
          verifyCommand,
          roles: { author: modelSelection },
          limits: options.limits ?? {},
        }),
      );

      const launched: World["launched"] = (deliveryId) =>
        Effect.gen(function* () {
          yield* drainFactory;
          const { awaiting, worktreePath } = (yield* delivery(deliveryId)).state;
          assert.strictEqual(awaiting?.type, "run");
          if (awaiting?.type !== "run" || worktreePath === null) {
            return assert.fail("The first launch did not record its run and worktree.");
          }
          // The launch returns once the worktree is recorded; the run starts once preparation
          // releases it.
          assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          return { deliveryId, threadId: awaiting.threadId, runId: awaiting.runId, worktreePath };
        }).pipe(Effect.orDie);
      const startWith: World["startWith"] = (options) =>
        Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
          service.start({ ...options, itemRef: item.ref }),
        ).pipe(
          Effect.orDie,
          Effect.flatMap(({ deliveryId }) => launched(deliveryId)),
        );

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

      let ownerTurns = 0;
      const ownerTurn: World["ownerTurn"] = (threadId, text) =>
        Effect.gen(function* () {
          ownerTurns += 1;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const sent = yield* threads.sendToThread({
            projectId,
            commandId: CommandId.make(`owner-turn:${ownerTurns}`),
            threadId,
            messageId: MessageId.make(`owner-turn-message:${ownerTurns}`),
            text,
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
          assert.strictEqual(yield* runReached(sent.run.id, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          return sent.run.id;
        }).pipe(Effect.orDie);

      const ownerThreadAt: World["ownerThreadAt"] = (workspaceRoot, text) =>
        Effect.gen(function* () {
          ownerTurns += 1;
          const ownerProject = ProjectId.make(`project-owner-${ownerTurns}`);
          yield* (yield* ProjectService.ProjectService).create({
            commandId: CommandId.make(`create-owner-project:${ownerTurns}`),
            projectId: ownerProject,
            title: `Owner ${ownerTurns}`,
            workspaceRoot,
          });
          const launches = yield* ThreadLaunch.ThreadLaunchService;
          const messageId = MessageId.make(`owner-launch-message:${ownerTurns}`);
          const launched = yield* launches.launch({
            commandId: CommandId.make(`owner-launch:${ownerTurns}`),
            projectId: ownerProject,
            title: "Owner thread",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId, text, attachments: [] },
            createdBy: "user",
            creationSource: "web",
          });
          const run =
            launched.projection.runs.find((candidate) => candidate.userMessageId === messageId) ??
            assert.fail("The owner's launch started no run.");
          assert.strictEqual(yield* runReached(run.id, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          return { threadId: launched.threadId, runId: run.id };
        }).pipe(Effect.orDie);

      const boot: World["boot"] = (body) =>
        options.manualReactor !== true
          ? body
          : Effect.gen(function* () {
              const reactor = yield* FactoryReactor.FactoryReactor;
              yield* reactor.start;
              yield* drainFactory;
              return yield* body;
            }).pipe(Effect.provide(FactoryReactor.layer), Effect.scoped);

      const rebuild: World["rebuild"] = (after, rebuildOptions) =>
        server
          .restart(rebuildOptions?.orchestration === true)
          .pipe(
            Effect.andThen(Effect.suspend(() => Effect.provideContext(after, server.context()))),
          );

      const rootStatus = yield* git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return yield* body({
        provider,
        projectId,
        root,
        t3Home,
        itemRef: item.ref,
        itemKey: item.key,
        itemTitle: item.title,
        rootStatus,
        pullRequestCalls,
        worktreeRemovals,
        publishHooks,
        factoryDispatch,
        processes,
        setupScripts,
        commentCalls,
        evidenceDir: (deliveryId) => path.join(t3Home, "userdata", "fd-factory", deliveryId),
        exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
        start: startWith({}),
        startWith,
        launched,
        boot,
        rebuild,
        launchScope: (body) =>
          body.pipe(
            Effect.provide(
              threadLaunch(setupScripts).pipe(Layer.provideMerge(WorktreeSetupTracker.layer)),
              { local: true },
            ),
            Effect.scoped,
          ),
        ownerTurn,
        ownerThreadAt,
        endRun,
      });
    }).pipe(Effect.provideContext(server.context()));
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
