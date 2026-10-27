import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

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
import { type FactoryEffect, queuedDeliveryState } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  instanceId as integratedInstanceId,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { makePiEffort, piEffortLayer } from "./testkit/piEffort.ts";

const projectId = ProjectId.make("project-mechanical");
const deliveryId = FactoryDeliveryId.make("delivery-mechanical");
const author = ThreadId.make("author-mechanical");
const authorRun = RunId.make("author-run");
const instanceId = ProviderInstanceId.make("test-provider");
const branch = "feature/mechanical";
const original = {
  instanceId,
  model: "author-model",
  options: [
    { id: "effort", value: "high" },
    { id: "fastMode", value: true },
  ],
} satisfies ModelSelection;
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
    id,
    label: id,
    isDefault: id === "high",
  })),
};
const atEffort = (selection: ModelSelection, value: string): ModelSelection => ({
  ...selection,
  options: [
    ...(selection.options ?? []).filter(({ id }) => id !== "effort"),
    { id: "effort", value },
  ],
});
type Send = ThreadManagement.ThreadManagementSendInput;
const runOf = (send: Send) => RunId.make(`run:${send.messageId}`);
const fixEffect: Extract<FactoryEffect, { type: "send_fix_commit_turn" }> = {
  id: 3,
  type: "send_fix_commit_turn",
  threadId: author,
  problems: ["The worktree is dirty."],
};
const decodeSettings = Schema.decodeEffect(FactoryProjectSettings);
interface World {
  readonly sends: Array<Send>;
  readonly accepted: Map<string, Send>;
  selection: ModelSelection;
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  sendFailure: ThreadManagement.ThreadManagementThreadNotFoundError | null;
  cwd: string;
}

/** Core's queued-run start persists the requested model selection; a receipt replay does not. */
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.suspend(() => {
          world.sends.push(input);
          if (world.sendFailure !== null) return Effect.fail(world.sendFailure);
          if (!world.accepted.has(input.commandId)) {
            world.accepted.set(input.commandId, input);
            if (input.modelSelection !== undefined) world.selection = input.modelSelection;
          }
          return Effect.succeed({
            run: { id: runOf(input) },
            message: { attachments: [] },
          } as unknown as ThreadManagement.ThreadManagementSendResult);
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.sync(() => ({
          thread: {
            id: threadId,
            worktreePath: world.cwd,
            deletedAt: null,
            modelSelection: world.selection,
          },
          runs: [...world.accepted.values()].map((send) => ({
            id: runOf(send),
            userMessageId: send.messageId,
            status: "running",
            startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
          })),
          messages: [],
        }))) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(WorkService.WorkService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(
        () =>
          [
            {
              instanceId,
              models: ["author-model", "owner-model"].map((slug) => ({
                slug,
                capabilities: { optionDescriptors: world.descriptors },
              })),
            },
          ] as unknown as ReadonlyArray<ServerProvider>,
      ),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  );
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provideMerge(FactoryThreadEffects.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void }),
        Layer.mock(FactoryChildren.FactoryChildren)({}),
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
      ),
    ),
    Layer.provide(
      FactoryVerifyRunner.layer.pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provide(FactoryEvidence.layer),
      ),
    ),
    Layer.provideMerge(fakes(world)),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-mechanical-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );
const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    sends: [],
    accepted: new Map(),
    selection: original,
    descriptors: [effort],
    sendFailure: null,
    cwd: "",
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver
      .execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 })
      .pipe(Effect.map(({ stdout }) => stdout.trim())),
  );
const commit = (cwd: string) =>
  git(cwd, ["add", "-A"]).pipe(
    Effect.andThen(
      git(cwd, [
        "-c",
        "user.name=Ada Lovelace",
        "-c",
        "user.email=ada@example.com",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "fix: record the work",
      ]),
    ),
  );
const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId),
).pipe(Effect.map(Option.getOrThrow));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const endRun = (runId: RunId) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) =>
    worker.step(deliveryId, {
      type: "run.finished",
      threadId: author,
      runId,
      status: "completed",
    }),
  ).pipe(Effect.andThen(drain));

