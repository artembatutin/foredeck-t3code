import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryPlanTask,
  FactoryTaskId,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
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
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  type FactoryAcceptedReview,
  type FactoryDeliveryState,
  type FactoryEvent,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * A parent's record gate and its one pull request on the service, as the server builds them, over
 * a stored parent whose children are approved and whose integrate reviewer's run it awaits:
 * in-memory SQLite, real git in a worktree standing in for the parent's with a bare `origin`, and
 * evidence under a temp T3 home. Threads, Work and the stacked Git action are faked.
 */

const projectId = ProjectId.make("project-alpha");
const parentId = FactoryDeliveryId.make("delivery-parent");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const branch = "work/fd-parent";
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const integrateRun = RunId.make("run-integrate");
const prUrl = "https://github.com/acme/alpha/pull/7";

const planTask = (id: string, title: string): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: "A test shows it.", paths: ["src/export.test.ts"] }],
  likelyPaths: ["src/export.ts"],
  risk: "normal",
});
const tasks = [
  planTask("export-csv", "Export the current table as CSV"),
  planTask("export-header", "Write a header row first"),
];
const children = tasks.map((task) => FactoryChildren.childDeliveryId(parentId, task.id));
const childAuthors = tasks.map((task) => ThreadId.make(`thread-author-${task.id}`));
/** The thread the parent's integrate launch made, its effect after the children's starts. */
const reviewer = FactoryThreadEffects.launchThreadId(parentId, 4 + tasks.length);

const workItem = (itemId: string, title: string, url: string | null = null) =>
  ({
    ref: { sourceId, itemId: WorkItemId.make(itemId) },
    kind: "markdown",
    key: itemId,
    title,
    url,
  }) as unknown as WorkItemDetail;
const parentItem = workItem(
  "fd-parent",
  "Add the export button",
  "https://tracker.example.com/items/fd-parent",
);
const childItems = tasks.map((task, index) => workItem(`fd-child-${index + 1}`, task.title));

interface World {
  /** The items Work reads, by id; a test may change one before the pull request is written. */
  readonly items: Map<string, WorkItemDetail>;
  readonly calls: Array<GitRunStackedActionInput>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

const shellOf = (threadId: ThreadId): OrchestrationV2ThreadShell | null =>
  threadId === reviewer
    ? liveThreadShell(threadId, { interactionMode: "plan", activeRunId: integrateRun })
    : null;

/**
 * The stacked action: records the call and pushes to the worktree's `origin` the way `create_pr`
 * does, the expected commit by its id, tracked as the branch's upstream, then reports the pull
 * request created. `exactCommitPush.test.ts` holds the real action to this.
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
            if (input.expectedHeadSha === undefined)
              return yield* Effect.die("No expected commit.");
            yield* run(input.cwd, [
              "push",
              "origin",
              `${input.expectedHeadSha}:refs/heads/${branch}`,
            ]);
            yield* run(input.cwd, ["branch", "--set-upstream-to", `origin/${branch}`]);
            return {
              action: "create_pr",
              branch: { status: "skipped_not_requested" },
              commit: { status: "skipped_not_requested" },
              push: { status: "pushed", branch },
              pr: {
                status: "created",
                url: prUrl,
                number: 7,
                baseBranch: "main",
                headBranch: branch,
                title: input.prTitle ?? "",
              },
              toast: { title: "Created pull request", cta: { kind: "none" } },
            } satisfies GitRunStackedActionResult;
          }),
      });
    }),
  );

const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(WorkService.WorkService)({
      getItem: (_actor, { ref }) =>
        Effect.suspend(() => {
          const item = world.items.get(ref.itemId);
          return item === undefined ? Effect.die(`No item ${ref.itemId}.`) : Effect.succeed(item);
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
    }),
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
    fakeGitWorkflow(world),
    // Nothing here verifies, plans, creates children or launches a thread.
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
    Layer.mock(FactoryPlanning.FactoryPlanning)({}),
    Layer.mock(FactoryChildren.FactoryChildren)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
    ProviderRegistryMock.layer(),
    ServerSettings.layerTest(),
  );

/** FactoryService, the worker, review judging, record and the PR stage as the server builds them. */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provideMerge(FactoryPullRequest.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(FactoryThreadEffects.layer),
    Layer.provideMerge(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
      }),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-parent-pr-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    items: new Map([parentItem, ...childItems].map((item) => [item.ref.itemId, item])),
    calls: [],
    dispatched: [],
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 30_000 }),
  ).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.orDie,
  );
