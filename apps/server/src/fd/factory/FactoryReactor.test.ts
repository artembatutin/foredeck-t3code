import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type OrchestrationV2StoredEvent,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryProjectSettings,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, type WorkItemRef, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type {
  FactoryDeliveryState,
  FactoryEvent,
  FactoryTerminalRunStatus,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/** A thread as the projection fake holds it; a thread missing from the map does not exist. */
interface ProjectedThread {
  readonly deleted: boolean;
  readonly runs: ReadonlyArray<{ readonly id: RunId; readonly status: OrchestrationV2RunStatus }>;
}

/** What the fakes report, and what they saw. */
interface World {
  readonly projections: Map<ThreadId, ProjectedThread>;
  projectionReads: number;
  /** The thread and run each delivery's author launch reports. */
  readonly launches: Map<FactoryDeliveryId, { readonly threadId: ThreadId; readonly runId: RunId }>;
  /** While set, a launch waits for it before reporting. */
  launchGate: Deferred.Deferred<void> | null;
  launchCalls: number;
  verifyCalls: number;
  /** While set, a verify run waits for it, then fails. */
  verifyGate: Deferred.Deferred<void> | null;
  /** Resolves once a verify run has started. */
  readonly verifyStarted: Deferred.Deferred<void>;
  /** The event log the tail reads, in sequence order. */
  readonly events: Array<OrchestrationV2StoredEvent>;
  /** While set, the tail waits for it before it subscribes. */
  subscribeGate: Deferred.Deferred<void> | null;
  /** Deliveries the worker cannot read. */
  readonly unreadable: Set<FactoryDeliveryId>;
  /** Runs when the worker reads a launched run, before it stores the launch. */
  onRunRead: ((threadId: ThreadId, runId: RunId) => Effect.Effect<void>) | null;
  /** Warnings logged, by message. */
  readonly warnings: Array<string>;
}

const at = "2026-10-24T08:00:00.000Z";
const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
// An existing directory: the settle check finds it, then waits on the fake git driver.
const worktreePath = process.cwd();
const baseline = "b".repeat(40);
const queued = queuedDeliveryState({ branch: "feature/item", baseRef: "main" });

/** One delivery with its own item, author thread and first run. */
interface Fixture {
  readonly id: FactoryDeliveryId;
  readonly item: WorkItemRef;
  readonly thread: ThreadId;
  readonly run: RunId;
}
const fixture = (name: string): Fixture => ({
  id: FactoryDeliveryId.make(`delivery-${name}`),
  item: { sourceId, itemId: WorkItemId.make(`fd-${name}`) },
  thread: ThreadId.make(`thread-${name}`),
  run: RunId.make(`run-${name}`),
});

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};

/** Settings a delivery can verify with; the fake runner never runs the command. */
const withVerify = Schema.decodeSync(FactoryProjectSettings)({
  verifyCommand: { executable: "vp", args: ["test", "run"] },
});

