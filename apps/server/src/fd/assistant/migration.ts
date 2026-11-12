import * as Migrator from "effect/sql/Migrator";
import { migration as multirepoMigration } from "../multirepo/index.ts";
import dispatchMigration from "./dispatchMigration.ts";
import ideasMigration from "./ideasMigration.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork core migration 2: the assistant's durable portfolio. Rows are keyed by environment-local
 * project id; the store keeps the latest brief, every revision with previous values, and
 * each assignment's lifecycle. Existing tables are untouched.
 */
const portfolioMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fd_assistant_project_briefs (
      project_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      priority_rank INTEGER,
      priority_reason TEXT,
      open_questions_json TEXT NOT NULL,
      execution_authorized INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fd_assistant_brief_revisions (
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      changes_json TEXT NOT NULL,
      reason TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (project_id, revision)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fd_assistant_assignments (
      assignment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      executor TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      state TEXT NOT NULL,
      worker_refs_json TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS fd_assistant_assignments_project_idx
    ON fd_assistant_assignments (project_id, created_at)
  `;
});

export default portfolioMigration;

/**
 * The fork's own ledger for schema it adds to core tables. These migrations were once recorded
 * in core's `effect_sql_migrations` at ids 63-66, which upstream later took; the core migrator
 * skips every id up to the highest recorded one, so sharing that ledger would skip upstream's
 * schema. Ids here are independent of core ids and must only ever be appended.
 */
export const FORK_CORE_MIGRATIONS_TABLE = "fd_core_migrations";

export const forkCoreMigrationEntries = [
  [1, "ProjectRepositories", multirepoMigration],
  [2, "AssistantPortfolio", portfolioMigration],
  [3, "AssistantDispatches", dispatchMigration],
  [4, "AssistantIdeas", ideasMigration],
] as const;

const forkCoreNames: ReadonlyArray<string> = forkCoreMigrationEntries.map(([, name]) => name);
const latestForkCoreId = Math.max(...forkCoreMigrationEntries.map(([id]) => id));

const tableExists = Effect.fn("AssistantMigration.tableExists")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
  return rows.length > 0;
});

/**
 * Run before core migrations: moves fork rows out of the core ledger into the fork ledger so
 * upstream's migrations at those ids run. The unpublished build that recorded only
 * AssistantPortfolio at 63 gets the repository-membership schema it never ran.
 */
export const releaseForkCoreLedger = Effect.fn("releaseForkCoreLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* tableExists("effect_sql_migrations"))) return;
      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id >= 63 AND name IN ${sql.in([...forkCoreNames])}`;
      if (rows.length === 0) return;
      const createdAt = new Map(rows.map((row) => [row.name, row.created_at]));
      const portfolioAt = createdAt.get("AssistantPortfolio");
      if (portfolioAt !== undefined && !createdAt.has("ProjectRepositories")) {
        yield* multirepoMigration;
        createdAt.set("ProjectRepositories", portfolioAt);
      }
      const recorded = forkCoreMigrationEntries.filter(([, name]) => createdAt.has(name));
      if (recorded.some(([id], index) => id !== index + 1)) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot move fork migrations out of the core ledger: recorded ${[...createdAt.keys()].join(", ")} is not an ordered prefix of ${forkCoreNames.join(", ")}.`,
        });
      }
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_CORE_MIGRATIONS_TABLE)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      for (const [id, name] of recorded) {
        yield* sql`INSERT INTO ${sql(FORK_CORE_MIGRATIONS_TABLE)} (migration_id, name, created_at)
          VALUES (${id}, ${name}, ${createdAt.get(name) ?? null})`;
      }
      yield* sql`DELETE FROM effect_sql_migrations
        WHERE migration_id >= 63 AND name IN ${sql.in([...forkCoreNames])}`;
    }),
  );
});

/** Whether the fork ledger still has migrations to run. */
export const hasPendingForkCoreMigrations = Effect.fn("hasPendingForkCoreMigrations")(function* () {
  if (!(yield* tableExists(FORK_CORE_MIGRATIONS_TABLE))) return true;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly latestId: number | null }>`
      SELECT MAX(migration_id) AS latestId FROM ${sql(FORK_CORE_MIGRATIONS_TABLE)}
    `;
  return (rows[0]?.latestId ?? 0) < latestForkCoreId;
});

const run = Migrator.make({});

/** Run after core migrations, which own the tables these extend. */
export const runForkCoreMigrations = Effect.fn("runForkCoreMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* tableExists(FORK_CORE_MIGRATIONS_TABLE)) {
    const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(FORK_CORE_MIGRATIONS_TABLE)}
    `;
    const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
    const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
    const skipped = forkCoreMigrationEntries.flatMap(([id, name]) => {
      if (id > latestRecordedId) return [];
      const recordedName = recordedNames.get(id);
      return recordedName === name
        ? []
        : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
    });
    if (skipped.length > 0) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `This database's fork migration history would skip required schema migrations: ${skipped.join(", ")}. It was written by a different build; report this history so an upgrade path can be added.`,
      });
    }
  }
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkCoreMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FORK_CORE_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork core migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
