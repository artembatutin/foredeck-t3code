import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Factory's own migration ledger, migrated after core for the reason Work keeps one: a fork
 * entry in the core manifest would collide with upstream's next migration.
 *
 * Effect's Migrator compares ids only, never names: it skips every id up to the highest one
 * recorded in this table. Ids must therefore only ever be appended; renumbering or replacing an
 * entry would silently leave an older database on the old schema. A database whose ledger names
 * another migration under one of these ids is refused with a `BadState` migration error instead.
 */
export const FACTORY_MIGRATIONS_TABLE = "fd_factory_migrations";

// Each DDL statement is its own query: the sqlite client does not run `;`-joined batches.
// Status, stage and outcome columns are unchecked, so a later value needs no table rebuild.

const FactorySettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fd_factory_settings (
    project_id TEXT PRIMARY KEY NOT NULL,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
});

const FactoryDeliveries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `status` mirrors `state_json`'s status so the index below can see it; the store writes both.
  yield* sql`CREATE TABLE fd_factory_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    parent_id TEXT REFERENCES fd_factory_deliveries (delivery_id),
    status TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // At most one delivery per Work item that is not done or cancelled. A new terminal status
  // needs a new index migration.
  yield* sql`CREATE UNIQUE INDEX fd_factory_deliveries_active_item
    ON fd_factory_deliveries (source_id, item_id)
    WHERE status NOT IN ('done', 'cancelled')`;
});

const FactoryTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fd_factory_tasks (
    delivery_id TEXT NOT NULL REFERENCES fd_factory_deliveries (delivery_id),
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 1),
    plan_json TEXT,
    last_reviewed_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (delivery_id, task_id),
    UNIQUE (delivery_id, position)
  )`;
});

const FactoryStageRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A run is active until it has an outcome.
  yield* sql`CREATE TABLE fd_factory_stage_runs (
    delivery_id TEXT NOT NULL REFERENCES fd_factory_deliveries (delivery_id),
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    thread_id TEXT,
    run_id TEXT,
    outcome TEXT,
    evidence_path TEXT,
    fingerprint TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (delivery_id, stage, attempt),
    CHECK ((outcome IS NULL) = (finished_at IS NULL))
  )`;
  // A thread's terminal run must map to exactly one active stage run.
  yield* sql`CREATE UNIQUE INDEX fd_factory_stage_runs_active_thread
    ON fd_factory_stage_runs (thread_id)
    WHERE finished_at IS NULL`;
});

const FactoryWorkComments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A comment is claimed, setting `attempted_at`, before it is posted.
  yield* sql`CREATE TABLE fd_factory_work_comments (
    delivery_id TEXT NOT NULL REFERENCES fd_factory_deliveries (delivery_id),
    transition INTEGER NOT NULL CHECK (transition >= 1),
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempted_at TEXT,
    PRIMARY KEY (delivery_id, transition)
  )`;
});

const FactoryWorkCommentOutcomes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Set once the post returned. A comment attempted but not finished was left by a process that
  // died mid-post, and is reconciled against its item. Comments attempted before this column were
  // never retried, so they count as finished.
  yield* sql`ALTER TABLE fd_factory_work_comments ADD COLUMN finished_at TEXT`;
  yield* sql`UPDATE fd_factory_work_comments SET finished_at = attempted_at
    WHERE attempted_at IS NOT NULL`;
});

export const factoryMigrationEntries = [
  [1, "FactorySettings", FactorySettings],
  [2, "FactoryDeliveries", FactoryDeliveries],
  [3, "FactoryTasks", FactoryTasks],
  [4, "FactoryStageRuns", FactoryStageRuns],
  [5, "FactoryWorkComments", FactoryWorkComments],
  [6, "FactoryWorkCommentOutcomes", FactoryWorkCommentOutcomes],
] as const;

const run = Migrator.make({});

/**
 * The migrator keys on migration_id and skips every id up to the highest recorded one, so a
 * ledger written by another build would silently skip this build's migration at a shared id.
 */
const assertFactoryMigrationsCanRun = Effect.fn("assertFactoryMigrationsCanRun")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FACTORY_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FACTORY_MIGRATIONS_TABLE)}
  `;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = factoryMigrationEntries.flatMap(([id, name]) => {
    if (id > latestRecordedId) return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's Factory migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was written by a different build; drop its fd_factory_* tables or report this history so an upgrade path can be added.`,
  });
});

/** Applies pending Factory migrations on a database whose core migrations already ran. */
export const runFactoryMigrations = Effect.fn("runFactoryMigrations")(function* () {
  yield* assertFactoryMigrationsCanRun();
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        factoryMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FACTORY_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Factory migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

/** Provide on top of the core-migrated SQL client; Factory stores are built on this layer. */
export const layer = Layer.effectDiscard(runFactoryMigrations());
