import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDeliveryId,
  FactoryProjectSettings,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
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
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
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
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import type { FactoryDeliveryState } from "./pipeline/state.ts";
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
} as unknown as WorkItemDetail;
const branch = workBranchName(item);
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const reviewer = ThreadId.make("thread-reviewer");
const reviewRun = RunId.make("run-review");

/** The worktree the fake launches report, and its task baseline. */
interface World {
  worktree: { readonly cwd: string; readonly baseline: string } | null;
}

// Threads are faked: FactoryThreadEffects.test.ts and FactoryReview.test.ts cover their launches.
// Every run is still going when its launch returns; the test steps its end.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(WorkService.WorkService)({
      canonicalRef: (ref) => Effect.succeed(ref),
      resolveSource: () =>
        Effect.succeed({
          stored: { sourceId, projectId },
        } as unknown as WorkService.ResolvedSource),
      getItem: () => Effect.succeed(item),
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
    // Every review here arrives through the tool, never the fenced fallback.
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    // FactoryPullRequest.test.ts opens pull requests; here an approved delivery's opens.
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({
      open: () =>
        Effect.succeed({
          number: 7,
          url: "https://github.com/acme/alpha/pull/7",
          headBranch: branch,
        }),
    }),
  );

/**
 * FactoryService, the worker, the verify runner, review judging and record as the server builds
 * them, on in-memory SQLite, real git, real processes and an evidence folder under a temp T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(FactoryVerifyRunner.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-record-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = { worktree: null };
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
/** The worktree's HEAD and its tree. */
const headOf = (cwd: string) =>
  Effect.map(git(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"]), (out) => {
    const [headSha = "", tree = ""] = out.split("\n");
    return { headSha, tree };
  });

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const useVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({
      verifyCommand: { executable: process.execPath, args: ["-e", 'console.log("checks pass")'] },
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
const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.get(deliveryId),
  ).pipe(Effect.map((delivery): FactoryDeliveryState => Option.getOrThrow(delivery).state));
const tasksOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) => tasks.listByDelivery(deliveryId));
const recordAttempt = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((runs) => runs.find(({ stage }) => stage === "record")));
const evidenceDirectory = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(stateDir, "fd-factory", deliveryId);
  });
const countTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_tasks
  `;
  return row?.count;
});

/** A review that passes: criterion 1 verified by the export's test. */
const passingReview = {
  verdict: "pass",
  findings: [],
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
 * A repository standing in for the delivery worktree (the task baseline on `main`, the author's
 * commit on the delivery branch), and a started delivery whose author has finished, whose commit
 * passed verify, and whose reviewer submitted a passing review that is still awaiting its run's
 * end. Returns the delivery and the reviewed commit.
 */
const reviewAccepted = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-record-wt-" });
    yield* git(cwd, ["init", "-b", "main"]);
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

    yield* useVerify;
    const { deliveryId } = yield* start;
    yield* drain;
    yield* runEnds(deliveryId, author, authorRun);
    const verified = yield* stateOf(deliveryId);
    assert.strictEqual(verified.stage, "review");
    assert.deepStrictEqual(verified.awaiting, {
      type: "run",
      threadId: reviewer,
      runId: reviewRun,
    });

    const service = yield* FactoryService.FactoryService;
    yield* service.submitReview({ threadId: reviewer, review: passingReview });
    const reviewed = yield* headOf(cwd);
    const receipt = verified.receipts.at(-1);
    assert.deepStrictEqual({ headSha: receipt?.headSha, tree: receipt?.tree }, reviewed);
    return { cwd, deliveryId, reviewed };
  });

describe("the record gate", () => {
  it.effect("approves the verified, reviewed commit once the reviewer's run completes", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        const directory = yield* evidenceDirectory(deliveryId);

        yield* runEnds(deliveryId, reviewer, reviewRun);

        // Approved, so the PR stage ran and its pull request is open.
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.stage, "pr");
        assert.isNull(state.awaiting);
        assert.isNull(state.block);

        // The approval names the item's task, the commit and the evidence it rests on.
        const approvalPath = `${directory}/approval-item.json`;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(approvalPath)), {
          version: 1,
          deliveryId,
          taskId: "item",
          headSha: reviewed.headSha,
          tree: reviewed.tree,
          receiptPath: `${directory}/verify-1.json`,
          reviewPath: `${directory}/review-1.json`,
          approvedAt: "1970-01-01T00:00:00.000Z",
        });
        assert.isTrue(yield* fileSystem.exists(`${directory}/verify-1.json`));
        assert.isTrue(yield* fileSystem.exists(`${directory}/review-1.json`));

        const [task] = yield* tasksOf(deliveryId);
        assert.strictEqual(task?.taskId, "item");
        assert.strictEqual(task?.lastReviewedSha, reviewed.headSha);
        const attempt = yield* recordAttempt(deliveryId);
        assert.strictEqual(attempt?.outcome, "passed");
        assert.strictEqual(attempt?.evidencePath, approvalPath);
        // Evidence stays under T3 home: the worktree is as the author left it.
        assert.strictEqual(
          yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
      }),
    ),
  );

  it.effect.each([
    {
      name: "a commit added after the review",
      change: (cwd: string) =>
        writeFile(cwd, "src/export.ts", "export const csv = 2;\n").pipe(
          Effect.andThen(git(cwd, ["add", "-A"])),
          Effect.andThen(commit(cwd, ["-m", "fix: write the header row"])),
        ),
      differences: ["head_changed", "tree_changed", "not_reviewed"],
      clean: true,
    },
    {
      name: "an amended tree",
      change: (cwd: string) =>
        writeFile(cwd, "src/export.ts", "export const csv = 3;\n").pipe(
          Effect.andThen(git(cwd, ["add", "-A"])),
          Effect.andThen(commit(cwd, ["--amend", "--no-edit"])),
        ),
      differences: ["head_changed", "tree_changed", "not_reviewed"],
      clean: true,
    },
    {
      name: "an untracked file",
      change: (cwd: string) => writeFile(cwd, "notes.txt", "scratch\n"),
      differences: ["tree_dirty"],
      clean: false,
    },
  ] as const)("blocks on $name, naming the expected and actual commit", (testCase) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, deliveryId, reviewed } = yield* reviewAccepted(world);
        yield* testCase.change(cwd);
        const actual = yield* headOf(cwd);

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "record");
        assert.deepStrictEqual(state.block, {
          reason: "record_mismatch",
          expected: reviewed,
          actual: { ...actual, clean: testCase.clean },
          differences: [...testCase.differences],
        });
        if (testCase.clean) assert.notStrictEqual(actual.headSha, reviewed.headSha);
        else assert.deepStrictEqual(actual, reviewed);

        // Nothing is approved: no file, and the task covers no commit.
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* evidenceDirectory(deliveryId);
        assert.isFalse(yield* fileSystem.exists(`${directory}/approval-item.json`));
        const [task] = yield* tasksOf(deliveryId);
        assert.isNull(task?.lastReviewedSha);
        const attempt = yield* recordAttempt(deliveryId);
        assert.strictEqual(attempt?.outcome, "blocked");
        assert.isNull(attempt?.evidencePath);
      }),
    ),
  );

  it.effect("blocks when the delivery has no task to approve", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* reviewAccepted(world);
        // As a delivery stored before tasks were written with it would be.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM fd_factory_tasks WHERE delivery_id = ${deliveryId}`;

        yield* runEnds(deliveryId, reviewer, reviewRun);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 5, type: "record_approval" },
          detail: "Factory could not record the approval (FactoryRecordTaskError).",
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* evidenceDirectory(deliveryId);
        assert.isFalse(yield* fileSystem.exists(`${directory}/approval-item.json`));
      }),
    ),
  );
});

describe("a single-item delivery's task", () => {
  it.effect("is stored with the delivery, once, so a second start adds none", () =>
    withWorld(() =>
      Effect.gen(function* () {
        yield* useVerify;
        const first = yield* start;
        yield* drain;

        const tasks = yield* tasksOf(first.deliveryId);
        assert.deepStrictEqual(
          tasks.map(({ deliveryId, taskId, position, plan, lastReviewedSha }) => ({
            deliveryId,
            taskId,
            position,
            plan,
            lastReviewedSha,
          })),
          [
            {
              deliveryId: first.deliveryId,
              taskId: FactoryTaskId.make("item"),
              position: 1,
              plan: null,
              lastReviewedSha: null,
            },
          ],
        );

        const error = yield* Effect.flip(start);
        assert.strictEqual(error._tag, "FactoryDeliveryActive");
        yield* drain;
        assert.strictEqual(yield* countTasks, 1);
        assert.deepStrictEqual(yield* tasksOf(first.deliveryId), tasks);
      }),
    ),
  );
});
