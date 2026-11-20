import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type ChangeRequest,
  type GitActionProgressEvent,
  GitRunStackedActionInput,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { explicitBare } from "../testkit/gitCommand.ts";

import * as ServerConfig from "../../../config.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import {
  appendingRemoteUrls,
  holdFirst,
  ignoringConfigEnvironment,
  spawningThrough,
} from "../testkit/gitProcesses.ts";

const decodeInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeInputExit = Schema.decodeUnknownExit(GitRunStackedActionInput);

const branch = "fd/fd-aaaaaa-add-the-export-button";
const text = { prTitle: "fd-aaaaaa: Add the export button", prBody: "Work item fd-aaaaaa." };

describe("GitRunStackedActionInput expected commit", () => {
  const legacy = { actionId: "action-1", cwd: "/repo", action: "create_pr" };

  it("decodes a payload without one unchanged, and a full object id as given", () => {
    const decoded = decodeInput(legacy);
    expect(decoded).toStrictEqual(legacy);
    assert.isFalse("expectedHeadSha" in decoded);
    for (const sha of ["a".repeat(40), "0".repeat(64)]) {
      assert.strictEqual(decodeInput({ ...legacy, expectedHeadSha: sha }).expectedHeadSha, sha);
    }
  });

  it.each([
    ["an abbreviated id", "a".repeat(12)],
    ["an uppercase id", "A".repeat(40)],
    ["a ref name", "HEAD"],
    ["an option", `-${"a".repeat(39)}`],
  ])("rejects %s", (_name, expectedHeadSha) => {
    assert.isTrue(Exit.isFailure(decodeInputExit({ ...legacy, expectedHeadSha })));
  });
});

/** A host that keeps change requests in memory; a created one is open afterwards. */
const makeFakeHost = () => {
  const open: Array<ChangeRequest> = [];
  const provider: SourceControlProvider.SourceControlProvider["Service"] = {
    kind: SourceControlProviderKind.make("github"),
    listChangeRequests: (input) =>
      Effect.succeed(
        open.filter((pr) => pr.headRefName === SourceControlProvider.sourceBranch(input)),
      ),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        open.push({
          provider: SourceControlProviderKind.make("github"),
          number: 101,
          title: input.title,
          url: "https://github.com/acme/widgets/pull/101",
          baseRefName: input.baseRefName,
          headRefName: branch,
          state: "open",
          updatedAt: Option.none(),
        });
      }),
    getDefaultBranch: () => Effect.succeed("main"),
    getChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    checkoutChangeRequest: () => Effect.die("unused"),
  };
  return { provider, open };
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    Effect.flatMap(explicitBare(cwd, args), (args) =>
      driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
    ),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const commitFile = (repo: string, name: string, message: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(repo, name), `${name}\n`);
    yield* git(repo, ["add", name]);
    yield* git(repo, ["commit", "-m", message]);
    return yield* git(repo, ["rev-parse", "HEAD"]);
  });

/** The commit the bare remote holds for the branch; empty when it holds none. */
const remoteHead = (remote: string) =>
  git(remote, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);

/**
 * A repository with `main` pushed to a bare remote and the branch holding one unpushed, approved
 * commit, and GitManager over a fake host as the server composes it otherwise.
 */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-exact-repo-" });
  const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-exact-remote-" });
  yield* git(remote, ["init", "--bare"]);
  yield* git(repo, ["init", "--initial-branch=main"]);
  yield* git(repo, ["config", "user.name", "Ada Lovelace"]);
  yield* git(repo, ["config", "user.email", "ada@example.com"]);
  yield* commitFile(repo, "README.md", "chore: initial commit");
  yield* git(repo, ["remote", "add", "origin", remote]);
  yield* git(repo, ["push", "-u", "origin", "main"]);
  yield* git(repo, ["checkout", "-b", branch]);
  const approved = yield* commitFile(repo, "export.txt", "feat: add the export button");

  const host = makeFakeHost();
  const stores = yield* Layer.build(
    Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  );
  const manager = yield* GitManager.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({}),
        ProviderRegistryMock.layer(),
        Layer.mock(PullRequestService.PullRequestService)({}),
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          get: () => Effect.succeed(host.provider),
          resolve: () => Effect.succeed(host.provider),
          resolveHandle: () => Effect.succeed({ provider: host.provider, context: null }),
        }),
        ServerSettings.layerTest(),
      ),
    ),
    Effect.provideContext(stores),
  );
  const services = yield* Effect.context<
    GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
  >();
  /**
   * Runs the action; `beforePush` runs when it starts its push phase, after every check it
   * makes and before anything is pushed, as a commit made by another process would land.
   */
  const run = (
    input: Partial<GitRunStackedActionInput>,
    beforePush?: ReturnType<typeof commitFile>,
    expectedPushTarget?: GitVcsDriver.GitCheckedPushTarget,
  ) =>
    manager.runStackedAction(
      { actionId: "action-1", cwd: repo, action: "create_pr", ...text, ...input },
      {
        ...(expectedPushTarget === undefined ? {} : { expectedPushTarget }),
        progressReporter: {
          publish: (event: GitActionProgressEvent) =>
            event.kind === "phase_started" && event.phase === "push" && beforePush !== undefined
              ? beforePush.pipe(Effect.provideContext(services), Effect.orDie, Effect.asVoid)
              : Effect.void,
        },
      },
    );
  return { repo, remote, host, approved, run };
});

