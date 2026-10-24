import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-ceiling");

/** A delivery awaiting its author's first run, started without a ceiling. */
const authoring = advance(
  advance(queuedDeliveryState({ branch: "fd/item-a", baseRef: "HEAD" }), { type: "start" })
    .delivery,
  {
    type: "thread.launched",
    effectId: 1,
    threadId: ThreadId.make("thread-author"),
    runId: RunId.make("run-author"),
    worktreePath: "/worktrees/item-a",
    baseline: "b".repeat(40),
  },
).delivery;

/** Writes `state` as the row's JSON, as a server stored it. */
const insertRow = (state: unknown) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO fd_factory_deliveries (
        delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
        created_at, updated_at
      )
      VALUES (
        ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'running',
        ${JSON.stringify(state)}, '2026-10-24T10:06:00.000Z', '2026-10-24T10:06:00.000Z'
      )
    `,
  );

const storedJson = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly state: string;
    }>`SELECT state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
).pipe(Effect.map(([row]) => JSON.parse(row?.state ?? "{}")));

describe("FactoryDeliveryStore with a runtime mode ceiling", () => {
  it.effect("loads a row stored before ceilings existed, with none, and keeps none", () =>
    Effect.gen(function* () {
      assert.notProperty(authoring, "runtimeModeCeiling");
      yield* insertRow(authoring);
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, authoring);
      assert.notProperty(loaded.state, "runtimeModeCeiling");

      // Stepped and stored again, it still names none: its launches keep the project's default.
      yield* store.update(deliveryId, advance(loaded.state, { type: "stop" }).delivery);
      assert.notProperty(yield* storedJson, "runtimeModeCeiling");
      assert.notProperty(
        Option.getOrThrow(yield* store.get(deliveryId)).state,
        "runtimeModeCeiling",
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "round-trips a delivery started with a %s ceiling",
    (runtimeModeCeiling) =>
      Effect.gen(function* () {
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        const state = queuedDeliveryState({
          branch: "fd/item-a",
          baseRef: "HEAD",
          runtimeModeCeiling,
        });
        yield* store.insert({ deliveryId, projectId, itemRef, state });

        assert.propertyVal(yield* storedJson, "runtimeModeCeiling", runtimeModeCeiling);
        const loaded = Option.getOrThrow(yield* store.get(deliveryId)).state;
        assert.deepStrictEqual(loaded, state);
        // Every later state keeps it: the engine never drops a field it does not change.
        const started = advance(loaded, { type: "start" }).delivery;
        yield* store.update(deliveryId, started);
        assert.strictEqual(
          Option.getOrThrow(yield* store.get(deliveryId)).state.runtimeModeCeiling,
          runtimeModeCeiling,
        );
      }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses a stored ceiling that is no runtime mode rather than dropping it", () =>
    Effect.gen(function* () {
      yield* insertRow({ ...authoring, runtimeModeCeiling: "unrestricted" });
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const error = yield* Effect.flip(store.get(deliveryId));
      assert.strictEqual(error._tag, "FactoryStoreError");
      assert.strictEqual(error.operation, "deliveries.get");
    }).pipe(Effect.provide(persistence)),
  );
});
