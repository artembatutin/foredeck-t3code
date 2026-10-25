import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryPlan,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  type WorkItemSummary,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { type WorkDomainError, WorkService } from "../work-management/index.ts";
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
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import { type FactoryEvent, queuedDeliveryState } from "./pipeline/state.ts";
import { childReference } from "./plan/childItem.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import { toFactoryError } from "./wireError.ts";

/**
 * A parent's plan approval through the real service, worker, engine, child creation and stores on
 * in-memory SQLite, with Work's Markdown source and the threads faked. Each `boot` is one server
 * process over the test's database. Nothing sleeps: each step drains.
 */

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const parentRef = { sourceId, itemId: WorkItemId.make("fd-parent") };
const parentId = FactoryDeliveryId.make("delivery-parent");
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const worktreePath = "/worktrees/fd-parent";

const decodePlan = Schema.decodeUnknownSync(FactoryPlan);
const plan = decodePlan({
  tasks: [
    {
      id: "export-csv",
      title: "Export the table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows.",
      acceptance: ["The export downloads the visible rows."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["src/export.test.ts"] }],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets need column names.",
      acceptance: ["The CSV starts with the column names.", "An empty table exports them."],
      testPlan: [
        { criterion: 1, check: "Read the first line.", paths: ["src/header.test.ts"] },
        { criterion: 2, check: "Export an empty table.", paths: [] },
      ],
      likelyPaths: ["src/header.ts"],
      risk: "high",
    },
    {
      id: "export-footer",
      title: "Sum the numeric columns",
      kind: "feature",
      summary: "Add a totals row.",
      acceptance: ["The last row sums each numeric column."],
      testPlan: [{ criterion: 1, check: "Sum two rows.", paths: ["src/footer.test.ts"] }],
      likelyPaths: ["src/footer.ts"],
      risk: "normal",
    },
  ],
});
const tasks = plan.tasks as readonly [FactoryPlanTask, FactoryPlanTask, FactoryPlanTask];
const limits = { maxFixRounds: 3, maxReviewRounds: 1 };

// Work's own errors are private to Work; this carries the same tag.
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}
const unavailable = (detail: string) =>
  Effect.fail(new FakeWorkUnavailable({ detail }) as unknown as WorkDomainError);

interface FakeItem {
  readonly ref: WorkItemRef;
  readonly title: string;
  readonly body: string;
  readonly parent: WorkItemId | null;
  blockedBy: ReadonlyArray<WorkItemId>;
}

/** The Markdown source as the fake holds it, and how it answers. */
interface World {
  /** Every item of the source, oldest first. */
  readonly items: Array<FakeItem>;
  /** How many creates were asked for, failed or not. */
  creates: number;
  /** The creates that fail before writing anything, by their number from 1. */
  readonly failingCreates: Set<number>;
  /** Every Work call fails once the source holds this many items, as with a disconnected source. */
  disconnectAt: number | null;
  /** Lists say they could not read every file. */
  stale: boolean;
  /** While set, the create with this number writes its item, then hangs until the process ends. */
  stopAfterCreate: { readonly create: number; readonly written: Deferred.Deferred<void> } | null;
  /** While set, the first create waits for this. */
  heldCreate: Hold | null;
  /** Every thread launch Factory asked for. */
  readonly launches: Array<string>;
}

