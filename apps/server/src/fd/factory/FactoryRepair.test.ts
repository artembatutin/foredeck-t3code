import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2RunStatus,
  ProjectId,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryProjectSettings,
  FactoryTaskId,
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
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
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
import { advance } from "./pipeline/engine.ts";
import { failureFingerprint } from "./pipeline/fingerprint.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryEffect, FactoryEvent, FactoryRoundLimits } from "./pipeline/state.ts";
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

const item = {
  ref: itemRef,
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: null,
  locator: "tasks/fd-aaaaaa.md",
  body: "Users can export the current table as CSV.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

const instanceId = ProviderInstanceId.make("claude");
const authorModel: ModelSelection = { instanceId, model: "author-model" };
const reviewerModel: ModelSelection = { instanceId, model: "reviewer-model" };
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
    id,
    label: id,
    ...(id === "medium" ? { isDefault: true } : {}),
  })),
};
/** The provider registry's view: both models offer the effort option, with `xhigh`. */
const providers = [
  {
    instanceId,
    models: [authorModel, reviewerModel].map(({ model }) => ({
      slug: model,
      capabilities: { optionDescriptors: [effort] },
    })),
  },
] as unknown as ReadonlyArray<ServerProvider>;
const escalated = (selection: ModelSelection): ModelSelection => ({
  ...selection,
  options: [{ id: "effort", value: "xhigh" }],
});

/** What the fakes are told and what they saw. */
interface World {
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput>;
  /** Assistant messages of each run, oldest first. */
  readonly messages: Map<RunId, ReadonlyArray<string>>;
  /** The model each thread runs with; a turn sent with a model switches its thread. */
  readonly models: Map<ThreadId, ModelSelection>;
  worktreePath: string | null;
}

/** The run a send starts: derived from its message, so a replayed send reports the same run. */
const runOf = (send: ThreadManagement.ThreadManagementSendInput | undefined) =>
  RunId.make(`run:${send?.messageId ?? "none"}`);

// The effects read only these fields of the launch and send results and the thread records, so
// the fakes build no more than that. Every run is still going; the test steps its end.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          world.launches.push(input);
          if (input.threadId !== undefined) world.models.set(input.threadId, input.modelSelection);
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
          if (input.modelSelection !== undefined) {
            world.models.set(input.threadId, input.modelSelection);
          }
          return {
            run: { id: runOf(input) },
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
          thread: {
            id: threadId,
            worktreePath: world.worktreePath,
            deletedAt: null,
            modelSelection: world.models.get(threadId),
          },
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
            defaultModelSelection: null,
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
      linkLaunch: (_input, launch) => launch,
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  );

/** Pull requests are opened in FactoryPullRequest.test.ts; here an approved delivery's opens. */
const openedPullRequest = Layer.mock(FactoryPullRequest.FactoryPullRequest)({
  open: () =>
    Effect.succeed({ number: 7, url: "https://github.com/acme/alpha/pull/7", headBranch: branch }),
});

/**
 * The service, worker, thread effects, review judging, record and verify runner as the server
 * builds them, on in-memory SQLite, real git, real processes and an evidence folder under a temp
 * T3 home.
 */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provideMerge(FactoryThreadEffects.layer),
    Layer.provide(FactoryReview.layer),
    Layer.provide(FactoryRecord.layer),
    Layer.provide(openedPullRequest),
    Layer.provide(FactoryVerifyRunner.layer.pipe(Layer.provide(ProcessRunner.layer))),
    Layer.provide(FactoryEvidence.layer),
    Layer.provide(fakes(world)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-repair-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    launches: [],
    sends: [],
    messages: new Map(),
    models: new Map([[author, authorModel]]),
    worktreePath: null,
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
/** Writes the files and commits them, as the author agent would during its turn. */
const commitFiles = (cwd: string, message: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [name, text] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, name), text);
    }
    yield* git(cwd, ["add", "-A"]);
    yield* git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "-m", message]);
  });

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const failureOutput = "1 test failed: the export has no header row";
const verifyCommands = {
  fails: `console.error(${JSON.stringify(failureOutput)}); process.exitCode = 1;`,
  passes: `console.log("all checks passed")`,
};
const useSettings = (script: string) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(
      projectId,
      decodeSettings({
        verifyCommand: { executable: process.execPath, args: ["-e", script] },
        roles: { author: authorModel, reviewer: reviewerModel },
      }),
    ),
  );
