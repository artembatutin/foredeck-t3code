import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

/** The names a new delivery tries: its item's branch name, then `-2` up to this suffix. */
const MAX_SUFFIX = 100;

/** Every name from `base` to `base-100` is held by an earlier delivery or an existing ref. */
export class FactoryBranchUnavailableError extends Schema.TaggedError<FactoryBranchUnavailableError>()(
  "FactoryBranchUnavailableError",
  { base: Schema.String },
) {
  override get message(): string {
    return `Factory found no free branch name for ${this.base}: earlier deliveries and existing branches hold every numbered name.`;
  }
}

/**
 * Whether a ref in any namespace ends in `name` (a local branch, a remote-tracking branch, a
 * tag), as `GitWorkflowService.hasRefNamed` asks it. Null when Git cannot read the repository.
 */
const refNamed = (git: GitVcsDriver.GitVcsDriver["Service"], cwd: string, name: string) =>
  // No ref name holds a pattern character; one here would widen the match.
  /[*?[\\]/.test(name)
    ? Effect.succeed(false)
    : git
        .execute({
          operation: "FactoryFreshBranch.refNamed",
          cwd,
          args: ["for-each-ref", "--count=1", "--format=%(refname)", `refs/**/${name}`],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim().length > 0 : null)),
          Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
        );

/**
 * The branch for a new delivery of an item: the first of `base`, `base-2`, `base-3`, … that no
 * earlier delivery of the item recorded (`taken`) and no ref in the repository at `cwd` carries.
 * A new delivery starts over and never takes a branch over: an earlier delivery keeps its branch,
 * worktree and commits, and so does a branch a thread started from the item outside Factory.
 * A repository Git cannot read hides nothing from the launch, which reports it, as it reports a
 * base the worktree cannot start from.
 */
export const freshBranchName = Effect.fn("FactoryFreshBranch.name")(function* (input: {
  readonly cwd: string;
  readonly base: string;
  readonly taken: ReadonlyArray<string>;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const taken = new Set(input.taken);
  for (let suffix = 1; suffix <= MAX_SUFFIX; suffix += 1) {
    const candidate = suffix === 1 ? input.base : `${input.base}-${suffix}`;
    if (taken.has(candidate)) continue;
    // Free, or unreadable (null): the launch has the last word either way.
    if ((yield* refNamed(git, input.cwd, candidate)) !== true) return candidate;
  }
  return yield* new FactoryBranchUnavailableError({ base: input.base });
});
