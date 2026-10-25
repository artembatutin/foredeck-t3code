import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryPlan, type FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
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
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  type FactoryDeliveryState,
  type FactoryEvent,
  type FactoryWorkspace,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * A parent's children across server processes. Each `boot` is one process, its reactor, worker
 * and service over the real engine and stores on the test's in-memory SQLite; threads are faked,
 * and every run they report is still going. The tests seed what an earlier process left: a
 * child's start, approval or cancel stored, and its parent never told. Nothing sleeps: each boot
 * drains its sweep and what it set off.
 */

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const parentId = FactoryDeliveryId.make("delivery-parent");
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const defaultWorktree = "/worktrees/fd-parent";
const branch = "work/fd-parent";
/** Where the planner's launch created the parent's branch. */
const branchStart = "a".repeat(40);
/** The commit the first task was approved for. */
const firstApproved = "c".repeat(40);
/** The worktree's HEAD as a launch reads it, which a child's assigned baseline outranks. */
const launchHead = "f".repeat(40);

const plan = Schema.decodeUnknownSync(FactoryPlan)({
  tasks: ["export-csv", "export-header", "export-totals"].map((id) => ({
    id,
    title: `Task ${id}`,
    kind: "feature",
    summary: "Change the export.",
    acceptance: ["The export changes."],
    testPlan: [{ criterion: 1, check: "Export a table.", paths: [] }],
    likelyPaths: ["src/export.ts"],
    risk: "normal",
  })),
});
const taskIds = plan.tasks.map(({ id }) => id) as unknown as readonly [
  FactoryTaskId,
  FactoryTaskId,
  FactoryTaskId,
];
const children = taskIds.map((taskId) => FactoryChildren.childDeliveryId(parentId, taskId)) as [
  FactoryDeliveryId,
  FactoryDeliveryId,
  FactoryDeliveryId,
];
const [first, second, third] = children;

/** What the fakes saw. */
interface World {
  /** Every thread launch the worker asked for. */
  readonly launches: Array<{
    readonly deliveryId: FactoryDeliveryId;
    readonly role: string;
    readonly workspace: FactoryWorkspace;
  }>;
  /** Every run or thread a cancelled delivery asked to stop. */
  readonly interrupts: Array<{
    readonly deliveryId: FactoryDeliveryId;
    readonly threadId: ThreadId;
    readonly runId?: RunId;
  }>;
}

/** The thread and first run a delivery's launch effect makes here. */
const launched = (deliveryId: FactoryDeliveryId, effectId: number) => ({
  threadId: ThreadId.make(`thread-${deliveryId}-${effectId}`),
  runId: RunId.make(`run-${deliveryId}-${effectId}`),
});

/** Launches report a thread whose first run goes on; every thread is there. */
const fakeThreads = (world: World) =>
  Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
    launchThread: (delivery, effect) =>
      Effect.sync(() => {
        world.launches.push({
          deliveryId: delivery.deliveryId,
          role: effect.role,
          workspace: effect.workspace,
        });
        return {
          ...launched(delivery.deliveryId, effect.id),
          worktreePath: delivery.state.worktreePath,
          baseline: launchHead,
        };
      }),
    threadState: () => Effect.succeed("present" as const),
    runEnded: () => Effect.succeedNone,
    interruptRun: (delivery, run) =>
      Effect.sync(() => void world.interrupts.push({ deliveryId: delivery.deliveryId, ...run })),
  });

/** An empty event log, and every run a delivery awaits still going. */
const fakeOrchestration = Layer.mergeAll(
  Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () => Effect.succeed(0),
    stream: () => Stream.empty,
  }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter?: { readonly runIds?: ReadonlyArray<RunId> },
    ) =>
      Effect.succeed({
        thread: { id: threadId, deletedAt: null },
        runs: (filter?.runIds ?? []).map((id) => ({ id, status: "running" })),
      })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
  }),
);

