import {
  type ProjectRepository,
  type ProjectRepositoryInput,
  type ThreadWorkspaceBinding,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

export class RepositorySetError extends Schema.TaggedError<RepositorySetError>()(
  "RepositorySetError",
  {
    reason: Schema.Literals([
      "unavailable",
      "not-git",
      "duplicate",
      "overlap",
      "project-overlap",
      "identity",
      "primary",
      "selection",
      "worktree",
      "rollback",
      "existing-worktrees",
    ]),
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return `Repository is unavailable at ${this.path}. Restore its checkout before continuing.`;
      case "not-git":
        return `No Git checkout exists at ${this.path}.`;
      case "duplicate":
        return "Each repository may appear only once. Aliases and multiple checkouts of the same repository are not independent repositories.";
      case "overlap":
        return "Repository roots must not overlap. A nested repository or submodule cannot also be associated with its parent.";
      case "project-overlap":
        return `Repository ${this.path} is already the workspace of another project. Keep it in that project or move that project before adding it here.`;
      case "identity":
        return "A repository identifier cannot be moved to a different checkout. Remove the association and add a new one.";
      case "primary":
        return "The first repository must contain the project's default working directory.";
      case "selection":
        return "Select a repository that belongs to this workspace. The requested repository is not in its binding.";
      case "worktree":
        return "Multi-repository projects use existing checkouts. Worktree creation, attachment, handoff, and isolated delegation are unavailable.";
      case "existing-worktrees":
        return "Finish or cancel pending worktree setup, and move or delete this project’s worktree threads before adding another repository. Historical worktree records and checkout files are preserved.";
      case "rollback":
        return "Whole-turn undo is unavailable for multi-repository threads. Review each repository's historical diff and revert changes separately.";
    }
  }
}

export const isMultiRepo = (repositories: ReadonlyArray<ProjectRepository> | undefined) =>
  (repositories?.length ?? 0) > 1;

/** Guards depend on configured membership, including temporarily missing checkouts. */
export const assertCheckoutMode = (
  repositories: ReadonlyArray<ProjectRepository> | undefined,
  operation: "worktree" | "rollback",
) =>
  isMultiRepo(repositories)
    ? Effect.fail(new RepositorySetError({ reason: operation }))
    : Effect.void;

export class RepositorySet extends Context.Service<
  RepositorySet,
  {
    readonly assertNoProjectOverlap: (
      repositories: readonly ProjectRepository[],
      otherProjects: readonly { readonly workspaceRoot: string }[],
    ) => Effect.Effect<void, RepositorySetError>;
    readonly normalize: (input: {
      readonly defaultCwd: string;
      readonly repositories: ReadonlyArray<ProjectRepositoryInput>;
      readonly previous?: ReadonlyArray<ProjectRepository>;
    }) => Effect.Effect<ReadonlyArray<ProjectRepository>, RepositorySetError>;
    readonly validate: (
      binding: ThreadWorkspaceBinding,
    ) => Effect.Effect<ThreadWorkspaceBinding, RepositorySetError>;
    readonly select: (
      binding: ThreadWorkspaceBinding,
      repositoryId: string,
    ) => Effect.Effect<ProjectRepository, RepositorySetError>;
  }
