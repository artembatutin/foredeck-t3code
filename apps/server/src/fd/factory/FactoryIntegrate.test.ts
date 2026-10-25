import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryCommand,
  FactoryDeliveryId,
  type FactoryPlanTask,
  FactoryReview as FactoryReviewSchema,
  FactoryTaskId,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerConfig from "../../config.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
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
import { advance } from "./pipeline/engine.ts";
import {
  type FactoryDeliveryState,
  type FactoryEvent,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import { needsYou } from "./snapshot.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * A parent's integrate stage on the server's real stack: Markdown children, real Git in the
 * parent's worktree, the fake provider and the server's verify runs. After the last child's
 * approval the parent verifies its whole branch afresh, then a new plan-mode reviewer reviews it.
 * Nothing sleeps: each step drains.
 */

/** Two tasks, the second building on the first, each with one criterion its child meets. */
const twoTaskPlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names."],
      testPlan: [{ criterion: 1, check: "Read the first line.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
};
const oneTaskPlan = { tasks: [twoTaskPlan.tasks[0]] };

/** A child's passing review: its one criterion, citing the file its author commits. */
const childReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "The export works.", paths: ["export.ts"] },
  ],
  missing_evidence: [],
};

/** An integrate review of `criteria` criteria, each verified by the file the children commit. */
const integrateReview = (criteria: number, verdict: "pass" | "changes-required" = "pass") => ({
  verdict,
  findings:
    verdict === "pass"
      ? []
      : [
          {
            id: "header-breaks-csv",
            severity: "high",
            required: true,
            file: "export.ts",
            line: 1,
            detail: "The header row is written after the rows, so the CSV no longer imports.",
          },
        ],
  acceptance: Array.from({ length: criteria }, (_, index) => ({
    criterion: index + 1,
    status: "verified",
    evidence: "The whole branch still meets it.",
    paths: ["export.ts"],
  })),
  missing_evidence: [],
});
const fenced = (review: unknown) =>
  `I reviewed the whole branch.\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``;

const service = FactoryService.FactoryService;

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

const head = (worktreePath: string) => git(worktreePath, ["rev-parse", "HEAD"]).pipe(Effect.orDie);
const treeOf = (worktreePath: string) =>
  git(worktreePath, ["rev-parse", "HEAD^{tree}"]).pipe(Effect.orDie);

/** The repository's worktrees, as `git worktree list` names them. */
const worktrees = (world: World) =>
  git(world.root, ["worktree", "list", "--porcelain"]).pipe(
    Effect.orDie,
    Effect.map((list) => list.split("\n").filter((line) => line.startsWith("worktree "))),
  );

/** Replaces the project's verify command; the next verify run reads it. */
const useVerify = (world: World, verifyCommand: FactoryCommand) =>
  Effect.gen(function* () {
    const settings = yield* Factory.FactorySettings.FactorySettings;
    const current = yield* settings.get(world.projectId);
    yield* settings.set(world.projectId, { ...current, verifyCommand });
  }).pipe(Effect.orDie);

/** The run the delivery awaits, once it has started. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);

/** The provider turn that started the run, as the provider received it. */
const turnOf = (world: World, runId: RunId) => {
  const turn = world.provider.started.find((candidate) => candidate.runId === runId);
  return turn ?? assert.fail(`No provider turn started run ${runId}.`);
};

/**
 * A parent whose planner's `plan` its owner approved, each of its children authored and reviewed
 * in turn; `beforeLastReview` runs right before the last child's reviewer run ends, which hands
 * the parent on to integrate. Returns the parent and its children's author and reviewer threads.
 */
const deliverChildren = (
  world: World,
  plan: { readonly tasks: ReadonlyArray<unknown> },
  beforeLastReview: Effect.Effect<
    void,
    never,
    Factory.FactorySettings.FactorySettings
  > = Effect.void,
) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan });
    yield* world.endRun(planner.runId, "completed");
    const branchStart = yield* git(world.root, ["rev-parse", "main"]);
    // The planner's launch made the parent's worktree; no later thread adds one.
    const checkouts = yield* worktrees(world);
    yield* factory.approvePlan(planner.deliveryId);
    yield* Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (worker) => worker.drain);
    const { children, branch } = yield* stateOf(planner.deliveryId);
    const childThreads: Array<ThreadId> = [];
    for (const [index, childId] of children.entries()) {
      const author = yield* world.launched(childId);
      yield* authorCommits(author.worktreePath, `feat: export step ${index + 1}`, `${index}\n`);
      yield* world.endRun(author.runId, "completed");
      const reviewer = yield* awaitedRun(childId);
      yield* factory.submitReview({ threadId: reviewer.threadId, review: childReview });
      if (index === children.length - 1) yield* beforeLastReview;
      yield* world.endRun(reviewer.runId, "completed");
      assert.strictEqual((yield* stateOf(childId)).status, "approved");
      childThreads.push(author.threadId, reviewer.threadId);
    }
    return {
      parentId: planner.deliveryId,
      planner: planner.threadId,
      worktreePath: planner.worktreePath,
      branch,
      branchStart,
      checkouts,
      children,
      childThreads,
    };
  }).pipe(Effect.orDie);

describe("a parent's integrate stage", () => {
  it.live(
    "verifies the whole branch afresh, then a new plan-mode reviewer judges it by every criterion",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const parent = yield* deliverChildren(world, twoTaskPlan);

          // One new receipt of the parent's own, for the worktree's HEAD after the last child,
          // in the parent's evidence: never a child's.
          const integrating = yield* stateOf(parent.parentId);
          assert.strictEqual(integrating.receipts.length, 1);
          const [receipt] = integrating.receipts;
          assert.strictEqual(receipt?.headSha, yield* head(parent.worktreePath));
          assert.strictEqual(receipt?.tree, yield* treeOf(parent.worktreePath));
          assert.strictEqual(receipt?.code, 0);
          assert.isTrue(receipt?.logPath.startsWith(world.evidenceDir(parent.parentId)));
          for (const childId of parent.children) {
            const child = yield* stateOf(childId);
            assert.notInclude(
              child.receipts.map(({ logPath }) => logPath),
              receipt?.logPath,
            );
          }

          // A new reviewer thread in plan mode on the shared worktree, no child's thread.
          const reviewer = yield* awaitedRun(parent.parentId);
          assert.strictEqual(integrating.stage, "integrate");
          assert.strictEqual(integrating.threads.reviewer, reviewer.threadId);
          assert.notInclude([parent.planner, ...parent.childThreads], reviewer.threadId);
          const { thread } = yield* threadProjection(reviewer.threadId);
          assert.strictEqual(thread.interactionMode, "plan");
          assert.strictEqual(thread.worktreePath, parent.worktreePath);
          assert.deepStrictEqual(yield* worktrees(world), parent.checkouts);

          // Its prompt covers the branch from where it started, by both tasks' criteria in order.
          const text = turnOf(world, reviewer.runId).message.text;
          for (const expected of [
            `\`${parent.branch}\``,
            `commit ${parent.branchStart} (created from \`HEAD\`)`,
            `\`${parent.branchStart}..${receipt?.headSha}\``,
            `- Commit: ${receipt?.headSha}`,
          ]) {
            assert.include(text, expected);
          }
          const order = [
            "`export-csv`: Export the current table as CSV",
            "- Criterion 1: The export button downloads the visible rows as CSV.",
            "`export-header`: Write a header row first",
            "- Criterion 2: The CSV starts with the column names.",
          ].map((line) => text.indexOf(line));
          assert.isTrue(order.every((position) => position >= 0));
          assert.deepStrictEqual(
            order,
            order.toSorted((left, right) => left - right),
          );

          // Its passing review, from the run the parent awaits, is recorded in the parent's
          // evidence and acted on once that run ends: the parent leaves integrate.
          const accepted = yield* factory.submitReview({
            threadId: reviewer.threadId,
            review: integrateReview(2),
          });
          assert.strictEqual(accepted.deliveryId, parent.parentId);
          assert.isFalse(accepted.review.summary.blocking);
          assert.isTrue(
            accepted.review.evidencePath.startsWith(world.evidenceDir(parent.parentId)),
          );
          assert.isTrue(yield* world.exists(accepted.review.evidencePath));
          yield* world.endRun(reviewer.runId, "completed");
          const after = yield* stateOf(parent.parentId);
          assert.strictEqual(after.stage, "pr");
          const attempts = yield* attemptsOf(parent.parentId);
          assert.deepStrictEqual(
            attempts.filter(([stage]) => stage === "verify" || stage === "integrate"),
            [
              ["verify", "passed"],
              ["integrate", "passed"],
            ],
          );
        }),
      ),
  );

  it.live(
    "blocks on a refused or failed verify with no repair turn, and verifies afresh on resume",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          // The child verified with the passing command; the parent's verify commits.
          const parent = yield* deliverChildren(
            world,
            oneTaskPlan,
            useVerify(world, verifyCommands.commits),
          );

          const refused = yield* stateOf(parent.parentId);
          assert.strictEqual(refused.status, "blocked");
          assert.strictEqual(refused.stage, "verify");
          assert.deepStrictEqual(refused.block, {
            reason: "receipt_refused",
            refusals: ["head_changed"],
          });
          assert.deepStrictEqual(refused.receipts, []);
          assert.isUndefined(refused.threads.reviewer);
          assert.strictEqual(needsYou(refused), "Factory refused the verify result: HEAD moved.");

          // A resume verifies again, at the HEAD it finds; this verify fails, and blocks the parent
          // with no repair turn, though its fix rounds are not spent.
          yield* useVerify(world, verifyCommands.fails);
          yield* factory.resume(parent.parentId);
          yield* drainFactory;
          yield* drainOrchestration;
          const turns = world.provider.started.length;
          const failed = yield* stateOf(parent.parentId);
          assert.strictEqual(failed.status, "blocked");
          assert.deepStrictEqual(failed.block, { reason: "verify_failed" });
          assert.isNull(failed.awaiting);
          assert.strictEqual(failed.receipts.length, 1);
          assert.strictEqual(failed.receipts[0]?.code, 3);
          assert.strictEqual(failed.receipts[0]?.headSha, yield* head(parent.worktreePath));
          assert.deepStrictEqual(failed.rounds, { fix: 0, review: 0 });
          assert.strictEqual(needsYou(failed), "Verify of the whole branch failed.");

          // Once verify passes, a resume records its receipt after the failed one, then launches
          // a reviewer.
          yield* useVerify(world, verifyCommands.passes);
          yield* factory.resume(parent.parentId);
          yield* drainFactory;
          const resumed = yield* stateOf(parent.parentId);
          assert.strictEqual(resumed.receipts.length, 2);
          assert.strictEqual(resumed.receipts[1]?.code, 0);
          const reviewer = yield* awaitedRun(parent.parentId);
          assert.strictEqual(resumed.stage, "integrate");
          assert.notInclude([parent.planner, ...parent.childThreads], reviewer.threadId);
          // The reviewer's is the only turn since the failed verify.
          assert.deepStrictEqual(
            world.provider.started.slice(turns).map(({ threadId }) => threadId),
            [reviewer.threadId],
          );
          assert.deepStrictEqual(
            (yield* attemptsOf(parent.parentId)).filter(([stage]) => stage === "verify"),
            [
              ["verify", "blocked"],
              ["verify", "failed"],
              ["verify", "passed"],
            ],
          );
        }),
      ),
  );

  it.live("blocks on a blocking review with its summary, then reviews afresh on resume", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const parent = yield* deliverChildren(world, oneTaskPlan);
        const reviewer = yield* awaitedRun(parent.parentId);
        const accepted = yield* factory.submitReview({
          threadId: reviewer.threadId,
          review: integrateReview(1, "changes-required"),
        });
        assert.isTrue(accepted.review.summary.blocking);
        yield* world.endRun(reviewer.runId, "completed");
        yield* drainOrchestration;
        const turns = world.provider.started.length;

        // No repair round: the parent blocks with the review's summary, though its review
        // rounds are not spent, and nothing is sent to any thread.
        const blocked = yield* stateOf(parent.parentId);
        assert.strictEqual(blocked.status, "blocked");
        assert.strictEqual(blocked.stage, "integrate");
        assert.deepStrictEqual(blocked.block, {
          reason: "review_changes_required",
          summary: accepted.review.summary,
        });
        assert.isNull(blocked.awaiting);
        assert.deepStrictEqual(blocked.rounds, { fix: 0, review: 0 });
        assert.strictEqual(
          needsYou(blocked),
          "The review of the whole branch requires changes (1 high, 0 medium, 0 low).",
        );
        yield* drainFactory;
        yield* drainOrchestration;
        assert.strictEqual(world.provider.started.length, turns);

        // A resume verifies again, then launches a reviewer of its own: the first gets nothing.
        yield* factory.resume(parent.parentId);
        yield* drainFactory;
        const resumed = yield* stateOf(parent.parentId);
        assert.strictEqual(resumed.receipts.length, 2);
        assert.strictEqual(resumed.reviewRound, 2);
        const second = yield* awaitedRun(parent.parentId);
        assert.notStrictEqual(second.threadId, reviewer.threadId);
        assert.strictEqual(resumed.threads.reviewer, second.threadId);
        assert.strictEqual(
          (yield* threadProjection(second.threadId)).thread.interactionMode,
          "plan",
        );
        assert.deepStrictEqual(
          world.provider.started.slice(turns).map(({ threadId }) => threadId),
          [second.threadId],
        );
      }),
    ),
  );

  it.live("takes a fenced review from a run without a submission, after one retry", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* deliverChildren(world, oneTaskPlan);
        const reviewer = yield* awaitedRun(parent.parentId);
        // Its one entry names a criterion the plan does not have.
        const outOfRange = {
          ...integrateReview(1),
          acceptance: integrateReview(2).acceptance.slice(1),
        };
        yield* world.provider.say(turnOf(world, reviewer.runId), fenced(outOfRange));
        yield* world.endRun(reviewer.runId, "completed");

        // The fenced review is judged as a submitted one: invalid, so one retry turn follows on
        // the same thread, naming the problem.
        const retrying = yield* stateOf(parent.parentId);
        assert.strictEqual(retrying.invalidSubmissions, 1);
        assert.deepStrictEqual(retrying.reviews, []);
        const retry = yield* awaitedRun(parent.parentId);
        assert.strictEqual(retry.threadId, reviewer.threadId);
        assert.notStrictEqual(retry.runId, reviewer.runId);
        assert.include(turnOf(world, retry.runId).message.text, "Criterion 2 is outside 1..1");

        yield* world.provider.say(turnOf(world, retry.runId), fenced(integrateReview(1)));
        yield* world.endRun(retry.runId, "completed");
        const after = yield* stateOf(parent.parentId);
        assert.strictEqual(after.stage, "pr");
        assert.strictEqual(after.reviews.length, 1);
        assert.strictEqual(after.reviews[0]?.source, "fallback");
        assert.isFalse(after.reviews[0]?.summary.blocking);
      }),
    ),
  );
});

