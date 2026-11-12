import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionMaintenance from "../../../orchestration-v2/ProjectionMaintenance.ts";
import { EVENT_LOG_PRUNE_MARK } from "../../../persistence/OrchestrationEventStore.ts";

/**
 * Core's event log pruning, now rather than a day after the head was marked: marks the head anew, ages
 * the mark past the retained history, then prunes every event the projections cover that core
 * does not keep.
 */
export const pruneEventLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = ${EVENT_LOG_PRUNE_MARK}`;
  yield* maintenance.pruneEventStore();
  const aged = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 2 }));
  yield* sql`
    UPDATE orchestration_v2_projection_metadata
    SET updated_at = ${aged}
    WHERE projection_name = ${EVENT_LOG_PRUNE_MARK}
  `;
  return yield* maintenance.pruneEventStore();
});