interface Hold {
  readonly waiting: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeHold = Effect.all({ waiting: Deferred.make<void>(), release: Deferred.make<void>() });

const makeWorld = (): World => ({
  items: [],
  creates: 0,
  failingCreates: new Set(),
  disconnectAt: null,
  stale: false,
  stopAfterCreate: null,
  heldCreate: null,
  launches: [],
});

const summaryOf = (item: FakeItem): WorkItemSummary => ({
  ref: item.ref,
  kind: "markdown",
  key: item.ref.itemId,
  title: item.title,
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: null,
  labels: [],
  assignee: null,
  parent: item.parent,
  blockedBy: item.blockedBy,
  url: null,
  updatedAt: null,
  revision: "r1",
  invalid: null,
});

const detailOf = (item: FakeItem): WorkItemDetail => ({
  ...summaryOf(item),
  body: item.body,
  bodyTruncated: false,
  bodyFidelity: "exact",
  comments: [],
  commentsTruncated: false,
  children: [],
  blocking: [],
  links: [],
  transitions: [],
  capabilities: {
    create: true,
    statuses: ["todo", "in_progress", "done", "cancelled"],
    fields: ["title", "body", "parent", "blockedBy"],
    comments: "add",
    transitions: false,
    people: false,
  },
});

/** A Markdown source: lists match title and body loosely, one item per page. */
const fakeWork = (world: World) => {
  const reachable = Effect.suspend(() =>
    world.disconnectAt !== null && world.items.length >= world.disconnectAt
      ? unavailable("This Work source is disconnected.")
      : Effect.void,
  );
  const find = (ref: WorkItemRef) =>
    world.items.find((item) => item.ref.itemId === ref.itemId) ??
    assert.fail(`No item ${ref.itemId}.`);
  return Layer.mock(WorkService.WorkService)({
    listItems: (_actor, query) =>
      reachable.pipe(
        Effect.map(() => {
          const search = query.search?.toLowerCase() ?? "";
          const matches = world.items.filter((item) =>
            `${item.title}\n\n${item.body}`.toLowerCase().includes(search),
          );
          const offset = query.cursor === undefined ? 0 : Number(query.cursor);
          return {
            items: matches.slice(offset, offset + 1).map(summaryOf),
            nextCursor: offset + 1 < matches.length ? String(offset + 1) : null,
            stale: world.stale,
          };
        }),
      ),
    getItem: (_actor, { ref }) => reachable.pipe(Effect.map(() => detailOf(find(ref)))),
    createItem: (_actor, input) =>
      Effect.gen(function* () {
        yield* reachable;
        world.creates += 1;
        const number = world.creates;
        const held = world.heldCreate;
        if (held !== null && number === 1) {
          yield* Deferred.succeed(held.waiting, undefined);
          yield* Deferred.await(held.release);
        }
        if (world.failingCreates.has(number)) {
          return yield* unavailable("The task file could not be written.");
        }
        const item: FakeItem = {
          ref: { sourceId: input.sourceId, itemId: WorkItemId.make(`fd-child-${number}`) },
          title: input.title,
          body: input.body ?? "",
          parent: input.parent ?? null,
          blockedBy: [],
        };
        world.items.push(item);
        const stop = world.stopAfterCreate;
        if (stop !== null && stop.create === number) {
          // The server stops here: the file is written, and nothing after it runs.
          yield* Deferred.succeed(stop.written, undefined);
          return yield* Effect.never;
        }
        return summaryOf(item);
      }),
    updateItem: (_actor, patch) =>
      reachable.pipe(
        Effect.map(() => {
          const item = find(patch.ref);
          if (patch.blockedBy !== undefined) item.blockedBy = patch.blockedBy;
          return summaryOf(item);
        }),
      ),
  });
};

/** The planner thread is there and runs nothing; no thread is launched here. */
const fakeThreads = (world: World) =>
  Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
    launchThread: (_delivery, effect) =>
      Effect.sync(() => world.launches.push(effect.role)).pipe(
        Effect.andThen(Effect.die("No thread is launched here.")),
      ),
    threadState: () => Effect.succeed("present" as const),
    runEnded: () => Effect.succeedNone,
    interruptRun: () => Effect.void,
  });

/**
 * What a boot's reactor reads: an empty event log, and every awaited run still going, so its
 * sweep acts only on a delivery awaiting an effect the previous process lost.
 */
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
    fakeWork(world),
    fakeThreads(world),
    fakeOrchestration,
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
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-children-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** One server process: its own service, worker, child creation and reactor. */
const serverLayer = FactoryReactor.layer.pipe(
  Layer.provideMerge(FactoryService.layer),
  Layer.provideMerge(FactoryWorker.layer),
  Layer.provide(FactoryChildren.layer),
  Layer.provideMerge(FactorySettings.layer),
);

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world = makeWorld();
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

