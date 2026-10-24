import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryDeliveryStatus,
  FactoryProjectSettings,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { type FactoryEvent, queuedDeliveryState } from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  runReached,
  stateOf as harnessStateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
// FactoryService reads only these fields of the item.
const item = {
  ref: itemRef,
  kind: "markdown",
  key: "fd-aaaaaa",
  title: "Add the export button",
} as unknown as WorkItemDetail;

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};

/** What the fakes are told and what they saw. */
interface World {
  /** Each author launch, by delivery. */
  readonly launches: Array<FactoryDeliveryId>;
  /** Each run Factory asked to interrupt. */
  readonly interrupts: Array<{ readonly threadId: ThreadId; readonly runId: RunId }>;
  /** While set, a launch waits for it before reporting. */
  launchGate: Deferred.Deferred<void> | null;
  /** While set, a verify run waits for it before reporting `verifyReceipt`. */
  verifyGate: Deferred.Deferred<void> | null;
  verifyStarted: Deferred.Deferred<void> | null;
  verifyReceipt: FactoryVerifyReceipt;
}

const threadOf = (deliveryId: FactoryDeliveryId) => ThreadId.make(`thread-${deliveryId}`);
const runOf = (deliveryId: FactoryDeliveryId) => RunId.make(`run-${deliveryId}`);

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
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeed(Option.some({ projectId: id } as unknown as ProjectStore.ProjectRow)),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ checkWorktreeBase: () => Effect.void }),
    // Each delivery's author gets its own thread: one thread can hold one active stage attempt.
    Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
      launchThread: (delivery) =>
        Effect.gen(function* () {
          world.launches.push(delivery.deliveryId);
          if (world.launchGate !== null) yield* Deferred.await(world.launchGate);
          return {
            threadId: threadOf(delivery.deliveryId),
            runId: runOf(delivery.deliveryId),
            worktreePath: `/worktrees/${delivery.deliveryId}`,
            baseline: "b".repeat(40),
          };
        }),
      runEnded: () => Effect.succeedNone,
      interruptRun: (_delivery, run) => Effect.sync(() => void world.interrupts.push(run)),
    }),
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({
      run: () =>
        Effect.gen(function* () {
          if (world.verifyStarted !== null) yield* Deferred.succeed(world.verifyStarted, undefined);
          if (world.verifyGate !== null) yield* Deferred.await(world.verifyGate);
          return {
            type: "receipt",
            receipt: world.verifyReceipt,
            evidencePath: "/t3/verify-1.json",
          } as const;
        }),
    }),
    // Nothing here is reviewed, records an approval or opens a pull request; the real stack
    // below cancels a review.
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    // No ref holds the item's branch name, so a start keeps it.
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  );

/** The service and the real worker on in-memory SQLite, with everything outside Factory faked. */
const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    launches: [],
    interrupts: [],
    launchGate: null,
    verifyGate: null,
    verifyStarted: null,
    verifyReceipt: receipt,
  };
  const layer = FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return body(world).pipe(Effect.provide(layer), Effect.scoped);
};

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const isStopRefused = Schema.is(FactoryService.FactoryStopRefusedError);
const isCancelRefused = Schema.is(FactoryService.FactoryCancelRefusedError);
const isDeliveryNotFound = Schema.is(FactoryService.FactoryDeliveryNotFoundError);
const isReviewRefused = Schema.is(FactoryService.FactoryReviewRefusedError);

const useVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({
      verifyCommand: { executable: "vp", args: ["test", "run"] },
    }),
  ),
);

const service = FactoryService.FactoryService;
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const stop = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.stop(deliveryId));
const cancel = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.cancel(deliveryId));
const stepThread = (event: Extract<FactoryEvent, { readonly type: "run.finished" }>) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.stepThread(event));

/** Starts a delivery of the item and waits until it awaits its author's first run. */
const started = Effect.gen(function* () {
  yield* useVerify;
  const { deliveryId } = yield* Effect.flatMap(service, (factory) => factory.start({ itemRef }));
  yield* drain;
  return deliveryId;
});
const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(deliveryId)).pipe(
    Effect.map((delivery) => Option.getOrThrow(delivery).state),
  );
