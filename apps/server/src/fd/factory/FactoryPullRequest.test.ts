import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  GitManagerError,
  type GitManagerServiceError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type PullRequestDetail,
  PullRequestUnavailableError,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { ChildProcess } from "effect/process";
import * as Schema from "effect/Schema";
import { explicitBare } from "./testkit/gitCommand.ts";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { type WorkDomainError, WorkService, workBranchName } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { type FactoryDeliveryState, queuedDeliveryState } from "./pipeline/state.ts";
import { holdFirst, spawningThrough } from "./testkit/gitProcesses.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const item = {
  ref: itemRef,
  kind: "markdown",
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: "https://tracker.example.com/items/fd-aaaaaa",
} as unknown as WorkItemDetail;
const branch = workBranchName(item);
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const reviewer = ThreadId.make("thread-reviewer");
const reviewRun = RunId.make("run-review");
const prUrl = "https://github.com/acme/alpha/pull/7";

/** The stacked action's result for a pull request step that ended with `pr`. */
const stackedResult = (pr: GitRunStackedActionResult["pr"]): GitRunStackedActionResult => ({
  action: "create_pr",
  branch: { status: "skipped_not_requested" },
  commit: { status: "skipped_not_requested" },
  push: { status: "pushed", branch },
  pr,
  toast: { title: "Created pull request", cta: { kind: "none" } },
});
const created = stackedResult({
  status: "created",
  url: prUrl,
  number: 7,
  baseBranch: "main",
  headBranch: branch,
  title: "feat: fd-aaaaaa Add the export button",
});

// Work's own errors are private to Work; this carries the same tag.
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

/** What a host saved of a pull request, as far as the PR stage reads it. */
type Saved = Pick<PullRequestDetail, "title" | "body" | "headBranch">;

interface World {
  worktree: { readonly cwd: string; readonly baseline: string } | null;
  /** The item Work returns; a test may change it once the delivery has started. */
  item: WorkItemDetail;
  /** Runs while Work reads the item, before the read returns. */
  onItemRead: Effect.Effect<void, WorkDomainError>;
  /** Runs inside the stacked action, before it pushes the branch. */
  beforePush: Effect.Effect<void>;
  /** Each Git process the driver starts goes through this first, which can hold it. */
  beforeGit: (command: ChildProcess.StandardCommand) => Effect.Effect<ChildProcess.StandardCommand>;
  /** The action pushes HEAD whatever commit it is given, as one that predates the field would. */
  ignoresExpectedCommit: boolean;
  /**
   * The action pushes through the Git driver's own push, bound to the target it is given, as the
   * real action does: it refuses a push that would go anywhere else, before writing anything.
   */
  pushesThroughDriver: boolean;
  /** How the stacked action answers; a test sets it before the delivery reaches the PR stage. */
  respond: (
    input: GitRunStackedActionInput,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  /** What the host holds, given what the last `create_pr` sent; by default exactly that. */
  saved: (sent: Saved) => Effect.Effect<Saved, PullRequestService.PullRequestError>;
  readonly calls: Array<GitRunStackedActionInput>;
  /** The remote branch each call's push was bound to, in call order. */
  readonly pushTargets: Array<GitVcsDriver.GitCheckedPushTarget | undefined>;
  /** How often the saved pull request was read, each after its cache was dropped. */
  readonly savedReads: Array<"invalidated" | "read">;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

/**
 * The fake PR service: its stacked action records the call and pushes like `create_pr` to its bound
 * remote branch (else `origin`'s): the expected commit as upstream, else HEAD, or with
 * `pushesThroughDriver` via the driver's push. `exactCommitPush.test.ts` holds the real action to
 * this, including refusing a push the target no longer describes.
 */
const fakeGitWorkflow = (world: World) =>
  Layer.unwrap(
    Effect.map(GitVcsDriver.GitVcsDriver, (driver) => {
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.push", cwd, args, timeoutMs: 30_000 }).pipe(Effect.orDie);
      return Layer.mock(GitWorkflow.GitWorkflowService)({
        runStackedAction: (input, options) =>
          Effect.gen(function* () {
            world.calls.push(input);
            world.pushTargets.push(options?.expectedPushTarget);
            yield* world.beforePush;
            const exact = world.ignoresExpectedCommit ? undefined : input.expectedHeadSha;
            const { remoteName, branch: onto } = options?.expectedPushTarget ?? {
              remoteName: "origin",
              branch,
            };
            if (world.pushesThroughDriver) {
              yield* driver.pushCurrentBranch(input.cwd, null, {
                ...(exact === undefined ? {} : { commitSha: exact }),
                ...(options?.expectedPushTarget === undefined
                  ? {}
                  : { expectedTarget: options.expectedPushTarget }),
              });
            } else if (exact === undefined) {
              yield* run(input.cwd, ["push", "-u", remoteName, `HEAD:refs/heads/${onto}`]);
            } else {
              yield* run(input.cwd, ["push", remoteName, `${exact}:refs/heads/${onto}`]);
              yield* run(input.cwd, ["branch", "--set-upstream-to", `${remoteName}/${onto}`]);
            }
            return yield* world.respond(input);
          }),
      });
    }),
  );

// Threads are faked as in FactoryRecord.test.ts; every run is still going when its launch
// returns, and the test steps its end.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(WorkService.WorkService)({
      canonicalRef: (ref) => Effect.succeed(ref),
      resolveSource: () =>
        Effect.succeed({
          stored: { sourceId, projectId },
        } as unknown as WorkService.ResolvedSource),
      getItem: () => world.onItemRead.pipe(Effect.as(world.item)),
    }),
    // No repository at the root: a start keeps the item's branch name (freshBranch.test.ts).
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeedSome({
          projectId: id,
          workspaceRoot: "/nowhere",
        } as unknown as ProjectStore.ProjectRow),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ checkWorktreeBase: () => Effect.void }),
    Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
      launchThread: (_delivery, effect) =>
        Effect.sync(() => {
          const worktreePath = world.worktree?.cwd ?? "/nowhere";
          const baseline = world.worktree?.baseline ?? "b".repeat(40);
          return effect.role === "author"
            ? { threadId: author, runId: authorRun, worktreePath, baseline }
            : { threadId: reviewer, runId: reviewRun, worktreePath, baseline };
        }),
      runEnded: () => Effect.succeedNone,
      threadState: () => Effect.succeed("present"),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    fakeGitWorkflow(world),
    // The created pull request is linked to the thread the action ran beside.
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          id: threadId,
          projectId,
          workspaceBinding: null,
        } as unknown as OrchestrationV2ThreadShell),
      dispatch: (command) =>
        Effect.sync(() => {
          world.dispatched.push(command);
          return { sequence: world.dispatched.length, storedEvents: [] } as never;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
    Layer.mock(PullRequestService.PullRequestService)({
      invalidate: () => Effect.sync(() => world.savedReads.push("invalidated")).pipe(Effect.asVoid),
      detail: () =>
        Effect.suspend(() => {
          world.savedReads.push("read");
          const sent = world.calls.findLast(({ action }) => action === "create_pr");
          return world.saved({
            title: sent?.prTitle ?? "",
            body: sent?.prBody ?? "",
            headBranch: branch,
          }) as Effect.Effect<PullRequestDetail, PullRequestService.PullRequestError>;
        }),
    }),
  );

/**
 * FactoryService, the worker, the verify runner, review judging, record and the PR service as
 * the server builds them, on in-memory SQLite, real git, real processes and an evidence folder
 * under a temp T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provideMerge(FactoryPullRequest.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPlanning.FactoryPlanning)({})),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(FactoryVerifyRunner.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provide(spawningThrough((command) => world.beforeGit(command))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-pr-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    worktree: null,
    item,
    onItemRead: Effect.void,
    beforePush: Effect.void,
    beforeGit: Effect.succeed,
    ignoresExpectedCommit: false,
    pushesThroughDriver: false,
    respond: () => Effect.succeed(created),
    saved: Effect.succeed,
    calls: [],
    pushTargets: [],
    savedReads: [],
    dispatched: [],
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* Effect.flatMap(explicitBare(cwd, args), (args) =>
      driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
    );
    return result.stdout.trim();
  });
const writeFile = (cwd: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, name), text);
  });
const commit = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", ...args]);

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const verifyScript = 'console.log("checks pass")';
/** The project's verify command: the script, then any arguments, which the script ignores. */
const useVerify = (extraArgs: ReadonlyArray<string> = []) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(
      projectId,
      decodeSettings({
        verifyCommand: { executable: process.execPath, args: ["-e", verifyScript, ...extraArgs] },
      }),
    ),
  );

const start = Effect.flatMap(FactoryService.FactoryService, (service) =>
  service.start({ itemRef }),
);
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const runEnds = (deliveryId: FactoryDeliveryId, threadId: ThreadId, runId: RunId) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) =>
    worker.step(deliveryId, { type: "run.finished", threadId, runId, status: "completed" }),
  ).pipe(Effect.andThen(drain));
const storedOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.get(deliveryId),
  ).pipe(Effect.map(Option.getOrThrow));
const stateOf = (deliveryId: FactoryDeliveryId) =>
  storedOf(deliveryId).pipe(Effect.map((delivery): FactoryDeliveryState => delivery.state));
const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((runs) => runs.map(({ stage, outcome }) => ({ stage, outcome }))));

/** A review that passes, with one low finding that does not block. */
const passingReview = {
  verdict: "pass",
  findings: [
    {
      id: "export-name",
      severity: "low",
      required: false,
      file: "src/export.ts",
      line: 1,
      detail: "The constant's name hides that it holds CSV text; callers may misread it.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export test covers CSV output.",
      paths: ["src/export.test.ts"],
    },
  ],
  missing_evidence: [],
};

/**
 * A worktree repository with a bare `origin`, and a delivery whose verified commit has a passing
 * review still awaiting the reviewer run's end. Returns the delivery and the reviewed commit.
 * `verifyArgs` follow the project's verify script; `earlier` commits before the author's, which
 * the delivery does not judge until `judgeFromRoot`.
 */
const reviewAccepted = (
  world: World,
  verifyArgs: ReadonlyArray<string> = [],
  earlier: (
    cwd: string,
  ) => Effect.Effect<
    void,
    never,
    GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
  > = () => Effect.void,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-wt-" });
    const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-origin-" });
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* writeFile(cwd, "README.md", "root\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, ["-m", "chore: root"]);
    const root = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* earlier(cwd);
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* writeFile(cwd, "src/export.ts", "export const csv = 1;\n");
    yield* writeFile(cwd, "src/export.test.ts", "// covers csv\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, ["-m", "feat: export the table as CSV"]);
    world.worktree = { cwd, baseline };

    yield* useVerify(verifyArgs);
    const { deliveryId } = yield* start;
    yield* drain;
    yield* runEnds(deliveryId, author, authorRun);
    const service = yield* FactoryService.FactoryService;
    yield* service.submitReview({ threadId: reviewer, review: passingReview });
    return { cwd, deliveryId, root, reviewed: yield* git(cwd, ["rev-parse", "HEAD"]) };
  });

/** The stored delivery with `change` applied, as an earlier server could have left it. */
const storeChanged = (
  deliveryId: FactoryDeliveryId,
  change: (state: FactoryDeliveryState) => FactoryDeliveryState,
) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const stored = yield* storedOf(deliveryId);
    yield* deliveries.update(deliveryId, change(stored.state));
  });

/**
 * Commits a change through the commit's own hooks, so one can add to its message. `trailer` can hold
 * line breaks and tabs, which the hook writes as such and the commit keeps byte for byte.
 */
