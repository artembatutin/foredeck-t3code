import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
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
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
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
import * as FactoryTurnSelectionStore from "./persistence/FactoryTurnSelectionStore.ts";
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
const piCatalog = (catalogDefault?: string) =>
  [
    {
      instanceId: integratedInstanceId,
      driver: ProviderDriverKind.make("pi"),
      models: [
        {
          slug: "test/reasoning",
          capabilities: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                ...(catalogDefault === "medium" ? { currentValue: catalogDefault } : {}),
                options: ["low", "medium", "high"].map((id) => ({
                  id,
                  label: id,
                  ...(catalogDefault === "low" && id === catalogDefault ? { isDefault: true } : {}),
                })),
              },
            ],
          },
        },
      ],
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
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
  it.live.each(
    (["unrelated option", "explicit medium"] as const).flatMap((change) =>
      [false, true].map((legacyArchive) => ({ change, legacyArchive })),
    ),
  )(
    "preserves owner $change intent across public event compaction before restoration (legacy archive: $legacyArchive)",
    ({ change, legacyArchive }) =>
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
                commandId: CommandId.make(`owner-compacted-selection:${++selections}`),
                threadId: author.threadId,
                modelSelection,
              });
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
            // Choosing effort away and back is intentional even when the final value is the
            // same as Factory's temporary value. An option-only change inherits that value.
            if (change === "explicit medium") yield* select(atEffort(before, "high"));
            yield* select({
              ...before,
              options: [
                { id: "effort", value: "medium" },
                { id: "fastMode", value: false },
              ],
            });
            if (change === "explicit medium")
              yield* threads.dispatch({
                type: "thread.visit",
                commandId: CommandId.make("owner-visit:before-compaction"),
                threadId: author.threadId,
                visitedAt: DateTime.formatIso(yield* DateTime.now),
              });
            const events = yield* EventStore.EventStoreV2;
            const choices = yield* events
              .read({ threadId: author.threadId, eventType: "thread.model-selection-updated" })
              .pipe(Stream.runCollect);
            const sql = yield* SqlClient.SqlClient;
            if (legacyArchive) {
              // Fixture for the interrupted build: these events were deleted and only their
              // selection provenance survived in its archive. No production code copies them.
              for (const { event, sequence, commandId } of choices) {
                if (event.type !== "thread.model-selection-updated") continue;
                yield* sql`INSERT INTO fd_factory_selection_history
                  (sequence, thread_id, command_id, selection_json)
                  VALUES (${sequence}, ${author.threadId}, ${commandId},
                    ${JSON.stringify(event.payload.modelSelection)})`;
                yield* sql`DELETE FROM orchestration_events WHERE event_id = ${event.id}`;
              }
            }
            const compacted = yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2)
              .compactEventStore;
            assert.isAbove(compacted.deletedEventCount, 0);
            const remaining = yield* events
              .read({ threadId: author.threadId, eventType: "thread.model-selection-updated" })
              .pipe(Stream.runCollect);
            assert.lengthOf(remaining, legacyArchive ? 0 : change === "explicit medium" ? 4 : 3);
            assert.lengthOf(
              yield* sql`SELECT * FROM fd_factory_selection_history`,
              legacyArchive ? choices.length : 0,
            );
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            const state = yield* stateOf(author.deliveryId);
            assert.strictEqual(state.risk, "normal");
            assert.deepStrictEqual(state.rounds, { fix: 1, review: 0 });
            const expected = {
              ...before,
              options:
                change === "explicit medium"
                  ? [
                      { id: "effort", value: "medium" },
                      { id: "fastMode", value: false },
                    ]
                  : [
                      { id: "fastMode", value: false },
                      { id: "effort", value: "high" },
                    ],
            };
            const next = yield* projection();
            assert.deepStrictEqual(next.thread.modelSelection, expected);
            assert.deepStrictEqual(next.runs.at(-1)?.modelSelection, expected);
            assert.deepStrictEqual(world.provider.started.at(-1)?.modelSelection, expected);
          }).pipe(
            Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provideMerge(EventStore.layer))),
          ),
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

  it.live.each(["valid snapshot", "read failure", "different native session"] as const)(
    "captures inherited effort while a real Pi owner turn is active with a different loaded selection: %s",
    (snapshotState) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const service = yield* FactoryService.FactoryService;
            yield* service.stop(author.deliveryId);
            yield* authorCommits(author.worktreePath, "fix: prepare before stopping");
            yield* world.endRun(author.runId, "completed");
            assert.strictEqual((yield* stateOf(author.deliveryId)).status, "stopped");
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projection = () =>
              threads.getProjectThread({ projectId: world.projectId, threadId: author.threadId });
            const before = { instanceId: integratedInstanceId, model: "test/reasoning" };
            const low = { ...before, options: [{ id: "thinking", value: "low" }] };
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("owner-selection:explicit-low"),
              threadId: author.threadId,
              modelSelection: low,
            });
            const context =
              yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProviderContext(
                author.threadId,
                before.instanceId,
              );
            const providerThread = context.providerThreads[0]!;
            const pi = yield* makePiEffort(author.threadId, low, {
              loaded: false,
              providerSessionId: providerThread.providerSessionId!,
            });
            world.provider.threadLoads.resume = pi.runtime.resumeThread;
            world.provider.threadLoads.snapshot = pi.runtime.readThreadSnapshot;
            // The public owner send loads the real adapter through the shared manager with low.
            const ownerRun = yield* world.ownerTurn(author.threadId, "Owner work before Resume");
            const owner = world.provider.started.find(({ runId }) => runId === ownerRun)!;
            assert.deepStrictEqual(owner.modelSelection, low);
            yield* pi.start(owner);
            assert.strictEqual(pi.thinking(), "low");
            const active = yield* pi.runtime.readThreadSnapshot({
              providerThread: owner.providerThread,
            });
            assert.strictEqual(active.providerThread.status, "active");
            // Persist the adapter's public binding event, as production's ingestor does.
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  type: "provider-thread.updated",
                  id: EventId.make("test-active-owner-binding"),
                  threadId: author.threadId,
                  occurredAt: active.providerThread.updatedAt,
                  payload: active.providerThread,
                },
              ],
            });
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("owner-selection:inherited-while-active"),
              threadId: author.threadId,
              modelSelection: before,
            });
            yield* (yield* FileSystem.FileSystem).writeFileString(
              `${author.worktreePath}/export.ts`,
              "uncommitted work\n",
            );
            const requestCount = pi.requests.length;
            if (snapshotState === "read failure") pi.state.failRead = true;
            if (snapshotState === "different native session")
              pi.state.nativeId = "native:another-thread";
            yield* service.resume(author.deliveryId);
            yield* drainFactory;
            const fixingState = yield* stateOf(author.deliveryId);
            if (snapshotState !== "valid snapshot") {
              assert.strictEqual(fixingState.status, "blocked");
              assert.strictEqual(fixingState.block?.reason, "effect_failed");
              assert.strictEqual((yield* projection()).runs.at(-1)?.id, ownerRun);
              assert.strictEqual((yield* projection()).runs.at(-1)?.status, "running");
              assert.deepStrictEqual(pi.levels(), ["low"]);
              assert.isFalse(
                pi.requests
                  .slice(requestCount)
                  .some((request) => request["type"] === "switch_session"),
              );
              assert.lengthOf(
                yield* (yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore).list(
                  author.threadId,
                ),
                0,
              );
              return;
            }
            if (fixingState.awaiting?.type !== "run")
              return assert.fail(JSON.stringify(fixingState.block));
            const fixing = fixingState.awaiting;
            const queued = (yield* projection()).runs.find(({ id }) => id === fixing.runId)!;
            assert.strictEqual(queued.status, "queued");
            assert.strictEqual(
              (yield* projection()).runs.find(({ id }) => id === ownerRun)?.status,
              "running",
            );
            assert.deepStrictEqual(queued.modelSelection, {
              ...before,
              options: [{ id: "thinking", value: "medium" }],
            });
            assert.deepStrictEqual(
              pi.requests.slice(requestCount).map((request) => request["type"]),
              ["get_state", "get_messages"],
            );
            assert.deepStrictEqual(
              (yield* (yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore).list(
                author.threadId,
              ))[0]!.before,
              low,
            );
            yield* pi.end();
            yield* world.endRun(ownerRun, "completed");
            const mechanical = world.provider.started.find(({ runId }) => runId === fixing.runId)!;
            yield* pi.run(mechanical);
            assert.strictEqual(pi.thinking(), "medium");
            yield* commit(author.worktreePath);
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            const repair = world.provider.started.at(-1)!;
            assert.notStrictEqual(repair.runId, fixing.runId);
            assert.deepStrictEqual(repair.modelSelection, low);
            yield* pi.run(repair);
            assert.strictEqual(pi.thinking(), "low");
            assert.deepStrictEqual(pi.levels(), ["low", "medium", "low"]);
          }).pipe(Effect.provide(piEffortLayer), Effect.scoped),
        { providers: piCatalog() },
      ),
  );

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

  it.live.each([
    "model",
    "effort",
    "direct high-to-medium effort",
    "direct high-to-medium effort across compaction",
    "effort round-trip",
    "unrelated option",
  ] as const)(
    "recovers an owner %s selection made after mechanical enqueue and before dequeue",
    (scenario) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const change =
              scenario === "direct high-to-medium effort across compaction"
                ? "direct high-to-medium effort"
                : scenario;
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
            assert.deepStrictEqual((yield* projection()).thread.modelSelection, before);
            const selected =
              change === "model"
                ? { ...atEffort(before, "low"), model: "owner-model" }
                : change === "effort"
                  ? atEffort(before, "low")
                  : change === "effort round-trip" || change === "direct high-to-medium effort"
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
            if (change === "direct high-to-medium effort") {
              assert.strictEqual(selections, 2);
              assert.deepStrictEqual((yield* projection()).thread.modelSelection, selected);
            }
            if (scenario === "direct high-to-medium effort across compaction")
              yield* Effect.flatMap(
                ProjectionMaintenance.ProjectionMaintenanceV2,
                (maintenance) => maintenance.compactEventStore,
              ).pipe(
                Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provide(EventStore.layer))),
              );
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

  it.live.each([
    { name: "no advertised default", loaded: true, catalogDefault: undefined, owner: null },
    {
      name: "no advertised default in an inactive session",
      loaded: false,
      catalogDefault: undefined,
      owner: null,
    },
    {
      name: "a catalog default different from the inactive session",
      loaded: false,
      catalogDefault: "low",
      owner: null,
    },
    {
      name: "a catalog currentValue different from the active session",
      loaded: true,
      catalogDefault: "medium",
      owner: null,
    },
    {
      name: "an inactive session without a native reference",
      loaded: false,
      catalogDefault: undefined,
      owner: null,
    },
    { name: "an owner model change", loaded: true, catalogDefault: undefined, owner: "model" },
    { name: "an owner effort change", loaded: true, catalogDefault: undefined, owner: "effort" },
    {
      name: "an owner unrelated option change",
      loaded: true,
      catalogDefault: undefined,
      owner: "option",
    },
  ] as const)(
    "restores inherited Pi effort after medium fix-commit with $name",
    ({ name, loaded, catalogDefault, owner }) =>
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
            const context =
              yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProviderContext(
                author.threadId,
                before.instanceId,
              );
            const providerSessionId = context.providerThreads[0]!.providerSessionId!;
            const pi = yield* makePiEffort(author.threadId, before, { loaded, providerSessionId });
            const sink = yield* EventSink.EventSinkV2;
            world.provider.threadLoads.ensure = (input) =>
              pi.runtime.ensureThread(input).pipe(
                // The real adapter publishes this native binding on its event stream. This
                // harness uses a recording turn driver, so persist that provider event here.
                Effect.tap((providerThread) =>
                  sink
                    .write({
                      events: [
                        {
                          type: "provider-thread.updated",
                          id: EventId.make(`test-loaded:${input.threadId}`),
                          threadId: input.threadId,
                          occurredAt: providerThread.updatedAt,
                          payload: providerThread,
                        },
                      ],
                    })
                    .pipe(Effect.orDie),
                ),
              );
            world.provider.threadLoads.resume = pi.runtime.resumeThread;
            world.provider.threadLoads.snapshot = pi.runtime.readThreadSnapshot;
            const service = yield* FactoryService.FactoryService;
            if (!loaded) yield* service.stop(author.deliveryId);
            assert.strictEqual(pi.thinking(), "high");
            assert.deepStrictEqual(pi.levels(), []);
            const fs = yield* FileSystem.FileSystem;
            if (loaded)
              yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            else yield* authorCommits(author.worktreePath, "fix: prepare before stopping");
            yield* world.endRun(author.runId, "completed");
            if (!loaded) {
              assert.strictEqual((yield* stateOf(author.deliveryId)).status, "stopped");
              const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
              yield* sessions.close(providerSessionId);
              assert.isTrue(Option.isNone(yield* sessions.get(providerSessionId)));
              if (name === "an inactive session without a native reference") {
                yield* (yield* EventSink.EventSinkV2).write({
                  events: [
                    {
                      type: "provider-thread.updated",
                      id: EventId.make("test-native-reference-cleared"),
                      occurredAt: yield* DateTime.now,
                      threadId: author.threadId,
                      payload: { ...context.providerThreads[0]!, nativeThreadRef: null },
                    },
                  ],
                });
              }
              yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
              yield* service.resume(author.deliveryId);
              yield* drainFactory;
            }
            yield* drainOrchestration;
            const fixingState = yield* stateOf(author.deliveryId);
            const fixing = fixingState.awaiting;
            if (fixing?.type !== "run") return assert.fail(JSON.stringify(fixingState.block));
            const mechanical = world.provider.started.find(({ runId }) => runId === fixing.runId)!;
            assert.isDefined(mechanical);
            assert.deepStrictEqual(pi.levels(), []);
            yield* pi.run(mechanical);
            assert.strictEqual(pi.thinking(), "medium");
            assert.deepStrictEqual(pi.levels(), ["medium"]);
            const requests = pi.requests.map((request) => request["type"]);
            assert.isBelow(requests.indexOf("get_state"), requests.indexOf("set_thinking_level"));
            assert.strictEqual(requests.filter((type) => type === "prompt").length, 1);
            const selections = yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore;
            const saved = (yield* selections.list(author.threadId))[0]!;
            assert.deepStrictEqual(saved.before.options, [{ id: "thinking", value: "high" }]);
            const effects = yield* FactoryThreadEffects.FactoryThreadEffects.pipe(
              Effect.provide(
                FactoryThreadEffects.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
                    ),
                  ),
                ),
              ),
            );
            const replay = yield* effects.sendFixCommitTurn(
              Option.getOrThrow(
                yield* (yield* FactoryDeliveryStore.FactoryDeliveryStore).get(author.deliveryId),
              ),
              { ...fixEffect, id: saved.effectId, threadId: author.threadId },
            );
            assert.strictEqual(replay.runId, fixing.runId);
            assert.lengthOf(world.provider.started, 2);
            assert.lengthOf(pi.requests, requests.length);
            const ownerSelection: ModelSelection | undefined =
              owner === "model"
                ? { ...before, model: "test/other" }
                : owner === "effort"
                  ? { ...before, options: [{ id: "thinking", value: "low" }] }
                  : owner === "option"
                    ? {
                        ...before,
                        options: [
                          { id: "thinking", value: "medium" },
                          { id: "fastMode", value: true },
                        ],
                      }
                    : undefined;
            if (ownerSelection !== undefined)
              yield* threads.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make("owner-selection:after-mechanical"),
                threadId: author.threadId,
                modelSelection: ownerSelection,
              });
            yield* commit(author.worktreePath);
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            const resumed = yield* stateOf(author.deliveryId);
            assert.strictEqual(resumed.risk, "normal");
            assert.deepStrictEqual(resumed.rounds, { fix: 1, review: 0 });
            const repair = world.provider.started.at(-1)!;
            assert.notStrictEqual(repair.runId, fixing.runId);
            assert.deepStrictEqual(
              repair.modelSelection,
              owner === "model" || owner === "effort"
                ? ownerSelection
                : {
                    ...before,
                    options: [
                      ...(owner === "option" ? [{ id: "fastMode", value: true }] : []),
                      { id: "thinking", value: "high" },
                    ],
                  },
            );
            if (owner === "model") return;
            yield* pi.run(repair);
            assert.strictEqual(pi.thinking(), owner === "effort" ? "low" : "high");
            assert.deepStrictEqual(pi.levels(), ["medium", owner === "effort" ? "low" : "high"]);
          }).pipe(Effect.provide(piEffortLayer), Effect.scoped),
        { providers: piCatalog(catalogDefault) },
      ),
  );

  it.live.each([
    "read failure",
    "missing effort",
    "unknown effort",
    "different native session",
    "load failure",
  ] as const)("blocks before imposing medium on inherited native thinking with %s", (failure) =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const before = { instanceId: integratedInstanceId, model: "test/reasoning" };
          yield* threads.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("owner-selection:pi-inherited"),
            threadId: author.threadId,
            modelSelection: before,
          });
          const context =
            yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProviderContext(
              author.threadId,
              before.instanceId,
            );
          const providerThread = context.providerThreads[0]!;
          const pi = yield* makePiEffort(author.threadId, before, {
            loaded: false,
            providerSessionId: providerThread.providerSessionId!,
          });
          world.provider.threadLoads.resume =
            failure === "load failure"
              ? () =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: pi.runtime.driver,
                      providerSessionId: pi.runtime.providerSessionId,
                      providerThreadId: providerThread.id,
                    }),
                  )
              : pi.runtime.resumeThread;
          world.provider.threadLoads.snapshot = (input) =>
            Effect.suspend(() => {
              if (failure === "read failure") pi.state.failRead = true;
              if (failure === "missing effort") pi.state.thinking = undefined;
              if (failure === "unknown effort") pi.state.thinking = "unavailable";
              if (failure === "different native session")
                pi.state.nativeId = "native:another-thread";
              return pi.runtime.readThreadSnapshot(input);
            });
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${author.worktreePath}/export.ts`,
            "uncommitted work\n",
          );
          yield* world.endRun(author.runId, "completed");
          yield* drainOrchestration;
          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.block?.reason, "effect_failed");
          assert.lengthOf(world.provider.started, 1);
          assert.deepStrictEqual(pi.levels(), []);
          assert.isFalse(pi.requests.some((request) => request["type"] === "prompt"));
          assert.deepStrictEqual(
            (yield* threads.getProjectThread({
              projectId: world.projectId,
              threadId: author.threadId,
            })).thread.modelSelection,
            before,
          );
          assert.lengthOf(
            yield* (yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore).list(
              author.threadId,
            ),
            0,
          );
        }).pipe(Effect.provide(piEffortLayer), Effect.scoped),
      { providers: piCatalog() },
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
