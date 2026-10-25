import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryProjectSettings,
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
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
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
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent, FactoryRoundLimits } from "./pipeline/state.ts";
import type { FactoryAuthorItem } from "./prompts/author.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-1");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const branch = "feature/item-7";
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
// The id Factory derives for the reviewer launch, the delivery's fourth effect.
const reviewer = ThreadId.make(`factory-thread:${deliveryId}:4`);
const reviewRun = RunId.make("run-review");
const retryRun = RunId.make("run-retry");

const model = (name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: name,
});
const reviewerModel = model("reviewer-model");
const authorModel = model("author-model");
const projectModel = model("project-model");

const item = {
  ref: itemRef,
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: null,
  locator: "tasks/fd-aaaaaa.md",
  body: "Users can export the current table as CSV.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

/** What the fakes are told and what they saw. */
interface World {
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput>;
  /** Assistant messages of each run, oldest first. */
  readonly messages: Map<RunId, ReadonlyArray<string>>;
  worktreePath: string | null;
  projectModel: ModelSelection | null;
}

// The effects read only these fields of the launch and send results and the thread records, so
// the fakes build no more than that. Every run is still going; the test steps its end.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          world.launches.push(input);
          return {
            threadId: input.threadId,
            projection: {
              runs: [
                {
                  id: reviewRun,
                  userMessageId: input.initialMessage?.messageId,
                  status: "running",
                },
              ],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.sync(() => {
          world.sends.push(input);
          return {
            run: { id: retryRun },
            message: { attachments: [] },
          } as unknown as ThreadManagement.ThreadManagementSendResult;
        }),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () => Stream.empty,
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((
        threadId: ThreadId,
        _fields: unknown,
        filter?: {
          readonly runIds?: ReadonlyArray<RunId>;
          readonly messageRunIds?: ReadonlyArray<RunId>;
          readonly messageRoles?: ReadonlyArray<string>;
        },
      ) =>
        Effect.sync(() => ({
          thread: { id: threadId, worktreePath: world.worktreePath, deletedAt: null },
          runs: (filter?.runIds ?? []).map((id) => ({
            id,
            status: "running" satisfies OrchestrationV2RunStatus,
          })),
          messages: filter?.messageRoles?.includes("assistant")
            ? (filter.messageRunIds ?? []).flatMap((runId) =>
                (world.messages.get(runId) ?? []).map((text) => ({
                  role: "assistant",
                  runId,
                  text,
                })),
              )
            : [],
        }))) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() =>
          Option.some({
            projectId: id,
            title: "Alpha",
            workspaceRoot: "/nowhere",
            defaultModelSelection: world.projectModel,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-24T00:00:00.000Z",
            updatedAt: "2026-10-24T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(WorkService.WorkService)({
      getItem: () => Effect.succeed(item as unknown as WorkItemDetail),
      // FactoryWorkLink.test.ts covers the link on the real Work service.
      linkLaunch: (_input, launch) => launch,
    }),
    // Verify is not run here: the test feeds its receipt.
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
  );

/** Pull requests are opened in FactoryPullRequest.test.ts; here an approved delivery's opens. */
const openedPullRequest = Layer.mock(FactoryPullRequest.FactoryPullRequest)({
  open: () =>
    Effect.succeed({ number: 7, url: "https://github.com/acme/alpha/pull/7", headBranch: branch }),
});

/**
 * FactoryService, the worker, the thread effects, review judging and record as the server builds
 * them, on in-memory SQLite, real git and an evidence folder under a temp T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(FactoryThreadEffects.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPlanning.FactoryPlanning)({})),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(openedPullRequest),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provide(ProviderRegistryMock.layer()),
    Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-review-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    launches: [],
    sends: [],
    messages: new Map(),
    worktreePath: null,
    projectModel: null,
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
const commit = (cwd: string, message: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", message]);

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const useRoles = (roles: {
  readonly author?: ModelSelection;
  readonly reviewer?: ModelSelection;
}) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(projectId, decodeSettings({ roles })),
  );

const store = FactoryDeliveryStore.FactoryDeliveryStore;
const stored = Effect.flatMap(store, (deliveries) => deliveries.get(deliveryId)).pipe(
  Effect.map((delivery) => Option.getOrThrow(delivery).state),
);
const step = (event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(deliveryId, event));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const submit = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(FactoryService.FactoryService, (service) =>
    service.submitReview({ threadId, review }),
  );
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
);
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`;
});
const evidenceDirectory = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(stateDir, "fd-factory", deliveryId);
});
/** The delivery's evidence files whose names start with `review-`. */
const reviewFiles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* evidenceDirectory;
  if (!(yield* fileSystem.exists(directory))) return [];
  return (yield* fileSystem.readDirectory(directory)).filter((name) => name.startsWith("review-"));
});