/** Runs `body` in a server process that stops as soon as it returns, draining nothing. */
const stopsAfter = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(serverLayer));

const service = FactoryService.FactoryService;

/** A parent as its planner's completed run left it: waiting at the gate on `plan`. */
const seedAtGate = (planned: FactoryPlan = plan) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) => {
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: planner,
        runId: planRun,
        worktreePath,
        baseline: "b".repeat(40),
      },
      {
        type: "plan.submitted",
        round: 1,
        threadId: planner,
        runId: planRun,
        judgment: {
          type: "accepted",
          plan: { ...planned, source: "mcp", evidencePath: "/t3/userdata/fd-factory/plan.json" },
        },
      },
      { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
    ];
    const state = events.reduce(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({
        kind: "parent",
        branch: "work/fd-parent",
        baseRef: "HEAD",
        limits,
        runtimeModeCeiling: "auto-accept-edits",
      }),
    );
    assert.strictEqual(state.status, "waiting");
    return deliveries.insert({ deliveryId: parentId, projectId, itemRef: parentRef, state });
  });

const parent = Effect.flatMap(service, (factory) => factory.get(parentId)).pipe(
  Effect.map(Option.getOrThrow),
);
const taskRows = Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
  store.listByDelivery(parentId),
);
const childItemIds = Effect.map(taskRows, (rows) => rows.map(({ childItemId }) => childItemId));
const childrenOf = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.list({}),
).pipe(Effect.map((all) => all.filter((delivery) => delivery.parentId === parentId)));
const currentEpoch = Effect.flatMap(service, (factory) =>
  factory.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
);

/** The items as `[title, parent, blockedBy]`. */
const itemsOf = (items: ReadonlyArray<FakeItem>) =>
  items.map(({ title, parent: itemParent, blockedBy }) => [title, itemParent, blockedBy]);

/**
 * The parent once each task's child (`children`, the source's items when not given) exists under
 * it, blocked by the one before: its queued child deliveries are stored, and it blocks where its
 * per-child phase would begin.
 */
const assertChildrenCreated = (world: World, children: ReadonlyArray<FakeItem> = world.items) =>
  Effect.gen(function* () {
    const itemIds = children.map(({ ref }) => ref.itemId);
    assert.deepStrictEqual(itemsOf(children), [
      [tasks[0].title, parentRef.itemId, []],
      [tasks[1].title, parentRef.itemId, itemIds.slice(0, 1)],
      [tasks[2].title, parentRef.itemId, itemIds.slice(1, 2)],
    ]);
    assert.deepStrictEqual(yield* childItemIds, itemIds);

    const snapshot = toFactoryDelivery(yield* parent);
    const childIds = tasks.map(({ id }) => FactoryChildren.childDeliveryId(parentId, id));
    assert.deepStrictEqual(snapshot.childIds, childIds);
    assert.strictEqual(snapshot.status, "blocked");
    assert.deepStrictEqual(snapshot.stage, { name: "author", kind: "agent" });
    assert.strictEqual(snapshot.needsYou, "This server cannot run the author stage.");

    const stored = yield* childrenOf;
    assert.deepStrictEqual(
      stored.map(({ deliveryId }) => deliveryId).toSorted(),
      childIds.toSorted(),
    );
    for (const [index, task] of tasks.entries()) {
      const child = stored.find(({ deliveryId }) => deliveryId === childIds[index]);
      assert.deepStrictEqual(child?.itemRef, { sourceId, itemId: itemIds[index] });
      assert.strictEqual(child?.projectId, projectId);
      assert.deepStrictEqual(
        child?.state,
        queuedDeliveryState({
          branch: "work/fd-parent",
          baseRef: "HEAD",
          worktreePath,
          limits,
          risk: task.risk,
          runtimeModeCeiling: "auto-accept-edits",
        }),
      );
    }
    // Nothing started: no thread was launched for any child.
    assert.deepStrictEqual(world.launches, []);
  });