/** What outlives a server process: the database, git and the fakes. */
const baseLayer = (world: World) =>
  Layer.mergeAll(
    fakeThreads(world),
    fakeOrchestration,
    Layer.mock(WorkService.WorkService)({}),
    Layer.mock(FactoryChildren.FactoryChildren)({}),
    Layer.mock(FactoryPlanning.FactoryPlanning)({}),
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
    Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void }),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  ).pipe(
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-child-boot-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** One server process: its own reactor, service and worker. */
const serverLayer = FactoryReactor.layer.pipe(
  Layer.provideMerge(FactoryService.layer),
  Layer.provideMerge(FactoryWorker.layer),
  Layer.provideMerge(FactorySettings.layer),
);

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = { launches: [], interrupts: [] };
  return body(world).pipe(Effect.provide(baseLayer(world)), Effect.scoped);
};

const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);

/**
 * Runs `body` in a new server process over the test's database, after its boot sweep, and drains
 * what it set off before the process ends.
 */
const boot = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start;
    yield* reactor.drain;
    yield* drain;
    const result = yield* body;
    yield* drain;
    return result;
  }).pipe(Effect.scoped, Effect.provide(serverLayer));

/** A server process that only runs its boot sweep and what that set off. */
const sweep = boot(Effect.void);

const service = FactoryService.FactoryService;

const fold = (state: FactoryDeliveryState, events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/**
 * A parent whose plan its owner approved and whose children exist, awaiting the start of the
 * first (effect 3), on `worktreePath`.
 */
const awaitingFirstStart = (worktreePath = defaultWorktree) =>
  fold(queuedDeliveryState({ kind: "parent", branch, baseRef: "HEAD" }), [
    { type: "start" },
    {
      type: "thread.launched",
      effectId: 1,
      threadId: planner,
      runId: planRun,
      worktreePath,
      baseline: branchStart,
    },
    {
      type: "plan.submitted",
      round: 1,
      threadId: planner,
      runId: planRun,
      judgment: {
        type: "accepted",
        plan: { ...plan, source: "mcp", evidencePath: "/t3/userdata/fd-factory/plan.json" },
      },
    },
    { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
    { type: "plan.approved" },
    { type: "children.created", effectId: 2, children },
  ]);
const startedFirst: FactoryEvent = { type: "child.started", effectId: 3 };

const queuedChild = (worktreePath = defaultWorktree) =>
  queuedDeliveryState({ kind: "child", branch, baseRef: "HEAD", worktreePath });
/** A child its parent started from `baseline`, whose author's first run goes on. */
const runningChild = (deliveryId: FactoryDeliveryId, baseline: string) =>
  fold(queuedChild(), [
    { type: "start", baseline },
    {
      type: "thread.launched",
      effectId: 1,
      ...launched(deliveryId, 1),
      worktreePath: defaultWorktree,
      baseline: launchHead,
    },
  ]);
const approvedChild = (baseline: string): FactoryDeliveryState => ({
  ...queuedChild(),
  status: "approved",
  stage: "record",
  baseline,
});

/**
 * Stores the parent and its tasks, the first approved for `firstApproved` when `approved`, and
 * each child in the state given.
 */
const seed = (input: {
  readonly parent: FactoryDeliveryState;
  readonly children: readonly [FactoryDeliveryState, FactoryDeliveryState, FactoryDeliveryState];
  readonly firstTaskApproved: boolean;
}) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const tasks = yield* FactoryTaskStore.FactoryTaskStore;
    const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
    const itemRef = (itemId: string) => ({ sourceId, itemId: WorkItemId.make(itemId) });
    yield* deliveries.insert({
      deliveryId: parentId,
      projectId,
      itemRef: itemRef("fd-parent"),
      state: input.parent,
    });
    if (input.parent.status !== "cancelled") {
      yield* stageRuns.append({ deliveryId: parentId, stage: "author" });
    }
    for (const [index, task] of plan.tasks.entries()) {
      yield* tasks.insert({ deliveryId: parentId, taskId: task.id, plan: task });
      yield* tasks.setChildItem({
        deliveryId: parentId,
        taskId: task.id,
        itemId: WorkItemId.make(`fd-child-${index + 1}`),
      });
    }
    if (input.firstTaskApproved) {
      yield* tasks.setLastReviewedSha({
        deliveryId: parentId,
        taskId: taskIds[0],
        sha: firstApproved,
      });
    }
    for (const [index, state] of input.children.entries()) {
      const deliveryId = children[index]!;
      yield* deliveries.insert({
        deliveryId,
        projectId,
        itemRef: itemRef(`fd-child-${index + 1}`),
        parentId,
        state,
      });
      if (state.awaiting?.type === "run") {
        yield* stageRuns.append({
          deliveryId,
          stage: "author",
          threadId: state.awaiting.threadId,
          runId: state.awaiting.runId,
        });
      }
    }
  });

