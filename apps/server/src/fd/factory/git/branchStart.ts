import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

/** Neither the branch's reflog nor an unmoved HEAD tells which commit a new worktree started at. */
export class FactoryBranchStartError extends Schema.TaggedError<FactoryBranchStartError>()(
  "FactoryBranchStartError",
  { path: Schema.String, branch: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Factory could not tell which commit branch ${this.branch} started at in ${this.path}.`;
  }
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit `branch` was created at, from the oldest entry of its reflog as read in
 * `worktreePath`: `worktree add -b` records it as "branch: Created from …". None when the reflog
 * does not record the creation, as when reflogs are turned off or the entry expired.
 */
export const readBranchCreation = Effect.fn("FactoryBranchStart.read")(function* (
  worktreePath: string,
  branch: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const reflog = yield* git
    .execute({
      operation: "FactoryBranchStart.reflog",
      cwd: worktreePath,
      args: ["reflog", "show", "--format=%H%x00%gs", `refs/heads/${branch}`, "--"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    })
    .pipe(
      Effect.catchTags({
        GitCommandError: (cause) =>
          Effect.fail(new FactoryBranchStartError({ path: worktreePath, branch, cause })),
      }),
    );
  // Newest first: the oldest entry is the branch's creation.
  const [sha = "", subject = ""] = (reflog.stdout.trim().split("\n").at(-1) ?? "").split("\0");
  return reflog.exitCode === 0 &&
    !reflog.stdoutTruncated &&
    OBJECT_ID.test(sha) &&
    subject.startsWith("branch: Created from ")
    ? Option.some(sha)
    : Option.none<string>();
});