const fold = (...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((state, event) => advance(state, event).delivery, queued);
const launched = (f: Fixture): FactoryEvent => ({
  type: "thread.launched",
  effectId: 1,
  threadId: f.thread,
  runId: f.run,
  worktreePath,
  baseline,
});
const finished = (f: Fixture, status: FactoryTerminalRunStatus): FactoryEvent => ({
  type: "run.finished",
  threadId: f.thread,
  runId: f.run,
  status,
});
const settled: FactoryEvent = {
  type: "settle.checked",
  effectId: 2,
  result: { status: "settled" },
};
// States a previous server process left behind.
const awaitingRun = (f: Fixture) => fold({ type: "start" }, launched(f));
const awaitingVerify = (f: Fixture) =>
  fold({ type: "start" }, launched(f), finished(f, "completed"), settled);
/** Where a delivery stopped before review existed: verified, with its passing receipt last. */
const stoppedVerified = (f: Fixture): FactoryDeliveryState => ({
  ...awaitingVerify(f),
  status: "stopped",
  awaiting: null,
  receipts: [receipt],
});

/** The settle check the engine issues once the author's first run completed. */
const awaitingSettle = (f: Fixture) =>
  ({
    type: "effect",
    effect: { id: 2, type: "check_settle", threadId: f.thread, runId: f.run },
  }) as const;

const runUpdated = (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
    runId,
    occurredAt: DateTime.makeUnsafe(at),
    payload: { id: runId, threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;
const threadDeleted = (threadId: ThreadId): OrchestrationV2DomainEvent =>
  ({
    type: "thread.deleted",
    threadId,
    occurredAt: DateTime.makeUnsafe(at),
    payload: { id: threadId },
  }) as unknown as OrchestrationV2DomainEvent;

const fakeThreads = (world: World) =>
  Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
    launchThread: (delivery) =>
      Effect.gen(function* () {
        world.launchCalls += 1;
        if (world.launchGate !== null) yield* Deferred.await(world.launchGate);
        const launch = world.launches.get(delivery.deliveryId);
        if (launch === undefined) return yield* Effect.die("launch not scripted");
        return { ...launch, worktreePath, baseline };
      }),
    sendFixCommitTurn: () => Effect.die("fix-commit turn not scripted"),
    sendReviewRetryTurn: () => Effect.die("review retry turn not scripted"),
    runEnded: (threadId, runId) =>
      (world.onRunRead?.(threadId, runId) ?? Effect.void).pipe(Effect.as(Option.none())),
  });

const fakeVerify = (world: World) =>
  Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({
    run: () =>
      Effect.gen(function* () {
        world.verifyCalls += 1;
        yield* Deferred.succeed(world.verifyStarted, undefined);
        if (world.verifyGate !== null) yield* Deferred.await(world.verifyGate);
        return yield* Effect.die("verify not scripted");
      }),
  });

/**
 * The event log like EventSink's: `stream` subscribes to live events, then replays the log after
 * `afterSequence` up to that moment, then delivers live events past it.
 */
const fakeEventSink = (
  world: World,
  live: PubSub.PubSub<OrchestrationV2StoredEvent>,
  tailSubscribed: Deferred.Deferred<void>,
) =>
  Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () => Effect.sync(() => world.events.length),
    stream: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (world.subscribeGate !== null) yield* Deferred.await(world.subscribeGate);
          const subscription = yield* PubSub.subscribe(live);
          const highWater = world.events.length;
          const after = input?.afterSequence ?? 0;
          yield* Deferred.succeed(tailSubscribed, undefined);
          return Stream.concat(
            Stream.fromIterable(
              world.events.filter(({ sequence }) => sequence > after && sequence <= highWater),
            ),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(({ sequence }) => sequence > Math.max(highWater, after)),
            ),
          );
        }),
      ),
  });

/** The worker's delivery store, which fails every read of an unreadable delivery. */
const failingStore = (world: World) =>
  Layer.effect(
    FactoryDeliveryStore.FactoryDeliveryStore,
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      return FactoryDeliveryStore.FactoryDeliveryStore.of({
        ...store,
        get: (id) =>
          world.unreadable.has(id)
            ? Effect.fail(
                new FactoryStoreError({
                  operation: "deliveries.get",
                  cause: new Error("disk I/O error"),
                }),
              )
            : store.get(id),
      });
    }),
  );

const fakeProjections = (world: World) =>
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter?: { readonly runIds?: ReadonlyArray<RunId> },
    ) =>
      Effect.suspend(() => {
        world.projectionReads += 1;
        const projected = world.projections.get(threadId);
        if (projected === undefined) {
          return Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }));
        }
        return Effect.succeed({
          thread: { id: threadId, deletedAt: projected.deleted ? DateTime.makeUnsafe(at) : null },
          runs: projected.runs.filter((run) => filter?.runIds?.includes(run.id) ?? true),
        });
      })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
  });

/**
 * The reactor over the real worker, engine and stores on in-memory SQLite, reading thread events
 * from a fake event log. `tailSubscribed` resolves once the tail has subscribed. The settle
 * check's git reads never return, so a delivery the reactor moved on stays awaiting that check.
 */