const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(deliveryId)).pipe(
    Effect.map((delivery) => Option.getOrThrow(delivery).state),
  );

/** Every Factory row exactly as SQLite holds it. */
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    deliveries: yield* sql`SELECT * FROM fd_factory_deliveries ORDER BY delivery_id`,
    tasks: yield* sql`SELECT * FROM fd_factory_tasks ORDER BY delivery_id, position`,
    attempts: yield* sql`SELECT * FROM fd_factory_stage_runs ORDER BY delivery_id, attempt`,
  };
});

/** The second child's author launch, on the parent's worktree. */
const secondLaunch = {
  deliveryId: second,
  role: "author",
  workspace: { type: "existing_worktree", worktreePath: defaultWorktree },
} as const;

/** The second child, started from the commit the first task was approved for. */
const assertSecondStarted = Effect.gen(function* () {
  const parent = yield* stateOf(parentId);
  assert.strictEqual(parent.status, "running");
  assert.deepStrictEqual(parent.approvedChildren, [first]);
  assert.deepStrictEqual(parent.awaiting, { type: "child", deliveryId: second });
  const started = yield* stateOf(second);
  assert.strictEqual(started.status, "running");
  assert.strictEqual(started.baseline, firstApproved);
  assert.deepStrictEqual(started.awaiting, { type: "run", ...launched(second, 1) });
  assert.strictEqual((yield* stateOf(third)).status, "queued");
});

describe("a parent's child approval across restarts", () => {
  it.effect("hands on an approval stored after the start, once, starting the next child once", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seed({
          parent: fold(awaitingFirstStart(), [startedFirst]),
          children: [approvedChild(branchStart), queuedChild(), queuedChild()],
          firstTaskApproved: true,
        });
        const firstBefore = yield* stateOf(first);

        yield* sweep;
        yield* assertSecondStarted;
        assert.deepStrictEqual(world.launches, [secondLaunch]);
        assert.deepStrictEqual(yield* stateOf(first), firstBefore);

        // The next server finds nothing to hand on and starts nothing more.
        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
        assert.deepStrictEqual(world.launches, [secondLaunch]);
      }),
    ),
  );

  it.effect("takes a child's start stored before its parent heard of it, then its approval", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // The first child started, ran and was approved; the server stopped before its parent
        // stored the start's result, so the parent still awaits the start.
        yield* seed({
          parent: awaitingFirstStart(),
          children: [approvedChild(branchStart), queuedChild(), queuedChild()],
          firstTaskApproved: true,
        });

        yield* sweep;
        yield* assertSecondStarted;
        assert.deepStrictEqual(world.launches, [secondLaunch]);
        assert.isNull((yield* stateOf(parentId)).block);

        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
        assert.deepStrictEqual(world.launches, [secondLaunch]);
      }),
    ),
  );

  it.effect("takes a running child's stored start, and waits for that child", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seed({
          parent: awaitingFirstStart(),
          children: [runningChild(first, branchStart), queuedChild(), queuedChild()],
          firstTaskApproved: false,
        });

        yield* sweep;
        const parent = yield* stateOf(parentId);
        assert.strictEqual(parent.status, "running");
        assert.deepStrictEqual(parent.awaiting, { type: "child", deliveryId: first });
        assert.deepStrictEqual(parent.approvedChildren, []);
        assert.deepStrictEqual(world.launches, []);

        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );

  it.effect("blocks a parent whose child's start the restart lost before it was stored", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seed({
          parent: awaitingFirstStart(),
          children: [queuedChild(), queuedChild(), queuedChild()],
          firstTaskApproved: false,
        });

        yield* sweep;
        const blocked = yield* stateOf(parentId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, {
          reason: "effect_failed",
          effect: { id: 3, type: "start_child", child: first },
          detail: "Factory could not start the child delivery: a server restart interrupted it.",
        });
        assert.strictEqual((yield* stateOf(first)).status, "queued");
        assert.deepStrictEqual(world.launches, []);
      }),
    ),
  );

  it.effect("takes an approval stored before the parent heard of the child's start, live", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // The parent blocked on its first child's start while the child went on to approval.
        yield* seed({
          parent: fold(awaitingFirstStart(), [
            { type: "effect.failed", effectId: 3, detail: "Factory could not start it." },
          ]),
          children: [approvedChild(branchStart), queuedChild(), queuedChild()],
          firstTaskApproved: true,
        });

        // Resumed, it issues that start again, finds the child approved, and goes on.
        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));
        yield* assertSecondStarted;
        assert.deepStrictEqual(world.launches, [secondLaunch]);

        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );
});

