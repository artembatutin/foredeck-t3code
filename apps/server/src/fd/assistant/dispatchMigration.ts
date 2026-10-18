import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fd_assistant_dispatches (
    assignment_id TEXT PRIMARY KEY REFERENCES fd_assistant_assignments(assignment_id),
    payload_json TEXT NOT NULL
  )`;
});
