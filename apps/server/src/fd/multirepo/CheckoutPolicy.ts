import type { RepositoryTarget, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { isMultiRepo, RepositorySetError } from "./RepositorySet.ts";

/** Legacy cwd-only worktree entry points must still honor configured membership. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = (cwd: string) =>
    fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  return {
    assertWorktree: Effect.fn("CheckoutPolicy.assertWorktree")(function* (
      cwd: string,
      target?: RepositoryTarget,
      threadId?: ThreadId,
    ) {
      const root = yield* canonical(cwd);
      // PR checkout may name a draft or an existing thread separately from its repository target.
      if (threadId !== undefined) {
        const attached = yield* threads.getThread(threadId).pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
          }),
        );
        if (attached !== undefined) {
          if (isMultiRepo(attached.workspaceBinding?.repositories))
            return yield* new RepositorySetError({ reason: "worktree" });
          if (target === undefined) return;
        }
      }
      if (target !== undefined) {
        const thread =
          target.type === "thread" ? yield* threads.getThread(target.threadId) : undefined;
        const project = yield* projects.get(
          target.type === "project" ? target.projectId : thread!.projectId,
        );
        if (Option.isNone(project)) return yield* new RepositorySetError({ reason: "selection" });
        const repositories = thread
          ? thread.workspaceBinding?.repositories
          : project.value.repositories;
        if (isMultiRepo(repositories)) return yield* new RepositorySetError({ reason: "worktree" });
        const repository = repositories?.find(
          (repository) => repository.id === target.repositoryId,
        );
        if (!repository) return yield* new RepositorySetError({ reason: "selection" });
        const relative = path.relative(yield* canonical(repository.rootPath), root);
        if (
          relative !== "" &&
          (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        )
          return yield* new RepositorySetError({ reason: "selection" });
        return;
      }
      const owner = yield* projects.findActiveByWorkspaceRoot(root);
      if (Option.isSome(owner) && isMultiRepo(owner.value.repositories))
        return yield* new RepositorySetError({ reason: "worktree" });
    }),
  };
});