/*
 * The integrate reviewer's submissions on the service, as the server builds it, over a stored
 * parent: in-memory SQLite, real git in a worktree standing in for the parent's, review judging
 * and its evidence under a temp T3 home. Threads are faked: only their shells are read, for the
 * run each is live in.
 */

const projectId = ProjectId.make("project-alpha");
const parentId = FactoryDeliveryId.make("delivery-parent");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const branch = "work/fd-parent";
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const childAuthor = ThreadId.make("thread-child-author");
const childReviewer = ThreadId.make("thread-child-reviewer");
const integrateRun = RunId.make("run-integrate");
/** A later turn of the integrate reviewer thread, queued behind its run. */
const nextRun = RunId.make("run-integrate-next");

const planTask = (id: string, criteria: number): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: Array.from({ length: criteria }, (_, index) => `${id} meets criterion ${index + 1}.`),
  testPlan: Array.from({ length: criteria }, (_, index) => ({
    criterion: index + 1,
    check: "A test shows it.",
    paths: ["src/export.test.ts"],
  })),
  likelyPaths: ["src/export.ts"],
  risk: "normal",
});
/** Two tasks of one and two criteria: three, numbered across the plan. */
const twoTasks = [planTask("export-csv", 1), planTask("export-header", 2)];

/** The thread the parent's integrate launch made, its effect after the children's starts. */
const integrateReviewerOf = (taskCount: number) =>
  FactoryThreadEffects.launchThreadId(parentId, 4 + taskCount);