/** A real dirty branch, stored just before the author's run ends. */
const prepare = (world: World, risk: "normal" | "high" = "normal") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    world.cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fd-factory-mechanical-wt-" });
    yield* git(world.cwd, ["init", "-b", "main"]);
    yield* fs.writeFileString(`${world.cwd}/README.md`, "baseline\n");
    yield* commit(world.cwd);
    const baseline = yield* git(world.cwd, ["rev-parse", "HEAD"]);
    yield* git(world.cwd, ["switch", "-c", branch]);
    yield* fs.writeFileString(`${world.cwd}/README.md`, "author's uncommitted work\n");
    const state = advance(
      advance(queuedDeliveryState({ branch, baseRef: "main", risk }), { type: "start" }).delivery,
      {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: world.cwd,
        baseline,
      },
    ).delivery;
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({
      deliveryId,
      projectId,
      itemRef: {
        sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
        itemId: WorkItemId.make("item"),
      },
      state,
    });
    const stages = yield* FactoryStageRunStore.FactoryStageRunStore;
    yield* stages.append({ deliveryId, stage: "author", threadId: author, runId: authorRun });
    const settings = yield* FactorySettings.FactorySettings;
    yield* settings.set(
      projectId,
      yield* decodeSettings({
        verifyCommand: {
          executable: process.execPath,
          args: ["-e", "console.error('verification failed'); process.exitCode = 1"],
        },
      }),
    );
  });