const commitThroughHook = (cwd: string, trailer: string, identity: ReadonlyArray<string> = ada) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hook = path.join(cwd, ".git", "hooks", "commit-msg");
    yield* fileSystem.makeDirectory(path.dirname(hook), { recursive: true });
    yield* fileSystem.writeFileString(
      hook,
      `#!/bin/sh\nprintf '\\n%b\\n' ${JSON.stringify(trailer)} >> "$1"\n`,
    );
    yield* fileSystem.chmod(hook, 0o755);
    yield* writeFile(cwd, "src/earlier.ts", "export const earlier = 1;\n");
    yield* git(cwd, ["add", "-A"]);
    yield* git(cwd, [
      ...identity,
      "-c",
      "core.hooksPath=.git/hooks",
      "commit",
      "--no-gpg-sign",
      "--cleanup=verbatim",
      "-m",
      "feat: add the earlier export",
    ]);
    yield* fileSystem.remove(hook);
  }).pipe(Effect.orDie);

/** The block a pull request failing the publication gate leaves. */
const refusedBlock = (detail: string) =>
  ({
    reason: "effect_failed",
    effect: { id: 6, type: "open_pr" },
    detail: `Factory could not open the pull request. ${detail}`,
  }) as const;

/** The commit `origin` holds for the delivery branch; empty when it holds none. */
const publishedOf = (cwd: string) =>
  git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]).pipe(
    Effect.map((line) => line.split("\t")[0] ?? ""),
  );