/** The run each thread is live in; each test's seed sets the integrate reviewer's. */
const live: { integrate: RunId } = { integrate: integrateRun };

const shellOf = (threadId: ThreadId): OrchestrationV2ThreadShell | null =>
  threadId === planner || threadId === childReviewer
    ? liveThreadShell(threadId, { interactionMode: "plan" })
    : threadId.startsWith(`factory-thread:${parentId}:`)
      ? liveThreadShell(threadId, { interactionMode: "plan", activeRunId: live.integrate })
      : null;

/**
 * FactoryService, the worker, review judging and the thread effects as the server builds them. A
 * submission issues no effect, so the services that perform effects are stubs.
 */
const layer = FactoryService.layer.pipe(
  Layer.provideMerge(FactoryWorker.layer),
  // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
  Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
  Layer.provide(FactoryReview.layer),
  Layer.provide(FactoryThreadEffects.layer),
  Layer.provide(FactoryEvidence.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
      Layer.mock(FactoryPlanning.FactoryPlanning)({}),
      Layer.mock(FactoryRecord.FactoryRecord)({}),
      Layer.mock(FactoryChildren.FactoryChildren)({}),
      Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(WorkService.WorkService)({}),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
      ProviderRegistryMock.layer(),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
    }),
  ),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-integrate-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const commit = (cwd: string, message: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", message]);

/**
 * A repository standing in for the parent's worktree: where its branch started on `main`, then
 * the children's commits on the parent's branch with the export and its test.
 */
const makeWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-integrate-wt-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* commit(cwd, "chore: root");
  const base = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* git(cwd, ["switch", "-c", branch]);
  yield* fileSystem.makeDirectory(path.join(cwd, "src"));
  yield* fileSystem.writeFileString(path.join(cwd, "src", "export.ts"), "export const csv = 1;\n");
  yield* fileSystem.writeFileString(path.join(cwd, "src", "export.test.ts"), "// covers it\n");
  yield* git(cwd, ["add", "-A"]);
  yield* commit(cwd, "feat: export the table");
  const [headSha = "", tree = ""] = (yield* git(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"])).split(
    "\n",
  );
  return { cwd, base, headSha, tree };
}).pipe(Effect.orDie);

