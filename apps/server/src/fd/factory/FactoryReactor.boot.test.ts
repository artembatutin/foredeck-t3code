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
import { FactoryDeliveryId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, type WorkItemRef, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
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
import type {
  FactoryDeliveryState,
  FactoryEvent,
  FactoryTerminalRunStatus,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * The boot sweep over deliveries in every status a previous server could leave behind. The
 * reactor runs over the real worker, engine, stores and git on in-memory SQLite; thread runs come
 * from a fake projection and the tail from a fake event log. Nothing sleeps: each test drains the
 * reactor and the worker.
 */

/** What the fakes report, and what they saw. */
interface World {
  /** Each thread's runs as the projection holds them; a thread missing from it does not exist. */
  readonly projections: Map<
    ThreadId,
    {
      readonly deleted: boolean;
      readonly runs: ReadonlyArray<{
        readonly id: RunId;
        readonly status: OrchestrationV2RunStatus;
      }>;
    }
  >;
  readonly events: Array<OrchestrationV2StoredEvent>;
  /** Thread effects and verify runs the worker asked for; the sweep must re-run none. */
  readonly calls: Array<string>;
}

const at = "2026-10-24T08:00:00.000Z";
const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const branch = "feature/item";
const queued = queuedDeliveryState({ branch, baseRef: "main" });

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T07:00:00.000Z",
  finishedAt: "2026-10-24T07:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};

/** One delivery with its own item and threads. */
interface Fixture {
  readonly id: FactoryDeliveryId;
  readonly item: WorkItemRef;
  readonly author: ThreadId;
  readonly authorRun: RunId;
  readonly reviewer: ThreadId;
  readonly reviewRun: RunId;
}
const fixture = (name: string): Fixture => ({
  id: FactoryDeliveryId.make(`delivery-${name}`),
  item: { sourceId, itemId: WorkItemId.make(`fd-${name}`) },
  author: ThreadId.make(`thread-author-${name}`),
  authorRun: RunId.make(`run-author-${name}`),
  reviewer: ThreadId.make(`thread-reviewer-${name}`),
  reviewRun: RunId.make(`run-review-${name}`),
});

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);
const finished = (
  threadId: ThreadId,
  runId: RunId,
  status: FactoryTerminalRunStatus = "completed",
): FactoryEvent => ({ type: "run.finished", threadId, runId, status });

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), record (5) and the PR (6).
/** Awaiting the author's first run in `worktreePath`, which started at `baseline`. */
const authoring = (f: Fixture, worktreePath = process.cwd(), baseline = "b".repeat(40)) =>
  fold(
    queued,
    { type: "start" },
    {
      type: "thread.launched",
      effectId: 1,
      threadId: f.author,
      runId: f.authorRun,
      worktreePath,
      baseline,
    },
  );
const verifying = (f: Fixture) =>
  fold(authoring(f), finished(f.author, f.authorRun), {
    type: "settle.checked",
    effectId: 2,
    result: { status: "settled" },
  });
/** Awaiting the reviewer's run, which submitted a passing review. */
const reviewed = (f: Fixture) =>
  fold(
    verifying(f),
    { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
    {
      type: "thread.launched",
      effectId: 4,
      threadId: f.reviewer,
      runId: f.reviewRun,
      worktreePath: process.cwd(),
      baseline: receipt.headSha,
    },
    {
      type: "review.submitted",
      round: 1,
      threadId: f.reviewer,
      runId: f.reviewRun,
      judgment: {
        type: "accepted",
        review: {
          source: "mcp",
          summary: {
            headSha: receipt.headSha,
            verdict: "pass",
            blocking: false,
            findings: { high: 0, medium: 0, low: 0 },
            reviewedAt: at,
          },
          evidencePath: "/t3/review-1.json",
        },
      },
    },
  );
const opening = (f: Fixture) =>
  fold(reviewed(f), finished(f.reviewer, f.reviewRun), {
    type: "approval.recorded",
    effectId: 5,
    outcome: { type: "approved", evidencePath: "/t3/approval-item.json" },
  });
const stop: FactoryEvent = { type: "stop" };

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

const fakeThreads = (world: World) =>
  Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
    launchThread: () =>
      Effect.sync(() => world.calls.push("launch")).pipe(Effect.andThen(Effect.never)),
    sendFixCommitTurn: () => Effect.die("fix-commit turn not scripted"),
    runEnded: () => Effect.succeedNone,
    interruptRun: () => Effect.sync(() => void world.calls.push("interrupt")),
  });

const fakeVerify = (world: World) =>
  Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({
    run: () => Effect.sync(() => world.calls.push("verify")).pipe(Effect.andThen(Effect.never)),
  });

/** The event log: replays what was committed after `afterSequence`, then live events. */
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

