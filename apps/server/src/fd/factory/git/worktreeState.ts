import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { FactoryBranchReadError, FactoryWorktreeMissingError } from "./branchFacts.ts";

/** What a receipt records and what review checks again: HEAD, its tree, and a clean worktree. */
export interface FactoryWorktreeState {
  readonly headSha: string;
  readonly tree: string;
  /** No staged, unstaged or untracked change (ignored files do not count). */
  readonly clean: boolean;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Reads HEAD, its tree and whether the worktree at `path` is clean. */
export const readWorktreeState = Effect.fn("FactoryWorktreeState.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const exists = yield* fileSystem.exists(path).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new FactoryBranchReadError({ operation: "worktree", path, cause })),
    }),
  );
  if (!exists) return yield* new FactoryWorktreeMissingError({ path });

  const read = (operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `FactoryWorktreeState.${operation}`,
        cwd: path,
        args,
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.catchTags({
          GitCommandError: (cause) =>
            Effect.fail(new FactoryBranchReadError({ operation, path, cause })),
        }),
      );

  const [headSha = "", tree = ""] = (yield* read("head", ["rev-parse", "HEAD", "HEAD^{tree}"]))
    .split("\n")
    .map((line) => line.trim());
  if (!OBJECT_ID.test(headSha) || !OBJECT_ID.test(tree)) {
    return yield* new FactoryBranchReadError({ operation: "head", path });
  }
  // No optional locks: reading status must not rewrite the worktree's index.
  const status = yield* read("status", [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return { headSha, tree, clean: status === "" } satisfies FactoryWorktreeState;
});