/**
 * A repository standing in for the delivery worktree: the task baseline on `main`, then the
 * author's commit on the delivery branch with the export and its test.
 */
const makeWorktree = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-review-wt-" });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* commit(cwd, "chore: root");
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* fileSystem.makeDirectory(path.join(cwd, "src"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "src", "export.ts"),
      "export const csv = 1;\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "src", "export.test.ts"), "// covers csv\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, "feat: export the table as CSV");
    world.worktreePath = cwd;
    return { cwd, baseline };
  });

/** Where the verify runner would have written the receipt below. */
const receiptPath = "/t3/userdata/fd-factory/delivery-1/verify-1.json";

/**
 * Stores the delivery as verify left it, feeds the passing receipt of the worktree's commit, and
 * returns once the reviewer's launch is stored and the delivery awaits its run.
 */
const startReview = (world: World, limits?: FactoryRoundLimits) =>
  Effect.gen(function* () {
    const { cwd, baseline } = yield* makeWorktree(world);
    const [headSha = "", tree = ""] = (yield* git(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"])).split(
      "\n",
    );
    const receipt: FactoryVerifyReceipt = {
      version: 1,
      headSha,
      tree,
      startedAt: "2026-10-24T10:00:00.000Z",
      finishedAt: "2026-10-24T10:01:05.000Z",
      code: 0,
      timedOut: false,
      durationMs: 65_000,
      command: { executable: "vp", args: ["test", "run"] },
      settingsHash: "settings-1",
      platform: "darwin-arm64",
      logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
      outputHash: "output-1",
    };
    const verifying = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: cwd,
        baseline,
      },
      { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
      { type: "settle.checked", effectId: 2, result: { status: "settled" } },
    ] satisfies ReadonlyArray<FactoryEvent>;
    const state = verifying.reduce<FactoryDeliveryState>(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ branch, baseRef: "main", ...(limits === undefined ? {} : { limits }) }),
    );
    yield* Effect.flatMap(store, (deliveries) =>
      deliveries.insert({ deliveryId, projectId, itemRef, state }),
    );
    // The item's one task, as FactoryService.start stores it.
    yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
      tasks.insert({ deliveryId, taskId: FactoryTaskId.make("item") }),
    );
    // The attempts the worker would have recorded: the author's passed, verify's is running.
    const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
    const authored = yield* runs.append({
      deliveryId,
      stage: "author",
      threadId: author,
      runId: authorRun,
    });
    yield* runs.finish({
      deliveryId,
      stage: "author",
      attempt: authored.attempt,
      outcome: "passed",
    });
    yield* runs.append({ deliveryId, stage: "verify" });
    // The author's own account of its work, which a first-round reviewer must never see.
    world.messages.set(authorRun, ["Done. AUTHOR-CLAIM: every criterion is verified."]);
    yield* step({
      type: "command.finished",
      effectId: 3,
      outcome: { type: "receipt", receipt, evidencePath: receiptPath },
    });
    yield* drain;
    return { cwd, baseline, receipt };
  });

/** Limits under which a blocking review blocks at once, with no repair round. */
const noRounds: FactoryRoundLimits = { maxFixRounds: 0, maxReviewRounds: 0 };

