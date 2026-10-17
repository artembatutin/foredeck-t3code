import { GitCommandError } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isMultiRepo } from "./RepositorySet.ts";

export interface Mutation {
  readonly cwd: string;
  readonly operation: string;
  readonly changesBranch?: boolean;
}
export interface Coordination {
  readonly withMutation: <A, E, R>(
    input: Mutation,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitCommandError, R>;
}

/** Owned once by GitManager. Internal Git steps run inside their caller's mutation lock. */
export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const canonical = (cwd: string) =>
    fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  const inside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const assertIdle = Effect.fn("CheckoutCoordination.assertIdle")(function* (
    root: string,
    input: Mutation,
    projectRows: Effect.Success<ReturnType<typeof projects.list>>,
  ) {
    const snapshot = yield* threads.getShellSnapshot({ unsettledOnly: true });
    const threadRows = [...snapshot.threads, ...snapshot.archivedThreads];
    for (const thread of threadRows) {
      if (
        thread.activeRunId === null &&
        thread.activityRunStatus == null &&
        (thread.pendingBackgroundTasks?.length ?? 0) === 0
      )
        continue;
      const project = projectRows.find((project) => project.projectId === thread.projectId);
      const roots =
        thread.worktreePath !== null
          ? [thread.worktreePath]
          : thread.workspaceBinding !== undefined
            ? thread.workspaceBinding.repositories.map((repository) => repository.rootPath)
            : project === undefined
              ? []
              : [project.workspaceRoot];
      for (const cwd of roots) {
        if (!inside(root, yield* canonical(cwd))) continue;
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: root,
          detail: `Stop or wait for the active conversation “${thread.title}” before changing or publishing this shared checkout.`,
        });
      }
    }
  });
  const withMutation: Coordination["withMutation"] = (input, effect) =>
    Effect.gen(function* () {
      const repository = yield* git.execute({
        operation: input.operation,
        cwd: input.cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
      });
      const root = yield* canonical(
        repository.exitCode === 0 && repository.stdout.trim() !== ""
          ? repository.stdout.trim()
          : input.cwd,
      );
      const projectRows = yield* projects.list().pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: root,
              detail: "Unable to resolve shared checkouts.",
              cause,
            }),
        ),
      );
      const configured = projectRows.some(
        (project) =>
          isMultiRepo(project.repositories) &&
          project.repositories?.some((repository) => repository.rootPath === root),
      );
      const shared =
        configured ||
        (yield* threads.usesMultiRepositoryCheckout(root).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: input.operation,
                command: "git",
                cwd: root,
                detail: "Unable to resolve saved checkouts.",
                cause,
              }),
          ),
        ));
      if (!shared) return yield* effect;
      return yield* locks.withLock(
        root,
        Effect.gen(function* () {
          if (input.changesBranch)
            yield* assertIdle(root, input, projectRows).pipe(
              Effect.mapError((cause) =>
                cause._tag === "GitCommandError"
                  ? cause
                  : new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: root,
                      detail: "Unable to check active conversations before changing this checkout.",
                      cause,
                    }),
              ),
            );
          return yield* effect;
        }),
      );
    });
  return { withMutation } satisfies Coordination;
});
