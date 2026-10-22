import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** Read only persisted scopes and snapshot availability, never live project membership. */
export function selectRepositoryCheckpoints(
  projection: OrchestrationV2ThreadProjection,
  repositoryId?: string,
) {
  if ((projection.thread.workspaceBinding?.repositories.length ?? 0) < 2)
    return projection.checkpoints;
  const scopes = new Set(
    projection.checkpointScopes
      .filter((scope) =>
        repositoryId === undefined
          ? scope.kind === "root_run"
          : scope.repository?.id === repositoryId,
      )
      .map((scope) => scope.id),
  );
  return projection.checkpoints
    .filter((checkpoint) => scopes.has(checkpoint.scopeId))
    .map((checkpoint) => {
      const baseline = projection.checkpoints.find(
        (candidate) =>
          candidate.scopeId === checkpoint.scopeId &&
          (checkpoint.appRunOrdinal === 1
            ? candidate.ordinalWithinScope === 0
            : candidate.appRunOrdinal === (checkpoint.appRunOrdinal ?? 0) - 1),
      );
      return checkpoint.status === "ready" &&
        checkpoint.appRunOrdinal !== null &&
        baseline?.status !== "ready"
        ? { ...checkpoint, status: "missing" as const, files: [] }
        : checkpoint;
    });
}
