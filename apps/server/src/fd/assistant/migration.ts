import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Migration 063: the assistant's durable portfolio. Rows are keyed by environment-local
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
