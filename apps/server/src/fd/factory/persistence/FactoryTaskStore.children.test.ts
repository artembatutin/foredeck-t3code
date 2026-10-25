import { assert, describe, it } from "@effect/vitest";
import { FactoryDeliveryId, FactoryPlanTask, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Work from "../../work-management/index.ts";
import * as FactoryMigrations from "./FactoryMigrations.ts";
import * as FactoryTaskStore from "./FactoryTaskStore.ts";

/** A core-migrated database with Work's tables, and the task store over it, unmigrated. */
const database = FactoryTaskStore.layer.pipe(
  Layer.provideMerge(Work.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const deliveryId = FactoryDeliveryId.make("delivery-parent");
const plan = Schema.decodeSync(FactoryPlanTask)({
  id: "export-csv",
  title: "Export the table as CSV",
  kind: "feature",
  summary: "Add a CSV export.",
  acceptance: ["The export downloads a CSV."],
  testPlan: [{ criterion: 1, check: "Read back the CSV.", paths: ["src/export.test.ts"] }],
  likelyPaths: ["src/export.ts"],
  risk: "high",
});

const ledger = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FactoryMigrations.FACTORY_MIGRATIONS_TABLE)}
    ORDER BY migration_id
  `.pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const))),
);

/** Runs the first `count` Factory migrations only, as a build from before the rest would. */
const migrateThrough = (count: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        FactoryMigrations.factoryMigrationEntries
          .slice(0, count)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
  });

describe("the task store's child items", () => {
  it.effect("are added by an appended migration that a rerun leaves as it is", () =>
    Effect.gen(function* () {
      const manifest = FactoryMigrations.factoryMigrationEntries.map(
        ([id, name]) => [id, name] as const,
      );
      assert.deepStrictEqual(manifest.slice(-2), [
        [7, "FactoryTaskChildItems"],
        [8, "FactoryTaskChildClaims"],
      ]);
      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), manifest);
      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), []);
      assert.deepStrictEqual(yield* ledger, manifest);
    }).pipe(Effect.provide(database)),
  );

  it.effect("migrate a ledger at 6 in order, and its tasks read back with no child item", () =>
    Effect.gen(function* () {
      yield* migrateThrough(6);
      const sql = yield* SqlClient.SqlClient;
      // A parent and its tasks as a build from before child items stored them.
      yield* sql`
        INSERT INTO fd_factory_deliveries (
          delivery_id, project_id, source_id, item_id, parent_id, status, state_json, created_at,
          updated_at
        )
        VALUES (
          ${deliveryId}, 'project-alpha', 'source-1', 'fd-aaaaaa', NULL, 'blocked', '{}',
          '2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z'
        )
      `;
      for (const [position, taskId, planJson] of [
        [1, "item", null],
        [2, plan.id, JSON.stringify(plan)],
      ] as const) {
        yield* sql`
          INSERT INTO fd_factory_tasks (
            delivery_id, task_id, position, plan_json, last_reviewed_sha, created_at, updated_at
          )
          VALUES (
            ${deliveryId}, ${taskId}, ${position}, ${planJson}, NULL,
            '2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z'
          )
        `;
      }

      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), [
        [7, "FactoryTaskChildItems"],
        [8, "FactoryTaskChildClaims"],
      ]);
      const tasks = yield* FactoryTaskStore.FactoryTaskStore;
      const stored = yield* tasks.listByDelivery(deliveryId);
      // The planned task may have had its child begun by that build, so it counts as claimed.
      assert.deepStrictEqual(
        stored.map(({ taskId, position, plan, childItemId, childClaimedAt }) => [
          taskId,
          position,
          plan,
          childItemId,
          childClaimedAt,
        ]),
        [
          [FactoryTaskId.make("item"), 1, null, null, null],
          [plan.id, 2, plan, null, "2026-10-25T08:00:00.000Z"],
        ],
      );

      // A task records its child item; the other keeps none.
      const itemId = WorkItemId.make("fd-bbbbbb");
      const recorded = yield* tasks.setChildItem({ deliveryId, taskId: plan.id, itemId });
      assert.strictEqual(Option.getOrThrow(recorded).childItemId, itemId);
      assert.deepStrictEqual(
        (yield* tasks.listByDelivery(deliveryId)).map(({ childItemId }) => childItemId),
        [null, itemId],
      );
      const unknown = yield* tasks.setChildItem({
        deliveryId,
        taskId: FactoryTaskId.make("missing"),
        itemId,
      });
      assert.isTrue(Option.isNone(unknown));
    }).pipe(Effect.provide(database)),
  );

  it.effect("migrate a ledger at 7 claiming only the planned tasks without a child", () =>
    Effect.gen(function* () {
      yield* migrateThrough(7);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO fd_factory_deliveries (
          delivery_id, project_id, source_id, item_id, parent_id, status, state_json, created_at,
          updated_at
        )
        VALUES (
          ${deliveryId}, 'project-alpha', 'source-1', 'fd-aaaaaa', NULL, 'blocked', '{}',
          '2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z'
        )
      `;
      // A single item's task, a planned task with its child recorded, and one without.
      for (const [position, taskId, planJson, childItemId, updatedAt] of [
        [1, "item", null, null, "2026-10-25T08:00:00.000Z"],
        [2, "recorded", JSON.stringify(plan), "fd-cccccc", "2026-10-25T08:01:00.000Z"],
        [3, plan.id, JSON.stringify(plan), null, "2026-10-25T08:02:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO fd_factory_tasks (
            delivery_id, task_id, position, plan_json, last_reviewed_sha, child_item_id,
            created_at, updated_at
          )
          VALUES (
            ${deliveryId}, ${taskId}, ${position}, ${planJson}, NULL, ${childItemId},
            '2026-10-25T08:00:00.000Z', ${updatedAt}
          )
        `;
      }

      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), [
        [8, "FactoryTaskChildClaims"],
      ]);
      const tasks = yield* FactoryTaskStore.FactoryTaskStore;
      assert.deepStrictEqual(
        (yield* tasks.listByDelivery(deliveryId)).map(({ childClaimedAt }) => childClaimedAt),
        [null, null, "2026-10-25T08:02:00.000Z"],
      );

      // A claim marks an unclaimed task once; a later claim keeps the first.
      const single = FactoryTaskId.make("item");
      const claimed = Option.getOrThrow(yield* tasks.claimChild({ deliveryId, taskId: single }));
      assert.isNotNull(claimed.childClaimedAt);
      const again = Option.getOrThrow(yield* tasks.claimChild({ deliveryId, taskId: single }));
      assert.strictEqual(again.childClaimedAt, claimed.childClaimedAt);
      const kept = Option.getOrThrow(yield* tasks.claimChild({ deliveryId, taskId: plan.id }));
      assert.strictEqual(kept.childClaimedAt, "2026-10-25T08:02:00.000Z");
      assert.isTrue(
        Option.isNone(
          yield* tasks.claimChild({ deliveryId, taskId: FactoryTaskId.make("missing") }),
        ),
      );
    }).pipe(Effect.provide(database)),
  );
});
