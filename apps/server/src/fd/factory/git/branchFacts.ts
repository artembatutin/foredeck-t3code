import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";

/** A commit the delivery added since its task baseline, with the raw (unmailmapped) identities. */
export interface FactoryBranchCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
}

/** What settle checks need from a delivery worktree. */
export interface FactoryBranchFacts {
  /** The checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null;
  /** No staged, unstaged or untracked change (ignored files do not count). */
  readonly clean: boolean;
  readonly baselineIsAncestor: boolean;
  /** Commits reachable from HEAD but not from the baseline, oldest first. */
  readonly commits: ReadonlyArray<FactoryBranchCommit>;
}

export class FactoryWorktreeMissingError extends Schema.TaggedError<FactoryWorktreeMissingError>()(
  "FactoryWorktreeMissingError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Factory worktree ${this.path} does not exist.`;
  }
}

/** A git read in the worktree failed. The command's output stays in `cause`, never the message. */
export class FactoryBranchReadError extends Schema.TaggedError<FactoryBranchReadError>()(
  "FactoryBranchReadError",
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Factory could not read '${this.operation}' in worktree ${this.path}.`;
  }
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FIELD = "%x00";
const LOG_FIELDS = ["%H", "%an", "%ae", "%cn", "%ce", "%s", "%b"];
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Reads the branch facts of `worktreePath` relative to `baselineSha` (a full object id). Each git
 * call passes an argument array; failures name the operation and path only.
 */
export const readBranchFacts = Effect.fn("FactoryBranchFacts.read")(function* (input: {
  readonly worktreePath: string;
  readonly baselineSha: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = input.worktreePath;

  const exists = yield* fileSystem.exists(path).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new FactoryBranchReadError({ operation: "worktree", path, cause })),
    }),
  );
  if (!exists) return yield* new FactoryWorktreeMissingError({ path });
  if (!OBJECT_ID.test(input.baselineSha)) {
    return yield* new FactoryBranchReadError({ operation: "baseline", path });
  }

  const run = (operation: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    git
      .execute({
        operation: `FactoryBranchFacts.${operation}`,
        cwd: path,
        args,
        allowNonZeroExit,
        timeoutMs: 30_000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.catchTags({
          GitCommandError: (cause) =>
            Effect.fail(new FactoryBranchReadError({ operation, path, cause })),
        }),
      );

  const branch = (yield* run("branch", ["branch", "--show-current"])).stdout.trim();
  const status = yield* run("status", ["status", "--porcelain=v1", "--untracked-files=all"]);

  const ancestry = yield* run(
    "ancestry",
    ["merge-base", "--is-ancestor", input.baselineSha, "HEAD"],
    true,
  );
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
    return yield* new FactoryBranchReadError({ operation: "ancestry", path });
  }

  const log = yield* run("log", [
    "log",
    "--reverse",
    `--format=${LOG_FIELDS.join(FIELD)}${FIELD}`,
    `${input.baselineSha}..HEAD`,
  ]);
  if (log.stdoutTruncated) return yield* new FactoryBranchReadError({ operation: "log", path });

  return {
    branch: branch === "" ? null : branch,
    clean: status.stdout.trim() === "",
    baselineIsAncestor: ancestry.exitCode === 0,
    commits: parseLog(log.stdout),
  } satisfies FactoryBranchFacts;
});

// Commit messages cannot hold NUL, so NUL-separated fields split unambiguously. Git puts a
// newline between records, which lands at the start of each later sha field.
const parseLog = (stdout: string): ReadonlyArray<FactoryBranchCommit> => {
  const fields = stdout.split("\0");
  const commits: FactoryBranchCommit[] = [];
  for (let index = 0; index + LOG_FIELDS.length <= fields.length; index += LOG_FIELDS.length) {
    const [
      sha = "",
      authorName = "",
      authorEmail = "",
      committerName = "",
      committerEmail = "",
      subject = "",
      body = "",
    ] = fields.slice(index, index + LOG_FIELDS.length);
    commits.push({
      sha: sha.trim(),
      subject,
      body: body.trim(),
      authorName,
      authorEmail,
      committerName,
      committerEmail,
    });
  }
  return commits;
};
