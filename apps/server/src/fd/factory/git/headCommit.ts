import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

/**
 * Whether the repository at `cwd` has no commit yet, so HEAD names a branch with nothing on it.
 * Core launches a thread there without a worktree, and its base check lets HEAD through; a
 * delivery always works on a worktree of its own, which needs a commit to start from. False when
 * Git cannot read the repository: the launch reports that, as it reports a base it cannot resolve.
 */
export const hasNoCommit = Effect.fn("FactoryHeadCommit.hasNoCommit")(function* (cwd: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  return yield* git
    .execute({
      operation: "FactoryHeadCommit.read",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    })
    .pipe(
      // `--quiet` exits 1 for a name that resolves to nothing; outside a repository Git exits 128.
      Effect.map((result) => result.exitCode === 1),
      Effect.catchTags({ GitCommandError: () => Effect.succeed(false) }),
    );
});