describe("approving a parent's plan", () => {
  it.effect("freezes it as tasks, then creates the children and their queued deliveries", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        const held = yield* makeHold;
        world.heldCreate = held;
        yield* boot(
          Effect.gen(function* () {
            const factory = yield* service;
            const epoch = yield* currentEpoch;
            const approved = toFactoryDelivery(yield* factory.approvePlan(parentId));
            assert.strictEqual(approved.status, "running");
            assert.deepStrictEqual(approved.stage, { name: "approve_plan", kind: "gate" });
            assert.deepStrictEqual(approved.childIds, []);
            assert.strictEqual(yield* currentEpoch, epoch + 1);

            // Frozen with the approval, before any child exists: one row per task, in order.
            yield* Deferred.await(held.waiting);
            assert.deepStrictEqual(
              (yield* taskRows).map(({ taskId, position, plan: taskPlan, childItemId }) => [
                taskId,
                position,
                taskPlan,
                childItemId,
              ]),
              tasks.map((task, index) => [task.id, index + 1, task, null]),
            );
            yield* Deferred.succeed(held.release, undefined);
          }),
        );
        yield* boot(assertChildrenCreated(world));
        // Each body carries the task, opened by the parent and task's reference.
        for (const [index, item] of world.items.entries()) {
          assert.isTrue(item.body.startsWith(childReference(parentId, tasks[index]!.id)));
          assert.include(item.body, tasks[index]!.summary);
        }
      }),
    ),
  );

  it.effect("refuses every plan action once approved, and approval away from the gate", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        const planning = FactoryDeliveryId.make("delivery-planning");
        // Its planner's run is going.
        const planningEvents: ReadonlyArray<FactoryEvent> = [
          { type: "start" },
          {
            type: "thread.launched",
            effectId: 1,
            threadId: ThreadId.make("thread-planner-other"),
            runId: RunId.make("run-plan-other"),
            worktreePath: "/worktrees/fd-other",
            baseline: "b".repeat(40),
          },
        ];
        yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
          deliveries.insert({
            deliveryId: planning,
            projectId,
            itemRef: { sourceId, itemId: WorkItemId.make("fd-other") },
            state: planningEvents.reduce(
              (current, event) => advance(current, event).delivery,
              queuedDeliveryState({ kind: "parent", branch: "work/fd-other", baseRef: "HEAD" }),
            ),
          }),
        );
        yield* boot(
          Effect.gen(function* () {
            const factory = yield* service;
            yield* factory.approvePlan(parentId);
            yield* drain;
            const before = yield* parent;
            const rows = yield* taskRows;
            const epoch = yield* currentEpoch;
            const actions: ReadonlyArray<
              Effect.Effect<FactoryService.FactoryDeliveryWithRuns, { readonly _tag: string }>
            > = [
              factory.approvePlan(parentId),
              factory.updatePlan({ deliveryId: parentId, plan: { tasks: [tasks[0]] } }),
              factory.replan({ deliveryId: parentId, note: "Split the header task." }),
              factory.rejectPlan(parentId),
            ];
            for (const action of actions) {
              const error = yield* Effect.flip(action);
              assert.strictEqual(error._tag, "FactoryPlanGateRefusedError");
            }
            assert.deepStrictEqual(yield* parent, before);
            assert.deepStrictEqual(yield* taskRows, rows);
            assert.strictEqual(yield* currentEpoch, epoch);

            // A parent still planning is refused alike, and the wire says why.
            const refused = yield* Effect.flip(factory.approvePlan(planning));
            assert.strictEqual(refused._tag, "FactoryPlanGateRefusedError");
            const wire = toFactoryError(refused);
            assert.strictEqual(wire.reason, "refused");
            assert.strictEqual(
              wire.message,
              "Only a delivery waiting at the plan gate can have its plan approved, edited, rejected or replanned; this one is running.",
            );
            const missing = yield* Effect.flip(
              factory.approvePlan(FactoryDeliveryId.make("delivery-missing")),
            );
            assert.strictEqual(missing._tag, "FactoryDeliveryNotFoundError");
            assert.strictEqual(yield* currentEpoch, epoch);
          }),
        );
        assert.strictEqual(world.items.length, 3);
      }),
    ),
  );

  it.effect("refuses a plan whose child item would not fit in Work, until it is shortened", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const criteria = Array.from({ length: 40 }, (_, index) => `${index}: ${"y".repeat(1990)}`);
        const oversized = {
          ...tasks[1],
          summary: "x".repeat(8000),
          acceptance: criteria,
          testPlan: criteria.map((_, index) => ({
            criterion: index + 1,
            check: "Check it.",
            paths: [],
          })),
        };
        yield* seedAtGate(decodePlan({ tasks: [tasks[0], oversized] }));
        yield* boot(
          Effect.gen(function* () {
            const factory = yield* service;
            const before = yield* parent;
            const epoch = yield* currentEpoch;
            const error = yield* Effect.flip(factory.approvePlan(parentId));
            assert.strictEqual(error._tag, "FactoryChildItemTooLongError");
            if (error._tag !== "FactoryChildItemTooLongError") return;
            assert.deepStrictEqual(error.taskIds, [tasks[1].id]);
            assert.strictEqual(toFactoryError(error).reason, "invalid_request");
            assert.deepStrictEqual(yield* parent, before);
            assert.deepStrictEqual(yield* taskRows, []);
            assert.strictEqual(yield* currentEpoch, epoch);

            // The owner shortens the task at the gate, and the plan is approved.
            const shortened = {
              ...oversized,
              acceptance: [criteria[0]!],
              testPlan: [oversized.testPlan[0]!],
            };
            yield* factory.updatePlan({
              deliveryId: parentId,
              plan: { tasks: [tasks[0], shortened] },
            });
            assert.strictEqual((yield* factory.approvePlan(parentId)).state.planApproved, true);
          }),
        );
        assert.deepStrictEqual(
          world.items.map(({ title }) => title),
          [tasks[0].title, tasks[1].title],
        );
      }),
    ),
  );
});

