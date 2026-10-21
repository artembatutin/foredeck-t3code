import { WorkProjectDirectory } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Why a directory cannot be a Work source root.
 *
 * `alias`: the directory or a parent is a symbolic link, or differs from the entry on disk
 * only by case or Unicode normalization. Checkpoint protection matches literal paths, so an
 * alias would leave the real directory unprotected.
 *
 * `nested_repository`: the directory or a parent below the project root holds its own
 * `.git`, as a nested clone, linked worktree or submodule does. Its files would belong to
 * that repository, outside the project's Git status, tracked-file checks and checkpoint
 * protection.
 */
const WorkSourceRootProblem = Schema.Literals([
  "project_root",
  "git_metadata",
  "outside_project",
  "not_normalized",
  "alias",
  "not_directory",
  "nested_repository",
  "overlaps_source",
]);
type WorkSourceRootProblem = typeof WorkSourceRootProblem.Type;

const problemMessages: Record<WorkSourceRootProblem, string> = {
  project_root: "Choose a dedicated directory inside the project, not the project root.",
  git_metadata: "Choose a directory outside Git metadata.",
  outside_project: "Choose a directory inside the project.",
  not_normalized: "Use a project-relative path with forward slashes and no '.' segments.",
  alias: "The directory or one of its parents is a symbolic link or differently named alias.",
  not_directory: "The selected path exists but is not a directory.",
  nested_repository:
    "The directory is inside another Git repository; choose one in the project's own repository.",
  overlaps_source: "The directory contains or lies inside another Work source of this project.",
};

export class WorkSourceRootRejected extends Schema.TaggedError<WorkSourceRootRejected>()(
  "WorkSourceRootRejected",
  { problem: WorkSourceRootProblem },
) {
  override get message(): string {
    return problemMessages[this.problem];
  }
}

export class WorkSourceFileError extends Schema.TaggedError<WorkSourceFileError>()(
  "WorkSourceFileError",
  {
    operation: Schema.Literals([
      "resolve_root",
      "create_directory",
      "read_manifest",
      "write_manifest",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Work source file operation '${this.operation}' failed.`;
  }
}

const isProjectDirectory = Schema.is(WorkProjectDirectory);

/**
 * Accepts only the canonical project-relative form a binding stores, classifying everything
 * else. Pure: nothing is resolved against a filesystem.
 */
export const parseSourceDirectory = (
  input: string,
): Result.Result<WorkProjectDirectory, WorkSourceRootProblem> => {
  if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:/.test(input)) {
    return Result.fail("outside_project");
  }
  const segments: Array<string> = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return Result.fail("outside_project");
  }
  if (segments.length === 0) return Result.fail("project_root");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return Result.fail("git_metadata");
  }
  const normalized = segments.join("/");
  return normalized === input && isProjectDirectory(normalized)
    ? Result.succeed(normalized)
    : Result.fail("not_normalized");
};

/**
 * Whether two project-relative directories are equal or nested. Compared case-insensitively:
 * on a case-insensitive volume `Work` and `work` are one directory, and refusing the rare
 * distinct pair on a case-sensitive volume is the safe mistake.
 */
export const directoriesOverlap = (left: string, right: string) => {
  const [a, b] = [left.toLowerCase(), right.toLowerCase()];
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export interface WorkSourceRoute {
  /** The project's canonical root on this environment. */
  readonly projectRoot: string;
  /** The source directory beneath it. */
  readonly path: string;
  /** False when the directory or a parent does not exist yet. */
  readonly exists: boolean;
}

const fileFailure = (operation: WorkSourceFileError["operation"]) => ({
  PlatformError: (cause: PlatformError.PlatformError) =>
    Effect.fail(new WorkSourceFileError({ operation, cause })),
});

/**
 * Resolves a source directory against the project's canonical root without changing
 * anything. Every existing component must be a real directory named exactly as on disk, so
 * a symbolic link or alias anywhere below the root is refused, and none may hold its own
 * `.git`. A missing tail is allowed. `authorize` runs before every filesystem call, so a
 * caller's grant revoked meanwhile stops the next read.
 */
export const resolveSourceRoute = Effect.fn("WorkSources.resolveSourceRoute")(function* <E>(
  workspaceRoot: string,
  directory: WorkProjectDirectory,
  authorize: Effect.Effect<void, E>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = <A>(operation: Effect.Effect<A, PlatformError.PlatformError>) =>
    Effect.andThen(authorize, operation.pipe(Effect.catchTags(fileFailure("resolve_root"))));
  const projectRoot = yield* read(fileSystem.realPath(workspaceRoot));
  let current = projectRoot;
  let exists = true;
  for (const segment of directory.split("/")) {
    const next = path.join(current, segment);
    if (exists) {
      const entries = yield* read(fileSystem.readDirectory(current));
      if (!entries.includes(segment)) {
        const folded = segment.normalize("NFC").toLowerCase();
        if (entries.some((entry) => entry.normalize("NFC").toLowerCase() === folded)) {
          return yield* new WorkSourceRootRejected({ problem: "alias" });
        }
        exists = false;
      } else {
        if ((yield* read(fileSystem.realPath(next))) !== next) {
          return yield* new WorkSourceRootRejected({ problem: "alias" });
        }
        if ((yield* read(fileSystem.stat(next))).type !== "Directory") {
          return yield* new WorkSourceRootRejected({ problem: "not_directory" });
        }
        if (yield* read(fileSystem.exists(path.join(next, ".git")))) {
          return yield* new WorkSourceRootRejected({ problem: "nested_repository" });
        }
      }
    }
    current = next;
  }
  return { projectRoot, path: current, exists } satisfies WorkSourceRoute;
});
