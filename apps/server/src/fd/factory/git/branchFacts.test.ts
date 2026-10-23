import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  FactoryBranchReadError,
  FactoryWorktreeMissingError,
  readBranchFacts,
} from "./branchFacts.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-branch-facts-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const branch = "feature/item-7";
const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
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
