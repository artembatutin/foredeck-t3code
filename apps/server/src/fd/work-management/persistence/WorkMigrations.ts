import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Work's own migration ledger. The core migrator skips every id up to the highest one it
 * has recorded, so a fork migration in the core manifest would collide with upstream's next
 * migration. Ids here are independent of core ids.
 *
 * Effect's Migrator compares ids only, never names: it skips every id up to the highest one
 * recorded in this table. Ids must therefore only ever be appended from here on; renumbering
 * or replacing an entry would silently leave an older database on the old schema.
 *
 * A database whose ledger names another migration under one of these ids is refused with a
 * `BadState` migration error instead of being left on the old schema. The scaffold's former
 * entries 1-3 (SourceBindings, SetupActors, SourceCheckouts) are the known case: drop
 * `fd_work_migrations`, `fd_work_project_preferences` and `fd_work_bindings` by hand, preferences
 * first, since foreign keys are on.
 */
export const WORK_MIGRATIONS_TABLE = "fd_work_migrations";

// Each DDL statement is its own query: the sqlite client does not run `;`-joined batches.
const WorkSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A disconnected source keeps its row and id so its thread links survive a reconnect.
  yield* sql`CREATE TABLE fd_work_sources (
    source_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('markdown', 'github', 'jira')),
    identity TEXT NOT NULL,
    label TEXT NOT NULL,
    config_json TEXT NOT NULL,
    secret_name TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'disconnected')),
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disconnected_at TEXT,
    CHECK ((state = 'disconnected') = (disconnected_at IS NOT NULL))
  )`;
  // One live source per identity in a project; tombstones may repeat it.
  yield* sql`CREATE UNIQUE INDEX fd_work_sources_live
    ON fd_work_sources (project_id, kind, identity)
    WHERE state = 'active'`;
  yield* sql`CREATE INDEX fd_work_sources_project ON fd_work_sources (project_id)`;
});

const WorkThreadLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fd_work_thread_links (
    source_id TEXT NOT NULL REFERENCES fd_work_sources (source_id),
    item_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    link_source TEXT NOT NULL CHECK (link_source IN ('started', 'manual', 'agent')),
    snapshot_json TEXT NOT NULL,
    run_json TEXT,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (source_id, item_id, thread_id)
  )`;
  yield* sql`CREATE INDEX fd_work_thread_links_thread ON fd_work_thread_links (thread_id)`;
});

export const workMigrationEntries = [
  [1, "WorkSources", WorkSources],
  [2, "WorkThreadLinks", WorkThreadLinks],
] as const;

const run = Migrator.make({});

/**
 * The migrator keys on migration_id and skips every id up to the highest recorded one, so a
 * ledger written by another build would silently skip this build's migration at a shared id.
 */
const assertWorkMigrationsCanRun = Effect.fn("assertWorkMigrationsCanRun")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${WORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(WORK_MIGRATIONS_TABLE)}
  `;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = workMigrationEntries.flatMap(([id, name]) => {
    if (id > latestRecordedId) return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's Work migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was written by a different build; drop its fd_work_* tables or report this history so an upgrade path can be added.`,
  });
});

/** Applies pending Work migrations on a database whose core migrations already ran. */
export const runWorkMigrations = Effect.fn("runWorkMigrations")(function* () {
  yield* assertWorkMigrationsCanRun();
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        workMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: WORK_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Work migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

/** Provide on top of the core-migrated SQL client; Work stores are built on this layer. */
export const layer = Layer.effectDiscard(runWorkMigrations());
