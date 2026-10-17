import {
  RepositoryTargetError,
  type RepositoryTarget,
  type ThreadWorkspaceBinding,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RepositorySet from "./RepositorySet.ts";

/** Shared by transports and service callers after their ordinary scope checks. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const repositories = yield* RepositorySet.RepositorySet;
  const resolve = Effect.fn("WorkspaceResolver.resolve")(
    function* (target: RepositoryTarget) {
      let binding: ThreadWorkspaceBinding | undefined;
      if (target.type === "thread") {
        binding = (yield* threads.getThread(target.threadId)).workspaceBinding;
      } else {
        const project = yield* projects.get(target.projectId);
        if (Option.isSome(project))
          binding = {
            version: 1,
            defaultCwd: project.value.workspaceRoot,
            repositories: project.value.repositories ?? [],
          };
      }
      if (binding === undefined)
        return yield* new RepositoryTargetError({
          detail:
            "This workspace has no repository binding. Select a configured project repository.",
        });
      // Validate only the selected checkout: a missing sibling must not block inspection or repair.
      return yield* repositories.select(binding, target.repositoryId);
    },
    Effect.mapError((cause) => new RepositoryTargetError({ detail: cause.message, cause })),
  );

  /** A transcript path has an immutable thread context even before it has a file-navigation target. */
  const resolveThreadPath = Effect.fn("WorkspaceResolver.resolveThreadPath")(
    function* (threadId: ThreadId, requestedPath: string) {
      const thread = yield* threads
        .getThread(threadId)
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined) }),
        );
      const binding = thread?.workspaceBinding;
      if (!RepositorySet.isMultiRepo(binding?.repositories) || binding === undefined)
        return undefined;
      const absolute = path.resolve(binding.defaultCwd, requestedPath);
      const repository = binding.repositories.find((entry) => {
        const relative = path.relative(entry.rootPath, absolute);
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      });
      if (!repository)
        return yield* new RepositoryTargetError({
          detail: "This file is outside the conversation's saved repositories.",
        });
      const target = { type: "thread" as const, threadId, repositoryId: repository.id };
      return { repository: yield* resolve(target), target, path: absolute };
    },
    Effect.mapError((cause) => new RepositoryTargetError({ detail: cause.message, cause })),
  );

  const updateClientError = () =>
    new RepositoryTargetError({
      detail: "Update this client to work with multi-repository projects.",
    });
  const assertLegacyCwd = Effect.fn("WorkspaceResolver.assertLegacyCwd")(
    function* (cwd: string) {
      const canonical = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
      const configured = (yield* projects.list()).some(
        (project) =>
          RepositorySet.isMultiRepo(project.repositories) &&
          project.repositories?.some((repository) => {
            const relative = path.relative(repository.rootPath, canonical);
            return (
              relative === "" ||
              (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative))
            );
          }),
      );
      if (configured || (yield* threads.usesMultiRepositoryCheckout(canonical)))
        return yield* updateClientError();
    },
    Effect.mapError((cause) => new RepositoryTargetError({ detail: cause.message, cause })),
  );

  // Connection-local policy only; repository services and Git process pools remain shared.
  const forClient = (supportsRepositories: boolean) => {
    const resolveInput = <
      T extends { readonly cwd: string; readonly repositoryTarget?: RepositoryTarget | undefined },
    >(
      input: T,
    ) =>
      input.repositoryTarget === undefined
        ? (supportsRepositories ? Effect.void : assertLegacyCwd(input.cwd)).pipe(Effect.as(input))
        : resolve(input.repositoryTarget).pipe(
            Effect.flatMap((repository) =>
              input.cwd !== repository.rootPath
                ? Effect.fail(
                    new RepositoryTargetError({
                      detail:
                        "The directory does not match the selected repository. Refresh the workspace and select the repository again.",
                    }),
                  )
                : Effect.succeed({ ...input, cwd: repository.rootPath }),
            ),
          );
    const run = <
      T extends { readonly cwd: string; readonly repositoryTarget?: RepositoryTarget | undefined },
      A,
      E,
      R,
    >(
      input: T,
      use: (resolved: T) => Effect.Effect<A, E, R>,
    ) => resolveInput(input).pipe(Effect.flatMap(use));
    const stream = <
      T extends { readonly cwd: string; readonly repositoryTarget?: RepositoryTarget | undefined },
      A,
      E,
      R,
    >(
      input: T,
      use: (resolved: T) => Stream.Stream<A, E, R>,
    ) => Stream.unwrap(resolveInput(input).pipe(Effect.map(use)));
    /** Terminal launch directories may be below a checkout, but cannot change its authority. */
    const resolveTerminalInput = Effect.fn("WorkspaceResolver.resolveTerminalInput")(
      function* <
        T extends {
          readonly threadId: string;
          readonly cwd?: string | undefined;
          readonly worktreePath?: string | null | undefined;
          readonly repositoryTarget?: RepositoryTarget | undefined;
        },
      >(input: T) {
        if (supportsRepositories && input.cwd === undefined) return input;
        const thread = yield* threads.getThread(ThreadIdSchema.make(input.threadId)).pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
          }),
        );
        if (!supportsRepositories) {
          if (RepositorySet.isMultiRepo(thread?.workspaceBinding?.repositories))
            return yield* updateClientError();
          // A draft has no saved binding, so use its launch directory for compatibility checks.
          if (thread === undefined && input.cwd !== undefined) yield* assertLegacyCwd(input.cwd);
        }
        // Attaching to an existing session without a launch directory cannot retarget it.
        if (input.cwd === undefined) return input;
        const target = input.repositoryTarget;
        if (target === undefined) {
          if (RepositorySet.isMultiRepo(thread?.workspaceBinding?.repositories))
            return yield* new RepositoryTargetError({
              detail: "Select a saved conversation repository before launching a terminal.",
            });
          return input;
        }
        if (
          (target.type === "thread" && target.threadId !== input.threadId) ||
          (thread?.workspaceBinding !== undefined && target.type !== "thread") ||
          (thread !== undefined &&
            target.type === "project" &&
            target.projectId !== thread.projectId)
        )
          return yield* new RepositoryTargetError({
            detail: "The terminal repository does not belong to this conversation.",
          });
        if (input.worktreePath)
          return yield* new RepositoryTargetError({
            detail:
              "A repository terminal uses the existing checkout. Open a separate single-repository worktree conversation to use a worktree.",
          });
        const repository = yield* resolve(target);
        const cwd = yield* fs.realPath(input.cwd);
        const relative = path.relative(repository.rootPath, cwd);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return yield* new RepositoryTargetError({
            detail: "The terminal directory is outside the selected repository.",
          });
        return { ...input, cwd };
      },
      Effect.mapError((cause) => new RepositoryTargetError({ detail: cause.message, cause })),
    );
    return {
      resolve,
      resolveThreadPath,
      resolveInput,
      resolveTerminalInput,
      run,
      stream,
    };
  };
  return { ...forClient(true), forClient };
});
