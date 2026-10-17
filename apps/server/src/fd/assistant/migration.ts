import * as Migrator from "effect/sql/Migrator";
import { migration as multirepoMigration } from "../multirepo/index.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Migration 064: the assistant's durable portfolio. Rows are keyed by environment-local
 * project id; the store keeps the latest brief, every revision with previous values, and
 * each assignment's lifecycle. Existing tables are untouched.
 */
export default Effect.gen(function* () {
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

/** Preserve portfolio rows and their ledger timestamp from the unpublished assistant build. */
export const reconcileAssistantMigration = Effect.fn("reconcileAssistantMigration")(function* (
  throughId?: number,
) {
  if (throughId !== undefined && throughId < 64) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
      if (tables.length === 0) return;
      const history = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 63`;
      if (!history.some((row) => row.migration_id === 63 && row.name === "AssistantPortfolio"))
        return;
      if (history.length !== 1)
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade assistant preview with unexpected later migrations.",
        });
      yield* multirepoMigration;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 64 WHERE migration_id = 63 AND name = 'AssistantPortfolio'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'ProjectRepositories')`;
    }),
  );
});