const store = FactoryDeliveryStore.FactoryDeliveryStore;
const stored = Effect.flatMap(store, (deliveries) => deliveries.get(parentId)).pipe(
  Effect.map((delivery) => Option.getOrThrow(delivery).state),
);
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${parentId}`;
});
/** The parent's evidence files whose names start with `review-`. */
const reviewFiles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = path.join(stateDir, "fd-factory", parentId);
  if (!(yield* fileSystem.exists(directory))) return [];
  return (yield* fileSystem.readDirectory(directory)).filter((name) => name.startsWith("review-"));
});
const submit = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(FactoryService.FactoryService, (factory) =>
    factory.submitReview({ threadId, review }),
  );

/** An integrate review of `criteria` criteria, each verified by the export's test. */
const review = (criteria: ReadonlyArray<number>) => ({
  verdict: "pass",
  findings: [],
  acceptance: criteria.map((criterion) => ({
    criterion,
    status: "verified",
    evidence: "The branch's test covers it.",
    paths: ["src/export.test.ts"],
  })),
  missing_evidence: [],
});
const upTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
/** Two entries for criterion 1, which a review may not hold. */
const invalidReview = review([1, 1, 2, 3]);

/**
 * Stores the parent as integrate left it, its plan approved and each child approved, its branch
 * verified at the worktree's HEAD and its integrate reviewer's run awaited, and its children's
 * deliveries approved, each with a reviewer thread of its own. `after` events follow.
 */
const seedIntegrating = (
  options: {
    readonly tasks?: ReadonlyArray<FactoryPlanTask>;
    readonly after?: ReadonlyArray<FactoryEvent>;
  } = {},
) =>
  Effect.gen(function* () {
    live.integrate = integrateRun;
    const worktree = yield* makeWorktree;
    const tasks = options.tasks ?? twoTasks;
    const children = tasks.map((task) => FactoryChildren.childDeliveryId(parentId, task.id));
    const receipt: FactoryVerifyReceipt = {
      version: 1,
      headSha: worktree.headSha,
      tree: worktree.tree,
      startedAt: "2026-10-25T10:00:00.000Z",
      finishedAt: "2026-10-25T10:01:00.000Z",
      code: 0,
      timedOut: false,
      durationMs: 60_000,
      command: { executable: "vp", args: ["test", "run"] },
      settingsHash: "settings-1",
      platform: "darwin-arm64",
      logPath: `/t3/userdata/fd-factory/${parentId}/verify-1.log`,
      outputHash: "output-1",
    };
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: planner,
        runId: planRun,
        worktreePath: worktree.cwd,
        baseline: worktree.base,
      },
      {
        type: "plan.submitted",
        round: 1,
        threadId: planner,
        runId: planRun,
        judgment: {
          type: "accepted",
          plan: {
            tasks,
            source: "mcp",
            evidencePath: `/t3/userdata/fd-factory/${parentId}/plan.json`,
          },
        },
      },
      { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
      { type: "plan.approved" },
      { type: "children.created", effectId: 2, children },
      ...children.flatMap((child, index): ReadonlyArray<FactoryEvent> => [
        { type: "child.started", effectId: 3 + index },
        { type: "child.approved", deliveryId: child },
      ]),
      {
        type: "command.finished",
        effectId: 3 + children.length,
        outcome: { type: "receipt", receipt },
      },
      {
        type: "thread.launched",
        effectId: 4 + children.length,
        threadId: integrateReviewerOf(children.length),
        runId: integrateRun,
        worktreePath: worktree.cwd,
        baseline: worktree.headSha,
      },
      ...(options.after ?? []),
    ];
    const state = events.reduce<FactoryDeliveryState>(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ kind: "parent", branch, baseRef: "HEAD" }),
    );
    const deliveries = yield* store;
    yield* deliveries.insert({
      deliveryId: parentId,
      projectId,
      itemRef: { sourceId, itemId: WorkItemId.make("fd-parent") },
      state,
    });
    for (const [index, child] of children.entries()) {
      yield* deliveries.insert({
        deliveryId: child,
        projectId,
        itemRef: { sourceId, itemId: WorkItemId.make(`fd-child-${index + 1}`) },
        parentId,
        state: {
          ...queuedDeliveryState({
            kind: "child",
            branch,
            baseRef: "HEAD",
            worktreePath: worktree.cwd,
          }),
          status: "approved",
          stage: "record",
          threads: { author: childAuthor, reviewer: childReviewer },
        },
      });
    }
    return { ...worktree, reviewer: integrateReviewerOf(children.length) };
  });

/** A task's own review, which holds at most 50 acceptance entries. */
const decodeTaskReview = Schema.decodeUnknownExit(FactoryReviewSchema);
const isRefused = Schema.is(FactoryService.FactoryReviewRefusedError);
const isInvalid = Schema.is(FactoryService.FactoryReviewInvalidError);
const isCodeChanged = Schema.is(FactoryService.FactoryReviewCodeChangedError);

describe("factory_submit_review from a parent's integrate reviewer", () => {
  it.effect("judges and records the review of the run the parent awaits", () =>
    Effect.gen(function* () {
      const { reviewer, headSha } = yield* seedIntegrating();

      const accepted = yield* submit(reviewer, review([1, 2, 3]));

      assert.strictEqual(accepted.deliveryId, parentId);
      assert.deepInclude(accepted.review, { round: 1, source: "mcp" });
      assert.deepInclude(accepted.review.summary, { headSha, verdict: "pass", blocking: false });
      const state = yield* stored;
      assert.deepStrictEqual(state.reviews, [accepted.review]);
      assert.deepStrictEqual(state.awaiting, {
        type: "run",
        threadId: reviewer,
        runId: integrateRun,
      });
      assert.deepStrictEqual(yield* reviewFiles, ["review-1.json"]);
      const fileSystem = yield* FileSystem.FileSystem;
      const evidence = JSON.parse(yield* fileSystem.readFileString(accepted.review.evidencePath));
      assert.deepInclude(evidence, { deliveryId: parentId, round: 1, threadId: reviewer });
      assert.deepStrictEqual(
        evidence.review.acceptance.map(({ criterion }: { criterion: number }) => criterion),
        [1, 2, 3],
      );
      // It names what each number stood for, the approved tasks' criteria in plan order.
      assert.deepStrictEqual(evidence.criteria, [
        { criterion: 1, taskId: "export-csv", text: "export-csv meets criterion 1." },
        { criterion: 2, taskId: "export-header", text: "export-header meets criterion 1." },
        { criterion: 3, taskId: "export-header", text: "export-header meets criterion 2." },
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("judges every criterion of every task, past a single review's bound", () =>
    Effect.gen(function* () {
      // The largest plan's tasks hold 50 criteria each; two of them hold 100 in all.
      const tasks = [planTask("export-csv", 50), planTask("export-header", 50)];
      const { reviewer } = yield* seedIntegrating({ tasks });
      assert.isTrue(Exit.isFailure(decodeTaskReview(review(upTo(100)))));

      // A criterion past the plan's is the reviewer's to correct; nothing is recorded for it.
      const outside = yield* Effect.flip(submit(reviewer, review([...upTo(100), 101])));
      if (!isInvalid(outside)) return assert.fail(`Expected an invalid review, got ${outside}.`);
      assert.include(outside.problems.join(" "), "Criterion 101 is outside 1..100");
      assert.isFalse(outside.blocked);
      assert.deepStrictEqual(yield* reviewFiles, []);

      // One left out blocks the branch; every one answered is judged as a review of all of them.
      const missingLast = yield* submit(reviewer, review(upTo(99)));
      assert.isTrue(missingLast.review.summary.blocking);
      const fileSystem = yield* FileSystem.FileSystem;
      const evidence = JSON.parse(
        yield* fileSystem.readFileString(missingLast.review.evidencePath),
      );
      assert.deepStrictEqual(evidence.blockingReasons, [
        { rule: "criterion_absent", description: "Criterion 100 has no acceptance entry." },
      ]);
      assert.strictEqual(evidence.review.acceptance.length, 99);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("takes a review of all hundred criteria as passing", () =>
    Effect.gen(function* () {
      const tasks = [planTask("export-csv", 50), planTask("export-header", 50)];
      const { reviewer } = yield* seedIntegrating({ tasks });
      const accepted = yield* submit(reviewer, review(upTo(100)));
      assert.isFalse(accepted.review.summary.blocking);
      assert.strictEqual(accepted.review.details?.omitted.criteria, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("blocks the parent on the second invalid submission of the round", () =>
    Effect.gen(function* () {
      const { reviewer } = yield* seedIntegrating();

      const first = yield* Effect.flip(submit(reviewer, invalidReview));
      if (!isInvalid(first)) return assert.fail(`Expected an invalid review, got ${first}.`);
      assert.isFalse(first.blocked);
      assert.include(first.problems.join(" "), "Criterion 1 has 2 acceptance entries");
      const counted = yield* stored;
      assert.strictEqual(counted.status, "running");
      assert.strictEqual(counted.invalidSubmissions, 1);

      const second = yield* Effect.flip(submit(reviewer, invalidReview));
      if (!isInvalid(second)) return assert.fail(`Expected an invalid review, got ${second}.`);
      assert.isTrue(second.blocked);
      const state = yield* stored;
      assert.strictEqual(state.status, "blocked");
      assert.deepStrictEqual(state.block, {
        reason: "invalid_submission",
        problems: second.problems,
      });
      assert.deepStrictEqual(yield* reviewFiles, []);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect.each([
    { change: "HEAD moved", expected: ["head_changed"] },
    { change: "the tree is dirty", expected: ["tree_dirty"] },
  ] as const)("blocks with code_changed on a submission after $change", ({ expected }) =>
    Effect.gen(function* () {
      const { reviewer, cwd } = yield* seedIntegrating();
      if (expected[0] === "head_changed") {
        yield* commit(cwd, "chore: a commit during review");
      } else {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, "scratch.txt"), "left behind\n");
      }

      const error = yield* Effect.flip(submit(reviewer, review([1, 2, 3])));

      if (!isCodeChanged(error)) return assert.fail(`Expected changed code, got ${error}.`);
      assert.deepStrictEqual(error.changes, expected);
      const state = yield* stored;
      assert.strictEqual(state.status, "blocked");
      assert.deepStrictEqual(state.block, { reason: "code_changed", changes: expected });
      assert.deepStrictEqual(state.reviews, []);
      assert.deepStrictEqual(yield* reviewFiles, []);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  const resumeCheck = { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null };
  it.effect.each([
    { name: "a child's reviewer", caller: () => childReviewer, refusal: "review_not_active" },
    {
      name: "a later run queued on the integrate reviewer's thread",
      caller: (seeded: { readonly reviewer: ThreadId }) => {
        live.integrate = nextRun;
        return seeded.reviewer;
      },
      refusal: "review_not_active",
    },
    { name: "the parent's planner", caller: () => planner, refusal: "not_reviewer" },
    {
      name: "the parent's integrate reviewer while a resume verifies the branch again",
      // The second invalid submission blocked the parent; its resume is verifying again.
      after: [
        {
          type: "review.submitted",
          round: 1,
          threadId: integrateReviewerOf(2),
          runId: integrateRun,
          judgment: { type: "invalid", problems: ["No."] },
        },
        {
          type: "review.submitted",
          round: 1,
          threadId: integrateReviewerOf(2),
          runId: integrateRun,
          judgment: { type: "invalid", problems: ["No."] },
        },
        { type: "resume", check: resumeCheck },
      ] satisfies ReadonlyArray<FactoryEvent>,
      caller: (seeded: { readonly reviewer: ThreadId }) => seeded.reviewer,
      refusal: "review_not_active",
    },
  ] as const)("refuses $name, changing nothing", ({ caller, refusal, ...options }) =>
    Effect.gen(function* () {
      const seeded = yield* seedIntegrating("after" in options ? { after: options.after } : {});
      const threadId = caller(seeded);
      const before = yield* rawRow;
      const { invalidSubmissions } = yield* stored;
      // A write now would move updated_at.
      yield* TestClock.adjust("1 minute");

      for (const submission of [review([1, 2, 3]), invalidReview]) {
        const error = yield* Effect.flip(submit(threadId, submission));
        if (!isRefused(error)) return assert.fail(`Expected a refusal, got ${error}.`);
        assert.strictEqual(error.reason, refusal);
      }
      assert.deepStrictEqual(yield* rawRow, before);
      assert.strictEqual((yield* stored).invalidSubmissions, invalidSubmissions);
      assert.deepStrictEqual(yield* reviewFiles, []);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
