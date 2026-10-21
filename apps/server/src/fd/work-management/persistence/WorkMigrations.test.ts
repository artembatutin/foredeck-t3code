import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as WorkMigrations from "./WorkMigrations.ts";
import * as WorkSourceStore from "./WorkSourceStore.ts";

const workManifest = WorkMigrations.workMigrationEntries.map(([id, name]) => [id, name] as const);

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });
const coreLedger = ledger("effect_sql_migrations");
const workLedger = ledger(WorkMigrations.WORK_MIGRATIONS_TABLE);

const schemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;
});

const isWorkObject = (name: string) => name.startsWith("fd_work_");

const workTables = Effect.map(schemaObjects, (objects) =>
  objects
    .filter((object) => object.type === "table" && isWorkObject(object.name))
    .map((object) => object.name),
);

// The highest core id before the assistant's fork migrations.
const beforeAssistantMigrations =
  Math.min(
    ...migrationManifest.filter(([, name]) => name.startsWith("Assistant")).map(([id]) => id),
  ) - 1;

/** The server's persistence composition on an in-memory database. */
const productionPersistence = WorkSourceStore.layer.pipe(
  Layer.provide(WorkMigrations.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

describe("runWorkMigrations", () => {
  it.effect("records Work migrations only in its own ledger and reruns as a no-op", () =>
    Effect.gen(function* () {
      const core = yield* coreLedger;
      assert.deepStrictEqual(core, migrationManifest);

      assert.deepStrictEqual(yield* WorkMigrations.runWorkMigrations(), workManifest);
      assert.deepStrictEqual(yield* workLedger, workManifest);
      assert.deepStrictEqual(yield* coreLedger, core);
      // The same numeric id names a different migration in each ledger.
      assert.deepStrictEqual(
        core.find(([id]) => id === 1),
        [1, "OrchestrationEvents"],
      );
      assert.deepStrictEqual(yield* workTables, [
        "fd_work_migrations",
        "fd_work_sources",
        "fd_work_thread_links",
      ]);

      const schema = yield* schemaObjects;
      assert.deepStrictEqual(yield* WorkMigrations.runWorkMigrations(), []);
      assert.deepStrictEqual(yield* schemaObjects, schema);
      assert.deepStrictEqual(yield* workLedger, workManifest);
      assert.deepStrictEqual(yield* coreLedger, core);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("keeps both ledgers independent while core upgrades", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: beforeAssistantMigrations });
      const olderCore = migrationManifest.filter(([id]) => id <= beforeAssistantMigrations);
      assert.deepStrictEqual(yield* coreLedger, olderCore);

      assert.deepStrictEqual(yield* WorkMigrations.runWorkMigrations(), workManifest);
      assert.deepStrictEqual(yield* coreLedger, olderCore);

      // Core's highest-id ordering and V2 guard see only core's ledger.
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > beforeAssistantMigrations),
      );
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
      assert.deepStrictEqual(yield* workLedger, workManifest);
      assert.deepStrictEqual(yield* WorkMigrations.runWorkMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("Work persistence composition", () => {
  it.effect("provides the store only after core and Work migrations completed", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
      assert.deepStrictEqual(yield* workLedger, workManifest);
      assert.deepStrictEqual(yield* store.list({ includeDisconnected: true }), []);
    }).pipe(Effect.provide(productionPersistence)),
  );

  it.effect("adds only empty Work objects to the core schema", () =>
    Effect.gen(function* () {
      const coreOnly = yield* schemaObjects.pipe(Effect.provide(SqlitePersistence.layerMemory));
      const withWork = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const counts = yield* sql<{ readonly sources: number; readonly links: number }>`
          SELECT
            (SELECT COUNT(*) FROM fd_work_sources) AS sources,
            (SELECT COUNT(*) FROM fd_work_thread_links) AS links
        `;
        assert.deepStrictEqual(counts, [{ sources: 0, links: 0 }]);
        assert.deepStrictEqual(yield* coreLedger, migrationManifest);
        return yield* schemaObjects;
      }).pipe(Effect.provide(productionPersistence));

      assert.deepStrictEqual(
        withWork.filter((object) => !isWorkObject(object.name)),
        coreOnly,
      );
      assert.deepStrictEqual(
        withWork.filter((object) => isWorkObject(object.name)).map((object) => object.name),
        [
          "fd_work_sources_live",
          "fd_work_sources_project",
          "fd_work_thread_links_thread",
          "fd_work_migrations",
          "fd_work_sources",
          "fd_work_thread_links",
        ],
      );
    }),
  );
});

describe("Work migration ledger guard", () => {
  it.effect("refuses a ledger that recorded another build's migration under a shared id", () =>
    Effect.gen(function* () {
      yield* WorkMigrations.runWorkMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE ${sql(WorkMigrations.WORK_MIGRATIONS_TABLE)}
        SET name = 'SourceBindings' WHERE migration_id = 1
      `;
      const refused = yield* Effect.flip(WorkMigrations.runWorkMigrations());
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "1_WorkSources (recorded: SourceBindings)");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
