import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as Work from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryMigrations from "./persistence/FactoryMigrations.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  type FactoryDeliveryState,
  type FactoryEvent,
  queuedDeliveryState,
} from "./pipeline/state.ts";
// After the Factory entry, which loads core's import cycle in an order it can initialize (see
// index.ts).
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-layers");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-layers"),
};
const threadId = ThreadId.make("thread-author");
const runId = RunId.make("run-author");

const fold = (...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce(
    (state, event) => advance(state, event).delivery,
    queuedDeliveryState({ branch: "work/fd-layers", baseRef: "HEAD" }),
  );
/** Started by an earlier process, which ended before its author launch fed a result back. */
const awaitingLaunch = fold({ type: "start" });
/** What the boot sweep makes of `awaitingLaunch`: the launch ended with that process. */
const interrupted = fold(
  { type: "start" },
  {
    type: "effect.failed",
    effectId: 1,
    detail: "Factory could not launch the author thread: a server restart interrupted it.",
  },
);
/** Launched by an earlier process; the author's first run was still going when it ended. */
const awaitingRun = fold(
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId,
    runId,
    worktreePath: "/worktrees/fd-layers",
    baseline: "b".repeat(40),
  },
);

/**
 * What server.ts provides Factory's layers besides SQLite and the platform. The project store,
 * process runner and config are real; the services that reach Work's sources, providers or Git
 * are fakes that fail if called, since nothing here launches a thread or runs a command.
 */
const serverServices = Layer.mergeAll(
  Layer.mock(Work.WorkService.WorkService)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ServerSettings.ServerSettingsService)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  ProviderRegistryMock.layer(),
  ProjectStore.layer,
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-fd-factory-layers-" }),
);

/**
 * Factory as server.ts composes it: the worker layer over `layerLive`, beside the orchestration
 * runtime's event sink (the orchestrator commits through it), behind the server's activation.
 */
const factoryLayers = (activation: Deferred.Deferred<void>) =>
  Factory.workerLayer.pipe(
    Layer.provideMerge(Factory.layerLive),
    Layer.provideMerge(RuntimeLayer.layerEventSink),
    Layer.provide(serverServices),
    Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation))),
  );

/** Core and Work persistence, which server.ts migrates before Factory's ledger. */
const corePersistence = <E, R>(sqlite: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Work.layerPersistence.pipe(Layer.provideMerge(sqlite));

/** Stores a delivery with its author attempt, as an earlier process left them. */
const seed = (
  state: FactoryDeliveryState,
  run?: { readonly threadId: ThreadId; readonly runId: RunId },
) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
    yield* deliveries.insert({ deliveryId, projectId, itemRef, state });
    yield* stageRuns.append({ deliveryId, stage: "author", ...run });
  });

/** Every Factory delivery and stage attempt row exactly as SQLite holds it. */
const factoryRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    deliveries: yield* sql`SELECT * FROM fd_factory_deliveries`,
    stageRuns: yield* sql`SELECT * FROM fd_factory_stage_runs`,
  };
});

const stateOf = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const authorAttempt = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (store) =>
  store.listByDelivery(deliveryId),
).pipe(Effect.map(([attempt]) => attempt));
const drainReactor = Effect.flatMap(Factory.FactoryReactor.FactoryReactor, (r) => r.drain);
const drainWorker = Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (w) => w.drain);

/**
 * Seeds an in-memory database through Factory's persistence, then runs `body` in a fresh build
 * of Factory's layers on it, as a restarted server would: activation is pending until `body`
 * runs `activate`.
 */
