import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Keep the original brief and every revision as the project's legacy idea. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fd_assistant_spoken_replies (
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (thread_id, run_id)
  ) WITHOUT ROWID`;
  yield* sql`ALTER TABLE fd_assistant_project_briefs RENAME TO fd_assistant_legacy_briefs`;
  yield* sql`CREATE TABLE fd_assistant_project_briefs (
    project_id TEXT NOT NULL, idea_id TEXT NOT NULL, goal TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL, constraints_json TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '[]', priority_rank INTEGER, priority_reason TEXT,
    open_questions_json TEXT NOT NULL, execution_authorized INTEGER NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, idea_id)
  )`;
  yield* sql`INSERT INTO fd_assistant_project_briefs
    SELECT project_id, 'legacy', goal, acceptance_criteria_json, constraints_json, '[]',
      priority_rank, priority_reason, open_questions_json, execution_authorized, revision, updated_at
    FROM fd_assistant_legacy_briefs`;
  yield* sql`DROP TABLE fd_assistant_legacy_briefs`;
  yield* sql`ALTER TABLE fd_assistant_brief_revisions RENAME TO fd_assistant_legacy_revisions`;
  yield* sql`CREATE TABLE fd_assistant_brief_revisions (
    project_id TEXT NOT NULL, idea_id TEXT NOT NULL, revision INTEGER NOT NULL,
    changes_json TEXT NOT NULL, reason TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY (project_id, idea_id, revision)
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO fd_assistant_brief_revisions
    SELECT project_id, 'legacy', revision, changes_json, reason, recorded_at
    FROM fd_assistant_legacy_revisions`;
  yield* sql`DROP TABLE fd_assistant_legacy_revisions`;
  yield* sql`ALTER TABLE fd_assistant_assignments ADD COLUMN idea_id TEXT NOT NULL DEFAULT 'legacy'`;
});