>()("t3/fd/multirepo/RepositorySet") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* WorkspacePaths.WorkspacePaths;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const inspect = Effect.fn("RepositorySet.inspect")(function* (rootPath: string) {
    const cwd = yield* workspaces.normalizeWorkspaceRoot(rootPath).pipe(
      Effect.flatMap((root) => fs.realPath(root)),
      Effect.mapError(
        (cause) => new RepositorySetError({ reason: "unavailable", path: rootPath, cause }),
      ),
    );
    const handle = yield* vcs
      .detect({ cwd, requestedKind: "git" })
      .pipe(
        Effect.mapError(
          (cause) => new RepositorySetError({ reason: "unavailable", path: rootPath, cause }),
        ),
      );
    if (handle === null)
      return yield* new RepositorySetError({ reason: "not-git", path: rootPath });
    const canonical = yield* fs
      .realPath(handle.repository.rootPath)
      .pipe(
        Effect.mapError(
          (cause) => new RepositorySetError({ reason: "unavailable", path: rootPath, cause }),
        ),
      );
    const metadata = handle.repository.metadataPath;
    const commonDir =
      metadata === null
        ? null
        : yield* fs
            .realPath(path.resolve(cwd, metadata))
            .pipe(
              Effect.mapError(
                (cause) => new RepositorySetError({ reason: "unavailable", path: rootPath, cause }),
              ),
            );
    return { rootPath: canonical, commonDir };
  });
  const validateRepository = Effect.fn("RepositorySet.validateRepository")(function* (
    repository: ProjectRepository,
  ) {
    const actual = yield* inspect(repository.rootPath);
    // Never follow a moved symlink or fall back to a containing repository.
    if (actual.rootPath !== repository.rootPath)
      return yield* new RepositorySetError({ reason: "identity", path: repository.rootPath });
    return repository;
  });
  return RepositorySet.of({
    assertNoProjectOverlap: Effect.fn("RepositorySet.assertNoProjectOverlap")(
      function* (repositories, otherProjects) {
        for (const project of otherProjects) {
          const root = yield* fs
            .realPath(project.workspaceRoot)
            .pipe(Effect.orElseSucceed(() => path.resolve(project.workspaceRoot)));
          for (const repository of repositories) {
            if (contains(repository.rootPath, root))
              return yield* new RepositorySetError({
                reason: "project-overlap",
                path: repository.rootPath,
              });
          }
        }
      },
    ),
    normalize: Effect.fn("RepositorySet.normalize")(function* (input) {
      // Once configured, keep the primary identity even when removing all additional repositories.
      if (input.repositories.length === 0 && input.previous?.[0] !== undefined)
        return [input.previous[0]];
      const result: ProjectRepository[] = [];
      const commonDirs = new Set<string>();
      for (const requested of input.repositories) {
        const previous = input.previous?.find((repository) => repository.id === requested.id);
        if (
          requested.id !== undefined &&
          (previous === undefined || previous.rootPath !== requested.rootPath)
        ) {
          return yield* new RepositorySetError({ reason: "identity", path: requested.rootPath });
        }
        // Retaining/removing a missing association must be possible. Execution validates it again.
        const inspected =
          previous !== undefined &&
          !(yield* fs.exists(previous.rootPath).pipe(Effect.orElseSucceed(() => false)))
            ? { rootPath: previous.rootPath, commonDir: null }
            : yield* inspect(requested.rootPath);
        if (previous !== undefined && previous.rootPath !== inspected.rootPath) {
          return yield* new RepositorySetError({ reason: "identity", path: requested.rootPath });
        }
        const duplicate =
          result.some((repository) => repository.rootPath === inspected.rootPath) ||
          (inspected.commonDir !== null && commonDirs.has(inspected.commonDir));
        if (duplicate)
          return yield* new RepositorySetError({ reason: "duplicate", path: inspected.rootPath });
        if (
          result.some(
            (repository) =>
              contains(repository.rootPath, inspected.rootPath) ||
              contains(inspected.rootPath, repository.rootPath),
          )
        ) {
          return yield* new RepositorySetError({ reason: "overlap", path: inspected.rootPath });
        }
        const existing = input.previous?.find(
          (repository) => repository.rootPath === inspected.rootPath,
        );
        result.push({
          id: existing?.id ?? (yield* randomUuidV4),
          name: requested.name,
          rootPath: inspected.rootPath,
        });
        if (inspected.commonDir !== null) commonDirs.add(inspected.commonDir);
      }
      if (result[0] !== undefined) {
        const cwd = yield* fs
          .realPath(input.defaultCwd)
          .pipe(Effect.orElseSucceed(() => path.resolve(input.defaultCwd)));
        if (!contains(result[0].rootPath, cwd))
          return yield* new RepositorySetError({ reason: "primary" });
      }
      return result;
    }),
    validate: Effect.fn("RepositorySet.validate")(function* (binding) {
      yield* Effect.forEach(binding.repositories, validateRepository, { concurrency: 2 });
      const cwd = yield* fs
        .realPath(binding.defaultCwd)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositorySetError({ reason: "unavailable", path: binding.defaultCwd, cause }),
          ),
        );
      const primary = binding.repositories[0];
      if (primary === undefined || !contains(primary.rootPath, cwd))
        return yield* new RepositorySetError({ reason: "primary" });
      return binding;
    }),
    select: Effect.fn("RepositorySet.select")(function* (binding, repositoryId) {
      const repository = binding.repositories.find((candidate) => candidate.id === repositoryId);
      if (repository === undefined) return yield* new RepositorySetError({ reason: "selection" });
      return yield* validateRepository(repository);
    }),
  });
});

export const layer = Layer.effect(RepositorySet, make);

export const layerDefault = layer.pipe(
  Layer.provide(Layer.merge(WorkspacePaths.layer, VcsDriverRegistry.layer)),
  Layer.provide(VcsProcess.layer),
);
