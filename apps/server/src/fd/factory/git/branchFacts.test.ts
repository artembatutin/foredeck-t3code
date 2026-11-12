import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { ChildProcess } from "effect/process";
import { explicitBare } from "../testkit/gitCommand.ts";

import * as ServerConfig from "../../../config.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  FactoryBranchReadError,
  FactoryWorktreeMissingError,
  readBranchFacts,
  readOutgoingCommits,
  readPushTarget,
} from "./branchFacts.ts";
import { holdFirst, ignoringConfigEnvironment, spawningThrough } from "../testkit/gitProcesses.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-branch-facts-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * The driver as `layer` builds it, its Git processes started through `before` first: built afresh,
 * since a test inside `layer` would otherwise be handed the driver that layer already built.
 */
const layerSpawningThrough = (
  before: (command: ChildProcess.StandardCommand) => Effect.Effect<ChildProcess.StandardCommand>,
) =>
  Layer.fresh(GitVcsDriver.layer).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-branch-facts-" })),
    Layer.provide(spawningThrough(before)),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const branch = "feature/item-7";
const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* Effect.flatMap(explicitBare(cwd, args), (args) =>
      driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
    );
    return result.stdout.trim();
  });

const commit = (cwd: string, message: string, extra: ReadonlyArray<string> = []) =>
  git(cwd, [
    ...ada,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    message,
    ...extra,
  ]);

/** A repository with a root commit and the baseline on `main`, then `branch` checked out. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-branch-facts-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* commit(cwd, "chore: root");
  yield* commit(cwd, "chore: baseline");
  const baselineSha = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* git(cwd, ["switch", "-c", branch]);
  return { cwd, baselineSha, path, fileSystem };
});

it.layer(layer)("readBranchFacts", (it) => {
  it.effect("reads the branch, cleanliness, ancestry and new commits with identities", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha } = yield* makeRepository;
      yield* commit(cwd, "feat(server): first\n\nThe body.\n\nRefs: item-7");
      yield* commit(cwd, "fix: second", ["--author", "Grace Hopper <grace@example.com>"]);
      const [first = "", second = ""] = (yield* git(cwd, [
        "rev-list",
        "--reverse",
        `${baselineSha}..HEAD`,
      ])).split("\n");

      const facts = yield* readBranchFacts({ worktreePath: cwd, baselineSha });
      assert.deepStrictEqual(facts, {
        branch,
        clean: true,
        baselineIsAncestor: true,
        commits: [
          {
            sha: first,
            subject: "feat(server): first",
            body: "The body.\n\nRefs: item-7",
            authorName: "Ada Lovelace",
            authorEmail: "ada@example.com",
            committerName: "Ada Lovelace",
            committerEmail: "ada@example.com",
          },
          {
            sha: second,
            subject: "fix: second",
            body: "",
            authorName: "Grace Hopper",
            authorEmail: "grace@example.com",
            committerName: "Ada Lovelace",
            committerEmail: "ada@example.com",
          },
        ],
      });
    }),
  );

  it.effect("reports no new commits on a branch still at its baseline", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha } = yield* makeRepository;
      const facts = yield* readBranchFacts({ worktreePath: cwd, baselineSha });
      assert.strictEqual(facts.baselineIsAncestor, true);
      assert.deepStrictEqual(facts.commits, []);
    }),
  );

  it.effect("counts untracked and modified files as dirty", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha, path, fileSystem } = yield* makeRepository;
      yield* fileSystem.makeDirectory(path.join(cwd, "nested"));
      yield* fileSystem.writeFileString(path.join(cwd, "nested", "new.txt"), "untracked\n");
      assert.strictEqual((yield* readBranchFacts({ worktreePath: cwd, baselineSha })).clean, false);

      yield* fileSystem.remove(path.join(cwd, "nested"), { recursive: true });
      assert.strictEqual((yield* readBranchFacts({ worktreePath: cwd, baselineSha })).clean, true);

      yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "changed\n");
      assert.strictEqual((yield* readBranchFacts({ worktreePath: cwd, baselineSha })).clean, false);
    }),
  );

  it.effect("reports a detached HEAD as no branch", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha } = yield* makeRepository;
      yield* commit(cwd, "feat: work");
      yield* git(cwd, ["switch", "--detach", "HEAD"]);
      const facts = yield* readBranchFacts({ worktreePath: cwd, baselineSha });
      assert.strictEqual(facts.branch, null);
      assert.strictEqual(facts.commits.length, 1);
    }),
  );

  it.effect("reports a rewritten history whose HEAD no longer contains the baseline", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha } = yield* makeRepository;
      yield* git(cwd, ["reset", "--hard", "HEAD~1"]);
      yield* commit(cwd, "feat: rewritten");
      const facts = yield* readBranchFacts({ worktreePath: cwd, baselineSha });
      assert.strictEqual(facts.baselineIsAncestor, false);
      assert.deepStrictEqual(
        facts.commits.map((entry) => entry.subject),
        ["feat: rewritten"],
      );
    }),
  );

  it.effect("fails with a typed error for a missing worktree", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha, path } = yield* makeRepository;
      const missing = path.join(cwd, "gone");
      const error = yield* Effect.flip(readBranchFacts({ worktreePath: missing, baselineSha }));
      assert.instanceOf(error, FactoryWorktreeMissingError);
      assert.strictEqual(error.message, `Factory worktree ${missing} does not exist.`);
    }),
  );

  it.effect("names the operation and path, never git's output, when a read fails", () =>
    Effect.gen(function* () {
      const { cwd, fileSystem } = yield* makeRepository;
      const notRepository = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "fd-factory-not-a-repository-",
      });
      const notRead = yield* Effect.flip(
        readBranchFacts({ worktreePath: notRepository, baselineSha: "e".repeat(40) }),
      );
      assert.instanceOf(notRead, FactoryBranchReadError);
      assert.deepInclude(notRead, { operation: "branch", path: notRepository });
      assert.strictEqual(
        notRead.message,
        `Factory could not read 'branch' in worktree ${notRepository}.`,
      );

      const unknownBaseline = yield* Effect.flip(
        readBranchFacts({ worktreePath: cwd, baselineSha: "e".repeat(40) }),
      );
      assert.deepInclude(unknownBaseline, {
        _tag: "FactoryBranchReadError",
        operation: "ancestry",
      });
      assert.notInclude(unknownBaseline.message.toLowerCase(), "fatal");
      assert.notInclude(unknownBaseline.message, "e".repeat(40));

      const optionLike = yield* Effect.flip(
        readBranchFacts({ worktreePath: cwd, baselineSha: "--output=x" }),
      );
      assert.deepInclude(optionLike, { _tag: "FactoryBranchReadError", operation: "baseline" });
    }),
  );
});

/**
 * A repository on `branch` holding `chore: root`, `chore: baseline` and `feat: work`, with a bare
 * `origin` that holds whatever the test pushes, and nothing yet. `outgoing` reads what a push would
 * add where the push goes, as the publication gate does.
 */
