import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryDeliveryStatus,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const parentId = FactoryDeliveryId.make("delivery-parent");
const singleId = FactoryDeliveryId.make("delivery-single");
const planner = ThreadId.make("thread-planner");
const author = ThreadId.make("thread-author");
const planRun = RunId.make("run-plan");
const authorRun = RunId.make("run-author");
const worktreePath = "/t3/worktrees/alpha/work-fd-parent";

const task = (id: string): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "high",
});
const children = ["child-a", "child-b"].map((id) => FactoryDeliveryId.make(id));
const [first, second] = children as [FactoryDeliveryId, FactoryDeliveryId];

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const single = fold(
  queuedDeliveryState({ branch: "work/fd-single", baseRef: "HEAD" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath: "/t3/worktrees/alpha/work-fd-single",
    baseline: "b".repeat(40),
  },
);
const atGate = fold(
  queuedDeliveryState({ kind: "parent", branch: "work/fd-parent", baseRef: "HEAD" }),
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
      plan: {
        tasks: [task("export-csv"), task("export-header")],
        source: "mcp",
        evidencePath: "/t3/userdata/fd-factory/delivery-parent/plan.json",
      },
    },
  },
  { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
);
const creating = fold(atGate, { type: "plan.approved" });
/** How a server before the per-child phase left a parent once its children existed. */
const blockedAtChildren: FactoryDeliveryState = {
  ...creating,
  stage: "author",
  status: "blocked",
  awaiting: null,
  children,
  block: { reason: "unsupported_stage", stage: "author" },
};
/** How plan approval stored a child before the child kind existed: a queued single item. */
const queuedLegacyChild = queuedDeliveryState({
  branch: "work/fd-parent",
  baseRef: "HEAD",
  worktreePath,
  risk: "high",
});

/** The state as a server before the per-child phase stored it: without the child approvals. */
const beforeChildPhase = ({ approvedChildren, ...state }: FactoryDeliveryState) => {
  assert.deepStrictEqual(approvedChildren, []);
  return JSON.stringify(state);
};

/** Inserts a row as an earlier server wrote it, with no state of this server's in it. */
const insertRaw = (row: {
  readonly deliveryId: FactoryDeliveryId;
  readonly itemId: string;
  readonly parentId: FactoryDeliveryId | null;
  readonly status: FactoryDeliveryStatus;
  readonly stateJson: string;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO fd_factory_deliveries (
        delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
        created_at, updated_at
      )
      VALUES (
        ${row.deliveryId}, ${projectId}, ${sourceId}, ${row.itemId}, ${row.parentId},
        ${row.status}, ${row.stateJson}, '2026-10-25T10:00:00.000Z', '2026-10-25T10:00:00.000Z'
      )
    `,
  );

const load = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
    store.get(deliveryId).pipe(Effect.map(Option.getOrThrow)),
  );

describe("FactoryDeliveryStore with the per-child phase", () => {
  it.effect.each([
    ["a single item", single],
    ["a parent waiting at the plan gate", atGate],
    ["a parent blocked unsupported at its per-child phase", blockedAtChildren],
  ] as const)("loads %s stored before it unchanged, with no child approved", ([, state]) =>
    Effect.gen(function* () {
      const stored = beforeChildPhase(state);
      assert.notInclude(stored, "approvedChildren");
      yield* insertRaw({
        deliveryId: parentId,
        itemId: "fd-parent",
        parentId: null,
        status: state.status,
        stateJson: stored,
      });
      const loaded = (yield* load(parentId)).state;
      assert.deepStrictEqual(loaded, { ...JSON.parse(stored), approvedChildren: [] });
      // Every earlier field is the one stored, kind included.
      assert.deepStrictEqual(loaded, state);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect(
    "resumes a parent an earlier server blocked at its children by starting the first",
    () =>
      Effect.gen(function* () {
        yield* insertRaw({
          deliveryId: parentId,
          itemId: "fd-parent",
          parentId: null,
          status: "blocked",
          stateJson: beforeChildPhase(blockedAtChildren),
        });
        const loaded = (yield* load(parentId)).state;
        const step = advance(loaded, {
          type: "resume",
          check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null },
        });
        assert.deepStrictEqual(step.effects, [{ id: 3, type: "start_child", child: first }]);
        assert.strictEqual(step.delivery.children, loaded.children);
      }).pipe(Effect.provide(persistence)),
  );

  it.effect("loads a child plan approval stored as a single item as a child", () =>
    Effect.gen(function* () {
      yield* insertRaw({
        deliveryId: parentId,
        itemId: "fd-parent",
        parentId: null,
        status: "blocked",
        stateJson: beforeChildPhase(blockedAtChildren),
      });
      const stored = beforeChildPhase(queuedLegacyChild);
      assert.include(stored, `"kind":"single"`);
      yield* insertRaw({
        deliveryId: first,
        itemId: "fd-child-a",
        parentId,
        status: "queued",
        stateJson: stored,
      });
      const loaded = (yield* load(first)).state;
      assert.deepStrictEqual(loaded, { ...queuedLegacyChild, kind: "child" });
      // A single item without a parent stays one.
      yield* insertRaw({
        deliveryId: singleId,
        itemId: "fd-single",
        parentId: null,
        status: "queued",
        stateJson: stored,
      });
      assert.strictEqual((yield* load(singleId)).state.kind, "single");
    }).pipe(Effect.provide(persistence)),
  );

  const startingFirst = fold(creating, { type: "children.created", effectId: 2, children });
  const onFirst = fold(startingFirst, { type: "child.started", effectId: 3 });
  const stoppedAfterFirst = fold(
    onFirst,
    { type: "stop" },
    { type: "child.approved", deliveryId: first },
  );
  const onSecond = fold(
    onFirst,
    { type: "child.approved", deliveryId: first },
    { type: "child.started", effectId: 4 },
  );
  const afterChildren = fold(onSecond, { type: "child.approved", deliveryId: second });

  it.effect.each([
    ["awaiting its first child's start", startingFirst, "effect", []],
    ["waiting on its first child", onFirst, "child", []],
    ["stopped where its second child would start", stoppedAfterFirst, null, [first]],
    ["waiting on its second child", onSecond, "child", [first]],
    ["verifying its whole branch after its children", afterChildren, "effect", children],
  ] as const)("round-trips a parent %s", ([, state, awaiting, approved]) =>
    Effect.gen(function* () {
      assert.strictEqual(state.awaiting?.type ?? null, awaiting);
      assert.deepStrictEqual(state.approvedChildren, approved);
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const itemRef = { sourceId, itemId: WorkItemId.make("fd-parent") };
      yield* store.insert({ deliveryId: parentId, projectId, itemRef, state: creating });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.update(parentId, state)).state, state);
      assert.deepStrictEqual((yield* load(parentId)).state, state);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("round-trips a child as plan approval now stores it", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({
        deliveryId: parentId,
        projectId,
        itemRef: { sourceId, itemId: WorkItemId.make("fd-parent") },
        state: creating,
      });
      const child = { ...queuedLegacyChild, kind: "child" } as const;
      const inserted = yield* store.insert({
        deliveryId: first,
        projectId,
        itemRef: { sourceId, itemId: WorkItemId.make("fd-child-a") },
        parentId,
        state: child,
      });
      assert.deepStrictEqual(inserted.state, child);
      assert.deepStrictEqual((yield* load(first)).state, child);
    }).pipe(Effect.provide(persistence)),
  );
});
