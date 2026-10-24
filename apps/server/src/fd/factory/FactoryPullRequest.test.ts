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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService, workBranchName } from "../work-management/index.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { type FactoryDeliveryState, queuedDeliveryState } from "./pipeline/state.ts";
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
  title: "fd-aaaaaa: Add the export button",
});

interface World {
  worktree: { readonly cwd: string; readonly baseline: string } | null;
  /** The item Work returns; a test may change it once the delivery has started. */
  item: WorkItemDetail;
  /** Runs while Work reads the item, before the read returns. */
  onItemRead: Effect.Effect<void>;
  /** Runs inside the stacked action, before it pushes the branch. */
  beforePush: Effect.Effect<void>;
  /** The action pushes HEAD whatever commit it is given, as one that predates the field would. */
  ignoresExpectedCommit: boolean;
  /** How the stacked action answers; a test sets it before the delivery reaches the PR stage. */
  respond: (
    input: GitRunStackedActionInput,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  readonly calls: Array<GitRunStackedActionInput>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

/**
 * The fake PR service: the Git workflow, whose stacked action records the call and pushes to the
 * worktree's `origin` the way `create_pr` does: the expected commit by its id, tracked as the
 * branch's upstream, or HEAD as it then is when given none. It answers as the test says.
 * `exactCommitPush.test.ts` holds the real action to this.
 */
const fakeGitWorkflow = (world: World) =>
  Layer.unwrap(
    Effect.map(GitVcsDriver.GitVcsDriver, (driver) => {
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.push", cwd, args, timeoutMs: 30_000 }).pipe(Effect.orDie);
      return Layer.mock(GitWorkflow.GitWorkflowService)({
        runStackedAction: (input) =>
          Effect.gen(function* () {
            world.calls.push(input);
            yield* world.beforePush;
            const exact = world.ignoresExpectedCommit ? undefined : input.expectedHeadSha;
            if (exact === undefined) {
              yield* run(input.cwd, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
            } else {
              yield* run(input.cwd, ["push", "origin", `${exact}:refs/heads/${branch}`]);
              yield* run(input.cwd, ["branch", "--set-upstream-to", `origin/${branch}`]);
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
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) => Effect.succeedSome({ projectId: id } as unknown as ProjectStore.ProjectRow),
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
          return { sequence: world.dispatched.length } as never;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
  );

/**
 * FactoryService, the worker, the verify runner, review judging, record and the PR service as
 * the server builds them, on in-memory SQLite, real git, real processes and an evidence folder
 * under a temp T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provideMerge(FactoryPullRequest.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(FactoryVerifyRunner.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-pr-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    worktree: null,
    item,
    onItemRead: Effect.void,
    beforePush: Effect.void,
    ignoresExpectedCommit: false,
    respond: () => Effect.succeed(created),
    calls: [],
    dispatched: [],
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
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
 * A repository standing in for the delivery worktree, with a bare `origin` the fake action pushes
 * to, and a started delivery whose author's commit passed verify and whose reviewer submitted a
 * passing review, still awaiting the reviewer run's end. Returns the delivery and the reviewed
 * commit. `verifyArgs` follow the verify script in the project's command.
 */
const reviewAccepted = (world: World, verifyArgs: ReadonlyArray<string> = []) =>
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
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
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
    return { cwd, deliveryId, reviewed: yield* git(cwd, ["rev-parse", "HEAD"]) };
  });

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
        assert.strictEqual(input?.prTitle, "fd-aaaaaa: Add the export button");
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

        // Linked to the author thread as a created pull request, like the action's RPC does.
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
        ]);
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
              title: "An earlier title",
            }),
          );
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
          ["thread.pull-request.link"],
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
      problems: [{ field: "body", rule: "ai_name" }],
    },
    {
      name: "an item title naming an AI provider",
      verifyArgs: [],
      item: { ...item, title: "Port the export to the Claude adapter" },
      problems: [
        { field: "title", rule: "ai_name" },
        { field: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item link naming an AI provider",
      verifyArgs: [],
      item: { ...item, url: "https://github.com/openai/alpha/issues/3" },
      problems: [{ field: "body", rule: "ai_name" }],
    },
    {
      name: "an item title carrying attribution",
      verifyArgs: [],
      item: { ...item, title: "Add the export button, generated with a tool" },
      problems: [
        { field: "title", rule: "ai_attribution" },
        { field: "body", rule: "ai_attribution" },
      ],
    },
    {
      name: "a verify command naming another provider",
      verifyArgs: ["tests/grok/verify.mjs"],
      item,
      problems: [{ field: "body", rule: "ai_name" }],
    },
    {
      name: "an item title naming another provider",
      verifyArgs: [],
      item: { ...item, title: "Fix the OpenCode adapter" },
      problems: [
        { field: "title", rule: "ai_name" },
        { field: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting a named assistant",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: GitHub Copilot" },
      problems: [
        { field: "title", rule: "ai_name" },
        { field: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting the Cursor editor",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: Cursor <cursor@cursor.com>" },
      problems: [
        { field: "title", rule: "ai_name" },
        { field: "body", rule: "ai_name" },
      ],
    },
    {
      name: "an item title crediting an unnamed assistant",
      verifyArgs: [],
      item: { ...item, title: "Export support. Co-authored-by: AI Assistant" },
      problems: [
        { field: "title", rule: "ai_attribution" },
        { field: "body", rule: "ai_attribution" },
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
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 6, type: "open_pr" },
          detail: "Factory could not open the pull request (FactoryPullRequestTextRefusedError).",
        });
        assert.deepStrictEqual(world.calls, []);
        assert.strictEqual(yield* publishedOf(cwd), "");

        // The refusal names each field and rule, never the text that broke it.
        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedOf(deliveryId), { id: 6, type: "open_pr" }),
        );
        assert.deepStrictEqual(
          error,
          new FactoryPullRequest.FactoryPullRequestTextRefusedError({
            deliveryId,
            problems: testCase.problems,
          }),
        );
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );

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