/** A repository whose branch a worktree created, with commits on it since. */
const legacyCheckout = (options: { readonly reflog: boolean }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
        driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
      ).pipe(Effect.map((result) => result.stdout.trim()));
    const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
    const commit = (cwd: string, subject: string) =>
      git(cwd, [
        ...identity,
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        subject,
      ]);
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-legacy-" });
    const root = path.join(parent, "alpha");
    const worktreePath = path.join(parent, "worktree");
    yield* fileSystem.makeDirectory(root);
    yield* git(root, ["init", "-b", "main"]);
    yield* commit(root, "chore: initial commit");
    const start = yield* git(root, ["rev-parse", "HEAD"]);
    yield* git(root, [
      ...(options.reflog ? [] : ["-c", "core.logAllRefUpdates=false"]),
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ]);
    // Committed on the branch while the plan waited at the gate.
    yield* commit(worktreePath, "docs: note the CSV format");
    const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);
    return { worktreePath, start, head };
  });

/**
 * A parent an earlier server stored without its branch start, blocked where it could not start
 * its first child yet, its children queued on `worktreePath`.
 */
const legacyParent = (worktreePath: string): FactoryDeliveryState => ({
  ...fold(awaitingFirstStart(worktreePath), [
    {
      type: "effect.failed",
      effectId: 3,
      detail: "Factory could not start the child delivery (FactoryChildStartUnsupportedError).",
    },
  ]),
  baseline: null,
});

