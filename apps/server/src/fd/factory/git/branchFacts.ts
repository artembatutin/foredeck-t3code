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
  /** Commits reachable from HEAD (or the commit asked about) but not the baseline, oldest first. */
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
/** Bringing a moved tip here is a fetch, which can take as long as any other. */
const FETCH_TIMEOUT_MS = 300_000;

/**
 * Reads the branch facts of `worktreePath` relative to `baselineSha` (a full object id), of the
 * commits up to `headSha` when given, which a publication names since it publishes that commit by
 * its id whatever HEAD becomes, and up to HEAD otherwise. Each git call passes an argument array;
 * failures name the operation and path only.
 */
export const readBranchFacts = Effect.fn("FactoryBranchFacts.read")(function* (input: {
  readonly worktreePath: string;
  readonly baselineSha: string;
  readonly headSha?: string;
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
  if (input.headSha !== undefined && !OBJECT_ID.test(input.headSha)) {
    return yield* new FactoryBranchReadError({ operation: "head", path });
  }
  const head = input.headSha ?? "HEAD";

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
    ["merge-base", "--is-ancestor", input.baselineSha, head],
    true,
  );
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
    return yield* new FactoryBranchReadError({ operation: "ancestry", path });
  }

  const log = yield* run("log", [
    "log",
    "--reverse",
    `--format=${LOG_FIELDS.join(FIELD)}${FIELD}`,
    `${input.baselineSha}..${head}`,
  ]);
  if (log.stdoutTruncated) return yield* new FactoryBranchReadError({ operation: "log", path });

  return {
    branch: branch === "" ? null : branch,
    clean: status.stdout.trim() === "",
    baselineIsAncestor: ancestry.exitCode === 0,
    commits: parseLog(log.stdout),
  } satisfies FactoryBranchFacts;
});

/** A failed read's output and arguments can hold a remote's URL, so only which read is logged. */
const cannotTell = ({ operation }: { readonly operation: string }) =>
  Effect.logWarning(`factory could not read where a push goes or what it holds: ${operation}`).pipe(
    Effect.as(null),
  );

/**
 * The remote and branch the stacked action's push of the checked-out branch lands on, with the URLs
 * Git sends it to, asked of the Git driver that pushes it rather than worked out here: Git can push a
 * branch under another name, and a copy of how it picks one would miss whatever it does not repeat.
 * The action is bound to what this returns, URLs included. Null when the push names none, or the
 * read fails.
 */
export const readPushTarget = Effect.fn("FactoryBranchFacts.pushTarget")(
  function* (input: { readonly worktreePath: string; readonly branch: string }) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.resolvePushTarget(input.worktreePath, input.branch);
  },
  Effect.catchTags({ GitCommandError: cannotTell }),
);

/**
 * The commits a push of `headSha` to `target` (see `readPushTarget`) would newly publish, oldest
 * first for each of its push URLs: those its destination does not hold, asked of that destination. A
 * tracking ref cannot answer: it can outlive its branch, a rewrite of that branch or a change of URL,
 * so vouching for a commit the destination lost would let it go out unjudged. A tip of the
 * destination this repository lacks could hold any commit it has: judged without it, a delivery
 * would count all its history as outgoing once the remote's main moved on. So that tip's objects are
 * fetched first, writing no ref. With several push URLs, a push goes to each, so a commit any of them
 * lacks counts. Only the target's URLs are asked, which the push is bound to, each exactly (see
 * `GitVcsDriver.pinUrl`). Null when this cannot be established: a target with no push URL, a URL
 * this Git cannot be held to, a destination or tip that cannot be read, or more than can be read.
 */