const limits = (maxFixRounds: number, maxReviewRounds: number): FactoryRoundLimits => ({
  maxFixRounds,
  maxReviewRounds,
});

const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery)));
const state = Effect.map(stored, (delivery) => delivery.state);
const step = (event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(deliveryId, event));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
/** Ends a run as completed and waits for everything it sets off. */
const runEnds = (threadId: ThreadId, runId: RunId) =>
  step({ type: "run.finished", threadId, runId, status: "completed" }).pipe(Effect.andThen(drain));
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
).pipe(
  Effect.map((runs) =>
    runs.map(({ stage, attempt, threadId, runId, outcome, evidencePath, fingerprint }) => ({
      stage,
      attempt,
      threadId,
      runId,
      outcome,
      evidence: evidencePath?.split("/").at(-1) ?? null,
      fingerprint,
    })),
  ),
);
/** The tree of the worktree's HEAD. */
const treeOf = (cwd: string) => git(cwd, ["rev-parse", "HEAD^{tree}"]);

/**
 * A repository standing in for the delivery worktree, with the task baseline on `main` and the
 * author's commit on the delivery branch, and the delivery stored as the author's launch left
 * it. Returns once the author's run has ended and everything it set off has run.
 */
const authorFinishes = (
  world: World,
  options: { readonly risk?: "high"; readonly limits?: FactoryRoundLimits } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-repair-wt-" });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "-m", "chore: root"]);
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* commitFiles(cwd, "feat: export the table as CSV", {
      "src/export.ts": "export const csv = 1;\n",
      "src/export.test.ts": "// covers csv\n",
    });
    world.worktreePath = cwd;

    const launched = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: cwd,
        baseline,
      },
    ] satisfies ReadonlyArray<FactoryEvent>;
    const initial = launched.reduce(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ branch, baseRef: "main", ...options }),
    );
    yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({ deliveryId, projectId, itemRef, state: initial }),
    );
    // The item's one task, as FactoryService.start stores it.
    yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
      tasks.insert({ deliveryId, taskId: FactoryTaskId.make("item") }),
    );
    // The attempt the worker would have recorded for the author's launch.
    yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
      runs.append({ deliveryId, stage: "author", threadId: author, runId: authorRun }),
    );
    yield* runEnds(author, authorRun);
    return { cwd };
  });

