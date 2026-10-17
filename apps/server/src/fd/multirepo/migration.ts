import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN repositories_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`CREATE INDEX orchestration_v2_multirepo_threads_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE json_array_length(payload_json, '$.workspaceBinding.repositories') > 1`;
});