/** A review that passes: a low finding, and criterion 1 verified by the export's test. */
const passingReview = {
  verdict: "pass",
  findings: [
    {
      id: "export-name",
      severity: "low",
      required: false,
      file: "src/export.ts",
      line: 1,
      detail: "The export is named for its format only, so a second format will need a rename.",
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
/** A review that blocks: a high finding the commit must fix. */
const blockingReview = {
  ...passingReview,
  verdict: "changes-required",
  findings: [
    {
      id: "empty-table",
      severity: "high",
      required: true,
      file: "src/export.ts",
      line: 1,
      detail: "An empty table exports no header row, so the CSV cannot be re-imported.",
    },
  ],
};
const fenced = (review: unknown) =>
  `I reviewed the export.\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``;

const reviewerFinished = (runId: RunId): FactoryEvent => ({
  type: "run.finished",
  threadId: reviewer,
  runId,
  status: "completed",
});

const isRefused = Schema.is(FactoryService.FactoryReviewRefusedError);
const isInvalid = Schema.is(FactoryService.FactoryReviewInvalidError);
const isCodeChanged = Schema.is(FactoryService.FactoryReviewCodeChangedError);
/** Why `error`, which must be a refusal, refused the submission. */
const refusalOf = (error: unknown) =>
  isRefused(error) ? error.reason : assert.fail(`Expected a refusal, got ${String(error)}.`);
const invalidOf = (error: unknown) =>
  isInvalid(error) ? error : assert.fail(`Expected an invalid review, got ${String(error)}.`);
const codeChangesOf = (error: unknown) =>
  isCodeChanged(error)
    ? error.changes
    : assert.fail(`Expected changed code, got ${String(error)}.`);

describe("the reviewer launch", () => {
  it.effect("launches the reviewer in plan mode on the worktree with the review prompt", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd, baseline, receipt } = yield* startReview(world);

        assert.strictEqual(world.launches.length, 1);
        const [launch] = world.launches;
        assert.strictEqual(launch?.threadId, reviewer);
        assert.strictEqual(launch?.interactionMode, "plan");
        assert.deepStrictEqual(launch?.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: cwd,
        });
        assert.strictEqual(launch?.title, "Review fd-aaaaaa: Add the export button");
        const text = launch?.initialMessage?.text ?? "";
        for (const expected of [
          "Work item fd-aaaaaa: Add the export button",
          "Users can export the current table as CSV.",
          `\`${baseline}..${receipt.headSha}\``,
          `Commit: ${receipt.headSha} (tree ${receipt.tree})`,
          "exit code 0 after 65 s",
          "factory_submit_review",
          "```json",
        ]) {
          assert.include(text, expected);
        }
        assert.notInclude(text, "AUTHOR-CLAIM");

        const state = yield* stored;
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.threads.reviewer, reviewer);
        assert.deepStrictEqual(state.awaiting, {
          type: "run",
          threadId: reviewer,
          runId: reviewRun,
        });
        // The task baseline stays the author's.
        assert.strictEqual(state.baseline, baseline);
      }),
    ),
  );

  it.effect.each([
    {
      name: "the reviewer profile",
      roles: { author: authorModel, reviewer: reviewerModel },
      expected: reviewerModel,
    },
    { name: "the author profile", roles: { author: authorModel }, expected: authorModel },
    { name: "the project default", roles: {}, expected: projectModel },
  ])("uses $name for the reviewer's model", ({ roles, expected }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.projectModel = projectModel;
        yield* useRoles(roles);
        yield* startReview(world);
        assert.deepStrictEqual(world.launches[0]?.modelSelection, expected);
      }),
    ),
  );
});