/** A review that blocks: a required high finding, with criterion 1 verified by the test. */
const emptyTable = {
  id: "empty-table",
  severity: "high",
  required: true,
  file: "src/export.ts",
  line: 1,
  detail: "An empty table exports no header row, so the CSV cannot be re-imported.",
} as const;
const blockingReview = {
  verdict: "changes-required",
  findings: [
    emptyTable,
    {
      id: "export-name",
      severity: "low",
      required: false,
      file: "src/export.ts",
      line: null,
      detail: "The export is named for its format only.",
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
const passingReview = { ...blockingReview, verdict: "pass", findings: [] };
const fenced = (review: unknown) =>
  `Rechecked.\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``;

describe("fix-verify rounds", () => {
  it.effect(
    "sends a fix-verify turn on the author thread naming the failure, and stores its fingerprint",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useSettings(verifyCommands.fails);
          const { cwd } = yield* authorFinishes(world, { limits: limits(2, 2) });

          const repairing = yield* state;
          assert.strictEqual(repairing.status, "running");
          assert.strictEqual(repairing.stage, "repair");
          assert.deepStrictEqual(repairing.rounds, { fix: 1, review: 0 });
          const fingerprint = failureFingerprint({
            stage: "verify",
            tail: failureOutput,
            tree: yield* treeOf(cwd),
          });
          assert.deepStrictEqual(repairing.fingerprints, [fingerprint]);

          assert.strictEqual(world.sends.length, 1);
          const [send] = world.sends;
          assert.strictEqual(send?.threadId, author);
          assert.strictEqual(send?.mode, "queue");
          assert.strictEqual(send?.commandId, `factory-fix-verify:${deliveryId}:4`);
          assert.strictEqual(send?.messageId, `factory-fix-verify-message:${deliveryId}:4`);
          assert.include(send?.text ?? "", `The end of its output:\n\`\`\`text\n${failureOutput}`);
          assert.include(send?.text ?? "", "exit code 1");
          // A first round of a normal-risk task keeps the thread's model as it is.
          assert.isUndefined(send?.modelSelection);
          assert.deepStrictEqual(repairing.awaiting, {
            type: "run",
            threadId: author,
            runId: runOf(send),
          });

          assert.deepStrictEqual(yield* attempts, [
            {
              stage: "author",
              attempt: 1,
              threadId: author,
              runId: authorRun,
              outcome: "passed",
              evidence: null,
              fingerprint: null,
            },
            {
              stage: "verify",
              attempt: 1,
              threadId: null,
              runId: null,
              outcome: "failed",
              evidence: "verify-1.json",
              fingerprint,
            },
            {
              stage: "repair",
              attempt: 1,
              threadId: author,
              runId: runOf(send),
              outcome: null,
              evidence: null,
              fingerprint: null,
            },
          ]);
        }),
      ),
  );

  it.effect(
    "verifies the repaired commit, escalates the second round and stops on a repeated failure",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useSettings(verifyCommands.fails);
          const { cwd } = yield* authorFinishes(world, { limits: limits(3, 2) });
          const firstTree = yield* treeOf(cwd);

          // Round 1 changes the code, but the check still fails: round 2, at raised effort.
          yield* commitFiles(cwd, "fix: write the header row", {
            "src/export.ts": "export const csv = 2;\n",
          });
          yield* runEnds(author, runOf(world.sends[0]));
          const secondTree = yield* treeOf(cwd);
          assert.strictEqual(world.sends.length, 2);
          const second = world.sends[1];
          assert.strictEqual(second?.threadId, author);
          assert.strictEqual(second?.commandId, `factory-fix-verify:${deliveryId}:7`);
          assert.include(second?.text ?? "", "This is repair round 2");
          assert.deepStrictEqual(second?.modelSelection, escalated(authorModel));
          assert.deepStrictEqual((yield* state).rounds, { fix: 2, review: 0 });

          // Round 2 changes nothing: the same failure on the same tree stops the loop.
          yield* runEnds(author, runOf(second));
          const blocked = yield* state;
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, { reason: "repeated_failure", stage: "verify" });
          assert.strictEqual(world.sends.length, 2);
          assert.deepStrictEqual(blocked.rounds, { fix: 2, review: 0 });

          const first = failureFingerprint({
            stage: "verify",
            tail: failureOutput,
            tree: firstTree,
          });
          const repeated = failureFingerprint({
            stage: "verify",
            tail: failureOutput,
            tree: secondTree,
          });
          assert.notStrictEqual(first, repeated);
          assert.deepStrictEqual(
            (yield* attempts).map(({ stage, outcome, evidence, fingerprint }) => ({
              stage,
              outcome,
              evidence,
              fingerprint,
            })),
            [
              { stage: "author", outcome: "passed", evidence: null, fingerprint: null },
              { stage: "verify", outcome: "failed", evidence: "verify-1.json", fingerprint: first },
              { stage: "repair", outcome: "passed", evidence: null, fingerprint: null },
              {
                stage: "verify",
                outcome: "failed",
                evidence: "verify-2.json",
                fingerprint: repeated,
              },
              { stage: "repair", outcome: "passed", evidence: null, fingerprint: null },
              {
                stage: "verify",
                outcome: "failed",
                evidence: "verify-3.json",
                fingerprint: repeated,
              },
            ],
          );
        }),
      ),
  );

  it.effect("blocks verify_failed once the fix rounds are spent", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useSettings(verifyCommands.fails);
        const { cwd } = yield* authorFinishes(world, { limits: limits(1, 2) });
        yield* commitFiles(cwd, "fix: write the header row", {
          "src/export.ts": "export const csv = 2;\n",
        });

        yield* runEnds(author, runOf(world.sends[0]));

        const blocked = yield* state;
        assert.deepStrictEqual(blocked.block, { reason: "verify_failed" });
        assert.deepStrictEqual(blocked.rounds, { fix: 1, review: 0 });
        assert.strictEqual(world.sends.length, 1);
      }),
    ),
  );

  it.effect("raises the effort of a high-risk task's first round", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useSettings(verifyCommands.fails);
        yield* authorFinishes(world, { risk: "high" });

        assert.deepStrictEqual(world.sends[0]?.modelSelection, escalated(authorModel));
      }),
    ),
  );

  it.effect("replays a retried repair effect under the same command and message ids", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useSettings(verifyCommands.fails);
        yield* authorFinishes(world);
        const delivery = yield* stored;
        const effect: Extract<FactoryEffect, { readonly type: "send_repair_turn" }> = {
          id: 4,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 1,
        };

        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        const retried = yield* threads.sendRepairTurn(delivery, effect);

        const [first, again] = world.sends;
        assert.strictEqual(world.sends.length, 2);
        assert.strictEqual(again?.commandId, first?.commandId);
        assert.strictEqual(again?.messageId, first?.messageId);
        assert.strictEqual(again?.text, first?.text);
        assert.strictEqual(again?.mode, "queue");
        assert.strictEqual(retried.runId, runOf(first));
      }),
    ),
  );
});

