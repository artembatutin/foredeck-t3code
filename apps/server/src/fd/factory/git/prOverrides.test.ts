import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  type ChangeRequest,
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
const overrides = {
  prTitle: "fd-aaaaaa: Add the export button",
  prBody: "Delivers fd-aaaaaa.\n\n## Accepted tasks\n- fd-aaaaaa: Add the export button",
};
const generated = {
  title: "feat: add an export button",
  body: "## Summary\n- Generated description",
};

type Overrides = Pick<GitRunStackedActionInput, "prTitle" | "prBody">;

describe("GitRunStackedActionInput PR text overrides", () => {
  const legacy = {
    actionId: "action-1",
    cwd: "/repo",
    action: "commit_push_pr",
    commitMessage: "feat: add the export button",
    threadId: "thread-author",
  };

  it("decodes a payload without overrides unchanged", () => {
    const decoded = decodeInput(legacy);
    expect(decoded).toStrictEqual(legacy);
    assert.isFalse("prTitle" in decoded);
    assert.isFalse("prBody" in decoded);
  });

  it("decodes both overrides, trimmed", () => {
    const decoded = decodeInput({
      ...legacy,
      prTitle: `  ${overrides.prTitle}\n`,
      prBody: `\n${overrides.prBody}  `,
    });
    expect(decoded).toStrictEqual({ ...legacy, ...overrides });
  });

  it("accepts each override at its length bound", () => {
    const decoded = decodeInput({
      ...legacy,
      prTitle: "t".repeat(256),
      prBody: "b".repeat(65_536),
    });
    assert.strictEqual(decoded.prTitle?.length, 256);
    assert.strictEqual(decoded.prBody?.length, 65_536);
  });

  it.each([
    ["an empty title", { prTitle: "" }],
    ["a blank title", { prTitle: " \n\t " }],
    ["an over-length title", { prTitle: "t".repeat(257) }],
    ["an empty body", { prBody: "" }],
    ["a blank body", { prBody: "\n  \n" }],
    ["an over-length body", { prBody: "b".repeat(65_537) }],
  ])("rejects %s", (_name, value) => {
    assert.isTrue(Exit.isFailure(decodeInputExit({ ...legacy, ...value })));
  });
});

/** A change request the fake host reports for a branch. */
const changeRequest = (number: number, title: string): ChangeRequest => ({
  provider: SourceControlProviderKind.make("github"),
  number,
  title,
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: "main",
  headRefName: branch,
  state: "open",
  updatedAt: Option.none(),
});

interface CreatedChangeRequest {
  readonly baseRefName: string;
  readonly headSelector: string;
  readonly title: string;
  readonly body: string;
}

/**
 * A source control host that keeps its change requests in memory. A created one is recorded with
 * its body file's contents (GitManager removes the file once creation returns) and is open
 * afterwards, as on a real host.
 */
const makeFakeHost = (open: Array<ChangeRequest>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const created: Array<CreatedChangeRequest> = [];
    const provider: SourceControlProvider.SourceControlProvider["Service"] = {
      kind: SourceControlProviderKind.make("github"),
      listChangeRequests: (input) =>
        Effect.succeed(
          open.filter(
            (pr) =>
              pr.headRefName === SourceControlProvider.sourceBranch(input) &&
              (input.state === "all" || pr.state === input.state),
          ),
        ),
      createChangeRequest: (input) =>
        fileSystem.readFileString(input.bodyFile).pipe(
          Effect.orDie,
          Effect.map((body) => {
            created.push({
              baseRefName: input.baseRefName,
              headSelector: input.headSelector,
              title: input.title,
              body,
            });
            open.push(changeRequest(100 + created.length, input.title));
          }),
        ),
      getDefaultBranch: () => Effect.succeed("main"),
      getChangeRequest: () => Effect.die("unused"),
      getRepositoryCloneUrls: () => Effect.die("unused"),
      createRepository: () => Effect.die("unused"),
      checkoutChangeRequest: () => Effect.die("unused"),
    };
    return { provider, created };
  });

/** Text generation that counts PR content requests; `refuse` fails the action when asked. */
const makeTextGeneration = (mode: "generate" | "refuse") => {
  let prContentRequests = 0;
  const layer = Layer.mock(TextGeneration.TextGeneration)({
    generatePrContent: () =>
      Effect.suspend(() => {
        prContentRequests += 1;
        return mode === "refuse"
          ? Effect.die(new Error("PR content must not be generated when both overrides are given."))
          : Effect.succeed(generated);
      }),
  });
  return { layer, prContentRequests: () => prContentRequests };
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

/** A repository whose `main` and feature branch are both pushed to a bare remote. */
const pushedBranch = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-repo-" });
  const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-remote-" });
  yield* git(remote, ["init", "--bare"]);
  yield* git(repo, ["init", "--initial-branch=main"]);
  yield* git(repo, ["config", "user.name", "Ada Lovelace"]);
  yield* git(repo, ["config", "user.email", "ada@example.com"]);
  yield* fileSystem.writeFileString(path.join(repo, "README.md"), "hello\n");
  yield* git(repo, ["add", "README.md"]);
  yield* git(repo, ["commit", "-m", "chore: initial commit"]);
  yield* git(repo, ["remote", "add", "origin", remote]);
  yield* git(repo, ["push", "-u", "origin", "main"]);
  yield* git(repo, ["checkout", "-b", branch]);
  yield* fileSystem.writeFileString(path.join(repo, "export.txt"), "export\n");
  yield* git(repo, ["add", "export.txt"]);
  yield* git(repo, ["commit", "-m", "feat: add the export button"]);
  yield* git(repo, ["push", "-u", "origin", branch]);
  return repo;
});