/** The delivery's row and stage attempts exactly as SQLite holds them. */
const rowsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${deliveryId}`,
    };
  });
const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((attempts) => attempts.map(({ stage, outcome }) => [stage, outcome])));

/** Moves a stored delivery to `status`, awaiting nothing, as the engine or its owner would. */
const storeStatus = (deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const current = Option.getOrThrow(yield* store.get(deliveryId));
    yield* store.update(deliveryId, { ...current.state, status, awaiting: null });
  });

const authorEnd = (
  deliveryId: FactoryDeliveryId,
  status: Extract<FactoryEvent, { readonly type: "run.finished" }>["status"],
) =>
  ({
    type: "run.finished",
    threadId: threadOf(deliveryId),
    runId: runOf(deliveryId),
    status,
  }) as const;

/**
 * A delivery whose verify (effect 3) is running until `release`: stored as a previous step left
 * it, with its author's run completed and its settle check (2) due, then settled.
 */
const verifying = (world: World) =>
  Effect.gen(function* () {
    yield* useVerify;
    const gate = yield* Deferred.make<void>();
    world.verifyGate = gate;
    world.verifyStarted = yield* Deferred.make<void>();
    const deliveryId = FactoryDeliveryId.make("delivery-verifying");
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: threadOf(deliveryId),
        runId: runOf(deliveryId),
        worktreePath: `/worktrees/${deliveryId}`,
        baseline: "b".repeat(40),
      },
      authorEnd(deliveryId, "completed"),
    ];
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({
      deliveryId,
      projectId,
      itemRef,
      state: events.reduce(
        (state, event) => advance(state, event).delivery,
        queuedDeliveryState({ branch: "work/fd-aaaaaa", baseRef: "HEAD" }),
      ),
    });
    const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
    yield* runs.append({ deliveryId, stage: "author", threadId: threadOf(deliveryId) });
    const worker = yield* FactoryWorker.FactoryWorker;
    yield* worker.step(deliveryId, {
      type: "settle.checked",
      effectId: 2,
      result: { status: "settled" },
    });
    yield* Deferred.await(world.verifyStarted);
    return { deliveryId, release: Deferred.succeed(gate, undefined) };
  });

describe("FactoryService.stop", () => {
  it.effect("stores a running delivery as stopping and issues nothing", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const deliveryId = yield* started;
        const before = yield* stateOf(deliveryId);

        const stopped = yield* stop(deliveryId);
        yield* drain;

        assert.deepStrictEqual(stopped.state, { ...before, status: "stopping" });
        assert.deepStrictEqual(yield* stateOf(deliveryId), stopped.state);
        // The author's turn goes on: nothing was launched, interrupted or recorded.
        assert.deepStrictEqual(world.launches, [deliveryId]);
        assert.deepStrictEqual(world.interrupts, []);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [["author", null]]);
      }),
    ),
  );

  it.effect("makes a second stop a no-op that writes nothing", () =>
    withWorld(() =>
      Effect.gen(function* () {
        const deliveryId = yield* started;
        yield* stop(deliveryId);
        const before = yield* rowsOf(deliveryId);
        // A write now would move updated_at.
        yield* TestClock.adjust("1 minute");

        const again = yield* stop(deliveryId);
        yield* drain;

        assert.strictEqual(again.state.status, "stopping");
        assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
      }),
    ),
  );

  it.effect.each([
    "queued",
    "stopped",
    "blocked",
    "approved",
    "pr_open",
    "done",
    "cancelled",
  ] as const)("refuses to stop a %s delivery, naming its status, and changes nothing", (status) =>
    withWorld(() =>
      Effect.gen(function* () {
        const deliveryId = yield* started;
        yield* storeStatus(deliveryId, status);
        const before = yield* rowsOf(deliveryId);
        yield* TestClock.adjust("1 minute");

        const error = yield* Effect.flip(stop(deliveryId));
        yield* drain;

        if (!isStopRefused(error)) {
          return assert.fail(`Expected a refused stop, got ${error._tag}.`);
        }
        assert.strictEqual(error.deliveryId, deliveryId);
        assert.strictEqual(error.status, status);
        assert.include(error.message, `is ${status}`);
        assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
      }),
    ),
  );

  it.effect("stops a failed verify before its repair round and records the verify failed", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const evidence = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-stop-" });
        const logPath = path.join(evidence, "verify-1.log");
        yield* fileSystem.writeFileString(logPath, "one check failed\n");
        world.verifyReceipt = { ...receipt, code: 1, logPath };
        const { deliveryId, release } = yield* verifying(world);

        yield* stop(deliveryId);
        yield* release;
        yield* drain;

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "stopped");
        assert.strictEqual(state.checkpoint, "repair");
        assert.strictEqual(state.stage, "verify");
        assert.deepStrictEqual(state.receipts, [world.verifyReceipt]);
        assert.strictEqual(state.fingerprints.length, 1);
        assert.deepStrictEqual(state.rounds, { fix: 0, review: 0 });
        // Verify judged the commit: its attempt failed, and no repair turn was sent.
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["author", "passed"],
          ["verify", "failed"],
        ]);
      }),
    ),
  );

  it.effect("waits for a step in progress, then judges the status that step left", () =>
    withWorld(() =>
      Effect.gen(function* () {
        const deliveryId = yield* started;
        const worker = yield* FactoryWorker.FactoryWorker;
        // The run's failure is being decided and stored under the delivery's lock.
        const decided = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const ending = yield* Effect.forkChild(
          worker.stepWith(deliveryId, () =>
            Deferred.succeed(decided, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ event: authorEnd(deliveryId, "failed"), value: undefined }),
            ),
          ),
        );
        yield* Deferred.await(decided);
        let stopReturned = false;
        const stopping = yield* Effect.forkChild(
          Effect.exit(stop(deliveryId)).pipe(
            Effect.tap(() => Effect.sync(() => (stopReturned = true))),
          ),
        );
        for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
        assert.isFalse(stopReturned);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(ending);
        const exit = yield* Fiber.join(stopping);

        // The stop saw the blocked delivery the run's end left, not the running one before it.
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
      }),
    ),
  );

  it.effect("refuses to stop or cancel a delivery that does not exist", () =>
    withWorld(() =>
      Effect.gen(function* () {
        const unknown = FactoryDeliveryId.make("delivery-unknown");
        assert.isTrue(isDeliveryNotFound(yield* Effect.flip(stop(unknown))));
        assert.isTrue(isDeliveryNotFound(yield* Effect.flip(cancel(unknown))));
      }),
    ),
  );
});

describe("FactoryService.cancel", () => {
  it.effect("cancels a running delivery, interrupts its run and takes no later end", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const deliveryId = yield* started;

        const cancelled = yield* cancel(deliveryId);
        yield* drain;

        assert.strictEqual(cancelled.state.status, "cancelled");
        assert.isNull(cancelled.state.awaiting);
        assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled.state);
        assert.deepStrictEqual(world.interrupts, [
          { threadId: threadOf(deliveryId), runId: runOf(deliveryId) },
        ]);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [["author", "cancelled"]]);

        // The interrupted run's end, or a completion that raced it, changes nothing.
        const before = yield* rowsOf(deliveryId);
        yield* TestClock.adjust("1 minute");
        yield* stepThread(authorEnd(deliveryId, "interrupted"));
        yield* stepThread(authorEnd(deliveryId, "completed"));
        yield* drain;
        assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
        assert.deepStrictEqual(world.launches, [deliveryId]);
      }),
    ),
  );

  it.effect("interrupts the run a launch reports after its delivery was cancelled", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.launchGate = yield* Deferred.make<void>();
        yield* useVerify;
        const { deliveryId } = yield* Effect.flatMap(service, (factory) =>
          factory.start({ itemRef }),
        );

        // The author's launch is still preparing when the owner cancels.
        const cancelled = yield* cancel(deliveryId);
        assert.strictEqual(cancelled.state.status, "cancelled");
        assert.deepStrictEqual(world.interrupts, []);

        yield* Deferred.succeed(world.launchGate, undefined);
        yield* drain;

        // The delivery took none of the launch, and the turn it started is interrupted.
        const state = yield* stateOf(deliveryId);
        assert.deepStrictEqual(state, cancelled.state);
        assert.deepStrictEqual(state.threads, {});
        assert.deepStrictEqual(world.interrupts, [
          { threadId: threadOf(deliveryId), runId: runOf(deliveryId) },
        ]);
      }),
    ),
  );

  it.effect("takes no verify result that arrives after the cancel", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { deliveryId, release } = yield* verifying(world);

        const cancelled = yield* cancel(deliveryId);
        // Verify is the server's command, not an agent turn: nothing is interrupted.
        assert.deepStrictEqual(world.interrupts, []);
        const before = yield* rowsOf(deliveryId);
        yield* TestClock.adjust("1 minute");

        yield* release;
        yield* drain;

        assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
        assert.deepStrictEqual((yield* stateOf(deliveryId)).receipts, cancelled.state.receipts);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["author", "passed"],
          ["verify", "cancelled"],
        ]);
      }),
    ),
  );

  it.effect.each(["queued", "stopped", "blocked", "pr_open"] as const)(
    "cancels a %s delivery awaiting nothing, interrupting nothing",
    (status) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const deliveryId = yield* started;
          yield* storeStatus(deliveryId, status);

          const cancelled = yield* cancel(deliveryId);
          yield* drain;

          assert.strictEqual(cancelled.state.status, "cancelled");
          assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled.state);
          assert.deepStrictEqual(world.interrupts, []);
        }),
      ),
  );

  it.effect.each(["done", "cancelled"] as const)(
    "refuses to cancel a %s delivery and changes nothing",
    (status) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const deliveryId = yield* started;
          yield* storeStatus(deliveryId, status);
          const before = yield* rowsOf(deliveryId);
          yield* TestClock.adjust("1 minute");

          const error = yield* Effect.flip(cancel(deliveryId));
          yield* drain;

          if (!isCancelRefused(error)) {
            return assert.fail(`Expected a refused cancel, got ${error._tag}.`);
          }
          assert.strictEqual(error.deliveryId, deliveryId);
          assert.strictEqual(error.status, status);
          assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
          assert.deepStrictEqual(world.interrupts, []);
        }),
      ),
  );
});

/** The passing review the reviewer would have submitted, had the delivery not been cancelled. */
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "The button exports.", paths: ["export.ts"] },
  ],
  missing_evidence: [],
};

describe("stop and cancel on the server's real stack", () => {
  it.live("stops after the author's step: the branch settles and nothing is verified", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        const stopping = yield* factory.stop(author.deliveryId);
        assert.strictEqual(stopping.state.status, "stopping");

        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");

        const state = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(state.status, "stopped");
        assert.strictEqual(state.checkpoint, "verify");
        assert.isNull(state.awaiting);
        assert.deepStrictEqual(state.receipts, []);
        const path = yield* Path.Path;
        const evidence = world.evidenceDir(author.deliveryId);
        assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.log")));
        assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.json")));
        // The author's turn was never interrupted: it ended on its own.
        assert.deepStrictEqual(world.provider.interrupted, []);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("stops during review: the review is taken and the delivery stops before record", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const { awaiting } = yield* harnessStateOf(author.deliveryId);
        if (awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;

        yield* factory.stop(author.deliveryId);
        const accepted = yield* factory.submitReview({
          threadId: awaiting.threadId,
          review: passingReview,
        });
        assert.strictEqual(accepted.review.round, 1);
        yield* world.endRun(awaiting.runId, "completed");

        const state = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(state.status, "stopped");
        assert.strictEqual(state.checkpoint, "record");
        assert.strictEqual(state.stage, "review");
        assert.deepStrictEqual(
          state.reviews.map(({ round, source }) => [round, source]),
          [[1, "mcp"]],
        );
        // Nothing was approved or published.
        const path = yield* Path.Path;
        assert.isFalse(
          yield* world.exists(
            path.join(world.evidenceDir(author.deliveryId), "approval-item.json"),
          ),
        );
        assert.deepStrictEqual(world.pullRequestCalls, []);
        assert.deepStrictEqual(world.provider.interrupted, []);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("cancels mid-review: the reviewer stops, its run and review change nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const factory = yield* Factory.FactoryService.FactoryService;
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const reviewing = yield* harnessStateOf(author.deliveryId);
        assert.strictEqual(reviewing.stage, "review");
        if (reviewing.awaiting?.type !== "run") return assert.fail("The reviewer is not running.");
        const reviewer = reviewing.awaiting;
        assert.strictEqual(yield* runReached(reviewer.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        const authored = yield* git(author.worktreePath, ["rev-parse", "HEAD"]);

        const cancelled = yield* factory.cancel(author.deliveryId);
        assert.strictEqual(cancelled.state.status, "cancelled");
        yield* drainOrchestration;
        // The reviewer's turn was asked to stop, through the thread's own interrupt.
        const reviewTurn = world.provider.started.find((turn) => turn.runId === reviewer.runId);
        assert.deepStrictEqual(
          world.provider.interrupted.map(({ providerTurnId }) => providerTurnId),
          [`provider-turn:${reviewTurn?.attemptId}`],
        );

        // Its run then completes anyway, and its review arrives: neither changes the delivery.
        yield* world.endRun(reviewer.runId, "completed");
        const refused = yield* Effect.flip(
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview }),
        );
        if (!isReviewRefused(refused)) {
          return assert.fail(`Expected a refused review, got ${refused._tag}.`);
        }
        assert.strictEqual(refused.reason, "not_reviewer");
        yield* drainFactory;
        assert.deepStrictEqual(yield* harnessStateOf(author.deliveryId), cancelled.state);
        assert.deepStrictEqual(world.pullRequestCalls, []);

        // The worktree, its branch and the author's commit stay.
        assert.isTrue(yield* fileSystem.exists(author.worktreePath));
        assert.strictEqual(yield* git(author.worktreePath, ["rev-parse", "HEAD"]), authored);
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${cancelled.state.branch}`]),
          authored,
        );

        // Cancelled once, the delivery refuses another cancel.
        const again = yield* Effect.flip(factory.cancel(author.deliveryId));
        assert.isTrue(isCancelRefused(again));

        // A new delivery of the item starts over: its author launches on a branch and worktree
        // of its own, from the project's HEAD, and the cancelled delivery's work stays as it was.
        const restart = yield* world.start;
        assert.notStrictEqual(restart.deliveryId, author.deliveryId);
        const restarted = yield* harnessStateOf(restart.deliveryId);
        assert.strictEqual(restarted.status, "running");
        assert.strictEqual(restarted.stage, "author");
        assert.strictEqual(restarted.branch, `${cancelled.state.branch}-2`);
        assert.notStrictEqual(restart.worktreePath, author.worktreePath);
        assert.strictEqual(
          yield* git(restart.worktreePath, ["branch", "--show-current"]),
          restarted.branch,
        );
        assert.strictEqual(
          yield* git(restart.worktreePath, ["rev-parse", "HEAD"]),
          yield* git(world.root, ["rev-parse", "main"]),
        );
        assert.notStrictEqual(restarted.baseline, authored);
        assert.strictEqual(
          world.provider.started.filter((turn) => turn.threadId === restart.threadId).length,
          1,
        );
        assert.strictEqual(yield* git(author.worktreePath, ["rev-parse", "HEAD"]), authored);
        assert.strictEqual(
          yield* git(author.worktreePath, ["branch", "--show-current"]),
          cancelled.state.branch,
        );
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${cancelled.state.branch}`]),
          authored,
        );
        assert.deepStrictEqual(yield* harnessStateOf(author.deliveryId), cancelled.state);
      }),
    ).pipe(Effect.orDie),
  );
});