const fakeProjections = (world: World) =>
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter?: { readonly runIds?: ReadonlyArray<RunId> },
    ) =>
      Effect.suspend(() => {
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

const setup = Effect.gen(function* () {
  const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
  const tailSubscribed = yield* Deferred.make<void>();
  const world: World = { projections: new Map(), events: [], calls: [] };
  const worker = FactoryWorker.layer.pipe(
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(fakeThreads(world)),
    Layer.provide(fakeVerify(world)),
    // No delivery here is reviewed, records an approval or opens its pull request.
    Layer.provide(Layer.mock(FactoryReview.FactoryReview)({})),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPlanning.FactoryPlanning)({})),
    Layer.provide(Layer.mock(FactoryRecord.FactoryRecord)({})),
    Layer.provide(Layer.mock(FactoryPullRequest.FactoryPullRequest)({})),
  );
  const layer = FactoryReactor.layer.pipe(
    Layer.provideMerge(worker),
    Layer.provide(fakeEventSink(world, live, tailSubscribed)),
    Layer.provide(fakeProjections(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-boot-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
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

const withReactor = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* setup;
    return yield* body(harness).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

/** Stores the delivery as a previous server left it, with the stage attempt it had open. */
const seed = (
  f: Fixture,
  state: FactoryDeliveryState,
  attempt?: { readonly threadId: ThreadId; readonly runId: RunId },
) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({ deliveryId: f.id, projectId, itemRef: f.item, state });
    if (state.stage !== null && state.awaiting !== null) {
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
      yield* runs.append({ deliveryId: f.id, stage: state.stage, ...attempt });
    }
  });
const stateOf = (f: Fixture) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(f.id)).pipe(
    Effect.map((delivery) => Option.getOrThrow(delivery).state),
  );
/** The delivery's row and stage attempts exactly as SQLite holds them. */
const rowsOf = (f: Fixture) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${f.id}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${f.id}`,
    };
  });
const attemptsOf = (f: Fixture) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) => runs.listByDelivery(f.id));

/** Starts the reactor and waits until the sweep, and every step and effect it fed, are done. */
const sweep = (harness: Harness) =>
  Effect.gen(function* () {
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start;
    yield* Deferred.await(harness.tailSubscribed);
    yield* reactor.drain;
    yield* Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
  });
const drainAll = Effect.gen(function* () {
  yield* Effect.flatMap(FactoryReactor.FactoryReactor, (reactor) => reactor.drain);
  yield* Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
});

const project = (
  world: World,
  threadId: ThreadId,
  runs: ReadonlyArray<{ readonly id: RunId; readonly status: OrchestrationV2RunStatus }>,
  deleted = false,
) => world.projections.set(threadId, { deleted, runs });

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));
const commit = (cwd: string, subject: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", subject]);

/** A delivery worktree whose author added one conforming commit after the task baseline. */
const settledWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-boot-wt-" });
  yield* git(cwd, ["init", "-b", branch]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* commit(cwd, "chore: root");
  const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* commit(cwd, "feat: add the export button");
  return { cwd, baseline };
});

describe("FactoryReactor boot sweep of stopping deliveries", () => {
  it.effect("stops a delivery whose reviewer run completed while down, as the tail would", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        // Both were stopping in review with an accepted review. One's run completed while no
        // server ran; the other's completes once the tail listens.
        const [down, live] = [fixture("down"), fixture("live")];
        for (const f of [down, live]) {
          yield* seed(f, fold(reviewed(f), stop), { threadId: f.reviewer, runId: f.reviewRun });
        }
        project(world, down.reviewer, [{ id: down.reviewRun, status: "completed" }]);
        project(world, live.reviewer, [{ id: live.reviewRun, status: "running" }]);
        const liveBefore = yield* rowsOf(live);
        yield* TestClock.adjust("1 minute");

        yield* sweep(harness);
        assert.deepStrictEqual(yield* rowsOf(live), liveBefore);

        project(world, live.reviewer, [{ id: live.reviewRun, status: "completed" }]);
        yield* harness.commit(runUpdated(live.reviewer, live.reviewRun, "completed"));
        yield* drainAll;

        for (const f of [down, live]) {
          const state = yield* stateOf(f);
          assert.deepStrictEqual(state, fold(reviewed(f), stop, finished(f.reviewer, f.reviewRun)));
          assert.strictEqual(state.status, "stopped");
          assert.strictEqual(state.checkpoint, "record");
          assert.isNull(state.awaiting);
          assert.deepStrictEqual(
            (yield* attemptsOf(f)).map(({ stage, outcome, evidencePath }) => ({
              stage,
              outcome,
              evidencePath,
            })),
            [{ stage: "review", outcome: "passed", evidencePath: "/t3/review-1.json" }],
          );
        }
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );

  it.effect("takes a stopping author run that completed, then stops at verify once settled", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const f = fixture("author");
        const worktree = yield* settledWorktree;
        yield* seed(f, fold(authoring(f, worktree.cwd, worktree.baseline), stop), {
          threadId: f.author,
          runId: f.authorRun,
        });
        project(world, f.author, [{ id: f.authorRun, status: "completed" }]);

        yield* sweep(harness);

        const state = yield* stateOf(f);
        assert.strictEqual(state.status, "stopped");
        assert.strictEqual(state.checkpoint, "verify");
        assert.strictEqual(state.stage, "author");
        assert.isNull(state.awaiting);
        assert.deepStrictEqual(state.receipts, []);
        // The settle check ran on the real branch; verify did not.
        assert.deepStrictEqual(world.calls, []);
        assert.deepStrictEqual(
          (yield* attemptsOf(f)).map(({ stage, outcome }) => [stage, outcome]),
          [["author", "passed"]],
        );
      }),
    ),
  );

  it.effect("blocks stopping deliveries whose run failed or thread vanished while down", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [failed, deleted, missing, running] = ["failed", "deleted", "missing", "running"].map(
          fixture,
        ) as [Fixture, Fixture, Fixture, Fixture];
        for (const f of [failed, deleted, missing, running]) {
          yield* seed(f, fold(authoring(f), stop), { threadId: f.author, runId: f.authorRun });
        }
        project(world, failed.author, [{ id: failed.authorRun, status: "failed" }]);
        project(world, deleted.author, [{ id: deleted.authorRun, status: "running" }], true);
        project(world, running.author, [{ id: running.authorRun, status: "running" }]);
        const runningBefore = yield* rowsOf(running);
        yield* TestClock.adjust("1 minute");

        yield* sweep(harness);

        // A failure blocks a stopping delivery as it would a running one.
        assert.deepStrictEqual((yield* stateOf(failed)).block, {
          reason: "run_ended",
          threadId: failed.author,
          runId: failed.authorRun,
          runStatus: "failed",
        });
        for (const f of [deleted, missing]) {
          const state = yield* stateOf(f);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(state.block, { reason: "thread_deleted", threadId: f.author });
        }
        assert.deepStrictEqual(yield* rowsOf(running), runningBefore);
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );
});

describe("FactoryReactor boot sweep of lost effects", () => {
  it.effect("blocks every delivery awaiting an effect the restart lost, re-running none", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [settling, verifyingStopped, opened] = ["settling", "verifying", "opening"].map(
          fixture,
        ) as [Fixture, Fixture, Fixture];
        yield* seed(
          settling,
          fold(authoring(settling), stop, finished(settling.author, settling.authorRun)),
        );
        yield* seed(verifyingStopped, fold(verifying(verifyingStopped), stop));
        yield* seed(opened, opening(opened));

        yield* sweep(harness);

        const expected = [
          [
            settling,
            "stopping",
            { id: 2, type: "check_settle", threadId: settling.author, runId: settling.authorRun },
            "check the branch",
          ],
          [
            verifyingStopped,
            "stopping",
            { id: 3, type: "run_command", stage: "verify" },
            "run the verify command",
          ],
          [opened, "approved", { id: 6, type: "open_pr" }, "open the pull request"],
        ] as const;
        for (const [f, before, effect, what] of expected) {
          const state = yield* stateOf(f);
          assert.strictEqual(state.status, "blocked", `${before} ${f.id}`);
          assert.deepStrictEqual(state.block, {
            reason: "effect_failed",
            effect,
            detail: `Factory could not ${what}: a server restart interrupted it.`,
          });
          const [attempt] = yield* attemptsOf(f);
          assert.strictEqual(attempt?.outcome, "blocked");
        }
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );
});

describe("FactoryReactor boot sweep of deliveries awaiting nothing", () => {
  it.effect("leaves queued, stopped, blocked and PR-open rows byte for byte", () =>
    withReactor((harness) =>
      Effect.gen(function* () {
        const { world } = harness;
        const [waiting, stopped, blocked, open] = ["queued", "stopped", "blocked", "open"].map(
          fixture,
        ) as [Fixture, Fixture, Fixture, Fixture];
        yield* seed(waiting, queued);
        yield* seed(
          stopped,
          fold(verifying(stopped), stop, {
            type: "command.finished",
            effectId: 3,
            outcome: { type: "receipt", receipt },
          }),
        );
        yield* seed(
          blocked,
          fold(authoring(blocked), finished(blocked.author, blocked.authorRun, "failed")),
        );
        yield* seed(
          open,
          fold(opening(open), {
            type: "pr.opened",
            effectId: 6,
            pullRequest: {
              number: 7,
              url: "https://github.com/acme/alpha/pull/7",
              headBranch: branch,
            },
          }),
        );
        const untouched = [waiting, stopped, blocked, open];
        // Their threads' runs all ended while no server ran; they still await nothing.
        for (const f of untouched) {
          project(world, f.author, [{ id: f.authorRun, status: "completed" }]);
          project(world, f.reviewer, [{ id: f.reviewRun, status: "completed" }]);
        }
        assert.deepStrictEqual(
          yield* Effect.forEach(untouched, (f) =>
            Effect.map(stateOf(f), (state) => [state.status, state.awaiting]),
          ),
          [
            ["queued", null],
            ["stopped", null],
            ["blocked", null],
            ["pr_open", null],
          ],
        );
        const before = yield* Effect.forEach(untouched, rowsOf);
        yield* TestClock.adjust("1 minute");

        yield* sweep(harness);

        assert.deepStrictEqual(yield* Effect.forEach(untouched, rowsOf), before);
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );
});