/** GitManager over the fake host and text generation, as the server composes it otherwise. */
const setup = (options: {
  readonly generation: "generate" | "refuse";
  readonly open?: ReadonlyArray<ChangeRequest>;
}) =>
  Effect.gen(function* () {
    const repo = yield* pushedBranch;
    const host = yield* makeFakeHost([...(options.open ?? [])]);
    const textGeneration = makeTextGeneration(options.generation);
    const stores = yield* Layer.build(
      Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    );
    const manager = yield* GitManager.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          textGeneration.layer,
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
    const run = (input: { readonly action: "create_pr" | "commit_push_pr" } & Overrides) =>
      manager.runStackedAction({
        actionId: "action-1",
        cwd: repo,
        ...(input.action === "commit_push_pr"
          ? { commitMessage: "feat: add the export menu" }
          : {}),
        ...input,
      });
    return { repo, host, run, prContentRequests: textGeneration.prContentRequests };
  });

const base = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-pr-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(base)("GitManager PR text overrides", (it) => {
  it.effect("create_pr opens the PR with both overrides and generates nothing", () =>
    Effect.gen(function* () {
      const { host, run, prContentRequests } = yield* setup({ generation: "refuse" });

      const result = yield* run({ action: "create_pr", ...overrides });

      assert.deepStrictEqual(host.created, [
        {
          baseRefName: "main",
          headSelector: branch,
          title: overrides.prTitle,
          body: overrides.prBody,
        },
      ]);
      assert.strictEqual(prContentRequests(), 0);
      assert.strictEqual(result.pr.status, "created");
      assert.strictEqual(result.pr.title, overrides.prTitle);
      assert.strictEqual(result.pr.number, 101);
    }),
  );

  it.effect("commit_push_pr commits, pushes and opens the PR with both overrides", () =>
    Effect.gen(function* () {
      const { repo, host, run, prContentRequests } = yield* setup({ generation: "refuse" });
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFileString(path.join(repo, "menu.txt"), "menu\n");

      const result = yield* run({ action: "commit_push_pr", ...overrides });

      assert.strictEqual(result.commit.status, "created");
      assert.strictEqual(result.push.status, "pushed");
      assert.strictEqual(
        yield* git(repo, ["rev-parse", `origin/${branch}`]),
        yield* git(repo, ["rev-parse", "HEAD"]),
      );
      assert.deepStrictEqual(
        host.created.map(({ title, body }) => ({ title, body })),
        [{ title: overrides.prTitle, body: overrides.prBody }],
      );
      assert.strictEqual(prContentRequests(), 0);
      assert.strictEqual(result.pr.status, "created");
      assert.strictEqual(result.pr.title, overrides.prTitle);
    }),
  );

  it.effect.each<[string, Overrides, { readonly title: string; readonly body: string }]>([
    ["no override", {}, generated],
    ["only a title", { prTitle: overrides.prTitle }, { ...generated, title: overrides.prTitle }],
    ["only a body", { prBody: overrides.prBody }, { ...generated, body: overrides.prBody }],
  ])("create_pr with %s generates what is missing", ([, given, expected]) =>
    Effect.gen(function* () {
      const { host, run, prContentRequests } = yield* setup({ generation: "generate" });

      const result = yield* run({ action: "create_pr", ...given });

      assert.deepStrictEqual(
        host.created.map(({ title, body }) => ({ title, body })),
        [expected],
      );
      assert.strictEqual(prContentRequests(), 1);
      assert.strictEqual(result.pr.status, "created");
      assert.strictEqual(result.pr.title, expected.title);
    }),
  );

  it.effect.each<[string, Overrides]>([
    ["no override", {}],
    ["both overrides", overrides],
    ["only a title", { prTitle: overrides.prTitle }],
  ])("an open PR is returned as it is, with %s", ([, given]) =>
    Effect.gen(function* () {
      const existing = changeRequest(42, "feat: the export button as first opened");
      const { host, run, prContentRequests } = yield* setup({
        generation: "refuse",
        open: [existing],
      });

      const result = yield* run({ action: "create_pr", ...given });

      assert.deepStrictEqual(result.pr, {
        status: "opened_existing",
        url: existing.url,
        number: 42,
        baseBranch: "main",
        headBranch: branch,
        title: existing.title,
      });
      assert.deepStrictEqual(host.created, []);
      assert.strictEqual(prContentRequests(), 0);
    }),
  );
});
