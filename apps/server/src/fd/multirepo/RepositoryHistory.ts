import { RepositoryTargetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionCheckpointContext } from "../../orchestration-v2/ProjectionStore.ts";

/** History uses the thread's saved membership, never the project's current settings. */
export const select = Effect.fn("RepositoryHistory.select")(function* (
  projection: ProjectionCheckpointContext,
  repositoryId: string | undefined,
) {
  const repositories = projection.repositories ?? [];
  const multiRepository = repositories.length > 1;
  if (multiRepository && repositoryId === undefined) {
    return yield* new RepositoryTargetError({
      detail: "Select a repository to read this conversation's historical diff.",
    });
  }
  if (
    repositoryId !== undefined &&
    !repositories.some((repository) => repository.id === repositoryId)
  ) {
    return yield* new RepositoryTargetError({
      detail: "This repository is not part of the conversation's saved workspace.",
    });
  }
  return {
    multiRepository,
    scope: multiRepository
      ? projection.checkpointScopes.find((scope) => scope.repositoryId === repositoryId)
      : undefined,
  };
});

/** A stopped multi-repository turn still owns its recorded snapshots. */
export const isReadableRun = (status: string, multiRepository: boolean) =>
  status === "completed" ||
  (multiRepository && (status === "cancelled" || status === "interrupted" || status === "failed"));