describe("fix-review rounds", () => {
  it.effect(
    "repairs a blocking review on the author thread, then follows up on the reviewer thread",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useSettings(verifyCommands.passes);
          const { cwd } = yield* authorFinishes(world, { limits: limits(2, 2) });
          const reviewedTree = yield* treeOf(cwd);
          const reviewedHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          assert.strictEqual(world.launches.length, 1);
          assert.strictEqual(world.launches[0]?.threadId, reviewer);

          const service = yield* FactoryService.FactoryService;
          yield* service.submitReview({ threadId: reviewer, review: blockingReview });
          yield* runEnds(reviewer, reviewRun);

          // The fix-review turn goes to the author thread with the finding to fix.
          const fixing = yield* state;
          assert.strictEqual(fixing.stage, "repair");
          assert.deepStrictEqual(fixing.rounds, { fix: 0, review: 1 });
          const fingerprint = failureFingerprint({
            stage: "review",
            findings: [emptyTable],
            tree: reviewedTree,
          });
          assert.deepStrictEqual(fixing.fingerprints, [fingerprint]);
          assert.strictEqual(world.sends.length, 1);
          const fixReview = world.sends[0];
          assert.strictEqual(fixReview?.threadId, author);
          assert.strictEqual(fixReview?.mode, "queue");
          assert.strictEqual(fixReview?.commandId, `factory-fix-review:${deliveryId}:5`);
          assert.include(
            fixReview?.text ?? "",
            `Findings to fix:\n- \`empty-table\` (high, required) at src/export.ts:1: ${emptyTable.detail}`,
          );
          assert.notInclude(fixReview?.text ?? "", "export-name");
          assert.isUndefined(fixReview?.modelSelection);
          const review = (yield* attempts).find(({ stage }) => stage === "review");
          assert.strictEqual(review?.outcome, "failed");
          assert.strictEqual(review?.evidence, "review-1.json");
          assert.strictEqual(review?.fingerprint, fingerprint);

          // The author fixes the finding and replies; the repaired commit settles and passes.
          const replyRun = runOf(fixReview);
          const reply = "Fixed empty-table: the header row is always written now.";
          world.messages.set(replyRun, ["Looking at the finding.", reply]);
          yield* commitFiles(cwd, "fix: write the header row for an empty table", {
            "src/export.ts": "export const csv = 2;\n",
          });
          yield* runEnds(author, replyRun);

          // The next round is a turn on the same reviewer thread, never a new launch.
          assert.strictEqual(world.launches.length, 1);
          assert.strictEqual(world.sends.length, 2);
          const followUp = world.sends[1];
          assert.strictEqual(followUp?.threadId, reviewer);
          assert.strictEqual(followUp?.mode, "queue");
          assert.strictEqual(followUp?.commandId, `factory-review-follow-up:${deliveryId}:8`);
          const text = followUp?.text ?? "";
          assert.include(text, "Factory review round 2.");
          assert.include(text, `Your previous findings, on ${reviewedHead}:`);
          assert.include(text, "- `empty-table` (high, required)");
          assert.include(text, "- `export-name` (low)");
          assert.include(
            text,
            `These are claims to check against the code, not evidence:\n\`\`\`text\n${reply}\n\`\`\``,
          );
          assert.notInclude(text, "Looking at the finding.");
          // A second review round raises the reviewer's effort.
          assert.deepStrictEqual(followUp?.modelSelection, escalated(reviewerModel));
          const reviewing = yield* state;
          assert.strictEqual(reviewing.stage, "review");
          assert.strictEqual(reviewing.reviewRound, 2);
          assert.deepStrictEqual(reviewing.reviewResponse, { threadId: author, runId: replyRun });
          assert.deepStrictEqual(reviewing.awaiting, {
            type: "run",
            threadId: reviewer,
            runId: runOf(followUp),
          });

          // The follow-up ends without a review: the retry turn goes to the reviewer thread too.
          yield* runEnds(reviewer, runOf(followUp));
          assert.strictEqual(world.sends.length, 3);
          const retry = world.sends[2];
          assert.strictEqual(retry?.threadId, reviewer);
          assert.strictEqual(retry?.commandId, `factory-review-retry:${deliveryId}:10`);

          // The retry answers in a fenced block, judged against the repaired commit, which
          // record then approves, and its pull request opens.
          world.messages.set(runOf(retry), [fenced(passingReview)]);
          yield* runEnds(reviewer, runOf(retry));
          const passed = yield* state;
          assert.strictEqual(passed.stage, "pr");
          assert.strictEqual(passed.status, "pr_open");
          assert.deepStrictEqual(
            passed.reviews.map(({ round, source, summary }) => ({
              round,
              source,
              blocking: summary.blocking,
              headSha: summary.headSha,
            })),
            [
              { round: 1, source: "mcp", blocking: true, headSha: reviewedHead },
              {
                round: 2,
                source: "fallback",
                blocking: false,
                headSha: yield* git(cwd, ["rev-parse", "HEAD"]),
              },
            ],
          );
          assert.deepStrictEqual(passed.rounds, { fix: 0, review: 1 });
          assert.deepStrictEqual(
            (yield* attempts).map(({ stage, threadId, outcome }) => ({ stage, threadId, outcome })),
            [
              { stage: "author", threadId: author, outcome: "passed" },
              { stage: "verify", threadId: null, outcome: "passed" },
              { stage: "review", threadId: reviewer, outcome: "failed" },
              { stage: "repair", threadId: author, outcome: "passed" },
              { stage: "verify", threadId: null, outcome: "passed" },
              { stage: "review", threadId: reviewer, outcome: "passed" },
              { stage: "record", threadId: null, outcome: "passed" },
              { stage: "pr", threadId: null, outcome: "passed" },
            ],
          );
          const [task] = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
            tasks.listByDelivery(deliveryId),
          );
          assert.strictEqual(task?.lastReviewedSha, yield* git(cwd, ["rev-parse", "HEAD"]));
        }),
      ),
  );

  it.effect("blocks with the review once the review rounds are spent", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useSettings(verifyCommands.passes);
        const { cwd } = yield* authorFinishes(world, { limits: limits(2, 1) });
        const service = yield* FactoryService.FactoryService;
        yield* service.submitReview({ threadId: reviewer, review: blockingReview });
        yield* runEnds(reviewer, reviewRun);
        yield* commitFiles(cwd, "fix: write the header row for an empty table", {
          "src/export.ts": "export const csv = 2;\n",
        });
        yield* runEnds(author, runOf(world.sends[0]));

        // The second round blocks again, on the repaired commit.
        yield* service.submitReview({ threadId: reviewer, review: blockingReview });
        yield* runEnds(reviewer, runOf(world.sends[1]));

        const blocked = yield* state;
        assert.strictEqual(blocked.status, "blocked");
        assert.strictEqual(blocked.block?.reason, "review_changes_required");
        assert.deepStrictEqual(blocked.rounds, { fix: 0, review: 1 });
        assert.strictEqual(world.sends.length, 2);
      }),
    ),
  );
});