const writeFile = (cwd: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, name), text);
  }).pipe(Effect.orDie);
const commitAll = (cwd: string, subject: string) =>
  git(cwd, ["add", "-A"]).pipe(
    Effect.andThen(git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "-m", subject])),
    Effect.andThen(git(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"])),
    Effect.map((out) => {
      const [headSha = "", tree = ""] = out.split("\n");
      return { headSha, tree };
    }),
  );

const receiptOf = (
  commit: { readonly headSha: string; readonly tree: string },
  logPath: string,
): FactoryVerifyReceipt => ({
  version: 1,
  ...commit,
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: "2026-10-25T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath,
  outputHash: "output-1",
});

/** A child's review of its own commit, in `round`, with `low` low findings that do not block. */
const childReview = (headSha: string, round: number, low: number): FactoryAcceptedReview => ({
  round,
  source: "mcp",
  summary: {
    headSha,
    verdict: "pass",
    blocking: false,
    findings: { high: 0, medium: 0, low },
    reviewedAt: "2026-10-25T10:02:00.000Z",
  },
  evidencePath: `/t3/userdata/fd-factory/child/review-${round}.json`,
});

/**
 * Stores the parent as integrate left it: its plan approved, its children's items recorded on its
 * tasks and each child approved for the commit it made on the branch, the branch verified at the
 * worktree's HEAD (its verify attempt passed) and its integrate reviewer's run awaited. `after`
 * events follow. Returns the worktree with its commits.
 */
const seed = (after: ReadonlyArray<FactoryEvent> = []) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-parent-pr-wt-" });
    const remote = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "fd-factory-parent-pr-origin-",
    });
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["init", "-b", "main"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* writeFile(cwd, "README.md", "root\n");
    const base = yield* commitAll(cwd, "chore: root");
    yield* git(cwd, ["switch", "-c", branch]);
    yield* writeFile(cwd, "src/export.ts", "export const csv = 1;\n");
    yield* writeFile(cwd, "src/export.test.ts", "// covers the export\n");
    const firstCommit = yield* commitAll(cwd, "feat: export the table as CSV");
    yield* writeFile(cwd, "src/export.ts", "export const header = 'id,name';\n");
    const secondCommit = yield* commitAll(cwd, "fix: write the header row first");
    const commits = [firstCommit, secondCommit];

    const { stateDir } = yield* ServerConfig.ServerConfig;
    const evidenceDir = `${stateDir}/fd-factory/${parentId}`;
    const receipt = receiptOf(secondCommit, `${evidenceDir}/verify-1.log`);
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: planner,
        runId: planRun,
        worktreePath: cwd,
        baseline: base.headSha,
      },
      {
        type: "plan.submitted",
        round: 1,
        threadId: planner,
        runId: planRun,
        judgment: {
          type: "accepted",
          plan: { tasks, source: "mcp", evidencePath: `${evidenceDir}/plan.json` },
        },
      },
      { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
      { type: "plan.approved" },
      { type: "children.created", effectId: 2, children },
      ...children.flatMap((child, index): ReadonlyArray<FactoryEvent> => [
        { type: "child.started", effectId: 3 + index },
        { type: "child.approved", deliveryId: child },
      ]),
      { type: "command.finished", effectId: 5, outcome: { type: "receipt", receipt } },
      {
        type: "thread.launched",
        effectId: 6,
        threadId: reviewer,
        runId: integrateRun,
        worktreePath: cwd,
        baseline: secondCommit.headSha,
      },
      ...after,
    ];
    const state = events.reduce<FactoryDeliveryState>(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ kind: "parent", branch, baseRef: "HEAD" }),
    );

    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const taskStore = yield* FactoryTaskStore.FactoryTaskStore;
    const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
    yield* deliveries.insert({ deliveryId: parentId, projectId, itemRef: parentItem.ref, state });
    const verify = yield* stageRuns.append({ deliveryId: parentId, stage: "verify" });
    yield* stageRuns.finish({
      deliveryId: parentId,
      stage: "verify",
      attempt: verify.attempt,
      outcome: "passed",
      evidencePath: `${evidenceDir}/verify-1.json`,
    });
    yield* stageRuns.append({
      deliveryId: parentId,
      stage: "integrate",
      threadId: reviewer,
      runId: integrateRun,
    });
    for (const [index, task] of tasks.entries()) {
      const commit = commits[index] ?? secondCommit;
      const childId = children[index] ?? assert.fail("No child.");
      yield* taskStore.insert({ deliveryId: parentId, taskId: task.id, plan: task });
      yield* taskStore.setChildItem({
        deliveryId: parentId,
        taskId: task.id,
        itemId: childItems[index]?.ref.itemId ?? assert.fail("No child item."),
      });
      yield* taskStore.setLastReviewedSha({
        deliveryId: parentId,
        taskId: task.id,
        sha: commit.headSha,
      });
      // The first child's review closed in round 2 with a low finding; the second's in round 1.
      const review =
        index === 0 ? childReview(commit.headSha, 2, 1) : childReview(commit.headSha, 1, 0);
      yield* deliveries.insert({
        deliveryId: childId,
        projectId,
        itemRef: childItems[index]?.ref ?? parentItem.ref,
        parentId,
        state: {
          ...queuedDeliveryState({ kind: "child", branch, baseRef: "HEAD", worktreePath: cwd }),
          status: "approved",
          stage: "record",
          threads: {
            author: childAuthors[index] ?? assert.fail("No author."),
            reviewer: ThreadId.make(`thread-reviewer-${task.id}`),
          },
          receipts: [receiptOf(commit, `${stateDir}/fd-factory/${childId}/verify-1.log`)],
          reviewRound: review.round,
          reviews: [review],
        },
      });
    }
    return { cwd, commits, receipt, evidenceDir };
  });

