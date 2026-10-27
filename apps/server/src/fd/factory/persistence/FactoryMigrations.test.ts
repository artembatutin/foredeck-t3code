import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "../../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Work from "../../work-management/index.ts";
import * as Factory from "../index.ts";
import * as FactoryMigrations from "./FactoryMigrations.ts";
import * as FactorySettingsStore from "./FactorySettingsStore.ts";

const factoryManifest = FactoryMigrations.factoryMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });
const coreLedger = ledger("effect_sql_migrations");
const workLedger = ledger("fd_work_migrations");
const factoryLedger = ledger(FactoryMigrations.FACTORY_MIGRATIONS_TABLE);

const schemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;
});

const factoryObjects = Effect.map(schemaObjects, (objects) =>
  objects
    .filter((object) => object.name.startsWith("fd_factory_"))
    .map((object) => [object.type, object.name] as const),
);

/** A core-migrated database that already carries Work's tables and ledger. */
const coreAndWork = Work.layerPersistence.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const alpha = ProjectId.make("project-alpha");
const settings = Schema.decodeUnknownSync(FactoryProjectSettings)({
  verifyCommand: { executable: "vp", args: ["test", "run"] },
});

describe("runFactoryMigrations", () => {
  it.effect("creates the Factory tables, recording them only in Factory's own ledger", () =>
    Effect.gen(function* () {
      const core = yield* coreLedger;
      const work = yield* workLedger;
      assert.deepStrictEqual(core, migrationManifest);
      assert.isAbove(work.length, 0);

      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), factoryManifest);
      assert.deepStrictEqual(yield* factoryLedger, factoryManifest);
      assert.deepStrictEqual(yield* factoryObjects, [
        ["index", "fd_factory_deliveries_active_item"],
        ["index", "fd_factory_stage_runs_active_thread"],
        ["index", "fd_factory_turn_selections_thread"],
        ["table", "fd_factory_deliveries"],
        ["table", "fd_factory_migrations"],
        ["table", "fd_factory_settings"],
        ["table", "fd_factory_stage_runs"],
        ["table", "fd_factory_tasks"],
        ["table", "fd_factory_turn_selections"],
        ["table", "fd_factory_work_comments"],
      ]);
      // The same numeric id names a different migration in each ledger.
      assert.deepStrictEqual(
        core.find(([id]) => id === 1),
        [1, "OrchestrationEvents"],
      );
      assert.deepStrictEqual(yield* coreLedger, core);
      assert.deepStrictEqual(yield* workLedger, work);
    }).pipe(Effect.provide(coreAndWork)),
  );

  it.effect("reruns as a no-op that keeps existing rows", () =>
    Effect.gen(function* () {
      yield* FactoryMigrations.runFactoryMigrations();
      const store = yield* FactorySettingsStore.FactorySettingsStore;
      yield* store.set(alpha, settings);
      const schema = yield* schemaObjects;
      const work = yield* workLedger;

      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), []);
      assert.deepStrictEqual(yield* schemaObjects, schema);
      assert.deepStrictEqual(yield* factoryLedger, factoryManifest);
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
      assert.deepStrictEqual(yield* workLedger, work);
      assert.deepStrictEqual(yield* store.get(alpha), Option.some(settings));
    }).pipe(Effect.provide(FactorySettingsStore.layer.pipe(Layer.provideMerge(coreAndWork)))),
  );
});

describe("Factory migration ledger guard", () => {
  it.effect("refuses a ledger that renamed an id this build already ran", () =>
    Effect.gen(function* () {
      yield* FactoryMigrations.runFactoryMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE ${sql(FactoryMigrations.FACTORY_MIGRATIONS_TABLE)}
        SET name = 'OtherSettings' WHERE migration_id = 1
      `;
      const refused = yield* Effect.flip(FactoryMigrations.runFactoryMigrations());
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "1_FactorySettings (recorded: OtherSettings)");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("refuses another build's ledger instead of skipping its ids", () =>
    Effect.gen(function* () {
      // Another build recorded a different migration under id 1. The migrator alone would skip
      // this build's id 1 and run 2-4 against a database without fd_factory_settings.
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "1_OtherBuildTables": Effect.void }),
        table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
      });

      const refused = yield* Effect.flip(FactoryMigrations.runFactoryMigrations());
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "1_FactorySettings (recorded: OtherBuildTables)");
      assert.deepStrictEqual(yield* factoryLedger, [[1, "OtherBuildTables"]]);
      assert.deepStrictEqual(yield* factoryObjects, [["table", "fd_factory_migrations"]]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("Factory persistence composition", () => {
  it.effect("provides the stores only after core and Factory migrations completed", () =>
    Effect.gen(function* () {
      const store = yield* FactorySettingsStore.FactorySettingsStore;
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
      assert.deepStrictEqual(yield* factoryLedger, factoryManifest);
      assert.deepStrictEqual(yield* store.get(alpha), Option.none());
    }).pipe(
      Effect.provide(
        Factory.layerPersistence.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  );
});