const setup = Effect.gen(function* () {
  const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
  const tailSubscribed = yield* Deferred.make<void>();
  const world: World = {
    projections: new Map(),
    projectionReads: 0,
    launches: new Map(),
    launchGate: null,
    launchCalls: 0,
    verifyCalls: 0,
    verifyGate: null,
    verifyStarted: yield* Deferred.make<void>(),
    events: [],
    subscribeGate: null,
    unreadable: new Set(),
    onRunRead: null,
    warnings: [],
  };
  const logger = Logger.make(({ logLevel, message }) => {
    const [first] = Array.isArray(message) ? message : [message];
    if (logLevel === "Warn" && typeof first === "string") world.warnings.push(first);
  });
  const worker = FactoryWorker.layer.pipe(
    Layer.provide(failingStore(world)),
    Layer.provide(fakeThreads(world)),
    Layer.provide(fakeVerify(world)),
    // No delivery here reaches a review.
    Layer.provide(Layer.mock(FactoryReview.FactoryReview)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ execute: () => Effect.never })),
  );
  const layer = FactoryReactor.layer.pipe(
    Layer.provideMerge(worker),
    Layer.provide(fakeEventSink(world, live, tailSubscribed)),
    Layer.provide(fakeProjections(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
  /** Appends the event to the log and publishes it, as EventSink does after a commit. */
  const commit = (event: OrchestrationV2DomainEvent) =>
    Effect.suspend(() => {
      const stored = { sequence: world.events.length + 1, commandId: null, event };
      world.events.push(stored);
      return PubSub.publish(live, stored);
    }).pipe(Effect.asVoid);
  return { world, layer, commit, tailSubscribed };
});

type Harness = Effect.Success<typeof setup>;

/** Runs `body` against a fresh database, worker and reactor. */
const withReactor = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* setup;
    return yield* body(harness).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

const insert = (f: Fixture, state: FactoryDeliveryState) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
    store.insert({ deliveryId: f.id, projectId, itemRef: f.item, state }),
  );
const stateOf = (f: Fixture) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(f.id)).pipe(
    Effect.map((delivery) => Option.getOrThrow(delivery).state),
  );
