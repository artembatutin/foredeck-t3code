import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryPlan, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

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
 * The boot sweep of a parent whose child was approved while no server handed the approval on.
 * Each `boot` is one server process, its reactor and worker over the real engine and stores on the
 * test's in-memory SQLite; threads are faked, and every run they report is still going. Nothing
 * sleeps: each boot drains its sweep and what it set off.
 */

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const parentId = FactoryDeliveryId.make("delivery-parent");
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const worktreePath = "/worktrees/fd-parent";
const branch = "work/fd-parent";
/** Where the planner's launch created the parent's branch. */
const branchStart = "a".repeat(40);
/** The commit the first task was approved for. */
const firstApproved = "c".repeat(40);
/** The worktree's HEAD as a launch reads it, which a child's assigned baseline outranks. */
const launchHead = "f".repeat(40);

const plan = Schema.decodeUnknownSync(FactoryPlan)({
  tasks: ["export-csv", "export-header"].map((id) => ({
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
];
const children = taskIds.map((taskId) => FactoryChildren.childDeliveryId(parentId, taskId)) as [
  FactoryDeliveryId,
  FactoryDeliveryId,
];

/** Every thread launch the worker asked for, and the delivery it was for. */
interface World {
  readonly launches: Array<{
    readonly deliveryId: FactoryDeliveryId;
    readonly role: string;
    readonly workspace: FactoryWorkspace;
  }>;
}

/** Launches report a thread whose first run goes on; nothing else is carried out here. */
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
          threadId: ThreadId.make(`thread-${delivery.deliveryId}-${effect.id}`),
          runId: RunId.make(`run-${delivery.deliveryId}-${effect.id}`),
          worktreePath,
          baseline: launchHead,
        };
      }),
    runEnded: () => Effect.succeedNone,
    interruptRun: () => Effect.void,
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
    Layer.mock(FactoryChildren.FactoryChildren)({}),
    Layer.mock(FactoryPlanning.FactoryPlanning)({}),
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
    Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void }),
  ).pipe(
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-child-boot-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** One server process: its own reactor and worker. */
const serverLayer = FactoryReactor.layer.pipe(
  Layer.provideMerge(FactoryWorker.layer),
  Layer.provideMerge(FactorySettings.layer),
);

/** Boots a server process over the test's database and drains its sweep and what it set off. */
const boot = Effect.gen(function* () {
  const reactor = yield* FactoryReactor.FactoryReactor;
  yield* reactor.start;
  yield* reactor.drain;
  yield* Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
}).pipe(Effect.scoped, Effect.provide(serverLayer));

const fold = (state: FactoryDeliveryState, events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/**
 * A parent waiting for its first child, as a server left it: its planner's plan approved, its
 * children created and the first started (effects 2 and 3).
 */
const waitingParent = fold(queuedDeliveryState({ kind: "parent", branch, baseRef: "HEAD" }), [
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
  { type: "child.started", effectId: 3 },
]);

const queuedChild = queuedDeliveryState({ kind: "child", branch, baseRef: "HEAD", worktreePath });

/**
 * Stores the parent, its tasks with the first approved, the first child approved at record and
 * the second queued: the first child's approval committed, and the server stopped before the
 * parent took it.
 */
const seed = Effect.gen(function* () {
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  assert.deepStrictEqual(waitingParent.awaiting, { type: "child", deliveryId: children[0] });
  assert.strictEqual(waitingParent.baseline, branchStart);
  const itemRef = (itemId: string) => ({ sourceId, itemId: WorkItemId.make(itemId) });
  yield* deliveries.insert({
    deliveryId: parentId,
    projectId,
    itemRef: itemRef("fd-parent"),
    state: waitingParent,
  });
  yield* stageRuns.append({ deliveryId: parentId, stage: "author" });
  for (const [index, task] of plan.tasks.entries()) {
    yield* tasks.insert({ deliveryId: parentId, taskId: task.id, plan: task });
    yield* tasks.setChildItem({
      deliveryId: parentId,
      taskId: task.id,
      itemId: WorkItemId.make(`fd-child-${index + 1}`),
    });
  }
  yield* tasks.setLastReviewedSha({ deliveryId: parentId, taskId: taskIds[0], sha: firstApproved });
  yield* deliveries.insert({
    deliveryId: children[0],
    projectId,
    itemRef: itemRef("fd-child-1"),
    parentId,
    state: { ...queuedChild, status: "approved", stage: "record", baseline: branchStart },
  });
  yield* deliveries.insert({
    deliveryId: children[1],
    projectId,
    itemRef: itemRef("fd-child-2"),
    parentId,
    state: queuedChild,
  });
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

describe("the boot sweep of a parent waiting for its child", () => {
  it.effect(
    "hands on an approval the restart kept from it once, starting the next child once",
    () =>
      Effect.gen(function* () {
        const world: World = { launches: [] };
        yield* Effect.gen(function* () {
          yield* seed;
          const firstBefore = yield* stateOf(children[0]);

          yield* boot;

          // The parent took the first child's approval and started the second, from the commit
          // the first task was approved for, on the parent's worktree.
          const parent = yield* stateOf(parentId);
          assert.strictEqual(parent.status, "running");
          assert.deepStrictEqual(parent.approvedChildren, [children[0]]);
          assert.deepStrictEqual(parent.awaiting, { type: "child", deliveryId: children[1] });
          assert.deepStrictEqual(world.launches, [
            {
              deliveryId: children[1],
              role: "author",
              workspace: { type: "existing_worktree", worktreePath },
            },
          ]);
          const second = yield* stateOf(children[1]);
          assert.strictEqual(second.status, "running");
          assert.strictEqual(second.stage, "author");
          assert.strictEqual(second.baseline, firstApproved);
          assert.deepStrictEqual(second.awaiting, {
            type: "run",
            threadId: ThreadId.make(`thread-${children[1]}-1`),
            runId: RunId.make(`run-${children[1]}-1`),
          });
          assert.deepStrictEqual(yield* stateOf(children[0]), firstBefore);

          // The next server finds nothing to hand on and starts nothing more.
          const before = yield* rows;
          yield* boot;
          assert.deepStrictEqual(yield* rows, before);
          assert.strictEqual(world.launches.length, 1);
        }).pipe(Effect.provide(baseLayer(world)), Effect.scoped);
      }),
  );
});