describe("FactoryService.submitReview refusals", () => {
  it.effect.each([
    { name: "the author thread", threadId: author },
    { name: "an unknown thread", threadId: ThreadId.make("thread-unknown") },
  ])("refuses $name as not the reviewer and changes nothing", ({ threadId }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        const before = yield* rawRow;
        const attemptsBefore = yield* attempts;
        // A write now would move updated_at.
        yield* TestClock.adjust("1 minute");

        const error = yield* Effect.flip(submit(threadId, passingReview));

        assert.strictEqual(refusalOf(error), "not_reviewer");
        assert.deepStrictEqual(yield* rawRow, before);
        assert.deepStrictEqual(yield* attempts, attemptsBefore);
        assert.deepStrictEqual(yield* reviewFiles, []);
      }),
    ),
  );

  it.effect.each([
    {
      name: "blocked on the reviewer run's failure",
      after: [{ type: "run.finished", threadId: reviewer, runId: reviewRun, status: "failed" }],
    },
    {
      name: "past review, at record",
      after: [
        {
          type: "review.submitted",
          round: 1,
          threadId: reviewer,
          runId: reviewRun,
          judgment: {
            type: "accepted",
            review: {
              source: "mcp",
              summary: {
                headSha: "a".repeat(40),
                verdict: "pass",
                blocking: false,
                findings: { high: 0, medium: 0, low: 0 },
                reviewedAt: "2026-10-24T10:05:00.000Z",
              },
              evidencePath: "/t3/review-1.json",
            },
          },
        },
        reviewerFinished(reviewRun),
      ],
    },
    {
      name: "reading the fallback after the run",
      after: [reviewerFinished(reviewRun)],
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly after: ReadonlyArray<FactoryEvent>;
  }>)("refuses the reviewer while its delivery is $name and changes nothing", ({ after }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        // Stored without running any effect, as another step would have left it.
        const deliveries = yield* store;
        const current = yield* stored;
        yield* deliveries.update(
          deliveryId,
          after.reduce((state, event) => advance(state, event).delivery, current),
        );
        const before = yield* rawRow;
        yield* TestClock.adjust("1 minute");

        const error = yield* Effect.flip(submit(reviewer, passingReview));

        assert.strictEqual(refusalOf(error), "review_not_active");
        assert.deepStrictEqual(yield* rawRow, before);
        assert.deepStrictEqual(yield* reviewFiles, []);
      }),
    ),
  );

  it.effect("refuses a second review once the round's review is accepted", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        yield* submit(reviewer, passingReview);
        const before = yield* rawRow;
        yield* TestClock.adjust("1 minute");

        const error = yield* Effect.flip(submit(reviewer, blockingReview));

        assert.strictEqual(refusalOf(error), "already_accepted");
        assert.deepStrictEqual(yield* rawRow, before);
        assert.deepStrictEqual(yield* reviewFiles, ["review-1.json"]);
      }),
    ),
  );
});

