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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";

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
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
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
  ) =>
    manager.runStackedAction(
      { actionId: "action-1", cwd: repo, action: "create_pr", ...text, ...input },
      {
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
