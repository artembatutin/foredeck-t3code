import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
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
import * as FactoryAutomaticTurnStore from "./FactoryAutomaticTurnStore.ts";
import * as FactoryMigrations from "./FactoryMigrations.ts";
import * as FactorySettingsStore from "./FactorySettingsStore.ts";
import * as FactoryTurnSelectionStore from "./FactoryTurnSelectionStore.ts";

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
        ["index", "fd_factory_selection_history_thread"],
        ["index", "fd_factory_stage_runs_active_thread"],
        ["index", "fd_factory_stage_runs_thread"],
        ["index", "fd_factory_turn_selections_thread"],
        ["table", "fd_factory_automatic_turns"],
        ["table", "fd_factory_deliveries"],
        ["table", "fd_factory_migrations"],
        ["table", "fd_factory_selection_history"],
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

  it.effect("retires the version-10 trigger without losing its archived owner choices", () =>
    Effect.gen(function* () {
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            FactoryMigrations.factoryMigrationEntries
              .filter(([id]) => id <= 10)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
        table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
      });
      const sql = yield* SqlClient.SqlClient;
      // Represents the trigger installed by the interrupted build. No new build installs it.
      yield* sql`CREATE TRIGGER fd_factory_preserve_selection_history
          BEFORE DELETE ON orchestration_events BEGIN SELECT 1; END`;
      const selection = JSON.stringify({ instanceId: "owner-provider", model: "owner-model" });
      yield* sql`INSERT INTO fd_factory_selection_history
          (sequence, thread_id, command_id, selection_json)
          VALUES (42, 'thread', 'owner-command', ${selection})`;
      const archived = yield* sql`SELECT * FROM fd_factory_selection_history`;
      const schema = yield* schemaObjects;
      const core = yield* coreLedger;
      const work = yield* workLedger;
      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), [
        [11, "FactoryRetireSelectionHistoryTrigger"],
        [12, "FactoryAutomaticTurns"],
      ]);
      assert.deepStrictEqual(
        (yield* schemaObjects).filter(({ name }) => name !== "fd_factory_automatic_turns"),
        schema.filter(({ name }) => name !== "fd_factory_preserve_selection_history"),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM fd_factory_selection_history`, archived);
      const turns = yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore;
      assert.deepStrictEqual(
        yield* turns.legacyHistory({ threadId: ThreadId.make("thread"), throughSequence: 42 }),
        [
          {
            sequence: 42,
            commandId: CommandId.make("owner-command"),
            selection: JSON.parse(selection),
          },
        ],
      );
      assert.deepStrictEqual(yield* coreLedger, core);
      assert.deepStrictEqual(yield* workLedger, work);
      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), []);
    }).pipe(Effect.provide(FactoryTurnSelectionStore.layer.pipe(Layer.provideMerge(coreAndWork)))),
  );

  it.effect(
    "adds selection provenance to a version-9 database without changing saved decisions",
    () =>
      Effect.gen(function* () {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              FactoryMigrations.factoryMigrationEntries
                .filter(([id]) => id <= 9)
                .map(([id, name, migration]) => [`${id}_${name}`, migration]),
            ),
          ),
          table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fd_factory_deliveries
        (delivery_id, project_id, source_id, item_id, status, state_json, created_at, updated_at)
        VALUES ('delivery', 'project', 'source', 'item', 'stopped', '{}', 'before', 'before')`;
        const before = JSON.stringify({
          instanceId: "provider",
          model: "model",
          options: [{ id: "effort", value: "high" }],
        });
        const mechanical = JSON.stringify({
          instanceId: "provider",
          model: "model",
          options: [{ id: "effort", value: "medium" }],
        });
        yield* sql`INSERT INTO fd_factory_turn_selections
        (delivery_id, effect_id, thread_id, before_json, mechanical_json)
        VALUES ('delivery', 3, 'thread', ${before}, ${mechanical})`;
        const saved = yield* sql`SELECT * FROM fd_factory_turn_selections`;
        const core = yield* coreLedger;
        const work = yield* workLedger;
        assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), [
          [10, "FactorySelectionHistory"],
          [11, "FactoryRetireSelectionHistoryTrigger"],
          [12, "FactoryAutomaticTurns"],
        ]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM fd_factory_turn_selections`, saved);
        assert.deepStrictEqual(yield* coreLedger, core);
        assert.deepStrictEqual(yield* workLedger, work);
        assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), []);
      }).pipe(Effect.provide(coreAndWork)),
  );
});

/** Runs Factory's migrations up to `id`, as a build that ended there did. */
const migrateThrough = (id: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        FactoryMigrations.factoryMigrationEntries
          .filter(([entryId]) => entryId <= id)
          .map(([entryId, name, migration]) => [`${entryId}_${name}`, migration]),
      ),
    ),
    table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
  });

/** A delivery row, which an automatic turn's root names. */
const insertDelivery = (deliveryId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO fd_factory_deliveries
      (delivery_id, project_id, source_id, item_id, status, state_json, created_at, updated_at)
      VALUES (${deliveryId}, 'project', 'source', ${`item-${deliveryId}`}, 'running', '{}',
        'before', 'before')`,
  );

const automaticTurnRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`SELECT thread_id, message_id, root_delivery_id, delivery_id, kind, class,
    source_run_id FROM fd_factory_automatic_turns ORDER BY message_id`,
);

describe("Factory migration 12, automatic turns", () => {
  it.effect("is appended to a version-11 ledger, whose ids 1-11 and rows stay as they were", () =>
    Effect.gen(function* () {
      yield* migrateThrough(11);
      const before = yield* factoryLedger;
      assert.deepStrictEqual(before, factoryManifest.slice(0, 11));
      yield* insertDelivery("delivery-root");
      const sql = yield* SqlClient.SqlClient;
      const deliveries = yield* sql`SELECT * FROM fd_factory_deliveries`;

      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), [
        [12, "FactoryAutomaticTurns"],
      ]);
      assert.deepStrictEqual(yield* factoryLedger, [...before, [12, "FactoryAutomaticTurns"]]);
      assert.deepStrictEqual(yield* factoryLedger, factoryManifest);
      assert.deepStrictEqual(yield* sql`SELECT * FROM fd_factory_deliveries`, deliveries);
      assert.deepStrictEqual(yield* automaticTurnRows, []);
      assert.deepStrictEqual(yield* FactoryMigrations.runFactoryMigrations(), []);
    }).pipe(Effect.provide(coreAndWork)),
  );

  it.effect("refuses a kind or class it cannot route and a second row for one turn", () =>
    Effect.gen(function* () {
      yield* FactoryMigrations.runFactoryMigrations();
      yield* insertDelivery("delivery-root");
      const sql = yield* SqlClient.SqlClient;
      const insert = (messageId: string, kind: string, decided: string) => sql`
        INSERT INTO fd_factory_automatic_turns
          (thread_id, message_id, root_delivery_id, delivery_id, kind, class, source_run_id,
            recorded_at)
        VALUES ('thread', ${messageId}, 'delivery-root', NULL, ${kind}, ${decided}, NULL, 'at')`;
      const refusal = <A, E extends { readonly _tag: string }, R>(write: Effect.Effect<A, E, R>) =>
        Effect.flip(write).pipe(Effect.map((error) => error._tag));
      yield* insert("message-1", "background_wake", "unknown");

      assert.strictEqual(
        yield* refusal(insert("message-2", "owner_message", "explicit")),
        "SqlError",
      );
      assert.strictEqual(
        yield* refusal(insert("message-3", "background_wake", "owner")),
        "SqlError",
      );
      assert.strictEqual(
        yield* refusal(insert("message-1", "pull_request_wake", "factory")),
        "SqlError",
      );
      assert.deepStrictEqual(yield* automaticTurnRows, [
        {
          thread_id: "thread",
          message_id: "message-1",
          root_delivery_id: "delivery-root",
          delivery_id: null,
          kind: "background_wake",
          class: "unknown",
          source_run_id: null,
        },
      ]);
    }).pipe(Effect.provide(coreAndWork)),
  );

  it.effect("keeps the first decision recorded on a turn", () =>
    Effect.gen(function* () {
      yield* insertDelivery("delivery-root");
      const store = yield* FactoryAutomaticTurnStore.FactoryAutomaticTurnStore;
      const key = { threadId: ThreadId.make("thread"), messageId: MessageId.make("message-1") };
      const first: FactoryAutomaticTurnStore.FactoryAutomaticTurnDecision = {
        ...key,
        root: FactoryDeliveryId.make("delivery-root"),
        deliveryId: FactoryDeliveryId.make("delivery-root"),
        kind: "usage_limit_resume",
        class: "factory",
        sourceRunId: RunId.make("run-author"),
      };
      assert.deepStrictEqual(yield* store.get(key), Option.none());

      assert.deepStrictEqual(yield* store.record(first), first);
      // Presented again once later runs changed what a decision would read, it keeps its class.
      assert.deepStrictEqual(
        yield* store.record({ ...first, class: "unknown", sourceRunId: null }),
        first,
      );
      assert.deepStrictEqual(yield* store.get(key), Option.some(first));
      assert.strictEqual((yield* automaticTurnRows).length, 1);
    }).pipe(Effect.provide(Factory.layerPersistence.pipe(Layer.provideMerge(coreAndWork)))),
  );
});

describe("Factory migration ledger guard", () => {
  it.effect("refuses a ledger that recorded another migration under id 12", () =>
    Effect.gen(function* () {
      yield* migrateThrough(11);
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "12_OtherTurns": Effect.void }),
        table: FactoryMigrations.FACTORY_MIGRATIONS_TABLE,
      });

      const refused = yield* Effect.flip(FactoryMigrations.runFactoryMigrations());
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "12_FactoryAutomaticTurns (recorded: OtherTurns)");
      assert.notInclude(
        (yield* factoryObjects).map(([, name]) => name),
        "fd_factory_automatic_turns",
      );
    }).pipe(Effect.provide(coreAndWork)),
  );

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