const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.get(deliveryId),
  ).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const storedParent = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(parentId),
).pipe(Effect.map(Option.getOrThrow));
const attemptsOf = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(parentId),
).pipe(Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);

/** The parent's evidence files whose names start with `approval`. */
const approvalFiles = (evidenceDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(evidenceDir))) return [];
    return (yield* fileSystem.readDirectory(evidenceDir)).filter((name) =>
      name.startsWith("approval"),
    );
  }).pipe(Effect.orDie);

/** The commit `origin` holds for the branch; empty when it holds none. */
const publishedOf = (cwd: string) =>
  git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]).pipe(
    Effect.map((line) => line.split("\t")[0] ?? ""),
  );

/** The integrate reviewer's passing review of both tasks' criteria, then its run's end. */
const reviewPasses = Effect.gen(function* () {
  const factory = yield* FactoryService.FactoryService;
  const accepted = yield* factory.submitReview({
    threadId: reviewer,
    review: {
      verdict: "pass",
      findings: [],
      acceptance: [1, 2].map((criterion) => ({
        criterion,
        status: "verified",
        evidence: "The branch's test covers it.",
        paths: ["src/export.test.ts"],
      })),
      missing_evidence: [],
    },
  });
  assert.isFalse(accepted.review.summary.blocking);
});
const reviewRunEnds = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) =>
  worker.step(parentId, {
    type: "run.finished",
    threadId: reviewer,
    runId: integrateRun,
    status: "completed",
  }),
).pipe(Effect.andThen(drain));

/** AI agent, model and provider names, and attribution lines, none of which a body may hold. */
const FORBIDDEN =
  /\b(claude|codex|chatgpt|gpt|openai|anthropic|devin|cognition|cursor|opencode|grok|gemini|copilot|antigravity|ai)\b|generated|co-authored|assisted-by|signed-off/i;

describe("a parent's record after its integrate review", () => {
  it.effect.each([
    {
      name: "HEAD moved",
      change: (cwd: string) =>
        writeFile(cwd, "src/export.ts", "export const csv = 2;\n").pipe(
          Effect.andThen(commitAll(cwd, "fix: a commit after the review")),
          Effect.asVoid,
        ),
      clean: true,
      differences: ["head_changed", "tree_changed", "not_reviewed"],
    },
    {
      name: "the tree is dirty",
      change: (cwd: string) => writeFile(cwd, "notes.txt", "left behind\n"),
      clean: false,
      differences: ["tree_dirty"],
    },
  ] as const)(
    "writes nothing and blocks with record_mismatch naming both commits once $name",
    (testCase) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { cwd, receipt, evidenceDir } = yield* seed();
          yield* reviewPasses;
          // The review was accepted while the reviewer's run went on; the change lands before it
          // ends.
          yield* testCase.change(cwd);

          yield* reviewRunEnds;

          const [headSha = "", tree = ""] = (yield* git(cwd, [
            "rev-parse",
            "HEAD",
            "HEAD^{tree}",
          ])).split("\n");
          const state = yield* stateOf(parentId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "record");
          assert.isNull(state.awaiting);
          assert.deepStrictEqual(state.block, {
            reason: "record_mismatch",
            expected: { headSha: receipt.headSha, tree: receipt.tree },
            actual: { headSha, tree, clean: testCase.clean },
            differences: testCase.differences,
          });
          // No approval is written, and nothing is pushed or opened.
          assert.deepStrictEqual(yield* approvalFiles(evidenceDir), []);
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.calls, []);
          assert.strictEqual(yield* publishedOf(cwd), "");
          assert.deepStrictEqual((yield* attemptsOf).slice(-2), [
            ["integrate", "passed"],
            ["record", "blocked"],
          ]);
        }),
      ),
  );
});