describe("Factory fix-commit effort", () => {
  it.live.each(["effort", "unrelated option"] as const)(
    "honors public owner %s changes during verification before another Factory turn",
    (change) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projection = () =>
              threads
                .getProjectThread({ projectId: world.projectId, threadId: author.threadId })
                .pipe(Effect.orDie);
            const before = {
              ...(yield* projection()).thread.modelSelection,
              options: original.options,
            };
            let selections = 0;
            const select = (selection: ModelSelection) =>
              threads
                .dispatch({
                  type: "thread.model-selection.set",
                  commandId: CommandId.make(`owner-selection:${++selections}`),
                  threadId: author.threadId,
                  modelSelection: selection,
                })
                .pipe(Effect.orDie);
            yield* select(before);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            yield* world.endRun(author.runId, "completed");
            yield* drainOrchestration;
            const fixing = (yield* stateOf(author.deliveryId)).awaiting;
            if (fixing?.type !== "run") return assert.fail("No mechanical turn started.");
            assert.deepStrictEqual(
              (yield* projection()).thread.modelSelection,
              atEffort(before, "medium"),
            );
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            let verified = false;
            world.processes.around = (input, run) =>
              Effect.gen(function* () {
                assert.isFalse(verified);
                verified = true;
                const during = yield* projection();
                assert.strictEqual(during.runs.length, 2);
                assert.strictEqual(during.runs.at(-1)?.status, "completed");
                if (change === "effort") {
                  yield* select(atEffort(before, "high"));
                  yield* select(atEffort(before, "medium"));
                } else {
                  yield* select({
                    ...before,
                    options: [
                      { id: "effort", value: "medium" },
                      { id: "fastMode", value: false },
                    ],
                  });
                }
                assert.strictEqual((yield* projection()).runs.length, 2);
                return yield* run(input);
              });
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            assert.isTrue(verified);
            const next = yield* projection();
            assert.strictEqual(next.runs.length, 3);
            assert.strictEqual((yield* stateOf(author.deliveryId)).rounds.fix, 1);
            const expected =
              change === "effort"
                ? atEffort(before, "medium")
                : {
                    ...before,
                    options: [
                      { id: "fastMode", value: false },
                      { id: "effort", value: "high" },
                    ],
                  };
            assert.deepStrictEqual(next.thread.modelSelection, expected);
            assert.deepStrictEqual(next.runs.at(-1)?.modelSelection, expected);
          }),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.live("restores effort after cancelling a queued restoration turn and publicly resuming", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const projection = () =>
            threads
              .getProjectThread({ projectId: world.projectId, threadId: author.threadId })
              .pipe(Effect.orDie);
          const before = {
            ...(yield* projection()).thread.modelSelection,
            options: original.options,
          };
          yield* threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("owner-selection:high"),
            threadId: author.threadId,
            modelSelection: before,
          });
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
          yield* world.endRun(author.runId, "completed");
          yield* drainOrchestration;
          const fixing = (yield* stateOf(author.deliveryId)).awaiting;
          if (fixing?.type !== "run") return assert.fail("No mechanical turn started.");
          assert.deepStrictEqual(
            (yield* projection()).thread.modelSelection,
            atEffort(before, "medium"),
          );
          yield* authorCommits(author.worktreePath, "fix: commit the work");
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof world.ownerTurn>>>();
          let ownerRun: RunId | undefined;
          world.processes.around = (input, run) =>
            Effect.gen(function* () {
              ownerRun = yield* world.ownerTurn(author.threadId, "Owner work during verification");
              return yield* run(input);
            }).pipe(Effect.provideContext(context));
          yield* world.endRun(fixing.runId, "completed");
          world.processes.around = undefined;
          const queued = (yield* stateOf(author.deliveryId)).awaiting;
          if (queued?.type !== "run") return assert.fail("No restoration turn queued.");
          const pending = yield* projection();
          const repair = pending.runs.find(({ id }) => id === queued.runId)!;
          assert.strictEqual(repair.status, "queued");
          assert.isNull(repair.startedAt);
          assert.deepStrictEqual(repair.modelSelection, before);
          assert.deepStrictEqual(pending.thread.modelSelection, atEffort(before, "medium"));
          yield* threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("owner-cancel:restoration"),
            threadId: author.threadId,
            runId: queued.runId,
          });
          yield* drainFactory;
          const cancelled = (yield* projection()).runs.find(({ id }) => id === queued.runId)!;
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isNull(cancelled.startedAt);
          assert.isFalse(world.provider.started.some(({ runId }) => runId === queued.runId));
          const blocked = yield* stateOf(author.deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.strictEqual(blocked.block?.reason, "run_ended");
          if (ownerRun === undefined) return assert.fail("No owner turn started.");
          yield* world.endRun(ownerRun, "completed");
          const service = yield* FactoryService.FactoryService;
          yield* service.resume(author.deliveryId);
          yield* drainFactory;
          yield* drainOrchestration;
          const resumed = yield* stateOf(author.deliveryId);
          assert.strictEqual(resumed.risk, "normal");
          assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
          assert.lengthOf(resumed.receipts, 2);
          if (resumed.awaiting?.type !== "run") return assert.fail("No resumed repair started.");
          const resumedRunId = resumed.awaiting.runId;
          assert.notStrictEqual(resumedRunId, queued.runId);
          const next = yield* projection();
          const active = next.runs.find(({ id }) => id === resumedRunId)!;
          assert.strictEqual(active.status, "running");
          assert.deepStrictEqual(next.thread.modelSelection, before);
          assert.deepStrictEqual(active.modelSelection, before);
        }),
      {
        providers: [
          {
            instanceId: integratedInstanceId,
            models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
          } as unknown as ServerProvider,
        ],
      },
    ),
  );

  it.live("keeps owner effort after cancelling a queued fix-commit and publicly resuming", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const projection = () =>
            threads
              .getProjectThread({ projectId: world.projectId, threadId: author.threadId })
              .pipe(Effect.orDie);
          const before = {
            ...(yield* projection()).thread.modelSelection,
            options: original.options,
          };
          yield* threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("owner-selection:high"),
            threadId: author.threadId,
            modelSelection: before,
          });
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
          // The owner's queued turn starts before Factory sends its mechanical fix-commit.
          const ownerTurn = yield* threads.sendToThread({
            projectId: world.projectId,
            commandId: CommandId.make("owner-turn:before-fix-commit"),
            threadId: author.threadId,
            messageId: MessageId.make("owner-message:before-fix-commit"),
            text: "Owner work before fix-commit",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          });
          const ownerRun = ownerTurn.run.id;
          yield* world.endRun(author.runId, "completed");
          const queued = (yield* stateOf(author.deliveryId)).awaiting;
          if (queued?.type !== "run") return assert.fail("No mechanical turn queued.");
          const pending = yield* projection();
          const mechanical = pending.runs.find(({ id }) => id === queued.runId)!;
          assert.strictEqual(mechanical.status, "queued");
          assert.isNull(mechanical.startedAt);
          assert.deepStrictEqual(mechanical.modelSelection, atEffort(before, "medium"));
          assert.deepStrictEqual(pending.thread.modelSelection, before);
          yield* threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("owner-cancel:mechanical"),
            threadId: author.threadId,
            runId: queued.runId,
          });
          yield* drainFactory;
          const cancelled = (yield* projection()).runs.find(({ id }) => id === queued.runId)!;
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isNull(cancelled.startedAt);
          assert.isFalse(world.provider.started.some(({ runId }) => runId === queued.runId));
          const blocked = yield* stateOf(author.deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.strictEqual(blocked.block?.reason, "run_ended");
          assert.lengthOf(blocked.receipts, 0);
          const selected = atEffort(before, "medium");
          yield* threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("owner-selection:medium"),
            threadId: author.threadId,
            modelSelection: selected,
          });
          const owned = yield* projection();
          assert.lengthOf(owned.runs, 3);
          assert.strictEqual(owned.runs.find(({ id }) => id === ownerRun)?.status, "running");
          assert.deepStrictEqual(owned.thread.modelSelection, selected);
          assert.deepStrictEqual(world.provider.interrupted, []);
          yield* authorCommits(author.worktreePath, "fix: commit the work");
          yield* world.endRun(ownerRun, "completed");
          const service = yield* FactoryService.FactoryService;
          yield* service.resume(author.deliveryId);
          yield* drainFactory;
          yield* drainOrchestration;
          const resumed = yield* stateOf(author.deliveryId);
          assert.strictEqual(resumed.risk, "normal");
          assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
          assert.lengthOf(resumed.receipts, 1);
          assert.strictEqual(resumed.receipts[0]?.code, 3);
          if (resumed.awaiting?.type !== "run") return assert.fail("No resumed repair started.");
          const resumedRunId = resumed.awaiting.runId;
          assert.notStrictEqual(resumedRunId, queued.runId);
          const next = yield* projection();
          assert.lengthOf(next.runs, 4);
          const active = next.runs.find(({ id }) => id === resumedRunId)!;
          assert.strictEqual(active.status, "running");
          assert.deepStrictEqual(next.thread.modelSelection, selected);
          assert.deepStrictEqual(active.modelSelection, selected);
        }),
      {
        providers: [
          {
            instanceId: integratedInstanceId,
            models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
          } as unknown as ServerProvider,
        ],
      },
    ),
  );

  it.live.each(["blocked", "stopped"] as const)(
    "restores the first applied override after %s Resume queues a cancelled second fix-commit",
    (pause) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const service = yield* FactoryService.FactoryService;
            const projection = () =>
              threads.getProjectThread({ projectId: world.projectId, threadId: author.threadId });
            const before = {
              ...(yield* projection()).thread.modelSelection,
              options: original.options,
            };
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("owner-selection:high"),
              threadId: author.threadId,
              modelSelection: before,
            });
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            yield* world.endRun(author.runId, "completed");
            const first = (yield* stateOf(author.deliveryId)).awaiting;
            if (first?.type !== "run") return assert.fail("No first fix-commit started.");
            yield* drainOrchestration;
            assert.deepStrictEqual(
              (yield* projection()).thread.modelSelection,
              atEffort(before, "medium"),
            );
            if (pause === "stopped") {
              yield* service.stop(author.deliveryId);
              yield* authorCommits(author.worktreePath, "fix: commit the first work");
            }
            // Blocked settlement or graceful Stop leaves the override applied.
            yield* world.endRun(first.runId, "completed");
            assert.strictEqual((yield* stateOf(author.deliveryId)).status, pause);
            const ownerRun = yield* world.ownerTurn(author.threadId, "Owner work before Resume");
            yield* fs.writeFileString(
              `${author.worktreePath}/export.ts`,
              "more uncommitted work\n",
            );
            yield* service.resume(author.deliveryId);
            yield* drainFactory;
            const second = (yield* stateOf(author.deliveryId)).awaiting;
            if (second?.type !== "run") return assert.fail("No second fix-commit queued.");
            assert.notStrictEqual(second.runId, first.runId);
            const queued = (yield* projection()).runs.find(({ id }) => id === second.runId)!;
            assert.strictEqual(queued.status, "queued");
            assert.deepStrictEqual(queued.modelSelection, atEffort(before, "medium"));
            yield* threads.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("owner-cancel:second-mechanical"),
              threadId: author.threadId,
              runId: second.runId,
            });
            yield* drainFactory;
            const cancelled = (yield* projection()).runs.find(({ id }) => id === second.runId)!;
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isNull(cancelled.startedAt);
            assert.isFalse(world.provider.started.some(({ runId }) => runId === second.runId));
            assert.strictEqual((yield* stateOf(author.deliveryId)).status, "blocked");
            yield* authorCommits(
              author.worktreePath,
              "fix: commit the work",
              "export const x = 2;\n",
            );
            yield* world.endRun(ownerRun, "completed");
            yield* service.resume(author.deliveryId);
            yield* drainFactory;
            yield* drainOrchestration;
            const resumed = yield* stateOf(author.deliveryId);
            assert.strictEqual(resumed.risk, "normal");
            assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
            assert.strictEqual(resumed.receipts.at(-1)?.code, 3);
            if (resumed.awaiting?.type !== "run") return assert.fail("No normal repair started.");
            const next = yield* projection();
            assert.deepStrictEqual(next.thread.modelSelection, before);
            const resumedRunId = resumed.awaiting.runId;
            assert.deepStrictEqual(
              next.runs.find(({ id }) => id === resumedRunId)?.modelSelection,
              before,
            );
            assert.deepStrictEqual(world.provider.started.at(-1)?.modelSelection, before);
          }),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.live.each(["model", "effort", "effort round-trip", "unrelated option"] as const)(
    "recovers an owner %s selection made after mechanical enqueue and before dequeue",
    (change) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projection = () =>
              threads.getProjectThread({ projectId: world.projectId, threadId: author.threadId });
            const before = {
              ...(yield* projection()).thread.modelSelection,
              options: original.options,
            };
            let selections = 0;
            const select = (modelSelection: ModelSelection) =>
              threads.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(`owner-selection:${++selections}`),
                threadId: author.threadId,
                modelSelection,
              });
            yield* select(before);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            const owner = yield* threads.sendToThread({
              projectId: world.projectId,
              commandId: CommandId.make("owner-turn:before-mechanical"),
              threadId: author.threadId,
              messageId: MessageId.make("owner-message:before-mechanical"),
              text: "Owner work before fix-commit",
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "web",
            });
            yield* world.endRun(author.runId, "completed");
            const fixing = (yield* stateOf(author.deliveryId)).awaiting;
            if (fixing?.type !== "run") return assert.fail("No mechanical turn queued.");
            assert.strictEqual(
              (yield* projection()).runs.find(({ id }) => id === fixing.runId)?.status,
              "queued",
            );
            const selected =
              change === "model"
                ? { ...atEffort(before, "low"), model: "owner-model" }
                : change === "effort"
                  ? atEffort(before, "low")
                  : change === "effort round-trip"
                    ? atEffort(before, "medium")
                    : {
                        ...before,
                        options: [
                          { id: "effort", value: "high" },
                          { id: "fastMode", value: false },
                        ],
                      };
            if (change === "effort round-trip") yield* select(atEffort(before, "low"));
            yield* select(selected);
            yield* world.endRun(owner.run.id, "completed");
            yield* drainOrchestration;
            // Core applies the queued mechanical selection over the owner's newer choice.
            assert.deepStrictEqual(
              (yield* projection()).thread.modelSelection,
              atEffort(before, "medium"),
            );
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            const resumed = yield* stateOf(author.deliveryId);
            assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
            const next = yield* projection();
            assert.deepStrictEqual(next.thread.modelSelection, selected);
            assert.deepStrictEqual(next.runs.at(-1)?.modelSelection, selected);
            assert.deepStrictEqual(world.provider.started.at(-1)?.modelSelection, selected);
          }),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: ["test-model", "owner-model"].map((slug) => ({
                slug,
                capabilities: { optionDescriptors: [effort] },
              })),
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.live(
    "restores inherited high thinking on a concrete Pi model through the provider boundary",
    () =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const before = { instanceId: integratedInstanceId, model: "test/reasoning" };
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("owner-selection:pi-default-thinking"),
              threadId: author.threadId,
              modelSelection: before,
            });
            const pi = yield* makePiEffort(author.threadId, before);
            assert.strictEqual(pi.thinking(), "high");
            assert.deepStrictEqual(pi.levels(), []);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            yield* world.endRun(author.runId, "completed");
            yield* drainOrchestration;
            const fixing = (yield* stateOf(author.deliveryId)).awaiting;
            if (fixing?.type !== "run") return assert.fail("No mechanical turn started.");
            const mechanical = world.provider.started.find(({ runId }) => runId === fixing.runId)!;
            yield* pi.run(mechanical);
            assert.strictEqual(pi.thinking(), "medium");
            assert.deepStrictEqual(pi.levels(), ["medium"]);
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            const resumed = yield* stateOf(author.deliveryId);
            assert.strictEqual(resumed.risk, "normal");
            assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
            const repair = world.provider.started.at(-1)!;
            assert.notStrictEqual(repair.runId, fixing.runId);
            yield* pi.run(repair);
            assert.strictEqual(pi.thinking(), "high");
            assert.deepStrictEqual(pi.levels(), ["medium", "high"]);
          }).pipe(Effect.provide(piEffortLayer), Effect.scoped),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: [
                {
                  slug: "test/reasoning",
                  capabilities: { optionDescriptors: [{ ...effort, id: "thinking" }] },
                },
              ],
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.effect.each(["immediate", "dequeued"] as const)(
    "restores effort after %s fix-commit startup fails and public Resume requests a repair",
    (start) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projection = () =>
              threads
                .getProjectThread({ projectId: world.projectId, threadId: author.threadId })
                .pipe(Effect.orDie);
            const before = {
              ...(yield* projection()).thread.modelSelection,
              options: original.options,
            };
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("owner-selection:high"),
              threadId: author.threadId,
              modelSelection: before,
            });
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            const ownerTurn =
              start === "dequeued"
                ? yield* threads.sendToThread({
                    projectId: world.projectId,
                    commandId: CommandId.make("owner-turn:before-fix-commit"),
                    threadId: author.threadId,
                    messageId: MessageId.make("owner-message:before-fix-commit"),
                    text: "Owner work before fix-commit",
                    attachments: [],
                    mode: "queue",
                    createdBy: "user",
                    creationSource: "web",
                  })
                : undefined;
            yield* world.endRun(author.runId, "completed");
            const fixing = (yield* stateOf(author.deliveryId)).awaiting;
            if (fixing?.type !== "run") return assert.fail("No mechanical turn requested.");
            if (ownerTurn !== undefined) {
              const queued = (yield* projection()).runs.find(({ id }) => id === fixing.runId)!;
              assert.strictEqual(queued.status, "queued");
              assert.isNull(queued.startedAt);
              assert.deepStrictEqual((yield* projection()).thread.modelSelection, before);
            }
            world.provider.threadLoads.before = () =>
              Effect.fail(
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: world.provider.adapter.driver,
                  threadId: author.threadId,
                }),
              );
            if (ownerTurn !== undefined) yield* world.endRun(ownerTurn.run.id, "completed");
            yield* drainOrchestration;
            // Exhaust core's four scheduled startup retries without waiting on wall time.
            for (let retry = 0; retry < 4; retry++) {
              yield* TestClock.adjust("1 minute");
              yield* drainOrchestration;
            }
            yield* drainFactory;
            const failed = yield* projection();
            const mechanical = failed.runs.find(({ id }) => id === fixing.runId)!;
            assert.strictEqual(mechanical.status, "failed");
            assert.isNull(mechanical.startedAt);
            assert.deepStrictEqual(mechanical.modelSelection, atEffort(before, "medium"));
            assert.deepStrictEqual(failed.thread.modelSelection, atEffort(before, "medium"));
            assert.isFalse(world.provider.started.some(({ runId }) => runId === fixing.runId));
            const blocked = yield* stateOf(author.deliveryId);
            assert.strictEqual(blocked.status, "blocked");
            assert.strictEqual(blocked.block?.reason, "run_ended");
            assert.lengthOf(blocked.receipts, 0);
            world.provider.threadLoads.before = undefined;
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            const service = yield* FactoryService.FactoryService;
            yield* service.resume(author.deliveryId);
            yield* drainFactory;
            yield* drainOrchestration;
            const resumed = yield* stateOf(author.deliveryId);
            assert.strictEqual(resumed.risk, "normal");
            assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
            assert.lengthOf(resumed.receipts, 1);
            assert.strictEqual(resumed.receipts[0]?.code, 3);
            if (resumed.awaiting?.type !== "run") return assert.fail("No resumed repair started.");
            const resumedRunId = resumed.awaiting.runId;
            assert.notStrictEqual(resumedRunId, fixing.runId);
            const next = yield* projection();
            const active = next.runs.find(({ id }) => id === resumedRunId)!;
            assert.strictEqual(active.status, "running");
            assert.deepStrictEqual(next.thread.modelSelection, before);
            assert.deepStrictEqual(active.modelSelection, before);
          }),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.effect.each(["normal", "high"] as const)(
    "uses medium for a %s-risk author's unsettled branch, irrespective of earlier rounds",
    (risk) =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* prepare(world, risk);
          const delivery = yield* stored;
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          yield* store.update(deliveryId, { ...delivery.state, rounds: { fix: 2, review: 2 } });
          yield* endRun(authorRun);
          assert.strictEqual(world.sends.length, 1);
          assert.deepStrictEqual(world.sends[0]?.modelSelection, atEffort(original, "medium"));
          assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
        }),
      ),
  );

  it.effect.each([
    { name: "no descriptors", descriptors: undefined },
    { name: "an empty descriptor list", descriptors: [] },
    { name: "no effort option", descriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }] },
    {
      name: "no medium value",
      descriptors: [{ ...effort, options: [{ id: "high", label: "High" }] }],
    },
  ] satisfies Array<{
    name: string;
    descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  }>)("omits modelSelection with $name", ({ descriptors }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.descriptors = descriptors;
        yield* prepare(world);
        yield* endRun(authorRun);
        assert.strictEqual(world.sends.length, 1);
        assert.isFalse("modelSelection" in world.sends[0]!);
        assert.deepStrictEqual(world.selection, original);
      }),
    ),
  );

  it.effect.each(
    (["normal", "high"] as const).flatMap((risk) =>
      ["low", "high", undefined].map((value) => ({ risk, value })),
    ),
  )(
    "restores $value before a $risk-risk round-1 fix-verify after medium fix-commit",
    ({ risk, value }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const before =
            value === undefined
              ? { ...original, options: [{ id: "fastMode", value: true }] }
              : atEffort(original, value);
          world.selection = before;
          yield* prepare(world, risk);
          yield* endRun(authorRun);
          const fixing = world.sends[0]!;
          assert.deepStrictEqual(fixing.modelSelection, atEffort(before, "medium"));
          yield* commit(world.cwd);
          yield* endRun(runOf(fixing));
          assert.strictEqual(world.sends.length, 2);
          assert.include(world.sends[1]!.commandId, "factory-fix-verify:");
          assert.deepStrictEqual((yield* stored).state.rounds, { fix: 1, review: 0 });
          assert.deepStrictEqual(
            world.sends[1]!.modelSelection,
            risk === "high"
              ? atEffort(before, "xhigh")
              : value === undefined
                ? atEffort(before, "high")
                : before,
          );
          assert.deepStrictEqual(
            world.selection,
            risk === "high"
              ? atEffort(before, "xhigh")
              : value === undefined
                ? atEffort(before, "high")
                : before,
          );
        }),
      ),
  );

  it.effect.each([undefined, "low"])(
    "captures the omitted effort with currentValue=%s before the model catalog changes",
    (currentValue) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const before = { ...original, options: [{ id: "fastMode", value: true }] };
          world.selection = before;
          world.descriptors = [
            { ...effort, ...(currentValue === undefined ? {} : { currentValue }) },
          ];
          yield* prepare(world);
          yield* endRun(authorRun);
          assert.deepStrictEqual(world.selection, atEffort(before, "medium"));
          // Restoration must use the original effective value, independently of the current catalog.
          world.descriptors = [{ ...effort, currentValue: "medium" }];
          yield* commit(world.cwd);
          yield* endRun(runOf(world.sends[0]!));
          assert.deepStrictEqual(world.selection, atEffort(before, currentValue ?? "high"));
        }),
      ),
  );

  it.effect.each([
    { name: "model", selection: { ...original, model: "owner-model" } },
    { name: "effort", selection: atEffort(original, "max") },
  ])("keeps an owner's subsequent $name change", ({ selection: ownerSelection }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        const fixing = world.sends[0]!;
        world.selection = ownerSelection;
        yield* commit(world.cwd);
        yield* endRun(runOf(fixing));
        assert.strictEqual(world.sends.length, 2);
        assert.isUndefined(world.sends[1]!.modelSelection);
        assert.deepStrictEqual(world.selection, ownerSelection);
      }),
    ),
  );

  it.effect(
    "replays one fix-commit effect with identical ids and selection across a rebuilt service",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* prepare(world);
          const delivery = yield* stored;
          const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
          const first = yield* threads.sendFixCommitTurn(delivery, fixEffect);
          world.selection = { ...original, model: "owner-model" };
          world.descriptors = undefined;
          const rebuilt = yield* FactoryThreadEffects.FactoryThreadEffects.pipe(
            Effect.provide(Layer.fresh(FactoryThreadEffects.layer)),
          );
          assert.notStrictEqual(rebuilt, threads);
          const again = yield* rebuilt.sendFixCommitTurn(delivery, fixEffect);
          assert.deepStrictEqual(world.sends[0], world.sends[1]);
          assert.deepStrictEqual(first, again);
          assert.strictEqual(world.accepted.size, 1);
          assert.deepStrictEqual(world.selection, { ...original, model: "owner-model" });
        }),
      ),
  );

  it.effect("replays an unsupported selection unchanged when the model later offers medium", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.descriptors = undefined;
        yield* prepare(world);
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        const delivery = yield* stored;
        yield* threads.sendFixCommitTurn(delivery, fixEffect);
        world.descriptors = [effort];
        yield* threads.sendFixCommitTurn(delivery, fixEffect);
        assert.deepStrictEqual(world.sends[0], world.sends[1]);
        assert.isFalse("modelSelection" in world.sends[0]!);
        assert.strictEqual(world.accepted.size, 1);
      }),
    ),
  );

  it.effect("leaves an owner's selection alone when a recorded mechanical send was refused", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const delivery = yield* stored;
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        world.sendFailure = new ThreadManagement.ThreadManagementThreadNotFoundError({
          projectId,
          threadId: author,
        });
        const refused = yield* Effect.flip(threads.sendFixCommitTurn(delivery, fixEffect));
        assert.strictEqual(refused._tag, "ThreadManagementThreadNotFoundError");
        assert.strictEqual(world.accepted.size, 0);
        world.sendFailure = null;
        world.selection = atEffort(original, "medium");
        yield* threads.sendReviewRetryTurn(delivery, {
          id: 4,
          type: "send_review_retry_turn",
          threadId: author,
          problems: ["Submit the review again."],
        });
        assert.isUndefined(world.sends[1]!.modelSelection);
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
      }),
    ),
  );

  it.effect("resumes an unsettled stopped delivery with the same medium selection rule", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const delivery = yield* stored;
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        yield* store.update(deliveryId, {
          ...delivery.state,
          status: "stopped",
          checkpoint: "verify",
          awaiting: null,
        });
        const stages = yield* FactoryStageRunStore.FactoryStageRunStore;
        yield* stages.finish({ deliveryId, stage: "author", attempt: 1, outcome: "passed" });
        const service = yield* FactoryService.FactoryService;
        yield* service.resume(deliveryId);
        yield* drain;
        assert.strictEqual(world.sends.length, 1);
        assert.deepStrictEqual(world.sends[0]?.modelSelection, atEffort(original, "medium"));
        assert.include(world.sends[0]!.text, "verify");
      }),
    ),
  );

  it.effect("restores effort while keeping unrelated options the owner changed", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        world.selection = {
          ...world.selection,
          options: [
            { id: "effort", value: "medium" },
            { id: "fastMode", value: false },
          ],
        };
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        assert.deepStrictEqual(world.selection, {
          ...original,
          options: [
            { id: "fastMode", value: false },
            { id: "effort", value: "high" },
          ],
        });
      }),
    ),
  );

  it.effect("does not undo an owner choosing medium after the temporary effort was restored", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        assert.deepStrictEqual(world.selection, original);
        world.selection = atEffort(original, "medium");
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        yield* threads.sendRepairTurn(yield* stored, {
          id: 20,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 1,
        });
        assert.isUndefined(world.sends.at(-1)!.modelSelection);
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
      }),
    ),
  );

  it.effect("escalates a later repair from the pre-mechanical effort without lowering max", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.selection = atEffort(original, "max");
        yield* prepare(world);
        yield* endRun(authorRun);
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        yield* threads.sendFixCommitTurn(yield* stored, { ...fixEffect, id: 10 });
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
        yield* threads.sendRepairTurn(yield* stored, {
          id: 11,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 2,
        });
        assert.deepStrictEqual(world.selection, atEffort(original, "max"));
      }),
    ),
  );

  it.effect("blocks without sending when recording the pre-mechanical selection fails", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_selection BEFORE INSERT ON fd_factory_turn_selections
      BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`;
        yield* endRun(authorRun);
        assert.strictEqual(world.sends.length, 0);
        assert.deepStrictEqual(world.selection, original);
        assert.strictEqual((yield* stored).state.status, "blocked");
        const { block } = (yield* stored).state;
        assert.strictEqual(block?.reason, "effect_failed");
        assert.strictEqual(
          block?.reason === "effect_failed" ? block.detail : undefined,
          "Factory could not send the fix-commit turn (FactoryStoreError).",
        );
      }),
    ),
  );
});