const makePublished = Effect.gen(function* () {
  const { cwd, baselineSha, fileSystem, path } = yield* makeRepository;
  const bare = (prefix: string) =>
    Effect.gen(function* () {
      const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix });
      yield* git(remote, ["init", "--bare"]);
      return remote;
    });
  const origin = yield* bare("fd-factory-outgoing-origin-");
  yield* git(cwd, ["remote", "add", "origin", origin]);
  yield* commit(cwd, "feat: work");
  const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
  const outgoing = readPushTarget({ worktreePath: cwd, branch }).pipe(
    Effect.flatMap((target) =>
      target === null
        ? Effect.succeed(null)
        : readOutgoingCommits({ worktreePath: cwd, target, headSha }),
    ),
    Effect.map((commits) => commits?.map(({ subject }) => subject) ?? null),
  );
  return { cwd, origin, baselineSha, headSha, outgoing, bare, fileSystem, path };
});

const allThree = ["chore: root", "chore: baseline", "feat: work"];

it.layer(layer)("readOutgoingCommits", (it) => {
  it.effect("reads a remote holding nothing as all of it, oldest first", () =>
    Effect.gen(function* () {
      const { outgoing } = yield* makePublished;
      assert.deepStrictEqual(yield* outgoing, allThree);
    }),
  );

  it.effect("leaves out what the remote holds, on a branch or a tag", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha, outgoing } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}~1:refs/heads/main`]);
      assert.deepStrictEqual(yield* outgoing, ["chore: baseline", "feat: work"]);
      yield* git(cwd, [...ada, "tag", "-a", "-m", "base", "v1", baselineSha]);
      yield* git(cwd, ["push", "origin", "refs/tags/v1"]);
      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);
      yield* git(cwd, ["push", "origin", `HEAD:refs/heads/${branch}`]);
      assert.deepStrictEqual(yield* outgoing, []);
    }),
  );

  it.effect("judges by a tip it lacks, whose objects it brings here and no ref", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      yield* git(cwd, ["fetch", "origin"]);
      // The remote's main moves to a commit this repository has never seen.
      const later = yield* git(origin, [
        ...ada,
        "commit-tree",
        "-p",
        baselineSha,
        "-m",
        "chore: later",
        `${baselineSha}^{tree}`,
      ]);
      yield* git(origin, ["update-ref", "refs/heads/main", later]);
      assert.notInclude(yield* git(cwd, ["log", "--all", "--format=%H"]), later);
      const refs = yield* git(cwd, ["for-each-ref"]);

      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

      assert.strictEqual(yield* git(cwd, ["cat-file", "-t", later]), "commit");
      assert.strictEqual(yield* git(cwd, ["for-each-ref"]), refs);
      assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/main"]), baselineSha);
      assert.notInclude(yield* git(cwd, ["log", "--all", "--format=%H"]), later);
    }),
  );

  it.effect("deletes no tag or ref, whatever the fetch settings ask for", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing, path, fileSystem } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      const later = yield* git(origin, [
        ...ada,
        "commit-tree",
        "-p",
        baselineSha,
        "-m",
        "chore: later",
        `${baselineSha}^{tree}`,
      ]);
      yield* git(origin, ["update-ref", "refs/heads/main", later]);
      // The remote has neither of these: settings like these delete them on a plain fetch.
      yield* git(cwd, ["tag", "only-here", baselineSha]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/gone", baselineSha]);
      yield* git(cwd, ["config", "fetch.prune", "true"]);
      yield* git(cwd, ["config", "fetch.pruneTags", "true"]);
      const refs = yield* git(cwd, ["for-each-ref"]);

      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

      assert.strictEqual(yield* git(cwd, ["for-each-ref"]), refs);
      assert.strictEqual(yield* git(cwd, ["tag", "--list", "only-here"]), "only-here");
      // Nor does it leave a note of the fetch for the next `FETCH_HEAD` reader.
      const fetchHead = yield* git(cwd, ["rev-parse", "--git-path", "FETCH_HEAD"]);
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, fetchHead)));
    }),
  );

  it.effect.each([
    {
      name: "its branch was rewound",
      left: ["chore: baseline", "feat: work"],
      change: (_cwd: string, origin: string, root: string) =>
        git(origin, ["update-ref", "refs/heads/main", root]),
    },
    {
      name: "its branch was rewritten to a commit not here",
      left: ["chore: baseline", "feat: work"],
      change: (_cwd: string, origin: string, root: string) =>
        Effect.gen(function* () {
          const rewritten = yield* git(origin, [
            ...ada,
            "commit-tree",
            "-p",
            root,
            "-m",
            "chore: rewritten",
            `${root}^{tree}`,
          ]);
          yield* git(origin, ["update-ref", "refs/heads/main", rewritten]);
        }),
    },
  ])("takes nothing from a tracking ref once $name", ({ change, left }) =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      yield* git(cwd, ["fetch", "origin"]);
      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

      yield* change(cwd, origin, yield* git(cwd, ["rev-parse", `${baselineSha}~1`]));

      assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/main"]), baselineSha);
      assert.deepStrictEqual(yield* outgoing, left);
    }),
  );

  it.effect.each([
    { name: "only part of it", holds: true, left: ["chore: baseline", "feat: work"] },
    { name: "none of it", holds: false, left: allThree },
  ])(
    "takes nothing from a tracking ref after moving to a repository holding $name",
    ({ holds, left }) =>
      Effect.gen(function* () {
        const { cwd, baselineSha, outgoing, bare } = yield* makePublished;
        yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
        yield* git(cwd, ["fetch", "origin"]);
        const other = yield* bare("fd-factory-outgoing-moved-");
        if (holds) yield* git(cwd, ["push", other, `${baselineSha}~1:refs/heads/main`]);
        yield* git(cwd, ["remote", "set-url", "origin", other]);

        assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/main"]), baselineSha);
        assert.deepStrictEqual(yield* outgoing, left);
      }),
  );

  it.effect("takes nothing from a tracking ref whose branch the remote no longer has", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/gone`]);
      yield* git(cwd, ["fetch", "origin"]);
      assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/gone"]), baselineSha);
      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

      yield* git(origin, ["update-ref", "-d", "refs/heads/gone"]);

      assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/gone"]), baselineSha);
      assert.deepStrictEqual(yield* outgoing, allThree);
    }),
  );

  it.effect("asks the URL a push goes to, and no tracking ref of another", () =>
    Effect.gen(function* () {
      const { cwd, baselineSha, outgoing, bare } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      yield* git(cwd, ["fetch", "origin"]);
      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

      const pushOnly = yield* bare("fd-factory-outgoing-push-url-");
      yield* git(cwd, ["remote", "set-url", "--push", "origin", pushOnly]);
      assert.deepStrictEqual(yield* outgoing, allThree);

      // Its main at a commit this repository lacks: origin's tracking ref says nothing of it.
      const unrelated = yield* git(pushOnly, [
        ...ada,
        "commit-tree",
        "-m",
        "chore: unrelated",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      ]);
      yield* git(pushOnly, ["update-ref", "refs/heads/main", unrelated]);
      assert.deepStrictEqual(yield* outgoing, allThree);
    }),
  );

  it.effect("counts what any of several push URLs lacks", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing, bare } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      const second = yield* bare("fd-factory-outgoing-second-url-");
      yield* git(cwd, ["remote", "set-url", "--add", "--push", "origin", origin]);
      yield* git(cwd, ["remote", "set-url", "--add", "--push", "origin", second]);
      assert.sameMembers((yield* outgoing) ?? [], allThree);

      yield* git(second, ["fetch", cwd, `${baselineSha}:refs/heads/main`]);
      assert.deepStrictEqual(yield* outgoing, ["feat: work"]);
    }),
  );

  describe("a URL Git rewrites", () => {
    /** The heads a bare repository holds, as the push left them. */
    const heads = (bare: string) =>
      git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]);

    it.effect("asks the repository a chain of rewrites pushes to, not the next one in it", () =>
      Effect.gen(function* () {
        const { cwd, baselineSha, headSha, outgoing, bare } = yield* makePublished;
        const pushed = yield* bare("fd-factory-outgoing-pushed-");
        const next = yield* bare("fd-factory-outgoing-next-");
        // The repository the push reaches holds only the root; the next one in the chain holds the
        // baseline too, so asking it would let the baseline go out unjudged.
        yield* git(cwd, ["push", pushed, `${baselineSha}~1:refs/heads/main`]);
        yield* git(cwd, ["push", next, `${baselineSha}:refs/heads/main`]);
        yield* git(cwd, ["remote", "set-url", "origin", "alias:widgets"]);
        yield* git(cwd, ["config", `url.${pushed}.insteadOf`, "alias:widgets"]);
        yield* git(cwd, ["config", `url.${next}.insteadOf`, pushed]);
        // Git rewrites once for the push, and again for whatever it is handed back.
        assert.strictEqual(yield* git(cwd, ["ls-remote", "--get-url", "--", pushed]), next);
        assert.deepStrictEqual(yield* readPushTarget({ worktreePath: cwd, branch }), {
          remoteName: "origin",
          branch,
          pushUrls: [pushed],
        });

        assert.deepStrictEqual(yield* outgoing, ["chore: baseline", "feat: work"]);

        // A real push reaches the repository asked, and nothing reaches the next.
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.pushCurrentBranch(cwd, null, { commitSha: headSha });
        assert.strictEqual(yield* heads(pushed), `refs/heads/${branch}\nrefs/heads/main`);
        assert.strictEqual(yield* heads(next), "refs/heads/main");
        assert.deepStrictEqual(yield* outgoing, []);
      }),
    );

    it.effect("asks the repository one rewrite names, under that URL", () =>
      Effect.gen(function* () {
        const { cwd, baselineSha, outgoing, fileSystem, path } = yield* makePublished;
        const host = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "fd-factory-outgoing-host-",
        });
        const widgets = path.join(host, "widgets.git");
        yield* git(host, ["init", "--bare", widgets]);
        yield* git(cwd, ["push", widgets, `${baselineSha}:refs/heads/main`]);
        // An ordinary alias for a host: `alias:` stands for the host's directory.
        yield* git(cwd, ["remote", "set-url", "origin", "alias:widgets.git"]);
        yield* git(cwd, ["config", `url.${host}/.insteadOf`, "alias:"]);
        assert.deepStrictEqual((yield* readPushTarget({ worktreePath: cwd, branch }))?.pushUrls, [
          `${host}/widgets.git`,
        ]);

        assert.deepStrictEqual(yield* outgoing, ["feat: work"]);
      }),
    );

    it.effect("asks where pushInsteadOf sends the push, not where a fetch goes", () =>
      Effect.gen(function* () {
        const { cwd, origin, baselineSha, headSha, outgoing, bare } = yield* makePublished;
        const pushOnly = yield* bare("fd-factory-outgoing-push-instead-");
        yield* git(cwd, ["push", origin, `${baselineSha}~1:refs/heads/main`]);
        yield* git(cwd, ["push", pushOnly, `${baselineSha}:refs/heads/main`]);
        yield* git(cwd, ["config", `url.${pushOnly}.pushInsteadOf`, origin]);

        assert.deepStrictEqual(yield* outgoing, ["feat: work"]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.pushCurrentBranch(cwd, null, { commitSha: headSha });
        assert.strictEqual(yield* heads(pushOnly), `refs/heads/${branch}\nrefs/heads/main`);
        assert.strictEqual(yield* heads(origin), "refs/heads/main");
      }),
    );

    it.effect("asks where the push goes though Git rewrites any read handed that URL", () =>
      Effect.gen(function* () {
        const { cwd, origin, baselineSha, headSha, outgoing, bare } = yield* makePublished;
        const pushOnly = yield* bare("fd-factory-outgoing-push-only-");
        const elsewhere = yield* bare("fd-factory-outgoing-elsewhere-");
        // Only `elsewhere` holds the baseline, so a read reaching it would let that go out unjudged.
        yield* git(cwd, ["push", elsewhere, `${baselineSha}:refs/heads/main`]);
        // The push goes to `pushOnly`, which any read Git is handed rewrites to `elsewhere`.
        yield* git(cwd, ["config", `url.${pushOnly}.pushInsteadOf`, origin]);
        yield* git(cwd, ["config", `url.${elsewhere}.insteadOf`, pushOnly]);
        const target = yield* readPushTarget({ worktreePath: cwd, branch });
        assert.deepStrictEqual(target?.pushUrls, [pushOnly]);
        assert.strictEqual(yield* git(cwd, ["ls-remote", "--get-url", "--", pushOnly]), elsewhere);

        assert.deepStrictEqual(yield* outgoing, allThree);

        // A real push bound to that target reaches the repository asked, and nothing reaches the other.
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.pushCurrentBranch(cwd, null, {
          commitSha: headSha,
          expectedTarget: target ?? assert.fail("No target."),
        });
        assert.strictEqual(yield* heads(pushOnly), `refs/heads/${branch}`);
        assert.strictEqual(yield* heads(elsewhere), "refs/heads/main");
        assert.deepStrictEqual(yield* outgoing, []);
      }),
    );
  });

  describe("a rule that sends the URL elsewhere after the push target was read", () => {
    /** The heads a bare repository holds. */
    const heads = (bare: string) =>
      git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]);

    // Where the reader stops for the rule to arrive: before asking what the destination holds, or
    // before bringing a tip of it here.
    const moments = [
      {
        name: "before the destination is asked what it holds",
        at: (args: ReadonlyArray<string>) => args[0] === "ls-remote" && args.includes("--heads"),
        tipUnknown: false,
      },
      {
        name: "before a tip of it is brought here",
        at: (args: ReadonlyArray<string>) => args[0] === "fetch",
        tipUnknown: true,
      },
    ];

    it.effect.each(moments)(
      "still judges by the repository the push reaches when the rule lands $name",
      ({ at, tipUnknown }) =>
        Effect.gen(function* () {
          const hold = yield* holdFirst(at);
          yield* Effect.gen(function* () {
            const { cwd, origin, baselineSha, headSha, bare } = yield* makePublished;
            const root = yield* git(cwd, ["rev-parse", `${baselineSha}~1`]);
            // `origin`'s URL is pushed to `pushed` by a pushInsteadOf rule, which no later rule
            // rewrites, so the push URLs stay `[pushed]` whatever comes next. `pushed` holds only the
            // root (or a commit on it this repository lacks), `other` the baseline too.
            const pushed = yield* bare("fd-factory-outgoing-pushed-");
            const other = yield* bare("fd-factory-outgoing-other-");
            yield* git(cwd, ["push", pushed, `${root}:refs/heads/main`]);
            const later = yield* git(pushed, [
              ...ada,
              "commit-tree",
              "-p",
              root,
              "-m",
              "chore: later",
              `${root}^{tree}`,
            ]);
            if (tipUnknown) yield* git(pushed, ["update-ref", "refs/heads/main", later]);
            yield* git(cwd, ["push", other, `${baselineSha}:refs/heads/main`]);
            yield* git(cwd, ["config", `url.${pushed}.pushInsteadOf`, origin]);
            const target = (yield* readPushTarget({ worktreePath: cwd, branch })) ?? assert.fail();
            assert.deepStrictEqual(target.pushUrls, [pushed]);

            const reading = yield* readOutgoingCommits({ worktreePath: cwd, target, headSha }).pipe(
              Effect.forkChild,
            );
            // From here on, any read Git is handed `pushed` reaches `other`, which holds the baseline.
            yield* hold.changeThere(git(cwd, ["config", `url.${other}.insteadOf`, pushed]));
            const outgoing = yield* Fiber.join(reading);

            assert.strictEqual(yield* git(cwd, ["ls-remote", "--get-url", "--", pushed]), other);
            assert.deepStrictEqual(
              (yield* readPushTarget({ worktreePath: cwd, branch }))?.pushUrls,
              [pushed],
            );
            // Judged by `pushed`, which lacks the baseline: read at `other`, it would not go out.
            assert.deepStrictEqual(
              outgoing?.map(({ subject }) => subject),
              ["chore: baseline", "feat: work"],
            );
            // The tip it lacked came from `pushed`, which alone holds it.
            assert.strictEqual(
              yield* git(cwd, ["cat-file", "-t", later]).pipe(Effect.orElseSucceed(() => "")),
              tipUnknown ? "commit" : "",
            );

            const driver = yield* GitVcsDriver.GitVcsDriver;
            yield* driver.pushCurrentBranch(cwd, null, {
              commitSha: headSha,
              expectedTarget: target,
            });
            assert.strictEqual(yield* heads(pushed), `refs/heads/${branch}\nrefs/heads/main`);
            assert.strictEqual(yield* heads(other), "refs/heads/main");
          }).pipe(Effect.provide(layerSpawningThrough(hold.before)));
        }),
    );
  });

  describe("a fetch of a tip the repository lacks", () => {
    /** Every ref with its commit, and what FETCH_HEAD says, if anything. */
    const refsAndFetchHead = (cwd: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fetchHead = path.join(
          cwd,
          yield* git(cwd, ["rev-parse", "--git-path", "FETCH_HEAD"]),
        );
        return {
          refs: yield* git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]),
          fetchHead: (yield* fileSystem.exists(fetchHead))
            ? yield* fileSystem.readFileString(fetchHead)
            : null,
        };
      });

    it.effect.each([
      { name: "a remote named origin at the relative URL origin", colliding: true, force: false },
      {
        name: "that remote, force-mapping its branches onto local ones",
        colliding: true,
        force: true,
      },
      { name: "a remote at a URL naming no remote, force-mapping", colliding: false, force: true },
    ])("moves no ref and writes no FETCH_HEAD for $name", ({ colliding, force }) =>
      Effect.gen(function* () {
        const { cwd, baselineSha, path, fileSystem } = yield* makeRepository;
        yield* commit(cwd, "feat: work");
        const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        const root = yield* git(cwd, ["rev-parse", `${baselineSha}~1`]);
        // The remote's repository, and how this one names it: as `origin` resolves, `origin` is
        // both a configured remote and the path the URL Git reports names.
        const store = colliding
          ? path.join(cwd, "origin")
          : yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-outgoing-store-" });
        yield* git(cwd, ["init", "--bare", store]);
        if (colliding) {
          yield* fileSystem.writeFileString(
            path.join(cwd, ".git", "info", "exclude"),
            "/origin/\n",
          );
        }
        yield* git(cwd, ["remote", "add", "origin", colliding ? "origin" : store]);
        if (force) {
          yield* git(cwd, [
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/heads/*:refs/heads/hist/*",
          ]);
        }
        // What this repository tracks of it, and a historical branch a forced mapping would move.
        yield* git(cwd, ["update-ref", "refs/remotes/origin/main", root]);
        yield* git(cwd, ["branch", "hist/main", root]);
        // The remote's main holds the baseline, then a commit this repository has never seen.
        yield* git(cwd, ["push", store, `${baselineSha}:refs/heads/main`]);
        const later = yield* git(store, [
          ...ada,
          "commit-tree",
          "-p",
          baselineSha,
          "-m",
          "chore: later",
          `${baselineSha}^{tree}`,
        ]);
        yield* git(store, ["update-ref", "refs/heads/main", later]);
        const target = (yield* readPushTarget({ worktreePath: cwd, branch })) ?? assert.fail();
        assert.deepStrictEqual(target, {
          remoteName: "origin",
          branch,
          pushUrls: [colliding ? "origin" : store],
        });
        const before = yield* refsAndFetchHead(cwd);

        const outgoing = yield* readOutgoingCommits({ worktreePath: cwd, target, headSha });

        // Judged by the tip it brought here, which holds the baseline and the root.
        assert.deepStrictEqual(
          outgoing?.map(({ subject }) => subject),
          ["feat: work"],
        );
        assert.strictEqual(yield* git(cwd, ["cat-file", "-t", later]), "commit");
        assert.deepStrictEqual(yield* refsAndFetchHead(cwd), before);
        assert.strictEqual(yield* git(cwd, ["rev-parse", "hist/main"]), root);
        assert.strictEqual(yield* git(cwd, ["rev-parse", "refs/remotes/origin/main"]), root);
        assert.strictEqual(yield* git(cwd, ["branch", "--show-current"]), branch);
        if (colliding) {
          // Fetched by that name instead, the same refs would follow the remote's mappings.
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const planned = yield* driver.execute({
            operation: "test.git",
            cwd,
            args: ["fetch", "--dry-run", "--no-write-fetch-head", "--stdin", "--", "origin"],
            stdin: "refs/heads/main\n",
            timeoutMs: 10_000,
          });
          assert.include(planned.stderr, "-> origin/main");
          if (force) assert.include(planned.stderr, "-> hist/main");
          assert.deepStrictEqual(yield* refsAndFetchHead(cwd), before);
        }
      }),
    );
  });

  it.effect("cannot say when Git cannot be held to the URL a push goes to", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, headSha } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      const target = (yield* readPushTarget({ worktreePath: cwd, branch })) ?? assert.fail();
      assert.deepStrictEqual(target.pushUrls, [origin]);

      assert.isNull(
        yield* readOutgoingCommits({ worktreePath: cwd, target, headSha }).pipe(
          Effect.provide(layerSpawningThrough(ignoringConfigEnvironment)),
        ),
      );
    }),
  );

  it.effect("cannot say when there is no remote, or it cannot be read", () =>
    Effect.gen(function* () {
      const { cwd, outgoing, fileSystem, path } = yield* makePublished;
      yield* git(cwd, ["remote", "set-url", "origin", path.join(cwd, "no-such-repository")]);
      assert.isNull(yield* outgoing);
      yield* git(cwd, ["remote", "remove", "origin"]);
      assert.isNull(yield* outgoing);
      assert.isTrue(yield* fileSystem.exists(cwd));
    }),
  );

  it.effect("cannot say when a tip it lacks cannot be brought here", () =>
    Effect.gen(function* () {
      const { cwd, origin, baselineSha, outgoing, path, fileSystem } = yield* makePublished;
      yield* git(cwd, ["push", "origin", `${baselineSha}:refs/heads/main`]);
      const tree = `${baselineSha}^{tree}`;
      const parent = yield* git(origin, [
        ...ada,
        "commit-tree",
        "-p",
        baselineSha,
        "-m",
        "a",
        tree,
      ]);
      const tip = yield* git(origin, [...ada, "commit-tree", "-p", parent, "-m", "b", tree]);
      yield* git(origin, ["update-ref", "refs/heads/main", tip]);
      // Still advertised, since its tip exists, but what it stands on is gone.
      yield* fileSystem.remove(path.join(origin, "objects", parent.slice(0, 2), parent.slice(2)));
      assert.include(yield* git(cwd, ["ls-remote", "origin", "refs/heads/main"]), tip);

      assert.isNull(yield* outgoing);
    }),
  );

  it.effect("cannot say for a commit that is not a full object id", () =>
    Effect.gen(function* () {
      const { cwd, origin } = yield* makePublished;
      assert.isNull(
        yield* readOutgoingCommits({
          worktreePath: cwd,
          target: { remoteName: "origin", branch, pushUrls: [origin] },
          headSha: "--output=x",
        }),
      );
    }),
  );

  it.effect("cannot say when what would go out is more than it can read", () =>
    Effect.gen(function* () {
      const { cwd, origin, path, fileSystem } = yield* makePublished;
      yield* fileSystem.writeFileString(
        path.join(cwd, ".git", "large-message"),
        `feat: large\n\n${"x".repeat(1_100_000)}\n`,
      );
      yield* git(cwd, [
        ...ada,
        "commit",
        "--no-verify",
        "--allow-empty",
        "-F",
        ".git/large-message",
      ]);
      const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      const target = { remoteName: "origin", branch, pushUrls: [origin] };

      assert.isNull(yield* readOutgoingCommits({ worktreePath: cwd, target, headSha }));
    }),
  );

  /**
   * Each way `pushCurrentBranch` picks a remote, of `origin`, `other`, `my-org/feature` and
   * `feature`, and the branch it lands on there, which is not always the branch's own name.
   */
  const destinations: ReadonlyArray<{
    readonly name: string;
    readonly arrange: (cwd: string, other: string) => ReturnType<typeof git> | Effect.Effect<void>;
    readonly lands: "origin" | "other" | "my-org/feature";
    readonly onto?: string;
  }> = [
    { name: "a branch tracking nothing", arrange: () => Effect.void, lands: "origin" },
    {
      name: "the first remote when there is no origin",
      arrange: (cwd) =>
        git(cwd, ["remote", "remove", "origin"]).pipe(
          Effect.andThen(git(cwd, ["remote", "remove", "my-org/feature"])),
        ),
      lands: "other",
    },
    {
      name: "a branch's pushRemote",
      arrange: (cwd) => git(cwd, ["config", `branch.${branch}.pushRemote`, "other"]),
      lands: "other",
    },
    {
      name: "remote.pushDefault",
      arrange: (cwd) => git(cwd, ["config", "remote.pushDefault", "other"]),
      lands: "other",
    },
    {
      name: "a branch tracking its own name, over pushDefault",
      arrange: (cwd) =>
        git(cwd, ["push", "origin", `HEAD~1:refs/heads/${branch}`]).pipe(
          Effect.andThen(git(cwd, ["fetch", "origin"])),
          Effect.andThen(git(cwd, ["branch", "--set-upstream-to", `origin/${branch}`])),
          Effect.andThen(git(cwd, ["config", "remote.pushDefault", "other"])),
        ),
      lands: "origin",
    },
    {
      name: "a branch cut from another ref, by pushDefault",
      arrange: (cwd) =>
        git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]).pipe(
          Effect.andThen(git(cwd, ["fetch", "origin"])),
          Effect.andThen(git(cwd, ["branch", "--set-upstream-to", "origin/main"])),
          Effect.andThen(git(cwd, ["config", "remote.pushDefault", "other"])),
        ),
      lands: "other",
    },
    {
      name: "a branch cut from another ref, by its remote",
      arrange: (cwd) =>
        git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]).pipe(
          Effect.andThen(git(cwd, ["fetch", "origin"])),
          Effect.andThen(git(cwd, ["branch", "--set-upstream-to", "origin/main"])),
        ),
      lands: "origin",
    },
    {
      // Git's name for a head of a remote whose own name holds a slash, over pushDefault.
      name: "a branch aliasing its upstream's head",
      arrange: (cwd) =>
        git(cwd, ["push", "my-org/feature", "HEAD~1:refs/heads/item-7"]).pipe(
          Effect.andThen(git(cwd, ["fetch", "my-org/feature"])),
          Effect.andThen(git(cwd, ["branch", "--set-upstream-to", "my-org/feature/item-7"])),
          Effect.andThen(git(cwd, ["config", "remote.pushDefault", "other"])),
        ),
      lands: "my-org/feature",
      onto: "item-7",
    },
    {
      // The push leaves out a leading remote name, though it goes to another remote.
      name: "a remote whose name starts the branch's",
      arrange: (cwd, other) => git(cwd, ["remote", "add", "feature", other]),
      lands: "origin",
      onto: "item-7",
    },
  ];

  it.effect.each(destinations)(
    "reads where a real push goes for $name",
    ({ arrange, lands, onto = branch }) =>
      Effect.gen(function* () {
        const { cwd, origin, headSha, outgoing, bare } = yield* makePublished;
        const other = yield* bare("fd-factory-outgoing-other-");
        const alias = yield* bare("fd-factory-outgoing-alias-");
        yield* git(cwd, ["remote", "add", "other", other]);
        yield* git(cwd, ["remote", "add", "my-org/feature", alias]);
        yield* arrange(cwd, other);
        const configured = yield* git(cwd, ["config", "--list", "--local"]);
        const landed = { origin, other, "my-org/feature": alias }[lands];
        assert.deepStrictEqual(yield* readPushTarget({ worktreePath: cwd, branch }), {
          remoteName: lands,
          branch: onto,
          pushUrls: [landed],
        });
        // Reading it fetched nothing and set nothing up.
        assert.strictEqual(yield* git(cwd, ["config", "--list", "--local"]), configured);
        assert.include((yield* outgoing) ?? [], "feat: work");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pushed = yield* driver.pushCurrentBranch(cwd, null, { commitSha: headSha });
        assert.strictEqual(pushed.status, "pushed");

        // It went where the read said it would, so the read now finds nothing left to go.
        assert.strictEqual(
          yield* git(landed, ["for-each-ref", "--format=%(objectname)", `refs/heads/${onto}`]),
          headSha,
        );
        assert.deepStrictEqual(yield* outgoing, []);
      }),
  );

  it.effect("names no target for a push with no remote", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makePublished;
      yield* git(cwd, ["remote", "remove", "origin"]);
      assert.isNull(yield* readPushTarget({ worktreePath: cwd, branch }));
    }),
  );
});