describe("a parent's pull request", () => {
  it.effect("opens one for the approved branch, listing every child in plan order", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, commits, receipt, evidenceDir } = yield* seed();
        const [firstCommit, secondCommit] = commits;
        yield* reviewPasses;

        yield* reviewRunEnds;

        // Record approved the branch for the reviewed commit, with no task of its own.
        const fileSystem = yield* FileSystem.FileSystem;
        assert.deepStrictEqual(yield* approvalFiles(evidenceDir), ["approval.json"]);
        const approval = JSON.parse(
          yield* fileSystem.readFileString(`${evidenceDir}/approval.json`),
        );
        assert.deepInclude(approval, {
          deliveryId: parentId,
          headSha: receipt.headSha,
          tree: receipt.tree,
          receiptPath: `${evidenceDir}/verify-1.json`,
        });
        assert.notProperty(approval, "taskId");
        assert.isTrue(approval.reviewPath.startsWith(`${evidenceDir}/review-`));
        // The children's tasks keep the commits their own records approved.
        const stored = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
          store.listByDelivery(parentId),
        );
        assert.deepStrictEqual(
          stored.map(({ lastReviewedSha }) => lastReviewedSha),
          commits.map(({ headSha }) => headSha),
        );

        // One stacked action, publishing the approved commit by its id, linked to the last
        // child's author thread.
        assert.strictEqual(world.calls.length, 1);
        const [input] = world.calls;
        assert.strictEqual(input?.action, "create_pr");
        assert.strictEqual(input?.cwd, cwd);
        assert.strictEqual(input?.projectId, projectId);
        assert.strictEqual(input?.threadId, childAuthors[1]);
        assert.strictEqual(input?.expectedHeadSha, approval.headSha);
        assert.strictEqual(input?.prTitle, "fd-parent: Add the export button");
        assert.strictEqual(
          input?.prBody,
          [
            "Work item fd-parent: Add the export button",
            "Link: https://tracker.example.com/items/fd-parent",
            "",
            "Whole branch, verified and reviewed by every child's criteria:",
            "",
            `- Verified commit: \`${receipt.headSha}\``,
            "- Verify command: `vp test run`, exit code 0",
            "- Review: pass in round 1, with 0 high, 0 medium and 0 low severity findings",
            "",
            "Child items, in order:",
            "",
            "1. fd-child-1: Export the current table as CSV",
            `   - Verified commit: \`${firstCommit?.headSha}\``,
            "   - Verify command: `vp test run`, exit code 0",
            "   - Review: pass in round 2, with 0 high, 0 medium and 1 low severity findings",
            "2. fd-child-2: Write a header row first",
            `   - Verified commit: \`${secondCommit?.headSha}\``,
            "   - Verify command: `vp test run`, exit code 0",
            "   - Review: pass in round 1, with 0 high, 0 medium and 0 low severity findings",
          ].join("\n"),
        );
        assert.notMatch(input?.prTitle ?? "", FORBIDDEN);
        assert.notMatch(input?.prBody ?? "", FORBIDDEN);
        assert.deepStrictEqual(world.dispatched, [
          {
            type: "thread.pull-request.link",
            commandId: CommandId.make(`factory-pr-link:${parentId}:8`),
            threadId: childAuthors[1] ?? assert.fail("No author."),
            host: "github.com",
            repository: "acme/alpha",
            number: 7,
            url: prUrl,
            source: "created",
          },
        ]);
        assert.strictEqual(yield* publishedOf(cwd), approval.headSha);

        // The parent's pull request is recorded; its children opened and recorded none.
        const state = yield* stateOf(parentId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.stage, "pr");
        assert.isNull(state.block);
        assert.deepStrictEqual(state.pullRequest, { number: 7, url: prUrl, headBranch: branch });
        for (const childId of children) {
          const child = yield* stateOf(childId);
          assert.strictEqual(child.status, "approved");
          assert.isNull(child.pullRequest);
        }
        assert.deepStrictEqual((yield* attemptsOf).slice(-3), [
          ["integrate", "passed"],
          ["record", "passed"],
          ["pr", "passed"],
        ]);
      }),
    ),
  );

  it.effect("publishes nothing when a child's title names an AI tool", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, evidenceDir } = yield* seed();
        // The second child's item reads this way by the time the pull request is written.
        const renamed = workItem("fd-child-2", "Port the export to the Claude adapter");
        world.items.set(renamed.ref.itemId, renamed);
        yield* reviewPasses;

        yield* reviewRunEnds;

        const state = yield* stateOf(parentId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "pr");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 8, type: "open_pr" },
          detail: "Factory could not open the pull request (FactoryPullRequestTextRefusedError).",
        });
        assert.isNull(state.pullRequest);
        // Record approved the branch, but nothing reached the remote.
        assert.deepStrictEqual(yield* approvalFiles(evidenceDir), ["approval.json"]);
        assert.deepStrictEqual(world.calls, []);
        assert.strictEqual(yield* publishedOf(cwd), "");

        // The refusal names the field and rule, never the text that broke it.
        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedParent, { id: 8, type: "open_pr" }),
        );
        assert.deepStrictEqual(
          error,
          new FactoryPullRequest.FactoryPullRequestTextRefusedError({
            deliveryId: parentId,
            problems: [{ field: "body", rule: "ai_name" }],
          }),
        );
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );

  it.effect("blocks a parent whose PR effect a restart lost at boot, opening nothing", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // An earlier process approved the branch and stored the PR effect, then ended before the
        // effect ran: no step of this process queued it, and no approval file was written.
        const { receipt, evidenceDir } = yield* seed();
        yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
          Effect.gen(function* () {
            const stored = Option.getOrThrow(yield* deliveries.get(parentId));
            const events: ReadonlyArray<FactoryEvent> = [
              {
                type: "review.submitted",
                round: 1,
                threadId: reviewer,
                runId: integrateRun,
                judgment: {
                  type: "accepted",
                  review: {
                    source: "mcp",
                    summary: {
                      headSha: receipt.headSha,
                      verdict: "pass",
                      blocking: false,
                      findings: { high: 0, medium: 0, low: 0 },
                      reviewedAt: "2026-10-25T10:05:00.000Z",
                    },
                    evidencePath: `${evidenceDir}/review-1.json`,
                  },
                },
              },
              {
                type: "run.finished",
                threadId: reviewer,
                runId: integrateRun,
                status: "completed",
              },
              {
                type: "approval.recorded",
                effectId: 7,
                outcome: { type: "approved", evidencePath: `${evidenceDir}/approval.json` },
              },
            ];
            const opening = events.reduce(
              (current, event) => advance(current, event).delivery,
              stored.state,
            );
            assert.strictEqual(opening.status, "approved");
            assert.deepStrictEqual(opening.awaiting, {
              type: "effect",
              effect: { id: 8, type: "open_pr" },
            });
            yield* deliveries.update(parentId, opening);
          }),
        );

        // The boot sweep of the next process.
        yield* Effect.gen(function* () {
          const reactor = yield* FactoryReactor.FactoryReactor;
          yield* reactor.start;
          yield* reactor.drain;
          yield* drain;
        }).pipe(
          Effect.provide(
            FactoryReactor.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(EventSink.EventSinkV2)({
                    latestSequence: () => Effect.succeed(0),
                    stream: () => Stream.never,
                  }),
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
                ),
              ),
            ),
          ),
          Effect.scoped,
        );

        const state = yield* stateOf(parentId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "pr");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 8, type: "open_pr" },
          detail: "Factory could not open the pull request: a server restart interrupted it.",
        });
        assert.isNull(state.pullRequest);
        assert.deepStrictEqual(world.calls, []);

        // Opened anyway, a parent whose branch approval was never written opens nothing.
        const pullRequests = yield* FactoryPullRequest.FactoryPullRequest;
        const error = yield* Effect.flip(
          pullRequests.open(yield* storedParent, { id: 8, type: "open_pr" }),
        );
        assert.deepStrictEqual(
          error,
          new FactoryPullRequest.FactoryPullRequestBasisMissingError({ deliveryId: parentId }),
        );
        assert.deepStrictEqual(world.calls, []);
      }),
    ),
  );
});