const afterRestart = <SE, A, E, R>(
  seeded: Effect.Effect<
    void,
    SE,
    FactoryDeliveryStore.FactoryDeliveryStore | FactoryStageRunStore.FactoryStageRunStore
  >,
  body: (activate: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* seeded;
    const activation = yield* Deferred.make<void>();
    const activate = Deferred.succeed(activation, undefined).pipe(Effect.asVoid);
    return yield* body(activate).pipe(Effect.provide(factoryLayers(activation), { local: true }));
  }).pipe(
    Effect.provide(
      Factory.layerPersistence.pipe(
        Layer.provideMerge(corePersistence(SqlitePersistence.layerMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("Factory server layers", () => {
  it.effect("resolve the service and leave the reactor parked until activation", () =>
    afterRestart(seed(awaitingLaunch), () =>
      Effect.gen(function* () {
        const before = yield* factoryRows;
        yield* Factory.FactoryService.FactoryService;
        // A boot sweep that ran without activation would block the delivery within a few turns:
        // in-memory SQLite never yields, so nothing it does waits on I/O.
        for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
        yield* drainWorker;

        assert.deepStrictEqual(yield* factoryRows, before);
        assert.deepStrictEqual(yield* stateOf, awaitingLaunch);
      }),
    ),
  );

  it.effect("block a delivery left awaiting an effect once the server activates", () =>
    afterRestart(seed(awaitingLaunch), (activate) =>
      Effect.gen(function* () {
        yield* activate;
        yield* drainReactor;
        yield* drainWorker;

        const state = yield* stateOf;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.block?.reason, "effect_failed");
        assert.deepStrictEqual(state, interrupted);
        assert.strictEqual((yield* authorAttempt)?.outcome, "blocked");
      }),
    ),
  );

  it.effect("feed runs the orchestrator commits after activation into their delivery", () =>
    afterRestart(seed(awaitingRun, { threadId, runId }), (activate) =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const commit = (name: string, event: OrchestrationV2DomainEvent) =>
          sink.commitCommand({
            commandId: CommandId.make(name),
            threadId,
            commandType: name,
            acceptedAt: now,
            events: [event],
            effects: [],
          });
        const providerInstanceId = ProviderInstanceId.make("test");
        const modelSelection = { instanceId: providerInstanceId, model: "test" };
        yield* commit("thread-create", {
          id: EventId.make("thread-create"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId,
            title: "Author",
            createdBy: "system",
            creationSource: "server",
            providerInstanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "work/fd-layers",
            worktreePath: "/worktrees/fd-layers",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const run: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message-author"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* commit("run-create", {
          id: EventId.make("run-create"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: run,
        });

        // The boot sweep finds the run still going and leaves the delivery waiting for it.
        yield* activate;
        yield* drainReactor;
        yield* drainWorker;
        assert.deepStrictEqual(yield* stateOf, awaitingRun);

        // Only the live tail can see this one, and only on the sink the orchestrator uses.
        yield* commit("run-fail", {
          id: EventId.make("run-fail"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        });
        yield* drainReactor;
        yield* drainWorker;

        const state = yield* stateOf;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "run_ended",
          threadId,
          runId,
          runStatus: "failed",
        });
        assert.strictEqual((yield* authorAttempt)?.outcome, "blocked");
      }),
    ),
  );

  it.effect("re-run Factory's ledger on the same database file and keep a delivery readable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fd-factory-layers-" });
      const dbPath = path.join(directory, "statev2.sqlite");
      // Neither process activates, so only the layer builds touch the database.
      const activation = yield* Deferred.make<void>();
      /** One server process: a fresh build of the composed layers on the file. */
      const inProcess = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        body.pipe(
          Effect.provide(
            factoryLayers(activation).pipe(
              Layer.provideMerge(corePersistence(SqlitePersistence.layerFromPath(dbPath))),
            ),
            { local: true },
          ),
        );
      const ledger = Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM fd_factory_migrations ORDER BY migration_id
        `,
      ).pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const)));
      const manifest = FactoryMigrations.factoryMigrationEntries.map(
        ([id, name]) => [id, name] as const,
      );

      yield* inProcess(
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* ledger, manifest);
          yield* seed(awaitingLaunch);
        }),
      );
      yield* inProcess(
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* ledger, manifest);
          const service = yield* Factory.FactoryService.FactoryService;
          const delivery = Option.getOrThrow(yield* service.get(deliveryId));
          assert.deepStrictEqual(delivery.itemRef, itemRef);
          assert.strictEqual(delivery.projectId, projectId);
          assert.deepStrictEqual(delivery.state, awaitingLaunch);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
