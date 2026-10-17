import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { selectRepositoryCheckpoints } from "./checkpointSelection.ts";

/** All repository groups use the same recorded turn, including unavailable siblings. */
export function repositoryHistoryGroups(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId | null,
) {
  const toTurnCount =
    runId === null
      ? projection.checkpoints
          .filter(
            (checkpoint) =>
              (projection.thread.workspaceBinding?.repositories.length ?? 0) > 1 ||
              (checkpoint.status === "ready" &&
                projection.runs.some(
                  (run) => run.id === checkpoint.runId && run.status === "completed",
                )),
          )
          .reduce((maximum, checkpoint) => Math.max(maximum, checkpoint.appRunOrdinal ?? 0), 0)
      : (projection.runs.find((run) => run.id === runId)?.ordinal ??
        projection.checkpoints.find((checkpoint) => checkpoint.runId === runId)?.appRunOrdinal ??
        0);
  return {
    toTurnCount,
    groups: (projection.thread.workspaceBinding?.repositories ?? []).map((repository) => {
      const checkpoints = selectRepositoryCheckpoints(projection, repository.id);
      const snapshot = (runId === null ? projection.checkpoints : checkpoints).find(
        (checkpoint) =>
          checkpoint.appRunOrdinal === toTurnCount &&
          projection.checkpointScopes.some(
            (scope) => scope.id === checkpoint.scopeId && scope.repository?.id === repository.id,
          ),
      );
      const baselineReady = projection.checkpoints.some(
        (checkpoint) =>
          checkpoint.ordinalWithinScope === 0 &&
          checkpoint.status === "ready" &&
          projection.checkpointScopes.some(
            (scope) => scope.id === checkpoint.scopeId && scope.repository?.id === repository.id,
          ),
      );
      const available = snapshot?.status === "ready" && (runId !== null || baselineReady);
      const incomplete = checkpoints.some(
        (checkpoint) =>
          checkpoint.appRunOrdinal !== null &&
          checkpoint.appRunOrdinal <= toTurnCount &&
          checkpoint.status !== "ready",
      );
      return {
        repository,
        available,
        message: !available
          ? "Snapshot unavailable"
          : runId === null
            ? incomplete
              ? "Combined diff available; some turn snapshots are unavailable"
              : "Combined conversation diff"
            : snapshot.filesAvailable === false
              ? "File list unavailable"
              : `${snapshot.files.length} changed ${snapshot.files.length === 1 ? "file" : "files"}`,
        files: available && runId !== null ? snapshot.files : [],
      };
    }),
  };
}