describe("a parent stored before its branch start was recorded", () => {
  it.effect("starts its first child where its branch started, and records it", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const checkout = yield* legacyCheckout({ reflog: true });
        assert.notStrictEqual(checkout.head, checkout.start);
        const queued = queuedChild(checkout.worktreePath);
        yield* seed({
          parent: legacyParent(checkout.worktreePath),
          children: [queued, queued, queued],
          firstTaskApproved: false,
        });

        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));

        // Not the HEAD the child found: the commit made on the branch since is the child's to
        // settle and review.
        const child = yield* stateOf(first);
        assert.strictEqual(child.status, "running");
        assert.strictEqual(child.baseline, checkout.start);
        const parent = yield* stateOf(parentId);
        assert.strictEqual(parent.baseline, checkout.start);
        assert.deepStrictEqual(parent.awaiting, { type: "child", deliveryId: first });
        assert.deepStrictEqual(world.launches, [
          {
            deliveryId: first,
            role: "author",
            workspace: { type: "existing_worktree", worktreePath: checkout.worktreePath },
          },
        ]);
      }),
    ),
  );

  it.effect("refuses to start its first child when its branch's reflog lost the start", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const checkout = yield* legacyCheckout({ reflog: false });
        const queued = queuedChild(checkout.worktreePath);
        yield* seed({
          parent: legacyParent(checkout.worktreePath),
          children: [queued, queued, queued],
          firstTaskApproved: false,
        });

        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));

        const parent = yield* stateOf(parentId);
        assert.strictEqual(parent.status, "blocked");
        assert.deepStrictEqual(parent.block, {
          reason: "effect_failed",
          effect: { id: 4, type: "start_child", child: first },
          detail: "Factory could not start the child delivery (FactoryChildStartError).",
        });
        assert.isNull(parent.baseline);
        // Nothing started: no child took the worktree's HEAD for where the branch started.
        assert.deepStrictEqual(yield* stateOf(first), queued);
        assert.deepStrictEqual(world.launches, []);
      }),
    ),
  );
});

describe("a cancellation a restart cut short", () => {
  it.effect("cancels the unfinished children of a cancelled parent, stopping their runs", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // The parent's cancel was stored; its children's were not.
        const waiting = fold(awaitingFirstStart(), [
          startedFirst,
          { type: "child.approved", deliveryId: first },
          { type: "child.started", effectId: 4 },
        ]);
        yield* seed({
          parent: advance(waiting, { type: "cancel" }).delivery,
          children: [
            approvedChild(branchStart),
            runningChild(second, firstApproved),
            queuedChild(),
          ],
          firstTaskApproved: true,
        });
        const approved = yield* stateOf(first);

        yield* sweep;

        assert.strictEqual((yield* stateOf(parentId)).status, "cancelled");
        assert.deepStrictEqual(yield* stateOf(first), approved);
        for (const childId of [second, third]) {
          const child = yield* stateOf(childId);
          assert.strictEqual(child.status, "cancelled");
          assert.isNull(child.awaiting);
        }
        // The running child's author was asked to stop its run; nothing was launched.
        assert.deepStrictEqual(world.interrupts, [{ deliveryId: second, ...launched(second, 1) }]);
        assert.deepStrictEqual(world.launches, []);

        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
        assert.strictEqual(world.interrupts.length, 1);
      }),
    ),
  );

  it.effect("cancels the parent and siblings of a child cancelled on its own", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // The second child's cancel was stored; its parent's was not.
        const running = runningChild(second, firstApproved);
        yield* seed({
          parent: fold(awaitingFirstStart(), [
            startedFirst,
            { type: "child.approved", deliveryId: first },
            { type: "child.started", effectId: 4 },
          ]),
          children: [
            approvedChild(branchStart),
            advance(running, { type: "cancel" }).delivery,
            queuedChild(),
          ],
          firstTaskApproved: true,
        });
        const approved = yield* stateOf(first);

        yield* sweep;

        const parent = yield* stateOf(parentId);
        assert.strictEqual(parent.status, "cancelled");
        assert.isNull(parent.awaiting);
        assert.strictEqual((yield* stateOf(third)).status, "cancelled");
        assert.strictEqual((yield* stateOf(second)).status, "cancelled");
        assert.deepStrictEqual(yield* stateOf(first), approved);
        // The first task's approval stays.
        const tasks = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
          store.listByDelivery(parentId),
        );
        assert.strictEqual(tasks[0]?.lastReviewedSha, firstApproved);
        // The parent's planner was asked to stop whatever it ran; nothing was launched.
        assert.deepStrictEqual(world.interrupts, [{ deliveryId: parentId, threadId: planner }]);
        assert.deepStrictEqual(world.launches, []);

        const before = yield* rows;
        yield* sweep;
        assert.deepStrictEqual(yield* rows, before);
      }),
    ),
  );
});