describe("creating a parent's children", () => {
  it.effect("finds the child a stopped server created and never recorded, by its reference", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        const written = yield* Deferred.make<void>();
        world.stopAfterCreate = { create: 2, written };
        // The server stops once the second child's file is written, before it is recorded.
        yield* stopsAfter(
          Effect.gen(function* () {
            yield* Effect.flatMap(service, (factory) => factory.approvePlan(parentId));
            yield* Deferred.await(written);
          }),
        );
        world.stopAfterCreate = null;
        const [first, second] = world.items.map(({ ref }) => ref.itemId) as [
          WorkItemId,
          WorkItemId,
        ];
        assert.strictEqual(world.items.length, 2);
        assert.deepStrictEqual(yield* childItemIds, [first, null, null]);

        // The next process blocks the parent on the lost effect; the owner resumes it.
        yield* boot(
          Effect.gen(function* () {
            const blocked = yield* parent;
            assert.strictEqual(blocked.state.status, "blocked");
            assert.strictEqual(blocked.state.block?.reason, "effect_failed");
            yield* Effect.flatMap(service, (factory) => factory.resume(parentId));
          }),
        );
        yield* boot(assertChildrenCreated(world));
        assert.deepStrictEqual((yield* childItemIds).slice(0, 2), [first, second]);
        assert.strictEqual(world.creates, 3);
      }),
    ),
  );

  it.effect.each([
    {
      name: "a write error on the second create",
      fail: (world: World) => world.failingCreates.add(2),
    },
    {
      name: "the source disconnecting after the first child",
      fail: (world: World) => {
        world.disconnectAt = 1;
      },
    },
  ])("blocks on $name, keeps the first child, and a resume creates the rest once", ({ fail }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        fail(world);
        yield* boot(Effect.flatMap(service, (factory) => factory.approvePlan(parentId)));
        const blocked = yield* boot(parent);
        const reason = "Factory could not create the child items (WorkUnavailable).";
        assert.strictEqual(blocked.state.status, "blocked");
        assert.deepStrictEqual(blocked.state.block, {
          reason: "effect_failed",
          effect: { id: 2, type: "create_children" },
          detail: reason,
        });
        assert.strictEqual(toFactoryDelivery(blocked).needsYou, reason);
        assert.deepStrictEqual(toFactoryDelivery(blocked).childIds, []);
        const [first] = world.items.map(({ ref }) => ref.itemId);
        assert.strictEqual(world.items.length, 1);
        assert.deepStrictEqual(yield* childItemIds, [first, null, null]);
        assert.deepStrictEqual(yield* childrenOf, []);

        // Work recovers; the resume goes on after the recorded child.
        world.failingCreates.clear();
        world.disconnectAt = null;
        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));
        yield* boot(assertChildrenCreated(world));
        assert.strictEqual((yield* childItemIds)[0], first);
      }),
    ),
  );

  it.effect("creates nothing while the source cannot be read whole", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        world.stale = true;
        yield* boot(Effect.flatMap(service, (factory) => factory.approvePlan(parentId)));
        const blocked = yield* boot(parent);
        assert.deepStrictEqual(blocked.state.block, {
          reason: "effect_failed",
          effect: { id: 2, type: "create_children" },
          detail: "Factory could not create the child items (FactoryChildLookupError).",
        });
        assert.strictEqual(world.creates, 0);

        world.stale = false;
        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));
        yield* boot(assertChildrenCreated(world));
      }),
    ),
  );

  it.effect("takes only an item under the parent, and never one of two carrying a reference", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        const carrying = (itemId: string, task: FactoryPlanTask, itemParent: string): FakeItem => ({
          ref: { sourceId, itemId: WorkItemId.make(itemId) },
          title: task.title,
          body: `${childReference(parentId, task.id)}\n\nCopied by hand.\n`,
          parent: WorkItemId.make(itemParent),
          blockedBy: [],
        });
        // The first task's reference under another parent, and the second's twice under this one.
        const elsewhere = carrying("fd-elsewhere-1", tasks[0], "fd-elsewhere");
        const twin = carrying("fd-twin-2", tasks[1], parentRef.itemId);
        world.items.push(elsewhere, carrying("fd-twin-1", tasks[1], parentRef.itemId), twin);

        yield* boot(Effect.flatMap(service, (factory) => factory.approvePlan(parentId)));
        const blocked = yield* boot(parent);
        assert.strictEqual(
          blocked.state.block?.reason === "effect_failed" && blocked.state.block.detail,
          "Factory could not create the child items (FactoryChildLookupError).",
        );
        // The first child was created rather than taken from another parent.
        assert.strictEqual(world.creates, 1);
        const created = world.items.at(-1)!;
        assert.deepStrictEqual(yield* childItemIds, [created.ref.itemId, null, null]);
        assert.deepStrictEqual(elsewhere.blockedBy, []);

        // With one of the two gone, the other is taken for the second task.
        world.items.splice(world.items.indexOf(twin), 1);
        yield* boot(Effect.flatMap(service, (factory) => factory.resume(parentId)));
        const [, taken] = world.items;
        yield* boot(assertChildrenCreated(world, [created, taken!, world.items.at(-1)!]));
        assert.strictEqual(world.creates, 2);
      }),
    ),
  );

  it.effect("queues no child delivery for a parent cancelled while its children are created", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* seedAtGate();
        const held = yield* makeHold;
        world.heldCreate = held;
        yield* boot(
          Effect.gen(function* () {
            const factory = yield* service;
            yield* factory.approvePlan(parentId);
            yield* Deferred.await(held.waiting);
            assert.strictEqual((yield* factory.cancel(parentId)).state.status, "cancelled");
            yield* Deferred.succeed(held.release, undefined);
          }),
        );
        // Work's writes are the server's and go on; the cancelled parent takes none of them.
        assert.strictEqual(world.items.length, 3);
        const cancelled = yield* boot(parent);
        assert.strictEqual(cancelled.state.status, "cancelled");
        assert.deepStrictEqual(cancelled.state.children, []);
        assert.deepStrictEqual(yield* childrenOf, []);
      }),
    ),
  );
});