/** Services a hook needs, so it runs inside the fakes with nothing left to provide. */
const captured = <A, E>(
  effect: Effect.Effect<A, E, GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.map(
    Effect.context<GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path>(),
    (context) => effect.pipe(Effect.provideContext(context), Effect.orDie, Effect.asVoid),
  );

/** Commits a change in the worktree, as an agent or the owner could at any time. */
const commitChange = (cwd: string) =>
  writeFile(cwd, "src/export.ts", "export const csv = 2;\n").pipe(
    Effect.andThen(git(cwd, ["add", "-A"])),
    Effect.andThen(commit(cwd, ["-m", "fix: write the header row"])),
  );

/** AI agent, model and provider names, and attribution lines, none of which a body may hold. */
const FORBIDDEN =
  /\b(claude|codex|chatgpt|gpt|openai|anthropic|devin|cognition|cursor|opencode|grok|gemini|copilot|antigravity|ai)\b|generated|co-authored|assisted-by|signed-off/i;

describe("the PR stage", () => {
  it.effect("opens the approved commit's pull request once, linked to the author thread", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        // The state the delivery is stored in while the stacked action runs.
        const during: Array<FactoryDeliveryState> = [];
        world.respond = () =>
          deliveries.listActive().pipe(
            Effect.map((active) => {
              during.push(...active.map(({ state }) => state));
              return created;
            }),
            Effect.orDie,
          );
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        assert.deepStrictEqual(world.calls, []);

        yield* runEnds(deliveryId, reviewer, reviewRun);

        // Approved at pr while the one stacked action runs, from the delivery worktree.
        assert.deepStrictEqual(
          during.map(({ status, stage, awaiting }) => ({ status, stage, awaiting })),
          [
            {
              status: "approved",
              stage: "pr",
              awaiting: { type: "effect", effect: { id: 6, type: "open_pr" } },
            },
          ],
        );
        assert.strictEqual(world.calls.length, 1);
        const [input] = world.calls;
        assert.strictEqual(input?.action, "create_pr");
        assert.strictEqual(input?.cwd, cwd);
        assert.strictEqual(input?.threadId, author);
        assert.strictEqual(input?.projectId, projectId);
        assert.strictEqual(input?.actionId, `factory-pr:${deliveryId}:6`);
        assert.strictEqual(input?.expectedHeadSha, reviewed);
        assert.strictEqual(input?.prTitle, "feat: fd-aaaaaa Add the export button");
        assert.strictEqual(
          input?.prBody,
          [
            "Work item fd-aaaaaa: Add the export button",
            "Link: https://tracker.example.com/items/fd-aaaaaa",
            "",
            "Accepted tasks:",
            "",
            "1. Add the export button",
            `   - Verified commit: \`${reviewed}\``,
            `   - Verify command: \`${process.execPath} -e ${verifyScript}\`, exit code 0`,
            "   - Review: pass in round 1, with 0 high, 0 medium and 1 low severity findings",
          ].join("\n"),
        );
        assert.notMatch(input?.prBody ?? "", FORBIDDEN);
        assert.notMatch(input?.prTitle ?? "", FORBIDDEN);

        // Open, with the pull request recorded, and its attempt passed.
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.stage, "pr");
        assert.isNull(state.awaiting);
        assert.isNull(state.block);
        assert.deepStrictEqual(state.pullRequest, { number: 7, url: prUrl, headBranch: branch });
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-2), [
          { stage: "record", outcome: "passed" },
          { stage: "pr", outcome: "passed" },
        ]);

        // Linked to the author thread as a created pull request, like the action's RPC does, then
        // watched there, under a command id derived from the delivery and the effect.
        assert.deepStrictEqual(world.dispatched, [
          {
            type: "thread.pull-request.link",
            commandId: CommandId.make(`factory-pr-link:${deliveryId}:6`),
            threadId: author,
            host: "github.com",
            repository: "acme/alpha",
            number: 7,
            url: prUrl,
            source: "created",
          },
          {
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`factory-pr-watch:${deliveryId}:6`),
            threadId: author,
            host: "github.com",
            repository: "acme/alpha",
            number: 7,
            watching: true,
            link: { url: prUrl, source: "created" },
          },
        ]);
        // Wakes committed after the watch's command are the delivery's to adopt.
        assert.deepStrictEqual(state.followThrough, {
          watchedAfter: 2,
          armedAt: 2,
          // The fake thread shell holds no link, so no watch is read back as Factory's.
          watchStartedAt: null,
          heldUntil: null,
          runs: [],
          pending: [],
          watchEnded: false,
        });
        // What the host saved was read back once, past the cache.
        assert.deepStrictEqual(world.savedReads, ["invalidated", "read"]);
        // Published the approved commit, which the worktree still holds, clean.
        assert.strictEqual(yield* publishedOf(cwd), reviewed);
        assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
        assert.strictEqual(
          yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
      }),
    ),
  );

  it.effect("records a pull request already open for the branch", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.respond = () =>
          Effect.succeed(
            stackedResult({
              status: "opened_existing",
              url: "https://github.com/acme/alpha/pull/3",
              number: 3,
              baseBranch: "main",
              headBranch: branch,
              title: "feat: fd-aaaaaa an owner's earlier words",
            }),
          );
        // Written by someone else: it need not be what Factory would send, only comply.
        world.saved = () =>
          Effect.succeed({
            title: "feat: fd-aaaaaa an owner's earlier words",
            body: "An owner's earlier body.",
            headBranch: branch,
          });
        const { deliveryId } = yield* reviewAccepted(world);

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.isNull(state.awaiting);
        assert.deepStrictEqual(state.pullRequest, {
          number: 3,
          url: "https://github.com/acme/alpha/pull/3",
          headBranch: branch,
        });
        assert.strictEqual(world.calls.length, 1);
        assert.deepStrictEqual(
          world.dispatched.map((command) => command.type),
          ["thread.pull-request.link", "thread.pull-request.watch"],
        );
      }),
    ),
  );

  it.effect.each([
    {
      name: "the stacked action fails",
      respond: () =>
        Effect.fail(
          new GitManagerError({
            operation: "runPrStep",
            cwd: "/worktrees/item",
            detail: "remote: Permission to acme/alpha.git denied to ada (token ghp_secret).",
          }),
        ),
      tag: "GitManagerError",
    },
    {
      name: "the action reports a pull request without its number and URL",
      respond: () =>
        Effect.succeed(
          stackedResult({ status: "created", baseBranch: "main", headBranch: branch, title: "t" }),
        ),
      tag: "FactoryPullRequestNotOpenedError",
    },
  ] as const)("blocks with a fixed detail when $name", (testCase) =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.respond = testCase.respond;
        const { deliveryId } = yield* reviewAccepted(world);

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "pr");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 6, type: "open_pr" },
          detail: `Factory could not open the pull request (${testCase.tag}).`,
        });
        // No command output reaches the stored state.
        assert.notInclude(JSON.stringify(state), "ghp_secret");
        assert.notInclude(JSON.stringify(state), "Permission");
        assert.isNull(state.pullRequest);
        assert.strictEqual(world.calls.length, 1);
        assert.deepStrictEqual(world.dispatched, []);
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-1), [
          { stage: "pr", outcome: "blocked" },
        ]);
      }),
    ),
  );

  it.effect("ignores a repeated PR result once the pull request is open", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* reviewAccepted(world);
        yield* runEnds(deliveryId, reviewer, reviewRun);
        const open = yield* storedOf(deliveryId);
        assert.strictEqual(open.state.status, "pr_open");

        const worker = yield* FactoryWorker.FactoryWorker;
        for (const event of [
          {
            type: "pr.opened",
            effectId: 6,
            pullRequest: { number: 8, url: `${prUrl}8`, headBranch: "other" },
          },
          { type: "effect.failed", effectId: 6, detail: "Late." },
        ] as const) {
          const stepped = yield* worker.step(deliveryId, event);
          assert.deepStrictEqual(Option.getOrThrow(stepped), open);
        }
        yield* drain;
        // Nothing was written, and nothing ran again.
        assert.deepStrictEqual(yield* storedOf(deliveryId), open);
        assert.strictEqual(world.calls.length, 1);
      }),
    ),
  );

  it.effect.each([
    {
      name: "a commit added after the approval",
      change: (cwd: string) =>
        writeFile(cwd, "src/export.ts", "export const csv = 2;\n").pipe(
          Effect.andThen(git(cwd, ["add", "-A"])),
          Effect.andThen(commit(cwd, ["-m", "fix: write the header row"])),
        ),
      clean: true,
    },
    {
      name: "an uncommitted change",
      change: (cwd: string) => writeFile(cwd, "notes.txt", "scratch\n"),
      clean: false,
    },
  ] as const)("pushes nothing after $name", (testCase) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        yield* runEnds(deliveryId, reviewer, reviewRun);
        assert.strictEqual(world.calls.length, 1);
        yield* testCase.change(cwd);

        // Opened again for the stored delivery, as a later attempt would: the worktree no
        // longer holds the approved commit on a clean tree, so the action never runs.
        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
        );
        assert.deepStrictEqual(
          error,
          new FactoryPullRequest.FactoryPullRequestUnapprovedError({
            deliveryId,
            approvedSha: reviewed,
            headSha: yield* git(cwd, ["rev-parse", "HEAD"]),
            clean: testCase.clean,
          }),
        );
        assert.strictEqual(world.calls.length, 1);
      }),
    ),
  );

  it.effect.each([
    {
      name: "a verify command naming an AI tool",
      verifyArgs: ["tests/codex/verify.mjs"],
      item,
      problems: [{ target: "body", rule: "ai_name" }],
    },
    {
      name: "an item title naming an AI provider",
      verifyArgs: [],
      item: { ...item, title: "Port the export to the Claude adapter" },
      problems: [
        { target: "title", rule: "ai_name" },
        { target: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item link naming an AI provider",
      verifyArgs: [],
      item: { ...item, url: "https://github.com/openai/alpha/issues/3" },
      problems: [{ target: "body", rule: "ai_name" }],
    },
    {
      name: "an item title carrying attribution",
      verifyArgs: [],
      item: { ...item, title: "Add the export button, generated with a tool" },
      problems: [
        { target: "title", rule: "ai_attribution" },
        { target: "body", rule: "ai_attribution" },
      ],
    },
    {
      name: "a verify command naming another provider",
      verifyArgs: ["tests/grok/verify.mjs"],
      item,
      problems: [{ target: "body", rule: "ai_name" }],
    },
    {
      name: "an item title naming another provider",
      verifyArgs: [],
      item: { ...item, title: "Fix the OpenCode adapter" },
      problems: [
        { target: "title", rule: "ai_name" },
        { target: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting a named assistant",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: GitHub Copilot" },
      problems: [
        { target: "title", rule: "ai_name" },
        { target: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting the Cursor editor",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: Cursor <cursor@cursor.com>" },
      problems: [
        { target: "title", rule: "ai_name" },
        { target: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting an unnamed assistant",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: AI Assistant" },
      problems: [
        { target: "title", rule: "ai_attribution" },
        { target: "body", rule: "ai_attribution" },
      ],
    },
    {
      // A title takes its first line, while the body keeps the whole of it.
      name: "an item title crediting the Cursor editor on a folded line",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by:\n Cursor <c@example.com>" },
      problems: [{ target: "body", rule: "ai_name" }],
    },
    {
      name: "an item title crediting an assistant after a person's address",
      verifyArgs: [],
      item: { ...item, title: "Export. Co-authored-by: Ada <a@example.com> and AI Assistant" },
      problems: [
        { target: "title", rule: "ai_attribution" },
        { target: "body", rule: "ai_attribution" },
      ],
    },
  ] as const)("publishes nothing for $name", (testCase) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId } = yield* reviewAccepted(world, testCase.verifyArgs);
        // The item reads this way by the time its pull request is written.
        world.item = testCase.item as unknown as WorkItemDetail;

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "pr");
        assert.deepStrictEqual(world.calls, []);
        assert.strictEqual(yield* publishedOf(cwd), "");

        // The refusal names each field and rule, never the text that broke it.
        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
        );
        const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
          deliveryId,
          branch,
          problems: testCase.problems,
        });
        assert.deepStrictEqual(error, refusal);
        assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
        assert.notInclude(refusal.message, testCase.item.title);
        assert.include(refusal.message, "Change the item or the verify command, then Resume.");
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );

  it.effect.each([
    { name: "an unbroken identifier", title: "x".repeat(500) },
    { name: "a URL", title: `https://tracker.example.com/${"items/".repeat(20)}` },
  ])("publishes nothing rather than cut $name in its title", ({ title }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId } = yield* reviewAccepted(world);
        world.item = { ...item, title };

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(world.calls, []);
        assert.strictEqual(yield* publishedOf(cwd), "");
        const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
          deliveryId,
          branch,
          problems: [{ target: "title", rule: "malformed_title" }],
        });
        assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
        assert.include(refusal.message, "the first word of its title fit on one short line");
        assert.notInclude(refusal.message, title);
      }),
    ),
  );

  describe("the gate reads what the push would add to its remote", () => {
    const trailer = "Generated-by: a release tool";

    /** Sends `main` as it stands to `origin`, then commits on it through a hook, unpushed or not. */
    const onMain = (at: string, pushAfter: boolean) =>
      Effect.gen(function* () {
        yield* git(at, ["push", "origin", "main"]);
        yield* git(at, ["switch", "main"]);
        yield* commitThroughHook(at, trailer);
        if (pushAfter) yield* git(at, ["push", "origin", "main"]);
        yield* git(at, ["switch", "-C", branch]);
      }).pipe(Effect.orDie);

    /** What `origin` holds of `main`. */
    const mainOnOrigin = (cwd: string) =>
      git(cwd, ["ls-remote", "origin", "refs/heads/main"]).pipe(
        Effect.map((line) => line.split("\t")[0] ?? ""),
      );

    it.effect("refuses a commit nobody pushed under the approved one, changing nothing", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
            onMain(at, false),
          );
          // The project's HEAD was the unpushed commit, so the delivery truly started there.
          const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          assert.strictEqual((yield* stateOf(deliveryId)).baseline, ancestor);
          assert.strictEqual(yield* git(cwd, ["rev-parse", "main"]), ancestor);
          const message = yield* git(cwd, ["log", "-1", "--format=%B", ancestor]);
          const before = yield* storedOf(deliveryId);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(world.calls, []);
          assert.isNull(state.pullRequest);
          assert.strictEqual(state.baseline, before.state.baseline);
          // Nothing went out, on the delivery's branch or the one it started from.
          assert.strictEqual(yield* publishedOf(cwd), "");
          assert.strictEqual(yield* mainOnOrigin(cwd), root);
          // No commit or reference here moved.
          assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          assert.strictEqual(yield* git(cwd, ["rev-parse", "main"]), ancestor);
          assert.strictEqual(yield* git(cwd, ["log", "-1", "--format=%B", ancestor]), message);
          const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
            deliveryId,
            branch,
            problems: [
              { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
            ],
          });
          assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
          assert.include(refusal.message, "from before this delivery and not yet on its remote");
          assert.include(
            refusal.message,
            "Factory changes no commit: correct it on the branch this delivery started from, or put the project's checkout on a commit its remote already holds, then cancel this delivery and deliver the item again.",
          );
          // Never a way past the gate: publishing the refused commit by hand, or resuming over it.
          assert.notInclude(refusal.message, "yourself");
          assert.notInclude(refusal.message, "Resume");
          assert.notInclude(refusal.message, trailer);
        }),
      ),
    );

    it.effect("refuses the same commit on a recorded pull request's push", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
            onMain(at, false),
          );
          const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          yield* runEnds(deliveryId, reviewer, reviewRun);
          yield* storeChanged(deliveryId, (state) => ({
            ...state,
            pullRequest: { number: 7, url: prUrl, headBranch: branch },
          }));

          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const error = yield* Effect.flip(
            pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
          );

          assert.deepStrictEqual(
            error,
            new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: [
                { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
              ],
            }),
          );
          // No push, and no read of the host: what is local refuses it first.
          assert.deepStrictEqual(world.calls, []);
          assert.deepStrictEqual(world.savedReads, []);
          assert.strictEqual(yield* publishedOf(cwd), "");
          assert.strictEqual(yield* mainOnOrigin(cwd), root);
        }),
      ),
    );

    it.effect("still refuses a delivery's own commit its remote already holds", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
            commitThroughHook(at, trailer),
          );
          const own = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));
          yield* git(cwd, ["push", "origin", `${reviewed}:refs/heads/${branch}`]);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(world.calls, []);
          const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
            deliveryId,
            branch,
            problems: [{ target: "commit", rule: "ai_attribution", commit: own.slice(0, 12) }],
          });
          assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
        }),
      ),
    );

    it.effect("publishes from a base its remote holds, whatever that history says", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world, [], (at) =>
            onMain(at, true),
          );
          const shared = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          assert.include(yield* git(cwd, ["log", "-1", "--format=%B", shared]), trailer);
          assert.strictEqual(yield* mainOnOrigin(cwd), shared);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(world.calls[0]?.action, "create_pr");
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          assert.strictEqual(yield* mainOnOrigin(cwd), shared);
        }),
      ),
    );

    it.effect("publishes from a shared base after its remote's branch moved on unfetched", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world, [], (at) =>
            onMain(at, true),
          );
          const shared = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
          const later = yield* git(origin, [
            ...ada,
            "commit-tree",
            "-p",
            shared,
            "-m",
            "chore: later",
            `${shared}^{tree}`,
          ]);
          yield* git(origin, ["update-ref", "refs/heads/main", later]);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          assert.strictEqual(yield* mainOnOrigin(cwd), later);
          // Judged by that commit, brought here without moving what this repository tracks.
          assert.strictEqual(yield* git(cwd, ["cat-file", "-t", later]), "commit");
          assert.strictEqual(yield* git(cwd, ["rev-parse", "origin/main"]), shared);
          assert.strictEqual(yield* git(cwd, ["rev-parse", "main"]), shared);
        }),
      ),
    );

    describe("a remote named by an alias whose URL Git rewrites again", () => {
      /**
       * Two repositories and `origin` renamed to an alias Git rewrites to `pushed`, the one a push
       * reaches, whose own URL it rewrites to `next`, which any read handed `pushed` would reach
       * instead. `pushed` holds `pushedHolds` on its main and `next` holds `nextHolds`, both pushed
       * before the rules exist, as they would stand on their hosts.
       */
      const chained = (cwd: string, pushedHolds: string, nextHolds: string) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const pushed = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "fd-factory-pr-pushed-",
          });
          const next = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-next-" });
          yield* git(pushed, ["init", "--bare"]);
          yield* git(next, ["init", "--bare"]);
          yield* git(cwd, ["push", pushed, `${pushedHolds}:refs/heads/main`]);
          yield* git(cwd, ["push", next, `${nextHolds}:refs/heads/main`]);
          yield* git(cwd, ["remote", "set-url", "origin", "alias:alpha"]);
          yield* git(cwd, ["config", `url.${pushed}.insteadOf`, "alias:alpha"]);
          yield* git(cwd, ["config", `url.${next}.insteadOf`, pushed]);
          assert.strictEqual(yield* git(cwd, ["ls-remote", "--get-url", "--", pushed]), next);
          return { pushed, next };
        });

      /** Every ref of the worktree and both repositories, to show nothing moved. */
      const refsOf = (cwd: string, pushed: string, next: string) =>
        Effect.all([
          git(cwd, ["for-each-ref"]),
          git(pushed, ["for-each-ref"]),
          git(next, ["for-each-ref"]),
        ]);

      it.effect("refuses a commit only the next repository holds, opening nothing", () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
              onMain(at, false),
            );
            const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            const { pushed, next } = yield* chained(cwd, root, ancestor);
            const before = yield* refsOf(cwd, pushed, next);

            yield* runEnds(deliveryId, reviewer, reviewRun);

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.deepStrictEqual(world.calls, []);
            assert.isNull(state.pullRequest);
            const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: [
                { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
              ],
            });
            assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
            assert.deepStrictEqual(yield* refsOf(cwd, pushed, next), before);
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          }),
        ),
      );

      it.effect("refuses it on a recorded pull request's push too", () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
              onMain(at, false),
            );
            const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            const { pushed, next } = yield* chained(cwd, root, ancestor);
            yield* runEnds(deliveryId, reviewer, reviewRun);
            yield* storeChanged(deliveryId, (state) => ({
              ...state,
              pullRequest: { number: 7, url: prUrl, headBranch: branch },
            }));
            const stored = yield* storedOf(deliveryId);
            const before = yield* refsOf(cwd, pushed, next);

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            const error = yield* Effect.flip(pullRequests.open(stored, { id: 6, type: "open_pr" }));

            assert.deepStrictEqual(
              error,
              new FactoryPullRequest.FactoryPublicationRefusedError({
                deliveryId,
                branch,
                problems: [
                  { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
                ],
              }),
            );
            assert.deepStrictEqual(world.calls, []);
            assert.deepStrictEqual(world.savedReads, []);
            assert.deepStrictEqual(yield* refsOf(cwd, pushed, next), before);
            assert.deepStrictEqual(yield* storedOf(deliveryId), stored);
          }),
        ),
      );

      it.effect(
        "publishes over history the repository it reaches holds, whatever the next lacks",
        () =>
          withWorld((world) =>
            Effect.gen(function* () {
              const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
                onMain(at, false),
              );
              const shared = yield* git(cwd, ["rev-parse", "HEAD~1"]);
              const { pushed, next } = yield* chained(cwd, shared, root);

              yield* runEnds(deliveryId, reviewer, reviewRun);

              assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
              assert.deepStrictEqual(world.pushTargets, [
                { remoteName: "origin", branch, pushUrls: [pushed] },
              ]);
              assert.strictEqual(
                yield* git(pushed, [
                  "for-each-ref",
                  "--format=%(objectname)",
                  `refs/heads/${branch}`,
                ]),
                reviewed,
              );
              assert.strictEqual(
                yield* git(next, ["for-each-ref", "--format=%(refname)"]),
                "refs/heads/main",
              );
              // The history it holds from before the delivery stays as it was there.
              assert.strictEqual(yield* git(pushed, ["rev-parse", "main"]), shared);
            }),
          ),
      );
    });

    describe("a rule sending reads of the push URL elsewhere once the gate has it", () => {
      /**
       * `origin` pushed to `pushed` by a pushInsteadOf rule, which no later rule rewrites, so a
       * push of the branch reaches `pushed` whatever comes next, and a second repository,
       * `other`. `pushed` holds `pushedHolds` on its main and `other` holds `otherHolds`.
       */
      const pushedByRule = (cwd: string, pushedHolds: string, otherHolds: string) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const pushed = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "fd-factory-pr-pushed-",
          });
          const other = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "fd-factory-pr-other-",
          });
          yield* git(pushed, ["init", "--bare"]);
          yield* git(other, ["init", "--bare"]);
          yield* git(cwd, ["push", pushed, `${pushedHolds}:refs/heads/main`]);
          yield* git(cwd, ["push", other, `${otherHolds}:refs/heads/main`]);
          const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
          yield* git(cwd, ["config", `url.${pushed}.pushInsteadOf`, origin]);
          return { pushed, other };
        });

      /** The gate asking the destination what it holds, once it has read where the push goes. */
      const asksDestination = (args: ReadonlyArray<string>) =>
        args[0] === "ls-remote" && args.includes("--refs");

      /** Then a read Git is handed `pushed` reaches `other`; a push still reaches `pushed`. */
      const readsGoElsewhere = (cwd: string, pushed: string, other: string) =>
        git(cwd, ["config", `url.${other}.insteadOf`, pushed]);

      const refsOf = (cwd: string, pushed: string, other: string) =>
        Effect.all([
          git(cwd, ["for-each-ref"]),
          git(pushed, ["for-each-ref"]),
          git(other, ["for-each-ref"]),
        ]);

      const refusalOf = (deliveryId: FactoryDeliveryId, ancestor: string) =>
        new FactoryPullRequest.FactoryPublicationRefusedError({
          deliveryId,
          branch,
          problems: [{ target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) }],
        });

      it.effect("refuses a commit only the other repository holds, opening nothing", () =>
        withWorld((world) =>
          Effect.gen(function* () {
            world.pushesThroughDriver = true;
            const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
              onMain(at, false),
            );
            const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            const { pushed, other } = yield* pushedByRule(cwd, root, ancestor);
            const hold = yield* holdFirst(asksDestination);
            world.beforeGit = hold.before;
            const before = yield* refsOf(cwd, pushed, other);

            const ending = yield* runEnds(deliveryId, reviewer, reviewRun).pipe(Effect.forkChild);
            yield* hold.changeThere(readsGoElsewhere(cwd, pushed, other));
            yield* Fiber.join(ending);

            // The rule is in force: asked at `pushed` without the pin, Git would have read `other`.
            assert.strictEqual(yield* git(cwd, ["ls-remote", "--get-url", "--", pushed]), other);
            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.deepStrictEqual(world.calls, []);
            assert.isNull(state.pullRequest);
            assert.deepStrictEqual(
              state.block,
              refusedBlock(refusalOf(deliveryId, ancestor).message),
            );
            assert.deepStrictEqual(yield* refsOf(cwd, pushed, other), before);
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          }),
        ),
      );

      it.effect("refuses it on a recorded pull request's push too", () =>
        withWorld((world) =>
          Effect.gen(function* () {
            world.pushesThroughDriver = true;
            const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
              onMain(at, false),
            );
            const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            const { pushed, other } = yield* pushedByRule(cwd, root, ancestor);
            yield* runEnds(deliveryId, reviewer, reviewRun);
            yield* storeChanged(deliveryId, (state) => ({
              ...state,
              pullRequest: { number: 7, url: prUrl, headBranch: branch },
            }));
            const stored = yield* storedOf(deliveryId);
            const hold = yield* holdFirst(asksDestination);
            world.beforeGit = hold.before;
            const before = yield* refsOf(cwd, pushed, other);

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            const opening = yield* Effect.flip(
              pullRequests.open(stored, { id: 6, type: "open_pr" }),
            ).pipe(Effect.forkChild);
            yield* hold.changeThere(readsGoElsewhere(cwd, pushed, other));
            const error = yield* Fiber.join(opening);

            assert.deepStrictEqual(error, refusalOf(deliveryId, ancestor));
            // No push, and no read of the host: what is local refuses it first.
            assert.deepStrictEqual(world.calls, []);
            assert.deepStrictEqual(world.savedReads, []);
            assert.deepStrictEqual(yield* refsOf(cwd, pushed, other), before);
            assert.deepStrictEqual(yield* storedOf(deliveryId), stored);
          }),
        ),
      );

      it.effect(
        "publishes over history the repository it pushes to holds, read there all along",
        () =>
          withWorld((world) =>
            Effect.gen(function* () {
              world.pushesThroughDriver = true;
              const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
                onMain(at, false),
              );
              const shared = yield* git(cwd, ["rev-parse", "HEAD~1"]);
              const { pushed, other } = yield* pushedByRule(cwd, shared, root);
              const hold = yield* holdFirst(asksDestination);
              world.beforeGit = hold.before;

              const ending = yield* runEnds(deliveryId, reviewer, reviewRun).pipe(Effect.forkChild);
              yield* hold.changeThere(readsGoElsewhere(cwd, pushed, other));
              yield* Fiber.join(ending);

              assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
              assert.deepStrictEqual(world.pushTargets, [
                { remoteName: "origin", branch, pushUrls: [pushed] },
              ]);
              assert.strictEqual(
                yield* git(pushed, [
                  "for-each-ref",
                  "--format=%(objectname)",
                  `refs/heads/${branch}`,
                ]),
                reviewed,
              );
              assert.strictEqual(
                yield* git(other, ["for-each-ref", "--format=%(refname)"]),
                "refs/heads/main",
              );
            }),
          ),
      );
    });

    describe("a tracking ref its remote no longer bears out", () => {
      /** A remote holding only `root` on `main`, with nothing else. */
      const holdingOnlyRoot = (cwd: string, root: string) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const other = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "fd-factory-pr-other-",
          });
          yield* git(other, ["init", "--bare"]);
          yield* git(cwd, ["push", other, `${root}:refs/heads/main`]);
          return other;
        });

      const changes = [
        {
          name: "its branch was rewound",
          arrange: (cwd: string, root: string) =>
            git(cwd, ["remote", "get-url", "origin"]).pipe(
              Effect.flatMap((origin) => git(origin, ["update-ref", "refs/heads/main", root])),
            ),
        },
        {
          name: "its branch was rewritten to a commit not here",
          arrange: (cwd: string, root: string) =>
            Effect.gen(function* () {
              const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
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
        {
          name: "it now names another repository",
          arrange: (cwd: string, root: string) =>
            Effect.gen(function* () {
              yield* git(cwd, ["remote", "set-url", "origin", yield* holdingOnlyRoot(cwd, root)]);
            }),
        },
      ];

      it.effect.each(changes)("refuses what only that ref vouches for once $name", ({ arrange }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
              onMain(at, true),
            );
            const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            yield* arrange(cwd, root);
            // The local record still says the remote holds it, and stays that way.
            assert.strictEqual(yield* git(cwd, ["rev-parse", "origin/main"]), ancestor);

            yield* runEnds(deliveryId, reviewer, reviewRun);

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.deepStrictEqual(world.calls, []);
            assert.isNull(state.pullRequest);
            assert.strictEqual(yield* publishedOf(cwd), "");
            assert.strictEqual(yield* git(cwd, ["rev-parse", "origin/main"]), ancestor);
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
            const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: [
                { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
              ],
            });
            assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
          }),
        ),
      );

      it.effect.each(changes)(
        "refuses it on a recorded pull request's push once $name",
        ({ arrange }) =>
          withWorld((world) =>
            Effect.gen(function* () {
              const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
                onMain(at, true),
              );
              const ancestor = yield* git(cwd, ["rev-parse", "HEAD~1"]);
              yield* arrange(cwd, root);
              yield* runEnds(deliveryId, reviewer, reviewRun);
              yield* storeChanged(deliveryId, (state) => ({
                ...state,
                pullRequest: { number: 7, url: prUrl, headBranch: branch },
              }));

              const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
              const error = yield* Effect.flip(
                pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
              );

              assert.deepStrictEqual(
                error,
                new FactoryPullRequest.FactoryPublicationRefusedError({
                  deliveryId,
                  branch,
                  problems: [
                    { target: "ancestor", rule: "ai_attribution", commit: ancestor.slice(0, 12) },
                  ],
                }),
              );
              assert.deepStrictEqual(world.calls, []);
              assert.strictEqual(yield* publishedOf(cwd), "");
            }),
          ),
      );
    });

    it.effect("publishes a compliant commit nobody pushed, which types nothing of its title", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world, [], (at) =>
            Effect.gen(function* () {
              yield* writeFile(at, "src/old.ts", "export const old = 1;\n");
              yield* git(at, ["add", "-A"]);
              yield* commit(at, ["-m", "feat(api)!: drop the old export"]);
            }).pipe(Effect.orDie),
          );

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          assert.strictEqual(world.calls[0]?.prTitle, "feat: fd-aaaaaa Add the export button");
        }),
      ),
    );

    it.effect.each([
      {
        name: "a remote that cannot be read",
        arrange: (cwd: string) =>
          git(cwd, ["remote", "set-url", "origin", `${cwd}/no-such-repository`]),
      },
      { name: "no remote", arrange: (cwd: string) => git(cwd, ["remote", "remove", "origin"]) },
    ])("publishes nothing with $name, since it cannot tell what would go out", ({ arrange }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          yield* arrange(cwd);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(world.calls, []);
          assert.isNull(state.pullRequest);
          assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          const refusal = new FactoryPullRequest.FactoryPublicationRefusedError({
            deliveryId,
            branch,
            problems: [{ target: "destination", rule: "unreadable" }],
          });
          assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
          assert.include(
            refusal.message,
            "Check that its branch has a remote and that Factory can reach it, then Resume.",
          );
        }),
      ),
    );
  });

  describe("the gate reads every commit right before the action", () => {
    // Each as Git reads it: `git interpret-trailers --parse` unfolds these into one credit.
    const refusedCredits = [
      {
        name: "the editor credited on the next line",
        trailer: "Co-authored-by:\n Cursor <editor@example.com>",
      },
      {
        name: "the editor credited on the next line after a tab",
        trailer: "Co-authored-by:\n\tCursor <editor@example.com>",
      },
      {
        name: "the editor credited on the next CRLF line",
        trailer: "Co-authored-by:\r\n Cursor <editor@example.com>",
      },
      {
        name: "an assistant signing off on the next line",
        trailer: "Signed-off-by:\n AI Assistant <assistant@example.com>",
      },
      {
        name: "an assistant signing off on the next CRLF line after a tab",
        trailer: "Signed-off-by:\r\n\tAI Assistant <assistant@example.com>",
      },
      {
        name: "the editor after a person's address",
        trailer: "Co-authored-by: Ada Lovelace <ada@example.com> and Cursor",
      },
      {
        name: "the editor as a second addressed party",
        trailer: "Co-authored-by: Ada Lovelace <ada@example.com>, Cursor <cursor@example.com>",
      },
      {
        name: "an assistant after a person's address",
        trailer: "Co-authored-by: Ada Lovelace <ada@example.com> and AI Assistant",
      },
      {
        name: "an assistant after a person's address, on the next line",
        trailer: "Co-authored-by: Ada Lovelace <ada@example.com>\n and AI Assistant",
      },
      {
        name: "the editor credited with a space before the colon",
        trailer: "Co-authored-by : Cursor <editor@example.com>",
      },
      {
        name: "an assistant signing off with a space before the colon",
        trailer: "Signed-off-by : AI Assistant <helper@example.com>",
      },
      {
        name: "the editor credited with a tab before the colon, on the next line",
        trailer: "Co-authored-by\t:\n Cursor <editor@example.com>",
      },
      {
        name: "the editor's credit folded into a person's sign-off",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Cursor <editor@example.com>",
      },
      {
        name: "the editor's credit after a person's sign-off on one line",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: Cursor <editor@example.com>",
      },
      {
        name: "an assistant's credit folded into a person's sign-off",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: AI Assistant <helper@example.com>",
      },
      { name: "the editor's help", trailer: "Helped-by: Cursor <e@example.com>" },
      { name: "an assistant's help", trailer: "Helped-by: AI Assistant <helper@example.com>" },
      {
        name: "the editor after a person's bare address",
        trailer: "Co-authored-by: ada+cursor@example.com and Cursor",
      },
      {
        name: "an assistant after a person's bare address",
        trailer: "Co-authored-by: ada+ai@example.com, AI Assistant <helper@example.com>",
      },
      { name: "the editor's suggestion", trailer: "Suggested-by: Cursor <e@example.com>" },
      { name: "the editor's report", trailer: "Reported-by: Cursor <e@example.com>" },
      {
        name: "an assistant's suggestion",
        trailer: "Suggested-by: AI Assistant <helper@example.com>",
      },
      { name: "an assistant's report", trailer: "Reported-by: AI Assistant <helper@example.com>" },
      {
        name: "the editor's suggestion with a space before the colon",
        trailer: "Suggested-by : Cursor <e@example.com>",
      },
      {
        name: "the editor's report on the next line after a tab",
        trailer: "Reported-by:\n\tCursor <e@example.com>",
      },
      {
        name: "the editor's report folded into a person's sign-off",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Reported-by: Cursor <e@example.com>",
      },
      {
        name: "an assistant's suggestion after a person's sign-off on one line",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com> Suggested-by: AI Assistant <helper@example.com>",
      },
    ];

    const passedCredits = [
      {
        name: "a human co-author on the next line",
        trailer: "Co-authored-by:\n Ada Lovelace <ada@example.com>",
      },
      {
        name: "a sign-off by a person called Ai on the next CRLF line",
        trailer: "Signed-off-by:\r\n Ai Nguyen <ai.nguyen@example.com>",
      },
      {
        name: "a person with the editor's name as a surname on the next line after a tab",
        trailer: "Co-authored-by:\n\tAda Cursor <ada@example.com>",
      },
      {
        name: "two people on one line",
        trailer:
          "Co-authored-by: Ada Lovelace <ada@example.com>, Ai Nguyen <ai.nguyen@example.com>",
      },
      {
        name: "two people joined by a word",
        trailer: "Signed-off-by: Ada Lovelace <ada@example.com> and Ada Cursor <ada.c@example.com>",
      },
      {
        name: "a human co-author with a space before the colon",
        trailer: "Co-authored-by : Ada Cursor <ada@example.com>",
      },
      {
        name: "a sign-off with a tab before the colon",
        trailer: "Signed-off-by\t: Ada Lovelace <ada@example.com>",
      },
      {
        name: "a human co-author folded into a sign-off",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Grace Hopper <grace@example.com>",
      },
      {
        name: "a human co-author after a sign-off on one line",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
      },
      { name: "a person's help", trailer: "Helped-by: Ada Cursor <ada@example.com>" },
      { name: "a bare address with a plus", trailer: "Co-authored-by: ada+cursor@example.com" },
      { name: "another bare address with a plus", trailer: "Co-authored-by: ada+ai@example.com" },
      {
        name: "a bracketed address with a plus",
        trailer: "Co-authored-by: Ada Lovelace <ada+cursor@example.com>",
      },
      {
        name: "a bare address with a plus on the next line",
        trailer: "Co-authored-by:\n ada+cursor@example.com",
      },
      {
        name: "a bare address with a plus folded into a sign-off",
        trailer:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: ada+cursor@example.com",
      },
      { name: "a person's suggestion", trailer: "Suggested-by: Ada Cursor <ada@example.com>" },
      {
        name: "a report by a person called Ai",
        trailer: "Reported-by: Ai Nguyen <ai.nguyen@example.com>",
      },
      {
        name: "a report from a bare address with a plus, on the next line",
        trailer: "Reported-by:\n ada+cursor@example.com",
      },
    ];

    it.effect.each(refusedCredits)(
      "pushes nothing to a recorded pull request when its hook added $name",
      ({ trailer }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
              commitThroughHook(at, trailer),
            );
            const earlier = yield* git(cwd, ["rev-parse", "HEAD~1"]);
            const message = yield* git(cwd, ["log", "-1", "--format=%B", earlier]);
            assert.include(message, trailer);
            yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));
            yield* runEnds(deliveryId, reviewer, reviewRun);
            yield* storeChanged(deliveryId, (state) => ({
              ...state,
              pullRequest: { number: 7, url: prUrl, headBranch: branch },
            }));

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            const error = yield* Effect.flip(
              pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
            );

            assert.isTrue(FactoryPullRequest.isFactoryPublicationRefusedError(error));
            assert.include(error.message, `commit ${earlier.slice(0, 12)} `);
            assert.notInclude(error.message, trailer);
            // No push, and no read of the host: what is local refuses it first.
            assert.deepStrictEqual(world.calls, []);
            assert.deepStrictEqual(world.savedReads, []);
            assert.strictEqual(yield* publishedOf(cwd), "");
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
            assert.strictEqual(yield* git(cwd, ["log", "-1", "--format=%B", earlier]), message);
          }),
        ),
    );

    it.effect.each(passedCredits)(
      "still pushes a recorded pull request when its hook added $name",
      ({ trailer }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
              commitThroughHook(at, trailer),
            );
            yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));
            yield* runEnds(deliveryId, reviewer, reviewRun);
            assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            yield* pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" });

            assert.deepStrictEqual(
              world.calls.map(({ action }) => action),
              ["create_pr", "push"],
            );
            assert.strictEqual(yield* publishedOf(cwd), reviewed);
          }),
        ),
    );

    it.effect.each([
      {
        name: "a co-author naming a tool",
        trailer: "Co-authored-by: Claude <noreply@anthropic.com>",
      },
      { name: "a sign-off by a tool", trailer: "Signed-off-by: Cursor <cursoragent@cursor.com>" },
      { name: "generated attribution", trailer: "Generated-by: a release tool" },
      { name: "a generated-with trailer", trailer: "Made-with: Cursor" },
      {
        name: "an assistant as co-author",
        trailer: "Co-authored-by: AI Assistant <assistant@example.com>",
      },
      { name: "a co-author who is only called Ai", trailer: "Co-authored-by: Ai <ai@example.com>" },
      {
        name: "a person's name on an assistant's address",
        trailer: "Co-authored-by: Ai Nguyen <assistant@example.com>",
      },
      {
        name: "the editor credited beside a person",
        trailer: "Co-authored-by: Ada Lovelace and Cursor <ada@example.com>",
      },
      {
        name: "a person's name on the editor's address",
        trailer: "Signed-off-by: Ada Cursor <cursor@example.com>",
      },
      ...refusedCredits,
    ])("refuses a commit whose hook added $name, changing nothing", ({ trailer }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
            commitThroughHook(at, trailer),
          );
          const earlier = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          const message = yield* git(cwd, ["log", "-1", "--format=%B", earlier]);
          // A real hook wrote it: nothing in the commit command asked for the trailer.
          assert.include(message, trailer);
          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));
          const before = yield* git(cwd, ["rev-parse", "HEAD"]);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(world.calls, []);
          assert.strictEqual(yield* publishedOf(cwd), "");
          assert.isNull(state.pullRequest);
          const detail =
            state.block?.reason === "effect_failed" ? state.block.detail : assert.fail("No block.");
          assert.include(detail, `commit ${earlier.slice(0, 12)} `);
          assert.include(detail, "Factory changes no commit");
          // The refusal does not quote the message that broke the rule.
          assert.notInclude(detail, trailer);
          // No commit was modified.
          assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), before);
          assert.strictEqual(yield* git(cwd, ["log", "-1", "--format=%B", earlier]), message);
        }),
      ),
    );

    it.effect.each([
      { name: "a human co-author", trailer: "Co-authored-by: Ada Lovelace <ada@example.com>" },
      { name: "a sign-off", trailer: "Signed-off-by: Ada Lovelace <ada@example.com>" },
      { name: "a verified task reference", trailer: "Refs: fd-aaaaaa" },
      {
        name: "a human co-author called Ai",
        trailer: "Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
      },
      {
        name: "a human co-author with the editor's name as a surname",
        trailer: "Co-authored-by: Ada Cursor <ada@example.com>",
      },
      {
        name: "a sign-off by that person",
        trailer: "Signed-off-by: Ada Cursor <ada@example.com>",
      },
      ...passedCredits,
    ])("publishes a commit whose hook added $name", ({ trailer }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root, reviewed } = yield* reviewAccepted(world, [], (at) =>
            commitThroughHook(at, trailer),
          );
          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(world.calls[0]?.action, "create_pr");
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
        }),
      ),
    );

    const identityOf = (author: string, committer: string) => [
      "-c",
      `author.name=${author}`,
      "-c",
      "author.email=ada@example.com",
      "-c",
      `committer.name=${committer}`,
      "-c",
      "committer.email=ada@example.com",
    ];

    it.effect.each([
      { name: "an author named for a provider", author: "Claude", committer: "Ada Lovelace" },
      { name: "an author called Cursor", author: "Cursor", committer: "Ada Lovelace" },
      { name: "a committer called Cursor", author: "Ada Lovelace", committer: "Cursor" },
      { name: "an author called AI Assistant", author: "AI Assistant", committer: "Ada Lovelace" },
      {
        name: "a committer called AI Assistant",
        author: "Ada Lovelace",
        committer: "AI Assistant",
      },
    ])("refuses $name before the action", ({ author: authorName, committer }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
            commitThroughHook(at, "Refs: fd-aaaaaa", identityOf(authorName, committer)),
          );
          const earlier = yield* git(cwd, ["rev-parse", "HEAD~1"]);
          assert.strictEqual(
            yield* git(cwd, ["log", "-1", "--format=%an|%cn", earlier]),
            `${authorName}|${committer}`,
          );
          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.deepStrictEqual(world.calls, []);
          assert.strictEqual(yield* publishedOf(cwd), "");
          assert.include(
            state.block?.reason === "effect_failed" ? state.block.detail : "",
            `commit ${earlier.slice(0, 12)} has an author or committer identity naming an AI agent, model or provider`,
          );
        }),
      ),
    );

    it.effect.each([
      { name: "Ada Cursor", person: "Ada Cursor" },
      { name: "Ai Nguyen", person: "Ai Nguyen" },
    ])("publishes a commit by a person called $name", ({ person }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { deliveryId, root } = yield* reviewAccepted(world, [], (at) =>
            commitThroughHook(at, "Refs: fd-aaaaaa", identityOf(person, person)),
          );
          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: root }));

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(world.calls[0]?.action, "create_pr");
        }),
      ),
    );

    it.effect("reads no commit past the approved one, which the action does not publish", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          // Inside the action, after the gate: a message it could not have read, and need not.
          world.beforePush = yield* captured(
            writeFile(cwd, "src/export.ts", "export const csv = 2;\n").pipe(
              Effect.andThen(git(cwd, ["add", "-A"])),
              Effect.andThen(commit(cwd, ["-m", "Not conventional, and never published"])),
            ),
          );

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
        }),
      ),
    );

    it.effect("refuses a worktree off the delivery's branch, or a delivery with no baseline", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId } = yield* reviewAccepted(world);
          yield* runEnds(deliveryId, reviewer, reviewRun);
          yield* storeChanged(deliveryId, (state) => ({ ...state, pullRequest: null }));
          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const effect = { id: 6, type: "open_pr" } as const;

          yield* git(cwd, ["switch", "-c", "feature/other"]);
          const offBranch = yield* Effect.flip(
            pullRequests.open(yield* storedOf(deliveryId), effect),
          );
          assert.deepStrictEqual(
            offBranch,
            new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: [{ target: "branch", rule: "wrong_branch" }],
            }),
          );
          assert.include(offBranch.message, "Put the worktree back on its branch, then Resume.");
          yield* git(cwd, ["switch", branch]);

          yield* storeChanged(deliveryId, (state) => ({ ...state, baseline: null }));
          assert.deepStrictEqual(
            yield* Effect.flip(pullRequests.open(yield* storedOf(deliveryId), effect)),
            new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: [{ target: "commits", rule: "baseline_missing" }],
            }),
          );
          assert.strictEqual(world.calls.length, 1);
        }),
      ),
    );
  });

  describe("the gate judges the remote branch a push lands on", () => {
    // The delivery's branch without its `feature/` prefix.
    const head = branch.slice("feature/".length);

    const bareRemote = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-other-" });
      yield* git(remote, ["init", "--bare"]);
      return remote;
    });

    /** Every ref and local setting of the worktree, and every ref of `origin` and `other`. */
    const everything = (cwd: string, other: string) =>
      Effect.gen(function* () {
        const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
        return yield* Effect.all([
          git(cwd, ["for-each-ref"]),
          git(cwd, ["config", "--list", "--local"]),
          git(origin, ["for-each-ref"]),
          git(other, ["for-each-ref"]),
        ]);
      });

    // How Git publishes `feature/<x>` as `<x>`, by the driver's own rules (branchFacts.test.ts).
    const redirections = [
      {
        name: "on origin without its prefix, once a remote is called feature",
        arrange: (cwd: string, other: string) => git(cwd, ["remote", "add", "feature", other]),
        remote: "origin",
      },
      {
        name: "on the head of an upstream it aliases",
        arrange: (cwd: string, other: string) =>
          Effect.gen(function* () {
            yield* git(cwd, ["remote", "add", "my-org/feature", other]);
            yield* git(cwd, ["push", "my-org/feature", `HEAD~1:refs/heads/${head}`]);
            yield* git(cwd, ["fetch", "my-org/feature"]);
            yield* git(cwd, ["branch", "--set-upstream-to", `my-org/feature/${head}`]);
          }),
        remote: "my-org/feature",
      },
    ];

    const refusalOf = (deliveryId: FactoryDeliveryId, remote: string) =>
      new FactoryPullRequest.FactoryPublicationRefusedError({
        deliveryId,
        branch,
        problems: [{ target: "remote_branch", rule: "branch_prefix", remote, branch: head }],
      });

    it.effect.each(redirections)(
      "opens nothing and pushes nothing when its push would land $name",
      ({ arrange, remote }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            const other = yield* bareRemote;
            yield* arrange(cwd, other);
            const before = yield* everything(cwd, other);

            yield* runEnds(deliveryId, reviewer, reviewRun);

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.isNull(state.pullRequest);
            assert.deepStrictEqual(world.calls, []);
            const refusal = refusalOf(deliveryId, remote);
            assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
            assert.include(
              refusal.message,
              `a push of its branch would land on "${remote}"'s branch "${head}", which has no feature/, bugfix/, chore/ or docs/ prefix`,
            );
            assert.include(refusal.message, "Factory changes no remote, upstream or branch");
            assert.notInclude(refusal.message, "yourself");
            // Nothing went out anywhere, and no ref, setting or commit here moved.
            assert.deepStrictEqual(yield* everything(cwd, other), before);
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
            assert.strictEqual(yield* git(cwd, ["branch", "--show-current"]), branch);
          }),
        ),
    );

    it.effect.each(redirections)(
      "pushes nothing to a recorded pull request once its push would land $name",
      ({ arrange, remote }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            yield* runEnds(deliveryId, reviewer, reviewRun);
            assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
            // As a branch the owner untracked, or tracked elsewhere, would publish.
            yield* git(cwd, ["branch", "--unset-upstream"]);
            const other = yield* bareRemote;
            yield* arrange(cwd, other);
            const stored = yield* storedOf(deliveryId);
            const before = yield* everything(cwd, other);
            const reads = world.savedReads.length;
            const links = world.dispatched.length;

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            const error = yield* Effect.flip(pullRequests.open(stored, { id: 6, type: "open_pr" }));

            assert.deepStrictEqual(error, refusalOf(deliveryId, remote));
            // No push and no read of the host: where the push lands refuses it first.
            assert.strictEqual(world.calls.length, 1);
            assert.strictEqual(world.savedReads.length, reads);
            assert.strictEqual(world.dispatched.length, links);
            // Its pull request's branch, link, commits and record are as they were.
            assert.strictEqual(yield* publishedOf(cwd), reviewed);
            assert.deepStrictEqual(yield* everything(cwd, other), before);
            assert.deepStrictEqual(yield* storedOf(deliveryId), stored);
            assert.deepStrictEqual(stored.state.pullRequest, {
              number: 7,
              url: prUrl,
              headBranch: branch,
            });
          }),
        ),
    );

    it.effect("publishes to a pushRemote under its own name, and pushes there afterwards", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          const fork = yield* bareRemote;
          yield* git(cwd, ["remote", "add", "fork", fork]);
          yield* git(cwd, ["config", `branch.${branch}.pushRemote`, "fork"]);

          yield* runEnds(deliveryId, reviewer, reviewRun);
          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const published = yield* pullRequests.open(yield* storedOf(deliveryId), {
            id: 6,
            type: "open_pr",
          });

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.isUndefined(published.publicationFailure);
          assert.deepStrictEqual(world.pushTargets, [
            { remoteName: "fork", branch, pushUrls: [fork] },
            { remoteName: "fork", branch, pushUrls: [fork] },
          ]);
          // The commit is on the fork, under the branch's own name, and not on origin.
          assert.strictEqual(
            yield* git(fork, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]),
            reviewed,
          );
          assert.strictEqual(yield* publishedOf(cwd), "");
        }),
      ),
    );

    it.effect("publishes to an upstream on another remote that it tracks under its own name", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          const other = yield* bareRemote;
          yield* git(cwd, ["remote", "add", "my-org", other]);
          yield* git(cwd, ["push", "my-org", `HEAD~1:refs/heads/${branch}`]);
          yield* git(cwd, ["fetch", "my-org"]);
          yield* git(cwd, ["branch", "--set-upstream-to", `my-org/${branch}`]);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          assert.deepStrictEqual(world.pushTargets, [
            { remoteName: "my-org", branch, pushUrls: [other] },
          ]);
          assert.strictEqual(
            yield* git(other, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]),
            reviewed,
          );
        }),
      ),
    );
  });

  describe("the push goes only where the gate judged", () => {
    const bare = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const other = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-pr-url-" });
      yield* git(other, ["init", "--bare"]);
      return other;
    });

    // Each keeps `origin` and the branch the push lands on there, and sends the push elsewhere.
    const urlChanges = [
      {
        name: "its push URL is edited",
        change: (cwd: string, _origin: string, other: string) =>
          git(cwd, ["remote", "set-url", "--push", "origin", other]),
      },
      {
        name: "a rewrite rule sends its URL elsewhere",
        change: (cwd: string, origin: string, other: string) =>
          git(cwd, ["config", `url.${other}.pushInsteadOf`, origin]),
      },
    ];

    const changedRefusal = (deliveryId: FactoryDeliveryId) =>
      new FactoryPullRequest.FactoryPublicationRefusedError({
        deliveryId,
        branch,
        problems: [{ target: "destination", rule: "changed" }],
      });

    it.effect.each(urlChanges)(
      "opens nothing and pushes nothing once $name after the gate read it",
      ({ change }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            world.pushesThroughDriver = true;
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
            const other = yield* bare;
            // Inside the action, after the gate read what the push would add at `origin`.
            world.beforePush = yield* captured(change(cwd, origin, other));
            const before = yield* Effect.all([
              git(cwd, ["for-each-ref"]),
              git(origin, ["for-each-ref"]),
            ]);

            yield* runEnds(deliveryId, reviewer, reviewRun);

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.isNull(state.pullRequest);
            assert.strictEqual(world.calls.length, 1);
            // The remote and branch are what the gate judged; only where Git sends them is not.
            assert.deepStrictEqual(world.pushTargets, [
              { remoteName: "origin", branch, pushUrls: [origin] },
            ]);
            const refusal = changedRefusal(deliveryId);
            assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
            assert.strictEqual(
              refusal.message,
              "Factory published nothing it had not judged: where a push of its branch goes, its remote, upstream or push URLs, changed after Factory judged what the push would add there. Factory pushes only where it judged, and goes no further once that changes: keep or restore the remote, upstream and push URLs its branch should publish to, then Resume, which judges that destination again before pushing.",
            );
            // Nothing went out, to either repository, and no ref here moved.
            assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
            assert.deepStrictEqual(
              yield* Effect.all([git(cwd, ["for-each-ref"]), git(origin, ["for-each-ref"])]),
              before,
            );
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          }),
        ),
    );

    it.effect.each(urlChanges)(
      "pushes nothing to a recorded pull request once $name after the gate read it",
      ({ change }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            world.pushesThroughDriver = true;
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            yield* runEnds(deliveryId, reviewer, reviewRun);
            assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
            const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
            const other = yield* bare;
            world.beforePush = yield* captured(change(cwd, origin, other));
            const stored = yield* storedOf(deliveryId);
            const before = yield* Effect.all([
              git(cwd, ["for-each-ref"]),
              git(cwd, ["config", "--get-regexp", "^branch\\."]),
              git(origin, ["for-each-ref"]),
            ]);
            const links = world.dispatched.length;

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            const error = yield* Effect.flip(pullRequests.open(stored, { id: 6, type: "open_pr" }));

            assert.deepStrictEqual(error, changedRefusal(deliveryId));
            assert.deepStrictEqual(
              world.calls.map(({ action }) => action),
              ["create_pr", "push"],
            );
            assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
            assert.deepStrictEqual(
              yield* Effect.all([
                git(cwd, ["for-each-ref"]),
                git(cwd, ["config", "--get-regexp", "^branch\\."]),
                git(origin, ["for-each-ref"]),
              ]),
              before,
            );
            // Its pull request, link and record are as they were.
            assert.strictEqual(yield* publishedOf(cwd), reviewed);
            assert.strictEqual(world.dispatched.length, links);
            assert.deepStrictEqual(yield* storedOf(deliveryId), stored);
          }),
        ),
    );

    describe("once where it goes changes after the push last read it", () => {
      /** The branch tracking `origin/main`, as one cut from it does: its push records that base. */
      const cutFromMain = (cwd: string) =>
        Effect.gen(function* () {
          yield* git(cwd, ["push", "origin", "main"]);
          yield* git(cwd, ["fetch", "origin"]);
          yield* git(cwd, ["branch", "--set-upstream-to", "origin/main"]);
        });

      /** The commit `at` holds for the delivery branch; empty when it holds none. */
      const branchAt = (at: string) =>
        git(at, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);

      it.effect("sends nothing elsewhere and opens nothing once its push URL moves mid-push", () =>
        withWorld((world) =>
          Effect.gen(function* () {
            world.pushesThroughDriver = true;
            let answered = 0;
            world.respond = () => Effect.sync(() => answered++).pipe(Effect.as(created));
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            yield* cutFromMain(cwd);
            const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
            const other = yield* bare;
            // As the push records the base it was cut from, after it last read where it goes.
            const hold = yield* holdFirst(
              (args) => args[0] === "config" && args[1] === `branch.${branch}.t3-merge-base`,
            );
            world.beforeGit = hold.before;

            const ending = yield* runEnds(deliveryId, reviewer, reviewRun).pipe(Effect.forkChild);
            yield* hold.changeThere(git(cwd, ["remote", "set-url", "--push", "origin", other]));
            yield* Fiber.join(ending);

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.isNull(state.pullRequest);
            assert.deepStrictEqual(world.pushTargets, [
              { remoteName: "origin", branch, pushUrls: [origin] },
            ]);
            const refusal = changedRefusal(deliveryId);
            assert.deepStrictEqual(state.block, refusedBlock(refusal.message));
            assert.include(refusal.message, "Factory published nothing it had not judged");
            // No pull request was asked for, nothing reached where the push would now go, and the
            // approved commit went only where the gate judged.
            assert.strictEqual(answered, 0);
            assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
            assert.strictEqual(yield* branchAt(origin), reviewed);
          }),
        ),
      );

      it.effect(
        "pushes a recorded pull request's branch nowhere else once a rule moves it mid-push",
        () =>
          withWorld((world) =>
            Effect.gen(function* () {
              world.pushesThroughDriver = true;
              const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
              yield* cutFromMain(cwd);
              yield* runEnds(deliveryId, reviewer, reviewRun);
              assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
              const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
              const other = yield* bare;
              const stored = yield* storedOf(deliveryId);
              const links = world.dispatched.length;
              // As its push starts, after it last read where it goes.
              const hold = yield* holdFirst(
                (args) =>
                  args[0] === "push" && (args.at(-1)?.endsWith(`:refs/heads/${branch}`) ?? false),
              );
              world.beforeGit = hold.before;

              const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
              const opening = yield* Effect.flip(
                pullRequests.open(stored, { id: 6, type: "open_pr" }),
              ).pipe(Effect.forkChild);
              yield* hold.changeThere(git(cwd, ["config", `url.${other}.insteadOf`, origin]));
              const error = yield* Fiber.join(opening);

              assert.deepStrictEqual(error, changedRefusal(deliveryId));
              assert.deepStrictEqual(
                world.calls.map(({ action }) => action),
                ["create_pr", "push"],
              );
              assert.strictEqual(yield* git(other, ["for-each-ref"]), "");
              assert.strictEqual(yield* branchAt(origin), reviewed);
              assert.strictEqual(world.dispatched.length, links);
              assert.deepStrictEqual(yield* storedOf(deliveryId), stored);
            }),
          ),
      );

      it.effect(
        "publishes a branch cut from main where it was judged, and pushes there after",
        () =>
          withWorld((world) =>
            Effect.gen(function* () {
              world.pushesThroughDriver = true;
              const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
              yield* cutFromMain(cwd);
              const origin = yield* git(cwd, ["remote", "get-url", "origin"]);

              yield* runEnds(deliveryId, reviewer, reviewRun);
              assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
              const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
              const published = yield* pullRequests.open(yield* storedOf(deliveryId), {
                id: 6,
                type: "open_pr",
              });

              assert.isUndefined(published.publicationFailure);
              const judged = { remoteName: "origin", branch, pushUrls: [origin] };
              assert.deepStrictEqual(world.pushTargets, [judged, judged]);
              assert.strictEqual(yield* branchAt(origin), reviewed);
              assert.strictEqual(
                yield* git(cwd, ["config", "--get", `branch.${branch}.t3-merge-base`]),
                "main",
              );
            }),
          ),
      );
    });

    it.effect("publishes to every push URL it judged, and pushes to them all afterwards", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.pushesThroughDriver = true;
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
          const second = yield* bare;
          yield* git(cwd, ["remote", "set-url", "--add", "--push", "origin", origin]);
          yield* git(cwd, ["remote", "set-url", "--add", "--push", "origin", second]);

          yield* runEnds(deliveryId, reviewer, reviewRun);
          assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const published = yield* pullRequests.open(yield* storedOf(deliveryId), {
            id: 6,
            type: "open_pr",
          });

          assert.isUndefined(published.publicationFailure);
          const both = { remoteName: "origin", branch, pushUrls: [origin, second] };
          assert.deepStrictEqual(world.pushTargets, [both, both]);
          for (const at of [origin, second]) {
            assert.strictEqual(
              yield* git(at, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]),
              reviewed,
            );
          }
        }),
      ),
    );

    it.effect("still shows no Git text when the push fails for another reason", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.pushesThroughDriver = true;
          const { cwd, deliveryId } = yield* reviewAccepted(world);
          const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const hooks = path.join(cwd, ".git", "hooks");
          yield* fileSystem.makeDirectory(hooks, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(hooks, "pre-push"),
            "#!/bin/sh\necho 'error: token ghp_example refused' >&2\nexit 1\n",
          );
          yield* fileSystem.chmod(path.join(hooks, "pre-push"), 0o755);
          yield* git(cwd, ["config", "core.hooksPath", hooks]);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(state.block, {
            reason: "effect_failed",
            effect: { id: 6, type: "open_pr" },
            detail: "Factory could not open the pull request (GitCommandError).",
          });
          assert.strictEqual(yield* git(origin, ["for-each-ref", "--format=%(refname)"]), "");
        }),
      ),
    );
  });

  describe("a recorded pull request gets no grandfathering", () => {
    const legacy = "work/fd-aaaaaa-add-the-export-button";

    /** A pull request opened, then stored the way an earlier server left it, on a legacy branch. */
    const openedOnLegacyBranch = (world: World) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        yield* runEnds(deliveryId, reviewer, reviewRun);
        assert.strictEqual(world.calls.length, 1);
        yield* git(cwd, ["branch", "-m", branch, legacy]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${branch}`]);
        yield* storeChanged(deliveryId, (state) => ({
          ...state,
          branch: legacy,
          pullRequest:
            state.pullRequest === null ? null : { ...state.pullRequest, headBranch: legacy },
        }));
        return { cwd, deliveryId, reviewed };
      });

    it.effect("pushes nothing, opens nothing and changes nothing on a disallowed branch", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* openedOnLegacyBranch(world);
          const before = yield* storedOf(deliveryId);
          const reads = world.savedReads.length;
          const links = world.dispatched.length;

          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const error = yield* Effect.flip(pullRequests.open(before, { id: 6, type: "open_pr" }));

          assert.deepStrictEqual(
            error,
            new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch: legacy,
              problems: [{ target: "branch", rule: "branch_prefix" }],
            }),
          );
          assert.strictEqual(
            error.message,
            `Factory published nothing: its branch "${legacy}" has no feature/, bugfix/, chore/ or docs/ prefix. Factory renames nothing, and any branch, pull request and commits it published stay as they are: cancel this delivery and deliver the item again, which publishes from a compliant branch.`,
          );
          // No push, no pull request, and no read of a host: the branch alone refuses it.
          assert.strictEqual(world.calls.length, 1);
          assert.strictEqual(world.savedReads.length, reads);
          assert.strictEqual(world.dispatched.length, links);
          // Its refs, link and commits are as they were.
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
          assert.strictEqual(yield* git(cwd, ["branch", "--show-current"]), legacy);
          assert.deepStrictEqual(yield* storedOf(deliveryId), before);
          assert.strictEqual(before.state.pullRequest?.headBranch, legacy);
          assert.strictEqual(before.state.pullRequest?.url, prUrl);
        }),
      ),
    );

    it.effect("still pushes a recorded pull request that complies", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          yield* runEnds(deliveryId, reviewer, reviewRun);
          const stored = yield* storedOf(deliveryId);

          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const published = yield* pullRequests.open(stored, { id: 6, type: "open_pr" });

          assert.deepStrictEqual(
            world.calls.map(({ action }) => action),
            ["create_pr", "push"],
          );
          assert.strictEqual(world.calls[1]?.expectedHeadSha, reviewed);
          // Each bound to the branch's own name on the remote the driver pushes it to, and its URL.
          const origin = yield* git(cwd, ["remote", "get-url", "origin"]);
          assert.deepStrictEqual(world.pushTargets, [
            { remoteName: "origin", branch, pushUrls: [origin] },
            { remoteName: "origin", branch, pushUrls: [origin] },
          ]);
          assert.deepStrictEqual(published.pullRequest, {
            number: 7,
            url: prUrl,
            headBranch: branch,
          });
          assert.isUndefined(published.publicationFailure);
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          // A read before the push, and none after: the push changes no text.
          assert.deepStrictEqual(world.savedReads, ["invalidated", "read", "invalidated", "read"]);
        }),
      ),
    );

    it.effect.each([
      { name: "a space before the colon", credit: "Co-authored-by : Ada Cursor <ada@example.com>" },
      {
        name: "a co-author folded into a sign-off",
        credit:
          "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
      },
      { name: "a person's help", credit: "Helped-by: Ada Cursor <ada@example.com>" },
      { name: "a bare address with a plus", credit: "Co-authored-by: ada+cursor@example.com" },
      {
        name: "a bracketed address with a plus",
        credit: "Co-authored-by: Ada Lovelace <ada+cursor@example.com>",
      },
      { name: "a suggestion", credit: "Suggested-by: Ada Cursor <ada@example.com>" },
      { name: "a report", credit: "Reported-by:\n Ai Nguyen <ai.nguyen@example.com>" },
    ])(
      "still pushes a recorded pull request whose saved body credits a person with $name",
      ({ credit }) =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
            yield* runEnds(deliveryId, reviewer, reviewRun);
            // Its owner added the credit on the host after Factory opened it.
            world.saved = (sent) => Effect.succeed({ ...sent, body: `${sent.body}\n\n${credit}` });

            const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
            yield* pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" });

            assert.deepStrictEqual(
              world.calls.map(({ action }) => action),
              ["create_pr", "push"],
            );
            assert.strictEqual(yield* publishedOf(cwd), reviewed);
          }),
        ),
    );

    it.effect.each([
      {
        name: "a saved title from before the rules",
        saved: (sent: Saved) => Effect.succeed({ ...sent, title: "fd-aaaaaa: a raw title" }),
        problems: [{ target: "saved_title", rule: "malformed_title" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved title that lost the item's key",
        saved: (sent: Saved) => Effect.succeed({ ...sent, title: "feat: unrelated change" }),
        problems: [{ target: "saved_title", rule: "malformed_title" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body naming a tool",
        saved: (sent: Saved) => Effect.succeed({ ...sent, body: "Written by Claude." }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor on a folded line",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: "Co-authored-by:\r\n Cursor <editor@example.com>" }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting an assistant on a folded line",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: "Signed-off-by:\n AI Assistant <assistant@example.com>",
          }),
        problems: [{ target: "saved_body", rule: "ai_attribution" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor after a person's address",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: "Co-authored-by: Ada Lovelace <ada@example.com>, Cursor <cursor@example.com>",
          }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting an assistant after a person's address",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: "Co-authored-by: Ada Lovelace <ada@example.com> and AI Assistant",
          }),
        problems: [{ target: "saved_body", rule: "ai_attribution" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor with a space before the colon",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: "Co-authored-by : Cursor <editor@example.com>" }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body with an assistant's sign-off spaced before the colon",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: "Signed-off-by : AI Assistant <helper@example.com>" }),
        problems: [{ target: "saved_body", rule: "ai_attribution" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body with the editor's credit folded into a sign-off",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Cursor <editor@example.com>",
          }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body with an assistant's credit after a sign-off",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: AI Assistant <helper@example.com>",
          }),
        problems: [{ target: "saved_body", rule: "ai_attribution" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor's help",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: "Helped-by: Cursor <e@example.com>" }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor after a person's bare address",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: "Co-authored-by: ada+cursor@example.com and Cursor" }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor's suggestion",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nSuggested-by: Cursor <e@example.com>` }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body crediting the editor's report spaced before the colon",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nReported-by : Cursor <e@example.com>` }),
        problems: [{ target: "saved_body", rule: "ai_name" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a saved body with an assistant's report folded into a sign-off",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nSigned-off-by: Ada Lovelace <ada@example.com>\r\n Reported-by: AI Assistant <helper@example.com>`,
          }),
        problems: [{ target: "saved_body", rule: "ai_attribution" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a head branch that moved",
        saved: (sent: Saved) => Effect.succeed({ ...sent, headBranch: "feature/other" }),
        problems: [{ target: "saved_head", rule: "differs" }],
        action: "Factory edits nothing on the host: correct the pull request there, then Resume.",
      },
      {
        name: "a read that fails",
        saved: () =>
          Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
        problems: [{ target: "saved_pull_request", rule: "unreadable" }],
        action:
          "Check its title, body and head branch on the host and that Factory can reach it, then Resume to read it again.",
      },
    ] as const)("pushes nothing when the host shows $name", (testCase) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          yield* runEnds(deliveryId, reviewer, reviewRun);
          world.saved = testCase.saved;

          const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
          const error = yield* Effect.flip(
            pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
          );

          assert.deepStrictEqual(
            error,
            new FactoryPullRequest.FactoryPublicationRefusedError({
              deliveryId,
              branch,
              problems: testCase.problems,
            }),
          );
          assert.include(error.message, testCase.action);
          assert.strictEqual(world.calls.length, 1);
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
        }),
      ),
    );
  });

  it.effect("pushes nothing when the item whose key it checks cannot be read", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        yield* runEnds(deliveryId, reviewer, reviewRun);
        const reads = world.savedReads.length;
        const unavailable = new FakeWorkUnavailable({ detail: "The tracker did not answer." });
        world.onItemRead = Effect.fail(unavailable as unknown as WorkDomainError);

        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
        );

        assert.strictEqual(error as unknown, unavailable);
        assert.strictEqual(world.calls.length, 1);
        assert.strictEqual(world.savedReads.length, reads);
        assert.strictEqual(yield* publishedOf(cwd), reviewed);
      }),
    ),
  );

  describe("what the host saved after create_pr", () => {
    const editsNothing =
      "Factory edits nothing on the host: correct the pull request there, then Resume.";

    it.effect.each([
      {
        name: "an altered title",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, title: "feat: fd-aaaaaa something else" }),
        detail: `Factory opened pull request #7, but its saved title is not what Factory sent. ${editsNothing}`,
      },
      {
        name: "an altered body",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nA host's footer.` }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent. ${editsNothing}`,
      },
      {
        name: "attribution a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nGenerated-by: a bot` }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body carries generated or assisted attribution. ${editsNothing}`,
      },
      {
        name: "a folded credit a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nCo-authored-by:\n Cursor <editor@example.com>`,
          }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body names an AI agent, model or provider. ${editsNothing}`,
      },
      {
        name: "an assistant credited after a person's address by a host's automation",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nCo-authored-by: Ada Lovelace <ada@example.com> and AI Assistant`,
          }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body carries generated or assisted attribution. ${editsNothing}`,
      },
      {
        name: "a spaced credit a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nCo-authored-by : Cursor <editor@example.com>`,
          }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body names an AI agent, model or provider. ${editsNothing}`,
      },
      {
        name: "an assistant's credit folded into a sign-off by a host's automation",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: AI Assistant <helper@example.com>`,
          }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body carries generated or assisted attribution. ${editsNothing}`,
      },
      {
        name: "the editor's help a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nHelped-by: Cursor <e@example.com>` }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body names an AI agent, model or provider. ${editsNothing}`,
      },
      {
        name: "the editor's suggestion a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({ ...sent, body: `${sent.body}\n\nSuggested-by: Cursor <e@example.com>` }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body names an AI agent, model or provider. ${editsNothing}`,
      },
      {
        name: "an assistant's report a host's automation added",
        saved: (sent: Saved) =>
          Effect.succeed({
            ...sent,
            body: `${sent.body}\n\nReported-by:\n AI Assistant <helper@example.com>`,
          }),
        detail: `Factory opened pull request #7, but its saved body is not what Factory sent; its saved body carries generated or assisted attribution. ${editsNothing}`,
      },
      {
        name: "an altered head",
        saved: (sent: Saved) => Effect.succeed({ ...sent, headBranch: "feature/other" }),
        detail: `Factory opened pull request #7, but its head branch on the host is not the remote branch its pushes land on. ${editsNothing}`,
      },
      {
        name: "a failed read",
        saved: () =>
          Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
        detail:
          "Factory opened pull request #7, but Factory could not read its saved title, body and head branch from the host. Check its title, body and head branch on the host and that Factory can reach it, then Resume to read it again.",
      },
    ] as const)("records the pull request and blocks on $name, editing nothing", (testCase) =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.saved = testCase.saved;
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "pr");
          assert.deepStrictEqual(state.block, {
            reason: "effect_failed",
            effect: { id: 6, type: "open_pr" },
            detail: testCase.detail,
          });
          // Published and recorded, so its merge or close is taken and a resume reuses it.
          assert.deepStrictEqual(state.pullRequest, { number: 7, url: prUrl, headBranch: branch });
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
          // One action, none of them an edit, and linked but never watched.
          assert.deepStrictEqual(
            world.calls.map(({ action }) => action),
            ["create_pr"],
          );
          assert.deepStrictEqual(
            world.dispatched.map((command) => command.type),
            ["thread.pull-request.link"],
          );
          assert.isUndefined(state.followThrough);
          assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-1), [
            { stage: "pr", outcome: "blocked" },
          ]);
        }),
      ),
    );

    it.effect("passes what the host normalized, and records the pull request as open", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.saved = (sent) =>
            Effect.succeed({ ...sent, body: `${sent.body.replace(/\n/g, "\r\n")}\r\n` });
          const { deliveryId } = yield* reviewAccepted(world);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "pr_open");
          assert.isNull(state.block);
        }),
      ),
    );

    it.effect("blocks on a pull request already open that does not comply", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.respond = () =>
            Effect.succeed(
              stackedResult({
                status: "opened_existing",
                url: "https://github.com/acme/alpha/pull/3",
                number: 3,
                baseBranch: "main",
                headBranch: branch,
                title: "An earlier title",
              }),
            );
          world.saved = () =>
            Effect.succeed({ title: "An earlier title", body: "", headBranch: branch });
          const { deliveryId } = yield* reviewAccepted(world);

          yield* runEnds(deliveryId, reviewer, reviewRun);

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(state.pullRequest, {
            number: 3,
            url: "https://github.com/acme/alpha/pull/3",
            headBranch: branch,
          });
          assert.deepStrictEqual(state.block, {
            reason: "effect_failed",
            effect: { id: 6, type: "open_pr" },
            detail: `Factory opened pull request #3, but its saved title is not one short Conventional line keeping the item's key. ${editsNothing}`,
          });
        }),
      ),
    );

    it.effect.each([
      { name: "a raw title", title: "fd-aaaaaa: a raw title" },
      // Conventional, so it passes every rule but the one that says whose it is.
      { name: "a title without the item's key", title: "feat: unrelated change" },
    ])("holds a resume to what the host saved until $name is corrected", ({ title }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          world.saved = (sent) => Effect.succeed({ ...sent, title });
          const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
          yield* runEnds(deliveryId, reviewer, reviewRun);
          assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
          const service = yield* FactoryService.FactoryService;

          // Resumed as it stands: judged again, and refused before any push.
          yield* service.resume(deliveryId);
          yield* drain;
          const refused = yield* stateOf(deliveryId);
          assert.strictEqual(refused.status, "blocked");
          assert.deepStrictEqual(refused.block, {
            reason: "effect_failed",
            effect: { id: refused.effectsIssued, type: "open_pr" },
            detail: `Factory could not open the pull request. Factory published nothing: its saved title is not one short Conventional line keeping the item's key. ${editsNothing}`,
          });
          assert.deepStrictEqual(
            world.calls.map(({ action }) => action),
            ["create_pr"],
          );

          // The owner corrects it on the host; the next resume pushes to that pull request.
          world.saved = (sent) => Effect.succeed(sent);
          yield* service.resume(deliveryId);
          yield* drain;
          const open = yield* stateOf(deliveryId);
          assert.strictEqual(open.status, "pr_open");
          assert.isNull(open.block);
          assert.deepStrictEqual(
            world.calls.map(({ action }) => action),
            ["create_pr", "push"],
          );
          assert.strictEqual(yield* publishedOf(cwd), reviewed);
        }),
      ),
    );
  });

  it.effect("refuses the action when the approved commit moves while the item is read", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        // A commit lands while Work reads the item, after record checked the worktree.
        world.onItemRead = yield* captured(commitChange(cwd));

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 6, type: "open_pr" },
          detail: "Factory could not open the pull request (FactoryPullRequestUnapprovedError).",
        });
        assert.isNull(state.pullRequest);
        // Nothing ran, so nothing was published.
        assert.deepStrictEqual(world.calls, []);
        assert.strictEqual(yield* publishedOf(cwd), "");
        assert.notStrictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), reviewed);
      }),
    ),
  );

  it.effect("publishes only the approved commit when another lands inside the action", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        // A commit lands inside the stacked action, after Factory's check and before its push.
        world.beforePush = yield* captured(commitChange(cwd));

        yield* runEnds(deliveryId, reviewer, reviewRun);

        // The action pushed the approved commit by its id: the unreviewed one stays local.
        const moved = yield* git(cwd, ["rev-parse", "HEAD"]);
        assert.notStrictEqual(moved, reviewed);
        assert.strictEqual(world.calls[0]?.expectedHeadSha, reviewed);
        assert.strictEqual(yield* publishedOf(cwd), reviewed);
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.isNull(state.block);
        assert.deepStrictEqual(state.pullRequest, { number: 7, url: prUrl, headBranch: branch });
      }),
    ),
  );

  it.effect("never takes a pull request published from a commit other than the approved", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        // An action that pushes HEAD whatever it is given: the read-back is the last guard.
        world.ignoresExpectedCommit = true;
        world.beforePush = yield* captured(commitChange(cwd));

        yield* runEnds(deliveryId, reviewer, reviewRun);

        // The pull request is linked so the owner finds it, but it is not the delivery's.
        const moved = yield* git(cwd, ["rev-parse", "HEAD"]);
        assert.notStrictEqual(moved, reviewed);
        assert.strictEqual(yield* publishedOf(cwd), moved);
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 6, type: "open_pr" },
          detail:
            "Factory could not open the pull request (FactoryPullRequestPublishedUnapprovedError).",
        });
        assert.isNull(state.pullRequest);
        assert.deepStrictEqual(
          world.dispatched.map((command) => command.type),
          ["thread.pull-request.link"],
        );
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-1), [
          { stage: "pr", outcome: "blocked" },
        ]);
      }),
    ),
  );

  it.effect("blocks a PR effect a restart interrupted, without running it", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // Approved by an earlier process, which ended before its PR effect fed a result back.
        // No step of this process queued it, so the worker has no lane for the delivery.
        const deliveryId = FactoryDeliveryId.make("delivery-interrupted");
        const opening: FactoryDeliveryState = {
          ...queuedDeliveryState({ branch, baseRef: "HEAD", worktreePath: "/worktrees/item" }),
          status: "approved",
          stage: "pr",
          threads: { author, reviewer },
          effectsIssued: 6,
          awaiting: { type: "effect", effect: { id: 6, type: "open_pr" } },
        };
        const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        yield* deliveries.insert({ deliveryId, projectId, itemRef, state: opening });
        const worker = yield* FactoryWorker.FactoryWorker;

        const swept = yield* worker.failInterruptedEffect(deliveryId);
        yield* drain;

        assert.deepStrictEqual(Option.getOrThrow(swept).state, {
          ...opening,
          status: "blocked",
          awaiting: null,
          block: {
            reason: "effect_failed",
            effect: { id: 6, type: "open_pr" },
            detail: "Factory could not open the pull request: a server restart interrupted it.",
          },
        });
        assert.deepStrictEqual(world.calls, []);
        // Swept again, a blocked delivery is left as it is.
        const again = yield* worker.failInterruptedEffect(deliveryId);
        assert.deepStrictEqual(again, swept);
      }),
    ),
  );
});