const base = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-exact-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * `base`, with its Git processes started through `before` first (see `spawningThrough`): built
 * afresh, since a test inside `base` would otherwise be handed the driver `base` already built.
 */
const spawnedThrough = (before: Parameters<typeof spawningThrough>[0]) =>
  Layer.fresh(GitVcsDriver.layer).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-exact-" })),
    Layer.provide(spawningThrough(before)),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(base)("GitManager publishing an expected commit", (it) => {
  it.effect("pushes only the expected commit when another lands during the action", () =>
    Effect.gen(function* () {
      const { repo, remote, host, approved, run } = yield* setup;

      const result = yield* run(
        { expectedHeadSha: approved },
        commitFile(repo, "notes.txt", "chore: unreviewed notes"),
      );

      // The unreviewed commit is the branch's HEAD, yet never reached the remote.
      const head = yield* git(repo, ["rev-parse", "HEAD"]);
      assert.notStrictEqual(head, approved);
      assert.strictEqual(yield* remoteHead(remote), approved);
      assert.strictEqual(yield* git(repo, ["rev-parse", "@{upstream}"]), approved);
      assert.strictEqual(
        yield* git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
        `origin/${branch}`,
      );
      assert.strictEqual(result.push.status, "pushed");
      assert.strictEqual(result.pr.status, "created");
      assert.strictEqual(result.pr.number, 101);
      assert.deepStrictEqual(
        host.open.map(({ headRefName, title }) => ({ headRefName, title })),
        [{ headRefName: branch, title: text.prTitle }],
      );
    }),
  );

  it.effect("without an expected commit, pushes HEAD as it is when the push runs", () =>
    Effect.gen(function* () {
      const { repo, remote, run } = yield* setup;

      yield* run({}, commitFile(repo, "notes.txt", "chore: unreviewed notes"));

      // The behavior every other caller keeps, and why Factory passes the commit.
      assert.strictEqual(yield* remoteHead(remote), yield* git(repo, ["rev-parse", "HEAD"]));
    }),
  );

  it.effect("refuses to start when HEAD is not the expected commit", () =>
    Effect.gen(function* () {
      const { repo, remote, host, approved, run } = yield* setup;
      yield* commitFile(repo, "notes.txt", "chore: unreviewed notes");

      const error = yield* Effect.flip(run({ expectedHeadSha: approved }));

      assert.strictEqual(error._tag, "GitManagerError");
      assert.include(error.message, "HEAD is not the expected commit.");
      assert.strictEqual(yield* remoteHead(remote), "");
      assert.deepStrictEqual(host.open, []);
    }),
  );

  it.effect("refuses a remote branch it would rewind, and opens nothing", () =>
    Effect.gen(function* () {
      const { repo, remote, host, approved, run } = yield* setup;
      // The remote branch already holds an unreviewed commit on top of the approved one.
      const unreviewed = yield* commitFile(repo, "notes.txt", "chore: unreviewed notes");
      yield* git(repo, ["push", "-u", "origin", branch]);
      yield* git(repo, ["reset", "--hard", approved]);

      const error = yield* Effect.flip(run({ expectedHeadSha: approved }));

      assert.strictEqual(error._tag, "GitCommandError");
      assert.strictEqual(yield* remoteHead(remote), unreviewed);
      assert.deepStrictEqual(host.open, []);
    }),
  );

  it.effect("opens the pull request for an expected commit already published", () =>
    Effect.gen(function* () {
      const { repo, remote, host, approved, run } = yield* setup;
      yield* git(repo, ["push", "-u", "origin", branch]);

      const result = yield* run({ expectedHeadSha: approved });

      assert.strictEqual(yield* remoteHead(remote), approved);
      assert.strictEqual(result.pr.status, "created");
      assert.strictEqual(host.open.length, 1);
    }),
  );

  describe("bound to a checked push target", () => {
    /** What `resolveCheckedPushTarget` reports of `origin` at `remote`, which the push is checked against. */
    const checkedAt = (remote: string) => ({ remoteName: "origin", branch, pushUrls: [remote] });

    /** Every ref and setting the repository and the remote hold, to show nothing moved. */
    const everything = (repo: string, remote: string) =>
      Effect.all([
        git(repo, ["for-each-ref"]),
        git(repo, ["config", "--list", "--local"]),
        git(remote, ["for-each-ref"]),
      ]);

    it.effect("pushes and opens the pull request where it was checked", () =>
      Effect.gen(function* () {
        const { repo, remote, host, approved, run } = yield* setup;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const checked = checkedAt(remote);
        assert.deepStrictEqual(yield* driver.resolveCheckedPushTarget(repo, null), checked);

        const result = yield* run({ expectedHeadSha: approved }, undefined, checked);

        assert.strictEqual(yield* remoteHead(remote), approved);
        assert.strictEqual(result.pr.status, "created");
        assert.deepStrictEqual(
          host.open.map(({ headRefName }) => headRefName),
          [branch],
        );
      }),
    );

    it.effect.each([
      {
        // `fd/x` is pushed to `origin` as `x` once a remote is called `fd`.
        name: "a remote whose name starts the branch's",
        change: (repo: string, remote: string) => git(repo, ["remote", "add", "fd", remote]),
      },
      {
        name: "a pushRemote that names another remote",
        change: (repo: string, remote: string) =>
          git(repo, ["remote", "add", "fork", remote]).pipe(
            Effect.andThen(git(repo, ["config", `branch.${branch}.pushRemote`, "fork"])),
          ),
      },
    ])("pushes nothing and opens nothing once $name moves it after the check", ({ change }) =>
      Effect.gen(function* () {
        const { repo, remote, host, approved, run } = yield* setup;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const checked = checkedAt(remote);
        assert.deepStrictEqual(yield* driver.resolveCheckedPushTarget(repo, null), checked);
        yield* change(repo, remote);
        assert.notDeepEqual(yield* driver.resolveCheckedPushTarget(repo, null), checked);
        const before = yield* everything(repo, remote);

        const error = yield* Effect.flip(run({ expectedHeadSha: approved }, undefined, checked));

        assert.strictEqual(error._tag, "GitCommandError");
        assert.strictEqual(error._tag === "GitCommandError" && error.reason, "push_target_changed");
        assert.include(error.message, "The push would not go to the expected remote branch.");
        assert.deepStrictEqual(yield* everything(repo, remote), before);
        assert.deepStrictEqual(host.open, []);
      }),
    );

    it.effect("pushes nothing when the target moves while the action runs", () =>
      Effect.gen(function* () {
        const { repo, remote, host, approved, run } = yield* setup;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // After every check the action makes, before it pushes.
        const moved = git(repo, ["remote", "add", "fd", remote]);

        const error = yield* Effect.flip(
          run({ expectedHeadSha: approved }, moved, checkedAt(remote)),
        );

        assert.include(error.message, "The push would not go to the expected remote branch.");
        assert.strictEqual(
          yield* git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
          "refs/heads/main",
        );
        // Nor did it record an upstream, as a push it made would.
        assert.isNull(yield* driver.readConfigValue(repo, `branch.${branch}.remote`));
        assert.deepStrictEqual(host.open, []);
      }),
    );

    it.effect("checks the head a tracked alias pushes to, which is its upstream's", () =>
      Effect.gen(function* () {
        const { repo, remote, approved, run } = yield* setup;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // `fd/fd-aaaaaa-…` tracking `my-org/fd`'s `fd-aaaaaa-…` pushes there, under that name.
        const head = branch.slice("fd/".length);
        yield* git(repo, ["remote", "add", "my-org/fd", remote]);
        yield* git(repo, ["push", "my-org/fd", `main:refs/heads/${head}`]);
        yield* git(repo, ["fetch", "my-org/fd"]);
        yield* git(repo, ["branch", "--set-upstream-to", `my-org/fd/${head}`]);
        // A Factory worktree records its base; without it core takes the upstream for the base.
        yield* git(repo, ["config", `branch.${branch}.t3-merge-base`, "main"]);
        const alias = { remoteName: "my-org/fd", branch: head, pushUrls: [remote] };
        assert.deepStrictEqual(yield* driver.resolveCheckedPushTarget(repo, null), alias);

        const refused = yield* Effect.flip(
          run({ expectedHeadSha: approved }, undefined, checkedAt(remote)),
        );
        assert.include(refused.message, "The push would not go to the expected remote branch.");
        assert.strictEqual(
          yield* git(remote, ["rev-parse", head]),
          yield* git(repo, ["rev-parse", "main"]),
        );

        yield* run({ action: "push", expectedHeadSha: approved }, undefined, alias);
        assert.strictEqual(yield* git(remote, ["rev-parse", head]), approved);
      }),
    );

    describe("with the same remote and branch, to other URLs", () => {
      const bare = Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const other = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "fd-factory-exact-url-",
        });
        yield* git(other, ["init", "--bare"]);
        return other;
      });

      // Each keeps `origin` and the branch a push lands on there, and sends the push elsewhere.
      const urlChanges = [
        {
          name: "an edited push URL",
          change: (repo: string, _remote: string, other: string) =>
            git(repo, ["remote", "set-url", "--push", "origin", other]),
          pushUrls: (_remote: string, other: string) => [other],
        },
        {
          name: "a push URL added beside it",
          change: (repo: string, remote: string, other: string) =>
            git(repo, ["remote", "set-url", "--add", "--push", "origin", remote]).pipe(
              Effect.andThen(git(repo, ["remote", "set-url", "--add", "--push", "origin", other])),
            ),
          pushUrls: (remote: string, other: string) => [remote, other],
        },
        {
          name: "a pushInsteadOf rewrite of its URL",
          change: (repo: string, remote: string, other: string) =>
            git(repo, ["config", `url.${other}.pushInsteadOf`, remote]),
          pushUrls: (_remote: string, other: string) => [other],
        },
        {
          name: "an insteadOf rewrite of its URL",
          change: (repo: string, remote: string, other: string) =>
            git(repo, ["config", `url.${other}.insteadOf`, remote]),
          pushUrls: (_remote: string, other: string) => [other],
        },
      ];

      it.effect.each(urlChanges)(
        "pushes nothing and opens nothing once $name moves it after the check",
        ({ change, pushUrls }) =>
          Effect.gen(function* () {
            const { repo, remote, host, approved, run } = yield* setup;
            const driver = yield* GitVcsDriver.GitVcsDriver;
            const other = yield* bare;
            const checked = checkedAt(remote);
            assert.deepStrictEqual(yield* driver.resolveCheckedPushTarget(repo, null), checked);
            yield* change(repo, remote, other);
            // The remote and branch alone would still pass.
            assert.deepStrictEqual(yield* driver.resolveCheckedPushTarget(repo, null), {
              ...checked,
              pushUrls: pushUrls(remote, other),
            });
            const before = yield* Effect.all([
              everything(repo, remote),
              git(other, ["for-each-ref"]),
            ]);

            const error = yield* Effect.flip(
              run({ expectedHeadSha: approved }, undefined, checked),
            );

            assert.strictEqual(
              error._tag === "GitCommandError" && error.reason,
              "push_target_changed",
            );
            // The message names neither URL.
            assert.notInclude(error.message, other);
            assert.deepStrictEqual(
              yield* Effect.all([everything(repo, remote), git(other, ["for-each-ref"])]),
              before,
            );
            assert.deepStrictEqual(host.open, []);
          }),
      );

      it.effect("pushes nothing when its push URL moves while the action runs", () =>
        Effect.gen(function* () {
          const { repo, remote, host, approved, run } = yield* setup;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const other = yield* bare;
          const moved = git(repo, ["remote", "set-url", "--push", "origin", other]);

          const error = yield* Effect.flip(
            run({ expectedHeadSha: approved }, moved, checkedAt(remote)),
          );

          assert.strictEqual(
            error._tag === "GitCommandError" && error.reason,
            "push_target_changed",
          );
          assert.strictEqual(yield* remoteHead(remote), "");
          assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
          assert.isNull(yield* driver.readConfigValue(repo, `branch.${branch}.remote`));
          assert.deepStrictEqual(host.open, []);
        }),
      );

      it.effect("pushes to every push URL it was checked against", () =>
        Effect.gen(function* () {
          const { repo, remote, host, approved, run } = yield* setup;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const second = yield* bare;
          yield* git(repo, ["remote", "set-url", "--add", "--push", "origin", remote]);
          yield* git(repo, ["remote", "set-url", "--add", "--push", "origin", second]);
          const checked = yield* driver.resolveCheckedPushTarget(repo, null);
          assert.deepStrictEqual(checked, { ...checkedAt(remote), pushUrls: [remote, second] });

          const result = yield* run(
            { expectedHeadSha: approved },
            undefined,
            checked ?? assert.fail("No target."),
          );

          assert.strictEqual(result.pr.status, "created");
          assert.strictEqual(yield* remoteHead(remote), approved);
          assert.strictEqual(yield* remoteHead(second), approved);
          assert.deepStrictEqual(
            host.open.map(({ headRefName }) => headRefName),
            [branch],
          );
        }),
      );
    });
  });

  describe("a destination that changes after the push last read it", () => {
    const bare = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const other = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-exact-late-" });
      yield* git(other, ["init", "--bare"]);
      return other;
    });

    /**
     * The setup, its branch tracking `origin/main` as one cut from it is, so its push publishes it
     * under its own name and records `main` as its base first; with `second`, `origin` pushes to
     * the remote and a second repository. Returns the target a caller would check.
     */
    const cutFromMain = (second: boolean) =>
      Effect.gen(function* () {
        const ready = yield* setup;
        yield* git(ready.repo, ["branch", "--set-upstream-to", "origin/main"]);
        const extra = second ? yield* bare : null;
        if (extra !== null) {
          yield* git(ready.repo, ["remote", "set-url", "--add", "--push", "origin", ready.remote]);
          yield* git(ready.repo, ["remote", "set-url", "--add", "--push", "origin", extra]);
        }
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const checked = (yield* driver.resolveCheckedPushTarget(ready.repo, null)) ?? assert.fail();
        assert.deepStrictEqual(checked, {
          remoteName: "origin",
          branch,
          pushUrls: extra === null ? [ready.remote] : [ready.remote, extra],
        });
        return { ...ready, extra, checked };
      });

    /** The action's own push of the branch, which the setup's push of `main` is not. */
    const pushesBranch = (args: ReadonlyArray<string>) =>
      args[0] === "push" && (args.at(-1)?.endsWith(`:refs/heads/${branch}`) ?? false);

    // Where the action is when the change lands, both after the push last read the target: as it
    // records the base it was cut from, or as the push itself starts.
    const moments = [
      {
        name: "while it records its base",
        at: (args: ReadonlyArray<string>) =>
          args[0] === "config" && args[1] === `branch.${branch}.t3-merge-base`,
      },
      { name: "as the push starts", at: pushesBranch },
    ];

    // Each keeps `origin` and the branch, and would send a push of `origin` elsewhere from then on.
    const changes = [
      {
        name: "its push URL",
        second: false,
        change: (repo: string, _remote: string, other: string) =>
          git(repo, ["remote", "set-url", "--push", "origin", other]),
      },
      {
        name: "a rule rewriting its URL",
        second: false,
        change: (repo: string, remote: string, other: string) =>
          git(repo, ["config", `url.${other}.insteadOf`, remote]),
      },
      {
        name: "one of its two push URLs",
        second: true,
        change: (repo: string, remote: string, other: string) =>
          git(repo, ["remote", "set-url", "--push", "origin", other, remote]),
      },
    ];

    const cases = moments.flatMap((moment) =>
      changes.map((change) => ({
        ...change,
        at: moment.at,
        name: `${change.name} ${moment.name}`,
      })),
    );

    it.effect.each(cases)(
      "sends nothing elsewhere and opens nothing once $name changes",
      ({ at, second, change }) =>
        Effect.gen(function* () {
          const hold = yield* holdFirst(at);
          yield* Effect.gen(function* () {
            const { repo, remote, host, approved, run, extra, checked } =
              yield* cutFromMain(second);
            const other = yield* bare;

            const action = yield* Effect.flip(
              run({ expectedHeadSha: approved }, undefined, checked),
            ).pipe(Effect.forkChild);
            yield* hold.changeThere(change(repo, remote, other));
            const error = yield* Fiber.join(action);

            assert.strictEqual(
              error._tag === "GitCommandError" && error.reason,
              "push_target_changed",
            );
            // Nothing reached the repository the push would now go to, and no pull request opened.
            assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
            assert.deepStrictEqual(host.open, []);
            // The approved commit went where it was checked to go, and nowhere else.
            assert.strictEqual(yield* remoteHead(remote), approved);
            if (extra !== null) assert.strictEqual(yield* remoteHead(extra), approved);
          }).pipe(Effect.provide(spawnedThrough(hold.before)));
        }),
    );

    it.effect.each(changes)(
      "pushes a recorded pull request's branch nowhere else once $name changes as it pushes",
      ({ second, change }) =>
        Effect.gen(function* () {
          const hold = yield* holdFirst(pushesBranch);
          yield* Effect.gen(function* () {
            const { repo, remote, approved, run, extra, checked } = yield* cutFromMain(second);
            const other = yield* bare;

            const action = yield* Effect.flip(
              run({ action: "push", expectedHeadSha: approved }, undefined, checked),
            ).pipe(Effect.forkChild);
            yield* hold.changeThere(change(repo, remote, other));
            const error = yield* Fiber.join(action);

            assert.strictEqual(
              error._tag === "GitCommandError" && error.reason,
              "push_target_changed",
            );
            assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
            assert.strictEqual(yield* remoteHead(remote), approved);
            if (extra !== null) assert.strictEqual(yield* remoteHead(extra), approved);
          }).pipe(Effect.provide(spawnedThrough(hold.before)));
        }),
    );

    it.effect.each([
      { name: "one push URL", second: false },
      { name: "two push URLs", second: true },
    ])(
      "publishes a branch cut from main to its $name and opens its pull request when nothing changes",
      ({ second }) =>
        Effect.gen(function* () {
          const { repo, remote, host, approved, run, extra, checked } = yield* cutFromMain(second);

          const result = yield* run({ expectedHeadSha: approved }, undefined, checked);

          assert.strictEqual(result.pr.status, "created");
          assert.deepStrictEqual(
            host.open.map(({ headRefName }) => headRefName),
            [branch],
          );
          assert.strictEqual(yield* remoteHead(remote), approved);
          if (extra !== null) assert.strictEqual(yield* remoteHead(extra), approved);
          // Its base was recorded and its upstream is now the branch it published, as before.
          assert.strictEqual(
            yield* git(repo, ["config", "--get", `branch.${branch}.t3-merge-base`]),
            "main",
          );
          assert.strictEqual(yield* git(repo, ["rev-parse", "@{upstream}"]), approved);
          assert.strictEqual(
            yield* git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
            `origin/${branch}`,
          );
        }),
    );

    it.effect.each([
      { name: "reads no GIT_CONFIG_* (before 2.31)", older: ignoringConfigEnvironment },
      { name: "cannot clear a remote's URLs (before 2.46)", older: appendingRemoteUrls },
    ])("pushes nothing where Git $name, refusing it as such", ({ older }) =>
      Effect.gen(function* () {
        const { repo, remote, host, approved, run, checked } = yield* cutFromMain(false);
        const configured = yield* git(repo, ["config", "--list", "--local"]);

        const error = yield* Effect.flip(run({ expectedHeadSha: approved }, undefined, checked));

        assert.strictEqual(
          error._tag === "GitCommandError" && error.reason,
          "push_target_unpinnable",
        );
        assert.include(
          error.message,
          "This Git cannot hold the push to the URLs it was checked against.",
        );
        assert.strictEqual(yield* remoteHead(remote), "");
        // Nor did it record a base or an upstream, as a push it made would.
        assert.strictEqual(yield* git(repo, ["config", "--list", "--local"]), configured);
        assert.deepStrictEqual(host.open, []);
      }).pipe(Effect.provide(spawnedThrough(older))),
    );
  });

  it.effect("refuses an expected commit on an action that commits", () =>
    Effect.gen(function* () {
      const { remote, host, approved, run } = yield* setup;

      const error = yield* Effect.flip(
        run({
          action: "commit_push_pr",
          commitMessage: "feat: add the export menu",
          expectedHeadSha: approved,
        }),
      );

      assert.include(error.message, "An expected commit applies only to push and pull request");
      assert.strictEqual(yield* remoteHead(remote), "");
      assert.deepStrictEqual(host.open, []);
    }),
  );
});