/** The delivery's row exactly as SQLite holds it. */
const rawRow = (f: Fixture) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${f.id}`,
  );
const attemptsOf = (f: Fixture) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) => runs.listByDelivery(f.id));

const reactor = FactoryReactor.FactoryReactor;
const start = Effect.flatMap(reactor, (service) => service.start);
const drain = Effect.flatMap(reactor, (service) => service.drain);
const drainWorker = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);

/** Starts the delivery through the worker; it then awaits its author's first run, still running. */
const launch = (world: World, f: Fixture) =>
  Effect.gen(function* () {
    world.launches.set(f.id, { threadId: f.thread, runId: f.run });
    world.projections.set(f.thread, { deleted: false, runs: [{ id: f.run, status: "running" }] });
    yield* insert(f, queued);
    const worker = yield* FactoryWorker.FactoryWorker;
    yield* worker.step(f.id, { type: "start" });
    yield* worker.drain;
  });

/** Starts the reactor and waits until its tail listens and the boot sweep has run. */
const listen = (harness: Harness) =>
  Effect.gen(function* () {
    yield* start;
    yield* Deferred.await(harness.tailSubscribed);
    yield* drain;
  });

describe("FactoryReactor run ends", () => {
  it.effect("moves a delivery whose author run completed on to the settle check", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const f = fixture("a");
        yield* launch(harness.world, f);
        yield* listen(harness);

        yield* harness.commit(runUpdated(f.thread, f.run, "completed"));
        yield* drain;

        const state = yield* stateOf(f);
        assert.strictEqual(state.status, "running");
        assert.deepStrictEqual(state.awaiting, awaitingSettle(f));
      }),
    ),
  );

  it.effect("blocks a delivery whose author run ended without completing", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const statuses = ["failed", "cancelled", "interrupted", "rolled_back"] as const;
        const fixtures = statuses.map(fixture);
        for (const f of fixtures) yield* launch(harness.world, f);
        yield* listen(harness);

        for (const [index, status] of statuses.entries()) {
          const f = fixtures[index]!;
          yield* harness.commit(runUpdated(f.thread, f.run, status));
        }
        yield* drain;

        for (const [index, status] of statuses.entries()) {
          const f = fixtures[index]!;
          const state = yield* stateOf(f);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(state.block, {
            reason: "run_ended",
            threadId: f.thread,
            runId: f.run,
            runStatus: status,
          });
          const [authorAttempt] = yield* attemptsOf(f);
          assert.strictEqual(authorAttempt?.outcome, "blocked");
        }
      }),
    ),
  );

  it.effect("ignores run updates that are not terminal", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const f = fixture("a");
        yield* launch(harness.world, f);
        yield* listen(harness);
        const before = yield* rawRow(f);
        // A write now would move updated_at.
        yield* TestClock.adjust("1 minute");

        for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
          yield* harness.commit(runUpdated(f.thread, f.run, status));
        }
        yield* drain;

        assert.deepStrictEqual(yield* rawRow(f), before);
      }),
    ),
  );

  it.effect("ignores terminal runs on threads Factory does not own", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const f = fixture("a");
        yield* launch(harness.world, f);
        yield* listen(harness);
        const before = yield* rawRow(f);
        yield* TestClock.adjust("1 minute");

        // Even one naming the very run the delivery awaits.
        yield* harness.commit(runUpdated(ThreadId.make("thread-unowned"), f.run, "failed"));
        yield* drain;

        assert.deepStrictEqual(yield* rawRow(f), before);
      }),
    ),
  );

  it.effect("feeds a run that ends while its launch is being stored", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const f = fixture("a");
        yield* listen(harness);
        // The worker read the launched run as still running, and it fails right after, while
        // no attempt names the thread. The yields let the reactor look the thread up before the
        // launch is stored; its step then waits for this delivery's lock.
        world.onRunRead = (threadId, runId) =>
          harness.commit(runUpdated(threadId, runId, "failed")).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
              }),
            ),
          );
        world.launches.set(f.id, { threadId: f.thread, runId: f.run });
        yield* insert(f, queued);

        const worker = yield* FactoryWorker.FactoryWorker;
        yield* worker.step(f.id, { type: "start" });
        yield* worker.drain;
        yield* drain;

        assert.deepStrictEqual((yield* stateOf(f)).block, {
          reason: "run_ended",
          threadId: f.thread,
          runId: f.run,
          runStatus: "failed",
        });
      }),
    ),
  );
});

describe("FactoryReactor thread deletion", () => {
  it.effect("blocks a delivery whose author thread was deleted", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const f = fixture("a");
        yield* launch(harness.world, f);
        yield* listen(harness);

        yield* harness.commit(threadDeleted(f.thread));
        yield* drain;

        const state = yield* stateOf(f);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, { reason: "thread_deleted", threadId: f.thread });
        const [authorAttempt] = yield* attemptsOf(f);
        assert.strictEqual(authorAttempt?.outcome, "blocked");
      }),
    ),
  );

  it.effect("blocks a delivery whose author thread is deleted while it verifies", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const f = fixture("a");
        yield* listen(harness);
        // The author's run completed and its attempt is active until the branch settles.
        yield* insert(f, fold({ type: "start" }, launched(f), finished(f, "completed")));
        const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
        yield* runs.append({ deliveryId: f.id, stage: "author", threadId: f.thread, runId: f.run });
        const settings = yield* FactorySettings.FactorySettings;
        yield* settings.set(projectId, withVerify);
        world.verifyGate = yield* Deferred.make<void>();
        const worker = yield* FactoryWorker.FactoryWorker;
        yield* worker.step(f.id, settled);
        yield* Deferred.await(world.verifyStarted);
        // Verify runs: the author attempt is finished, and the verify attempt names no thread.
        assert.deepStrictEqual(
          (yield* attemptsOf(f)).map(({ stage, threadId, outcome }) => ({
            stage,
            threadId,
            outcome,
          })),
          [
            { stage: "author", threadId: f.thread, outcome: "passed" },
            { stage: "verify", threadId: null, outcome: null },
          ],
        );

        yield* harness.commit(threadDeleted(f.thread));
        yield* drain;

        const state = yield* stateOf(f);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "verify");
        assert.deepStrictEqual(state.block, { reason: "thread_deleted", threadId: f.thread });
        assert.strictEqual((yield* attemptsOf(f))[1]?.outcome, "blocked");

        // The verify run that was still going fails afterwards and changes nothing.
        yield* Deferred.succeed(world.verifyGate, undefined);
        yield* worker.drain;
        assert.deepStrictEqual((yield* stateOf(f)).block, {
          reason: "thread_deleted",
          threadId: f.thread,
        });
      }),
    ),
  );

  it.effect("changes no delivery when an unrelated thread is deleted", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const f = fixture("a");
        yield* launch(harness.world, f);
        yield* listen(harness);
        const before = yield* rawRow(f);
        const attemptsBefore = yield* attemptsOf(f);
        yield* TestClock.adjust("1 minute");

        yield* harness.commit(threadDeleted(ThreadId.make("thread-unrelated")));
        yield* drain;

        assert.deepStrictEqual(yield* rawRow(f), before);
        assert.deepStrictEqual(yield* attemptsOf(f), attemptsBefore);
      }),
    ),
  );
});

describe("FactoryReactor boot sweep", () => {
  it.effect("catches up deliveries whose runs ended or threads vanished while it was down", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [completed, missing, deleted, interrupted, running] = [
          "completed",
          "missing",
          "deleted",
          "interrupted",
          "running",
        ].map(fixture) as [Fixture, Fixture, Fixture, Fixture, Fixture];
        for (const f of [completed, missing, deleted, interrupted, running]) {
          yield* insert(f, awaitingRun(f));
        }
        world.projections.set(completed.thread, {
          deleted: false,
          runs: [{ id: completed.run, status: "completed" }],
        });
        // A deleted thread still has its row; its run never ended.
        world.projections.set(deleted.thread, {
          deleted: true,
          runs: [{ id: deleted.run, status: "running" }],
        });
        world.projections.set(interrupted.thread, {
          deleted: false,
          runs: [{ id: interrupted.run, status: "interrupted" }],
        });
        world.projections.set(running.thread, {
          deleted: false,
          runs: [{ id: running.run, status: "running" }],
        });
        const runningBefore = yield* rawRow(running);
        yield* TestClock.adjust("1 minute");

        // No event is published: everything below comes from the sweep.
        yield* start;
        yield* drain;

        assert.deepStrictEqual((yield* stateOf(completed)).awaiting, awaitingSettle(completed));
        for (const f of [missing, deleted]) {
          assert.deepStrictEqual((yield* stateOf(f)).block, {
            reason: "thread_deleted",
            threadId: f.thread,
          });
        }
        assert.deepStrictEqual((yield* stateOf(interrupted)).block, {
          reason: "run_ended",
          threadId: interrupted.thread,
          runId: interrupted.run,
          runStatus: "interrupted",
        });
        assert.deepStrictEqual(yield* rawRow(running), runningBefore);
      }),
    ),
  );

  it.effect("hands on a run that ended between the sweep's read and the tail's start", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const f = fixture("a");
        yield* launch(world, f);
        world.subscribeGate = yield* Deferred.make<void>();
        yield* start;
        yield* drain;
        // The sweep read the run as running, and the tail has not subscribed yet.
        assert.strictEqual(world.projectionReads, 1);
        assert.isFalse(yield* Deferred.isDone(harness.tailSubscribed));
        assert.deepStrictEqual((yield* stateOf(f)).awaiting, {
          type: "run",
          threadId: f.thread,
          runId: f.run,
        });

        world.projections.set(f.thread, {
          deleted: false,
          runs: [{ id: f.run, status: "completed" }],
        });
        yield* harness.commit(runUpdated(f.thread, f.run, "completed"));
        yield* Deferred.succeed(world.subscribeGate, undefined);
        yield* drain;

        assert.deepStrictEqual((yield* stateOf(f)).awaiting, awaitingSettle(f));
      }),
    ),
  );

  it.effect("blocks deliveries whose effect the restart lost, without re-running it", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [verifying, launching, waiting, stopped, blocked] = [
          "verifying",
          "launching",
          "queued",
          "stopped",
          "blocked",
        ].map(fixture) as [Fixture, Fixture, Fixture, Fixture, Fixture];
        yield* insert(verifying, awaitingVerify(verifying));
        const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
        yield* runs.append({ deliveryId: verifying.id, stage: "verify" });
        yield* insert(launching, fold({ type: "start" }));
        yield* insert(waiting, queued);
        yield* insert(stopped, stoppedVerified(stopped));
        yield* insert(
          blocked,
          fold({ type: "start" }, launched(blocked), finished(blocked, "failed")),
        );
        const untouched = [waiting, stopped, blocked];
        const before = yield* Effect.forEach(untouched, rawRow);
        yield* TestClock.adjust("1 minute");

        yield* start;
        yield* drain;
        yield* drainWorker;

        const verifyState = yield* stateOf(verifying);
        assert.strictEqual(verifyState.status, "blocked");
        assert.deepStrictEqual(verifyState.block, {
          reason: "effect_failed",
          effect: { id: 3, type: "run_command", stage: "verify" },
          detail: "Factory could not run the verify command: a server restart interrupted it.",
        });
        const [verifyAttempt] = yield* attemptsOf(verifying);
        assert.strictEqual(verifyAttempt?.outcome, "blocked");
        assert.deepStrictEqual((yield* stateOf(launching)).block, {
          reason: "effect_failed",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "worktree", branch: "feature/item", baseRef: "main" },
          },
          detail: "Factory could not launch the author thread: a server restart interrupted it.",
        });
        assert.strictEqual(world.verifyCalls, 0);
        assert.strictEqual(world.launchCalls, 0);
        assert.deepStrictEqual(yield* Effect.forEach(untouched, rawRow), before);
      }),
    ),
  );

  it.effect("leaves an effect this server queued to finish", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const f = fixture("a");
        world.launchGate = yield* Deferred.make<void>();
        world.launches.set(f.id, { threadId: f.thread, runId: f.run });
        yield* insert(f, queued);
        const worker = yield* FactoryWorker.FactoryWorker;
        yield* worker.step(f.id, { type: "start" });

        yield* start;
        yield* drain;
        const during = yield* stateOf(f);
        assert.strictEqual(during.status, "running");
        assert.strictEqual(during.awaiting?.type, "effect");

        yield* Deferred.succeed(world.launchGate, undefined);
        yield* worker.drain;
        assert.deepStrictEqual((yield* stateOf(f)).awaiting, {
          type: "run",
          threadId: f.thread,
          runId: f.run,
        });
      }),
    ),
  );
});

describe("FactoryReactor failures", () => {
  it.effect("logs a failed step and goes on to the next event", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [first, second] = [fixture("first"), fixture("second")];
        yield* launch(world, first);
        yield* launch(world, second);
        yield* listen(harness);
        world.unreadable.add(first.id);

        yield* harness.commit(runUpdated(first.thread, first.run, "completed"));
        yield* harness.commit(runUpdated(second.thread, second.run, "completed"));
        yield* drain;
        world.unreadable.delete(first.id);

        assert.deepStrictEqual(world.warnings, ["factory thread event skipped"]);
        assert.deepStrictEqual((yield* stateOf(second)).awaiting, awaitingSettle(second));
        assert.deepStrictEqual((yield* stateOf(first)).awaiting, {
          type: "run",
          threadId: first.thread,
          runId: first.run,
        });
      }),
    ),
  );
});