export const readOutgoingCommits = Effect.fn("FactoryBranchFacts.outgoing")(
  function* (input: {
    readonly worktreePath: string;
    readonly target: GitVcsDriver.GitPushTarget;
    readonly headSha: string;
  }) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const cwd = input.worktreePath;
    if (!OBJECT_ID.test(input.headSha)) return null;
    const run = (
      operation: string,
      args: ReadonlyArray<string>,
      options: {
        readonly stdin?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly timeoutMs?: number;
      } = {},
    ) =>
      git
        .execute({
          operation: `FactoryBranchFacts.${operation}`,
          cwd,
          args,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options.env === undefined ? {} : { env: options.env }),
          timeoutMs: options.timeoutMs ?? 30_000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.stdoutTruncated
              ? Effect.fail(new FactoryBranchReadError({ operation, path: cwd }))
              : Effect.succeed(result.stdout),
          ),
        );
    const linesOf = (stdout: string) => stdout.split("\n").filter((line) => line.length > 0);
    const asStdin = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join("");

    if (input.target.pushUrls.length === 0) return null;

    const outgoing = new Map<string, FactoryBranchCommit>();
    for (const url of input.target.pushUrls) {
      // These come rewritten once, as the push rewrites them, and Git would rewrite one handed back
      // again, by the rules as they stand when each command runs: a rule sending this URL elsewhere,
      // there before or added in between, would read another repository's history while the push
      // goes here. Pinned, both commands reach this URL whatever the rules say.
      const pinned = yield* git.pinUrl(cwd, url);
      if (pinned === null) {
        yield* Effect.logWarning("factory could not hold a read to the URL a push goes to");
        return null;
      }
      const ask = pinned.repository;
      const advertised = linesOf(
        yield* run("advertised", ["ls-remote", "--heads", "--tags", "--refs", "--", ask], {
          env: pinned.env,
        }),
      ).map((line) => {
        const at = line.search(/\s/);
        return { sha: line.slice(0, at), name: line.slice(at + 1) };
      });
      const tips = advertised.map(({ sha }) => sha);
      const known = linesOf(
        yield* run("knownTips", ["cat-file", "--batch-check"], { stdin: asStdin(tips) }),
      );
      const missing = new Set(
        known.flatMap((line) => (line.endsWith(" missing") ? [line.split(" ")[0]] : [])),
      );
      const fetched = advertised.filter(({ sha }) => missing.has(sha)).map(({ name }) => name);
      if (fetched.length > 0) {
        // Objects only: no ref moves and no FETCH_HEAD is written. A fetch from a configured remote
        // maps what it fetches through that remote's refspecs, however the refs are named here, and
        // can move or force-update its tracking refs and branches; the empty `--refmap` drops those
        // refspecs, and the pinned spelling names no remote anyway. The prune flags matter too:
        // `fetch.pruneTags` would otherwise delete each tag the destination lacks. See
        // `fetchRemoteForStatus` for `--no-auto-gc`.
        yield* run(
          "fetchTips",
          [
            "fetch",
            "--quiet",
            "--refmap=",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-prune",
            "--no-prune-tags",
            "--no-recurse-submodules",
            "--no-auto-gc",
            "--stdin",
            "--",
            ask,
          ],
          { stdin: asStdin(fetched), env: pinned.env, timeoutMs: FETCH_TIMEOUT_MS },
        );
      }
      // By stdin, since a destination can have more refs than a command line holds. A ref that moved
      // since it was listed can leave its old tip unknown here, which excludes nothing: its commits
      // are judged too.
      const log = yield* run(
        "outgoing",
        [
          "log",
          "--reverse",
          `--format=${LOG_FIELDS.join(FIELD)}${FIELD}`,
          "--ignore-missing",
          "--stdin",
          input.headSha,
        ],
        { stdin: asStdin(tips.map((sha) => `^${sha}`)) },
      );
      for (const commit of parseLog(log)) outgoing.set(commit.sha, commit);
    }
    return [...outgoing.values()];
  },
  Effect.catchTags({
    GitCommandError: cannotTell,
    FactoryBranchReadError: cannotTell,
  }),
);

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