describe("FactoryService.submitReview accepted reviews", () => {
  it.effect(
    "records a passing review with its evidence and moves to record when the run ends",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { receipt } = yield* startReview(world);
          const directory = yield* evidenceDirectory;

          const accepted = yield* submit(reviewer, passingReview);

          const evidencePath = `${directory}/review-1.json`;
          assert.deepStrictEqual(accepted, {
            deliveryId,
            review: {
              round: 1,
              source: "mcp",
              summary: {
                headSha: receipt.headSha,
                verdict: "pass",
                blocking: false,
                findings: { high: 0, medium: 0, low: 1 },
                reviewedAt: "1970-01-01T00:00:00.000Z",
              },
              evidencePath,
              // FactoryReview.findings.test.ts covers the projection's bounds.
              details: {
                findings: [
                  {
                    id: "export-name",
                    severity: "low",
                    required: false,
                    blocking: false,
                    file: "src/export.ts",
                    line: 1,
                    detail:
                      "The export is named for its format only, so a second format will need a rename.",
                  },
                ],
                criteria: [],
                missingEvidence: [],
                omitted: { findings: 0, criteria: 0, missingEvidence: 0 },
              },
            },
          });
          // Recorded, but not acted on while the reviewer's run goes on.
          const recorded = yield* stored;
          assert.deepStrictEqual(recorded.reviews, [accepted.review]);
          assert.strictEqual(recorded.status, "running");
          assert.strictEqual(recorded.stage, "review");
          assert.deepStrictEqual(recorded.awaiting, {
            type: "run",
            threadId: reviewer,
            runId: reviewRun,
          });

          // The evidence holds the review as submitted and the judgment, under T3 home.
          const fileSystem = yield* FileSystem.FileSystem;
          const written = JSON.parse(yield* fileSystem.readFileString(evidencePath));
          assert.strictEqual(written.source, "mcp");
          assert.strictEqual(written.round, 1);
          assert.strictEqual(written.threadId, reviewer);
          assert.strictEqual(written.tree, receipt.tree);
          assert.deepStrictEqual(written.summary, accepted.review.summary);
          assert.deepStrictEqual(written.blockingReasons, []);
          assert.deepStrictEqual(written.review, passingReview);

          yield* step(reviewerFinished(reviewRun));
          yield* drain;

          // FactoryRecord.test.ts covers the approval itself.
          const state = yield* stored;
          assert.strictEqual(state.stage, "pr");
          assert.strictEqual(state.status, "pr_open");
          assert.deepStrictEqual(
            (yield* attempts).map(({ stage, outcome, evidencePath }) => ({
              stage,
              outcome,
              evidencePath,
            })),
            [
              { stage: "author", outcome: "passed", evidencePath: null },
              { stage: "verify", outcome: "passed", evidencePath: receiptPath },
              { stage: "review", outcome: "passed", evidencePath },
              {
                stage: "record",
                outcome: "passed",
                evidencePath: `${directory}/approval-item.json`,
              },
              { stage: "pr", outcome: "passed", evidencePath: null },
            ],
          );
        }),
      ),
  );

  it.effect("blocks with the summary of a blocking review once the run ends, without rounds", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world, noRounds);

        const accepted = yield* submit(reviewer, blockingReview);
        assert.isTrue(accepted.review.summary.blocking);
        assert.strictEqual((yield* stored).status, "running");

        yield* step(reviewerFinished(reviewRun));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "review");
        assert.deepStrictEqual(state.block, {
          reason: "review_changes_required",
          summary: accepted.review.summary,
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const written = JSON.parse(yield* fileSystem.readFileString(accepted.review.evidencePath));
        assert.deepStrictEqual(
          written.blockingReasons.map(({ rule }: { readonly rule: string }) => rule),
          ["changes_required", "blocking_finding"],
        );
        const review = (yield* attempts).find((attempt) => attempt.stage === "review");
        assert.strictEqual(review?.outcome, "failed");
        assert.strictEqual(review?.evidencePath, accepted.review.evidencePath);
      }),
    ),
  );
});

describe("FactoryService.submitReview when the code changed", () => {
  it.effect.each([
    {
      name: "a commit after the verified receipt",
      change: (cwd: string) => commit(cwd, "fix: change during review").pipe(Effect.asVoid),
      changes: ["head_changed"],
    },
    {
      name: "an untracked file",
      change: (cwd: string) =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(`${cwd}/notes.txt`, "scratch\n"),
        ),
      changes: ["tree_dirty"],
    },
  ] as const)("refuses the review after $name and blocks", ({ change, changes }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        const { cwd } = yield* startReview(world);
        yield* change(cwd);

        const error = yield* Effect.flip(submit(reviewer, passingReview));

        assert.deepStrictEqual(codeChangesOf(error), changes);
        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, { reason: "code_changed", changes });
        assert.deepStrictEqual(state.reviews, []);
        assert.deepStrictEqual(yield* reviewFiles, []);
      }),
    ),
  );
});

describe("invalid submissions", () => {
  it.effect("takes one corrected tool submission, then blocks on a second invalid one", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        const duplicated = {
          ...passingReview,
          findings: [passingReview.findings[0], passingReview.findings[0]],
        };

        const first = invalidOf(yield* Effect.flip(submit(reviewer, duplicated)));
        assert.isFalse(first.blocked);
        assert.deepStrictEqual(first.problems, [
          'Finding id "export-name" is used 2 times; give each finding its own id.',
        ]);
        const counted = yield* stored;
        assert.strictEqual(counted.status, "running");
        assert.strictEqual(counted.invalidSubmissions, 1);

        const second = invalidOf(
          yield* Effect.flip(
            submit(reviewer, {
              ...passingReview,
              acceptance: [{ ...passingReview.acceptance[0], paths: ["src/missing.test.ts"] }],
            }),
          ),
        );
        assert.isTrue(second.blocked);
        const problems = ['Evidence path "src/missing.test.ts" does not exist in the worktree.'];
        assert.deepStrictEqual(second.problems, problems);
        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, { reason: "invalid_submission", problems });
        assert.deepStrictEqual(yield* reviewFiles, []);
      }),
    ),
  );

  it.effect("counts a submission that is not a review at all", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);

        const error = invalidOf(yield* Effect.flip(submit(reviewer, { verdict: "maybe" })));

        assert.isFalse(error.blocked);
        assert.match(error.problems[0] ?? "", /^The review is not valid: /);
        assert.strictEqual((yield* stored).invalidSubmissions, 1);
      }),
    ),
  );
});

