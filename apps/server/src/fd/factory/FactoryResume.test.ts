import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  type FactoryDeliveryId,
  type FactoryDeliveryStatus,
  FactoryProjectSettings,
  type FactoryRole,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService, workBranchName } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import type {
  FactoryDeliveryState,
  FactoryEffect,
  FactoryTerminalRunStatus,
} from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git as harnessGit,
  runReached,
  stateOf as harnessStateOf,
  verifyCommands,
  type World as DeliveryWorld,
  withProject,
} from "./testkit/deliveryHarness.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const item = {
  ref: itemRef,
  kind: "markdown",
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: "https://tracker.example.com/items/fd-aaaaaa",
} as unknown as WorkItemDetail;
const branch = workBranchName(item);
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const prUrl = "https://github.com/acme/alpha/pull/7";

/** Each launch or turn starts a run named for its effect, so no two runs share an id. */
const runOf = (effectId: number) => RunId.make(`run-${effectId}`);

/** What the fakes are told and what they saw. */
interface World {
  worktree: { readonly cwd: string; readonly baseline: string } | null;
  /** Runs inside the record effect, before the approval is recorded. */
  beforeRecord: Effect.Effect<void>;
  /** While set, a launch fails before it launches anything. */
  launchFails: boolean;
  /** The role of each launch, in order. */
  readonly launches: Array<FactoryRole>;
  /** The effect id of each launch, in order; one id names one thread, as the real launch's do. */
  readonly launchIds: Array<number>;
  /** How many of the worker's next run reads fail, as a projection read can. */
  runReadFailures: number;
  /** Runs that have ended, with how. */
  readonly ended: Map<RunId, FactoryTerminalRunStatus>;
  readonly fixCommitTurns: Array<Extract<FactoryEffect, { readonly type: "send_fix_commit_turn" }>>;
  readonly deleted: Set<ThreadId>;
  /** Every stacked action the fake PR service ran. */
  readonly calls: Array<GitRunStackedActionInput>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

/** The PR service's stacked action, pushing the expected commit to the worktree's `origin`. */
const fakeGitWorkflow = (world: World) =>
  Layer.unwrap(
    Effect.map(GitVcsDriver.GitVcsDriver, (driver) => {
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.push", cwd, args, timeoutMs: 30_000 }).pipe(Effect.orDie);
      return Layer.mock(GitWorkflow.GitWorkflowService)({
        runStackedAction: (input) =>
          Effect.gen(function* () {
            world.calls.push(input);
            yield* run(input.cwd, [
              "push",
              "origin",
              `${input.expectedHeadSha}:refs/heads/${branch}`,
            ]);
            yield* run(input.cwd, ["branch", "--set-upstream-to", `origin/${branch}`]);
            return {
              action: "create_pr",
              branch: { status: "skipped_not_requested" },
              commit: { status: "skipped_not_requested" },
              push: { status: "pushed", branch },
              pr: {
                status: "created",
                url: prUrl,
                number: 7,
                baseBranch: "main",
                headBranch: branch,
              },
              toast: { title: "Created pull request", cta: { kind: "none" } },
            } satisfies GitRunStackedActionResult;
          }),
      });
    }),
  );

/** Threads are faked: every run is still going when its launch or turn returns. */
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(WorkService.WorkService)({
      canonicalRef: (ref) => Effect.succeed(ref),
      resolveSource: () =>
        Effect.succeed({
          stored: { sourceId, projectId },
        } as unknown as WorkService.ResolvedSource),
      getItem: () => Effect.succeed(item),
    }),
    // No repository at the root: a start keeps the item's branch name.
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeedSome({
          projectId: id,
          workspaceRoot: "/nowhere",
        } as unknown as ProjectStore.ProjectRow),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ checkWorktreeBase: () => Effect.void }),
    Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
      launchThread: (delivery, effect) =>
        Effect.gen(function* () {
          world.launches.push(effect.role);
          world.launchIds.push(effect.id);
          if (world.launchFails) {
            return yield* new FactoryThreadEffects.FactoryLaunchRunMissingError({
              deliveryId: delivery.deliveryId,
              threadId: author,
            });
          }
          return {
            threadId: effect.role === "author" ? author : reviewer,
            runId: runOf(effect.id),
            worktreePath: world.worktree?.cwd ?? "/nowhere",
            baseline: world.worktree?.baseline ?? "b".repeat(40),
          };
        }),
      sendFixCommitTurn: (_delivery, effect) =>
        Effect.sync(() => {
          world.fixCommitTurns.push(effect);
          return { runId: runOf(effect.id) };
        }),
      // A launch's thread is the real one's id; its run is the one this fake named for the effect.
      launchState: ({ deliveryId }, effect) =>
        Effect.sync(() => {
          if (world.deleted.has(FactoryThreadEffects.launchThreadId(deliveryId, effect.id))) {
            return "deleted";
          }
          if (!world.launchIds.includes(effect.id)) return "missing";
          return world.ended.has(runOf(effect.id)) ? "ended" : "unfinished";
        }),
      threadState: (threadId) =>
        Effect.succeed(world.deleted.has(threadId) ? "deleted" : "present"),
      runEnded: (threadId, runId) =>
        Effect.suspend(() => {
          if (world.runReadFailures > 0) {
            world.runReadFailures -= 1;
            return Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }));
          }
          return Effect.succeed(Option.fromUndefinedOr(world.ended.get(runId)));
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    fakeGitWorkflow(world),
    // The created pull request is linked to the author thread.
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          id: threadId,
          projectId,
          workspaceBinding: null,
        } as unknown as OrchestrationV2ThreadShell),
      dispatch: (command) =>
        Effect.sync(() => {
          world.dispatched.push(command);
          return { sequence: world.dispatched.length, storedEvents: [] } as never;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
  );

/** The real record, which first runs the world's `beforeRecord`. */
const gatedRecord = (world: World) =>
  Layer.effect(
    FactoryRecord.FactoryRecord,
    Effect.map(FactoryRecord.FactoryRecord, (record) =>
      FactoryRecord.FactoryRecord.of({
        record: (delivery) =>
          Effect.suspend(() => world.beforeRecord).pipe(Effect.andThen(record.record(delivery))),
      }),
    ),
  ).pipe(Layer.provide(FactoryRecord.layer));

/**
 * FactoryService, the worker, the verify runner, review judging, record and the PR service as the
 * server builds them, on in-memory SQLite, real git, real processes and a temp T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provideMerge(FactoryPullRequest.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPlanning.FactoryPlanning)({})),
    Layer.provide(gatedRecord(world)),
    Layer.provide(FactoryVerifyRunner.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-resume-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    worktree: null,
    beforeRecord: Effect.void,
    launchFails: false,
    launches: [],
    launchIds: [],
    runReadFailures: 0,
    ended: new Map(),
    fixCommitTurns: [],
    deleted: new Set(),
    calls: [],
    dispatched: [],
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));
const writeFile = (cwd: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, name), text);
  });
const commit = (cwd: string, args: ReadonlyArray<string>, identity = ada) =>
  git(cwd, [...identity, "commit", "--no-verify", "--no-gpg-sign", ...args]);

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const isResumeRefused = Schema.is(FactoryService.FactoryResumeRefusedError);
const useVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({
      verifyCommand: { executable: process.execPath, args: ["-e", 'console.log("checks pass")'] },
    }),
  ),
);

const service = FactoryService.FactoryService;
const resume = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.resume(deliveryId));
const stop = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.stop(deliveryId));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const runEnds = (deliveryId: FactoryDeliveryId, threadId: ThreadId, runId: RunId) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) =>
    worker.step(deliveryId, { type: "run.finished", threadId, runId, status: "completed" }),
  ).pipe(Effect.andThen(drain));
const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.get(deliveryId),
  ).pipe(Effect.map((delivery): FactoryDeliveryState => Option.getOrThrow(delivery).state));
/** The run the delivery awaits; fails the test when it awaits none. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  stateOf(deliveryId).pipe(
    Effect.map(({ awaiting }) =>
      awaiting?.type === "run" ? awaiting : assert.fail("The delivery awaits no run."),
    ),
  );
const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])));
/** The delivery's row and stage attempts exactly as SQLite holds them. */
const rowsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${deliveryId}`,
    };
  });
/** The receipt files in the evidence folder of a delivery with a receipt. */
const receiptFiles = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [first] = (yield* stateOf(deliveryId)).receipts;
    if (first === undefined) return assert.fail("The delivery has no receipt.");
    return (yield* fileSystem.readDirectory(path.dirname(first.logPath)))
      .filter((name) => /^verify-\d+\.json$/.test(name))
      .toSorted();
  });

/** A review that passes. */
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export test covers CSV output.",
      paths: ["src/export.test.ts"],
    },
  ],
  missing_evidence: [],
};

/**
 * A repository standing in for the delivery worktree, on the delivery branch with the author's
 * commit, and a bare `origin` the fake PR service pushes to. Starts the delivery, which awaits
 * its author's first run.
 */
const started = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-resume-wt-" });
    const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-resume-git-" });
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* writeFile(cwd, "README.md", "root\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, ["-m", "chore: root"]);
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* writeFile(cwd, "src/export.ts", "export const csv = 1;\n");
    yield* writeFile(cwd, "src/export.test.ts", "// covers csv\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, ["-m", "feat: export the table as CSV"]);
    world.worktree = { cwd, baseline };

    yield* useVerify;
    const { deliveryId } = yield* Effect.flatMap(service, (factory) => factory.start({ itemRef }));
    yield* drain;
    return { cwd, deliveryId };
  });

/**
 * A delivery stopped at `pr`: its author's commit verified, reviewed and approved, with the stop
 * landing while record ran. Returns it with the approved commit.
 */
const stoppedAtPr = (world: World) =>
  Effect.gen(function* () {
    const { cwd, deliveryId } = yield* started(world);
    yield* runEnds(deliveryId, author, runOf(1));
    const review = yield* awaitedRun(deliveryId);
    yield* Effect.flatMap(service, (factory) =>
      factory.submitReview({ threadId: reviewer, review: passingReview }),
    );
    const factory = yield* service;
    world.beforeRecord = factory.stop(deliveryId).pipe(Effect.orDie, Effect.asVoid);
    yield* runEnds(deliveryId, review.threadId, review.runId);
    world.beforeRecord = Effect.void;

    const state = yield* stateOf(deliveryId);
    assert.strictEqual(state.status, "stopped");
    assert.strictEqual(state.checkpoint, "pr");
    assert.deepStrictEqual(world.calls, []);
    return { cwd, deliveryId, approved: yield* git(cwd, ["rev-parse", "HEAD"]) };
  });

describe("FactoryService.resume, with faked threads over a real worktree", () => {
  it.effect("runs a stopping delivery on: same awaited run, nothing new, and it goes on", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* started(world);
        const before = yield* stateOf(deliveryId);
        yield* stop(deliveryId);

        const resumed = yield* resume(deliveryId);
        yield* drain;

        assert.deepStrictEqual(resumed.state, before);
        assert.deepStrictEqual(yield* stateOf(deliveryId), before);
        assert.deepStrictEqual(world.launches, ["author"]);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [["author", null]]);

        // The author's run ends: its branch settles, is verified and goes to review.
        yield* runEnds(deliveryId, author, runOf(1));
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.deepStrictEqual(world.launches, ["author", "reviewer"]);
      }),
    ),
  );

  it.effect("opens the pull request of a delivery stopped at pr, without a new receipt", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, approved } = yield* stoppedAtPr(world);
        const before = yield* stateOf(deliveryId);
        const receipts = yield* receiptFiles(deliveryId);
        assert.deepStrictEqual(receipts, ["verify-1.json"]);

        const resumed = yield* resume(deliveryId);
        assert.strictEqual(resumed.state.status, "approved");
        assert.strictEqual(resumed.state.stage, "pr");
        yield* drain;

        assert.strictEqual(world.calls.length, 1);
        assert.strictEqual(world.calls[0]?.expectedHeadSha, approved);
        assert.strictEqual(world.calls[0]?.cwd, cwd);
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.deepStrictEqual(state.pullRequest, { number: 7, url: prUrl, headBranch: branch });
        // Nothing was verified or reviewed again.
        assert.deepStrictEqual(state.receipts, before.receipts);
        assert.deepStrictEqual(yield* receiptFiles(deliveryId), receipts);
        assert.strictEqual(state.reviewRound, before.reviewRound);
        assert.deepStrictEqual(world.launches, ["author", "reviewer"]);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["author", "passed"],
          ["verify", "passed"],
          ["review", "passed"],
          ["record", "passed"],
          ["pr", "passed"],
        ]);
      }),
    ),
  );

  it.effect("verifies and reviews a commit made after the approval before any pull request", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, approved } = yield* stoppedAtPr(world);
        yield* writeFile(cwd, "src/export.ts", "export const csv = 2;\n");
        yield* git(cwd, ["add", "-A"]);
        yield* commit(cwd, ["-m", "fix: write the header row"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* resume(deliveryId);
        yield* drain;

        const state = yield* stateOf(deliveryId);
        assert.deepStrictEqual(world.calls, []);
        assert.deepStrictEqual(
          state.receipts.map(({ headSha }) => headSha),
          [approved, head],
        );
        assert.deepStrictEqual(yield* receiptFiles(deliveryId), ["verify-1.json", "verify-2.json"]);
        // A second review round, by a fresh reviewer: no fix-review reply to follow up on.
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.reviewRound, 2);
        assert.deepStrictEqual(world.launches, ["author", "reviewer", "reviewer"]);
        assert.deepStrictEqual(state.awaiting, {
          type: "run",
          threadId: reviewer,
          runId: runOf(7),
        });
      }),
    ),
  );

  it.effect("blocks at once on a commit whose identity names an AI tool, with no turn", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId } = yield* started(world);
        yield* stop(deliveryId);
        yield* runEnds(deliveryId, author, runOf(1));
        assert.strictEqual((yield* stateOf(deliveryId)).checkpoint, "verify");
        yield* writeFile(cwd, "src/export.ts", "export const csv = 3;\n");
        yield* git(cwd, ["add", "-A"]);
        yield* commit(
          cwd,
          ["-m", "fix: quote the cells"],
          ["-c", "user.name=Devin", "-c", "user.email=devin@example.com"],
        );

        const resumed = yield* resume(deliveryId);
        yield* drain;

        assert.strictEqual(resumed.state.status, "blocked");
        assert.strictEqual(resumed.state.block?.reason, "unsettled");
        if (resumed.state.block?.reason !== "unsettled") return;
        const label = `Commit ${(yield* git(cwd, ["rev-parse", "HEAD"])).slice(0, 12)}`;
        assert.deepStrictEqual(resumed.state.block.problems, [
          `${label} author identity names an AI agent, model or provider.`,
          `${label} committer identity names an AI agent, model or provider.`,
        ]);
        assert.deepStrictEqual(world.fixCommitTurns, []);
        assert.deepStrictEqual(resumed.state.receipts, []);
        assert.deepStrictEqual(yield* stateOf(deliveryId), resumed.state);
      }),
    ),
  );

  it.effect("launches the author of a delivery whose launch failed, under the launch's id", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.launchFails = true;
        const { deliveryId } = yield* started(world);
        const failed = yield* stateOf(deliveryId);
        assert.strictEqual(failed.status, "blocked");
        assert.strictEqual(failed.block?.reason, "effect_failed");
        assert.deepStrictEqual(failed.threads, {});

        world.launchFails = false;
        const resumed = yield* resume(deliveryId);
        yield* drain;

        assert.deepStrictEqual(world.launches, ["author", "author"]);
        assert.deepStrictEqual(world.launchIds, [1, 1]);
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(resumed.state.stage, "author");
        assert.strictEqual(state.status, "running");
        assert.isNull(state.block);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: runOf(1) });
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["author", "blocked"],
          ["author", null],
        ]);
      }),
    ),
  );

  it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "verifies the work of a lost author launch whose run had ended %s, launching nothing new",
    (status) =>
      withWorld((world) =>
        Effect.gen(function* () {
          // The launch went through, but the worker's read of its run failed: the delivery blocked
          // recording no author, while the author's thread went on and committed its work.
          world.runReadFailures = 1;
          const { cwd, deliveryId } = yield* started(world);
          const failed = yield* stateOf(deliveryId);
          assert.deepStrictEqual(failed.block, {
            reason: "effect_failed",
            effect: {
              id: 1,
              type: "launch_thread",
              role: "author",
              workspace: { type: "worktree", branch, baseRef: "HEAD" },
            },
            detail: "Factory could not launch the author thread (ProjectionStoreReadError).",
          });
          assert.deepStrictEqual(failed.threads, {});
          assert.isNull(failed.worktreePath);
          world.ended.set(runOf(1), status);

          yield* resume(deliveryId);
          yield* drain;

          // The same launch again, so the same thread: no second author on the branch.
          assert.deepStrictEqual(world.launchIds, [1, 1, 4]);
          assert.deepStrictEqual(world.launches, ["author", "author", "reviewer"]);
          const state = yield* stateOf(deliveryId);
          assert.deepStrictEqual(state.threads, { author, reviewer });
          assert.strictEqual(state.worktreePath, cwd);
          assert.strictEqual(state.baseline, world.worktree?.baseline);
          // Its work is settled and verified afresh, then reviewed.
          assert.deepStrictEqual(
            state.receipts.map(({ headSha }) => headSha),
            [yield* git(cwd, ["rev-parse", "HEAD"])],
          );
          assert.strictEqual(state.status, "running");
          assert.strictEqual(state.stage, "review");
          assert.deepStrictEqual(state.awaiting, {
            type: "run",
            threadId: reviewer,
            runId: runOf(4),
          });
          // However its run ended, the author got no turn of any kind.
          assert.deepStrictEqual(world.fixCommitTurns, []);
          assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
            ["author", "blocked"],
            ["author", "passed"],
            ["verify", "passed"],
            ["review", null],
          ]);
        }),
      ),
  );

  it.effect("stays blocked on every resume once a lost author launch's thread is deleted", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.runReadFailures = 1;
        const { deliveryId } = yield* started(world);
        const launched = FactoryThreadEffects.launchThreadId(deliveryId, 1);
        world.deleted.add(launched);

        const first = yield* resume(deliveryId);
        yield* drain;
        const second = yield* resume(deliveryId);
        yield* drain;

        for (const resumed of [first, second]) {
          assert.strictEqual(resumed.state.status, "blocked");
          assert.deepStrictEqual(resumed.state.block, {
            reason: "thread_deleted",
            threadId: launched,
          });
          assert.deepStrictEqual(resumed.state.threads, {});
        }
        assert.deepStrictEqual(second.state, first.state);
        assert.deepStrictEqual(yield* stateOf(deliveryId), second.state);
        // No launch of any kind after the first.
        assert.deepStrictEqual(world.launchIds, [1]);
        assert.deepStrictEqual(world.launches, ["author"]);
      }),
    ),
  );

  it.effect.each([
    "queued",
    "running",
    "approved",
    "pr_open",
    "done",
    "cancelled",
  ] as const satisfies ReadonlyArray<FactoryDeliveryStatus>)(
    "refuses to resume a %s delivery, naming its status, and changes nothing",
    (status) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* started(world);
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const current = yield* stateOf(deliveryId);
          if (status !== "running") yield* store.update(deliveryId, { ...current, status });
          const before = yield* rowsOf(deliveryId);
          // A write now would move updated_at.
          yield* TestClock.adjust("1 minute");

          const error = yield* Effect.flip(resume(deliveryId));
          yield* drain;

          if (!isResumeRefused(error)) {
            return assert.fail(`Expected a refused resume, got ${error._tag}.`);
          }
          assert.strictEqual(error.deliveryId, deliveryId);
          assert.strictEqual(error.status, status);
          assert.include(error.message, `is ${status}`);
          assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
          assert.deepStrictEqual(world.launches, ["author"]);
        }),
      ),
  );
});

/** A passing review whose evidence is the file `authorCommits` writes. */
const harnessReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "The button exports.", paths: ["export.ts"] },
  ],
  missing_evidence: [],
};

/** The real thread effects' read of a thread, over the server stack the harness built. */
const threadState = (threadId: ThreadId) =>
  Effect.flatMap(FactoryThreadEffects.FactoryThreadEffects, (effects) =>
    effects.threadState(threadId),
  ).pipe(
    Effect.provide(
      FactoryThreadEffects.layer.pipe(
        Layer.provide(ProviderRegistryMock.layer()),
        Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
      ),
    ),
  );

/** Worktrees of the project's repository, its own checkout included. */
const worktreeCount = (root: string) =>
  harnessGit(root, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((list) => list.split("\n").filter((line) => line.startsWith("worktree ")).length),
  );

/**
 * A delivery whose author launch went through while the server lost its result: started, its
 * launch recorded, then stored back as it was before the result and failed as the next boot's
 * sweep fails an effect it finds awaited (`failInterruptedEffect`). The author's run is starting.
 */
const lostLaunch = (world: DeliveryWorld) =>
  Effect.gen(function* () {
    const factory = yield* Factory.FactoryService.FactoryService;
    const worker = yield* Factory.FactoryWorker.FactoryWorker;
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    // Stored as start left it: running, awaiting its author's launch.
    const queued = yield* factory.start({ itemRef: world.itemRef });
    const { deliveryId } = queued;
    assert.strictEqual(queued.state.awaiting?.type, "effect");
    yield* drainFactory;
    const launched = yield* harnessStateOf(deliveryId);
    const { awaiting, worktreePath } = launched;
    if (awaiting?.type !== "run" || worktreePath === null) {
      return assert.fail("The author launch recorded no run and worktree.");
    }
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;

    yield* store.update(deliveryId, queued.state);
    yield* worker.step(deliveryId, {
      type: "effect.failed",
      effectId: 1,
      detail: "Factory could not launch the author thread: a server restart interrupted it.",
    });
    const lost = yield* harnessStateOf(deliveryId);
    assert.strictEqual(lost.status, "blocked");
    assert.deepStrictEqual(lost.threads, {});
    assert.isNull(lost.worktreePath);
    return { deliveryId, awaiting, worktreePath, launched, lost };
  });

describe("FactoryService.resume on the server's real stack", () => {
  it.live.each(["completed", "failed", "cancelled"] as const)(
    "picks up an author launch a restart lost after its run ended %s, and verifies its work",
    (status) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId, awaiting, worktreePath, launched, lost } = yield* lostLaunch(world);
          // The author's turn went on regardless, committed its work, and then ended.
          yield* authorCommits(worktreePath, "feat: add the export button");
          yield* world.endRun(awaiting.runId, status);
          assert.deepStrictEqual(yield* harnessStateOf(deliveryId), lost);

          yield* factory.resume(deliveryId);
          yield* drainFactory;

          // The launch replayed: its own thread, worktree and baseline, and no second author.
          const state = yield* harnessStateOf(deliveryId);
          assert.strictEqual(state.threads.author, awaiting.threadId);
          assert.strictEqual(state.worktreePath, worktreePath);
          assert.strictEqual(state.baseline, launched.baseline);
          // However its run ended, its work was settled and verified afresh, and is under review.
          assert.deepStrictEqual(
            state.receipts.map(({ headSha }) => headSha),
            [yield* harnessGit(worktreePath, ["rev-parse", "HEAD"])],
          );
          assert.strictEqual(state.status, "running");
          assert.strictEqual(state.stage, "review");
          if (state.awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
          assert.strictEqual(
            yield* runReached(state.awaiting.runId, ["starting", ...ended]),
            "starting",
          );
          yield* drainOrchestration;
          // One author turn, the one the lost launch started, then the reviewer's.
          assert.deepStrictEqual(
            world.provider.started.map((turn) => [turn.threadId, turn.runId]),
            [
              [awaiting.threadId, awaiting.runId],
              [state.awaiting.threadId, state.awaiting.runId],
            ],
          );
          assert.strictEqual(yield* worktreeCount(world.root), 2);
          assert.strictEqual(
            yield* harnessGit(worktreePath, ["branch", "--show-current"]),
            state.branch,
          );
        }),
      ).pipe(Effect.orDie),
  );

  it.live(
    "stays blocked, launching nothing, on resumes after a lost author's thread is deleted",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId, awaiting } = yield* lostLaunch(world);
          yield* world.endRun(awaiting.runId, "completed");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-the-lost-author"),
            threadId: awaiting.threadId,
          });
          yield* drainOrchestration;
          yield* drainFactory;

          const first = yield* factory.resume(deliveryId);
          yield* drainFactory;
          yield* drainOrchestration;
          const second = yield* factory.resume(deliveryId);
          yield* drainFactory;
          yield* drainOrchestration;

          for (const resumed of [first, second]) {
            assert.strictEqual(resumed.state.status, "blocked");
            assert.deepStrictEqual(resumed.state.block, {
              reason: "thread_deleted",
              threadId: awaiting.threadId,
            });
          }
          assert.deepStrictEqual(yield* harnessStateOf(deliveryId), second.state);
          // No thread, turn or worktree beyond the lost launch's.
          assert.deepStrictEqual(
            world.provider.started.map((turn) => turn.runId),
            [awaiting.runId],
          );
          assert.strictEqual(yield* worktreeCount(world.root), 2);
        }),
      ).pipe(Effect.orDie),
  );

  it.live("verifies a delivery stopped at verify and reviews it, with no new author turn", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        yield* factory.stop(author.deliveryId);
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const stopped = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(stopped.checkpoint, "verify");
        assert.deepStrictEqual(stopped.receipts, []);

        const resumed = yield* factory.resume(author.deliveryId);
        assert.strictEqual(resumed.state.status, "running");
        assert.strictEqual(resumed.state.stage, "verify");
        yield* drainFactory;

        const state = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(
          state.receipts[0]?.headSha,
          yield* harnessGit(author.worktreePath, ["rev-parse", "HEAD"]),
        );
        assert.isTrue(
          yield* world.exists(path.join(world.evidenceDir(author.deliveryId), "verify-1.json")),
        );
        const { awaiting } = state;
        if (awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
        assert.notStrictEqual(awaiting.threadId, author.threadId);
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.deepStrictEqual(
          world.provider.started.map((turn) => [turn.threadId, turn.runId]),
          [
            [author.threadId, author.runId],
            [awaiting.threadId, awaiting.runId],
          ],
        );
      }),
    ).pipe(Effect.orDie),
  );

  it.live("writes a fresh receipt for the commit a stopped review already verified", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const reviewing = yield* harnessStateOf(author.deliveryId);
        if (reviewing.awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
        const firstReviewer = reviewing.awaiting;
        assert.strictEqual(
          yield* runReached(firstReviewer.runId, ["starting", ...ended]),
          "starting",
        );
        yield* drainOrchestration;
        yield* factory.stop(author.deliveryId);
        yield* factory.submitReview({ threadId: firstReviewer.threadId, review: harnessReview });
        yield* world.endRun(firstReviewer.runId, "completed");
        const stopped = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(stopped.checkpoint, "record");
        assert.strictEqual(stopped.receipts.length, 1);
        const authored = yield* harnessGit(author.worktreePath, ["rev-parse", "HEAD"]);

        yield* factory.resume(author.deliveryId);
        yield* drainFactory;

        // The same commit, verified again: a second receipt, never the first one reused.
        const state = yield* harnessStateOf(author.deliveryId);
        assert.deepStrictEqual(
          state.receipts.map(({ headSha }) => headSha),
          [authored, authored],
        );
        const evidence = world.evidenceDir(author.deliveryId);
        assert.strictEqual(state.receipts[1]?.logPath, path.join(evidence, "verify-2.log"));
        assert.deepStrictEqual(
          JSON.parse(yield* fileSystem.readFileString(path.join(evidence, "verify-2.json"))),
          state.receipts[1],
        );
        // Then a second review round, and the author got no new turn.
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.reviewRound, 2);
        if (state.awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
        assert.strictEqual(
          yield* runReached(state.awaiting.runId, ["starting", ...ended]),
          "starting",
        );
        yield* drainOrchestration;
        assert.deepStrictEqual(
          world.provider.started
            .filter((turn) => turn.threadId === author.threadId)
            .map((turn) => turn.runId),
          [author.runId],
        );
      }),
    ).pipe(Effect.orDie),
  );

  it.live("sends one fix-commit turn naming the checkpoint, then blocks a still dirty tree", () =>
    withProject(verifyCommands.dirties, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const dirty = "Worktree has uncommitted or untracked changes.";
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        // Verify leaves a file behind: its receipt is refused and the delivery blocks.
        yield* world.endRun(author.runId, "completed");
        const refused = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(refused.status, "blocked");
        assert.strictEqual(refused.stage, "verify");
        assert.strictEqual(refused.block?.reason, "receipt_refused");

        const resumed = yield* factory.resume(author.deliveryId);
        assert.strictEqual(resumed.state.status, "running");
        assert.strictEqual(resumed.state.stage, "repair");
        yield* drainFactory;
        const repairing = yield* harnessStateOf(author.deliveryId);
        if (repairing.awaiting?.type !== "run") return assert.fail("No fix-commit turn runs.");
        const fixRun = repairing.awaiting;
        assert.strictEqual(fixRun.threadId, author.threadId);
        assert.strictEqual(yield* runReached(fixRun.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        const turn = world.provider.started.find((started) => started.runId === fixRun.runId);
        assert.include(
          turn?.message.text ?? "",
          "Factory is resuming this delivery from its `verify` checkpoint",
        );
        assert.include(turn?.message.text ?? "", `- ${dirty}`);

        // The turn leaves the file: the delivery blocks, with no second turn.
        yield* world.endRun(fixRun.runId, "completed");
        yield* drainOrchestration;
        yield* drainFactory;
        const state = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, { reason: "unsettled", problems: [dirty] });
        assert.deepStrictEqual(state.receipts, []);
        assert.deepStrictEqual(
          world.provider.started.map((started) => started.runId),
          [author.runId, fixRun.runId],
        );
      }),
    ).pipe(Effect.orDie),
  );

  it.live("blocks again, launching nothing, when the author thread was deleted", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        yield* factory.stop(author.deliveryId);
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        assert.strictEqual(yield* threadState(author.threadId), "present");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-the-author"),
          threadId: author.threadId,
        });
        yield* drainOrchestration;
        yield* drainFactory;
        // Deleted while stopped, the delivery stayed as it was until resumed.
        const stopped = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(yield* threadState(author.threadId), "deleted");
        assert.strictEqual(yield* threadState(ThreadId.make("never-launched")), "missing");

        const resumed = yield* factory.resume(author.deliveryId);
        yield* drainFactory;
        yield* drainOrchestration;

        assert.deepStrictEqual(resumed.state, {
          ...stopped,
          status: "blocked",
          block: { reason: "thread_deleted", threadId: author.threadId },
        });
        assert.deepStrictEqual(yield* harnessStateOf(author.deliveryId), resumed.state);
        assert.deepStrictEqual(
          world.provider.started.map((turn) => turn.runId),
          [author.runId],
        );
      }),
    ).pipe(Effect.orDie),
  );
});
