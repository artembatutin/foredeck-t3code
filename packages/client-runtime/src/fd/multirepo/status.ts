import type {
  ProjectRepository,
  RepositoryTarget,
  VcsStatusStreamEvent,
  VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export interface RepositoryStatusInput {
  readonly repositories: readonly ProjectRepository[];
  readonly target: RepositoryTarget;
}

/** Take one passive local snapshot per checkout, closing each stream immediately. */
export function loadRepositoryStatuses<E, R>(
  input: RepositoryStatusInput,
  subscribe: (input: VcsStatusSubscriptionInput) => Stream.Stream<VcsStatusStreamEvent, E, R>,
) {
  return Effect.forEach(
    input.repositories,
    (repository) =>
      subscribe({
        cwd: repository.rootPath,
        repositoryTarget: { ...input.target, repositoryId: repository.id },
        includeRemote: false,
      }).pipe(
        Stream.filter((event) => event._tag !== "remoteUpdated"),
        Stream.runHead,
        Effect.map((event) =>
          Option.isSome(event)
            ? {
                repository,
                status: {
                  branch: event.value.local.refName,
                  files: event.value.local.workingTree.files.length,
                  insertions: event.value.local.workingTree.insertions,
                  deletions: event.value.local.workingTree.deletions,
                },
                error: null,
              }
            : { repository, status: null, error: "Repository status is unavailable." },
        ),
        Effect.catch((error) =>
          Effect.succeed({
            repository,
            status: null,
            error: error instanceof Error ? error.message : "Repository status is unavailable.",
          }),
        ),
      ),
    { concurrency: 2 },
  );
}