describe("the fenced-JSON fallback", () => {
  it.effect("accepts a fenced review from a run that submitted none", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        world.messages.set(reviewRun, ["Looking at the diff.", fenced(passingReview)]);

        yield* step(reviewerFinished(reviewRun));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.stage, "pr");
        assert.deepStrictEqual(
          state.reviews.map(({ round, source, summary }) => ({
            round,
            source,
            blocking: summary.blocking,
          })),
          [{ round: 1, source: "fallback", blocking: false }],
        );
        const fileSystem = yield* FileSystem.FileSystem;
        const written = JSON.parse(
          yield* fileSystem.readFileString(state.reviews[0]?.evidencePath ?? ""),
        );
        assert.strictEqual(written.source, "fallback");
        assert.deepStrictEqual(written.review, passingReview);
        assert.deepStrictEqual(world.sends, []);
      }),
    ),
  );

  it.effect("sends one retry turn for a run without a fenced review, then blocks", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        world.messages.set(reviewRun, ["The export looks fine to me."]);

        yield* step(reviewerFinished(reviewRun));
        yield* drain;

        assert.strictEqual(world.sends.length, 1);
        const [send] = world.sends;
        assert.strictEqual(send?.threadId, reviewer);
        assert.strictEqual(send?.mode, "queue");
        assert.include(send?.text ?? "", "- Your final message has no fenced ```json block");
        assert.include(send?.text ?? "", "factory_submit_review");
        const retrying = yield* stored;
        assert.strictEqual(retrying.status, "running");
        assert.strictEqual(retrying.invalidSubmissions, 1);
        assert.deepStrictEqual(retrying.awaiting, {
          type: "run",
          threadId: reviewer,
          runId: retryRun,
        });

        // The retry's answer is not a review either.
        world.messages.set(retryRun, ['```json\n{"verdict": "maybe"}\n```']);
        yield* step(reviewerFinished(retryRun));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.block?.reason, "invalid_submission");
        assert.match(
          state.block?.reason === "invalid_submission" ? (state.block.problems[0] ?? "") : "",
          /^The last json block is not a valid review: /,
        );
        assert.strictEqual(world.sends.length, 1);
        assert.deepStrictEqual(yield* reviewFiles, []);
      }),
    ),
  );

  it.effect("judges a fenced review like a submitted one", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world);
        world.messages.set(reviewRun, [
          fenced({
            ...passingReview,
            acceptance: [{ ...passingReview.acceptance[0], paths: ["src/missing.test.ts"] }],
          }),
        ]);

        yield* step(reviewerFinished(reviewRun));
        yield* drain;

        // Its evidence path is checked in the worktree, and the reviewer is asked to correct it.
        assert.strictEqual(world.sends.length, 1);
        assert.include(
          world.sends[0]?.text ?? "",
          '- Evidence path "src/missing.test.ts" does not exist in the worktree.',
        );
        const state = yield* stored;
        assert.strictEqual(state.invalidSubmissions, 1);
        assert.deepStrictEqual(state.reviews, []);
      }),
    ),
  );

  it.effect("accepts a corrected fenced review from the retry turn", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startReview(world, noRounds);
        world.messages.set(reviewRun, ["No review here."]);
        yield* step(reviewerFinished(reviewRun));
        yield* drain;

        world.messages.set(retryRun, [fenced(blockingReview)]);
        yield* step(reviewerFinished(retryRun));
        yield* drain;

        const state = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.block?.reason, "review_changes_required");
        assert.deepStrictEqual(
          state.reviews.map(({ source }) => source),
          ["fallback"],
        );
      }),
    ),
  );
});
