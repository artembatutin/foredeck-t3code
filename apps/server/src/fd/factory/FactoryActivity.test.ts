import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TxRef from "effect/TxRef";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FactoryActivity from "./FactoryActivity.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryAutomaticTurnStore from "./persistence/FactoryAutomaticTurnStore.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { WATCH_SYNC_COMMAND } from "./followThrough.ts";
import {
  type FactoryDeliveryState,
  type FactoryEffect,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  agentSends,
  coreRecovery,
  delegateFrom,
  endTurnOnly,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  endWhileDown,
  linkOf,
  openSingle,
  reviewPasses,
  runStarted,
  wakeThread,
} from "./testkit/followThrough.ts";
// After the Factory entry, which loads core's import cycle in an order it can initialize (see
// index.ts).
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";

const projectId = ProjectId.make("project-activity");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
let items = 0;

/** What the stack fails while set, and the jobs its worker reports in flight. */
interface Faults {
  projection: boolean;
  outbox: boolean;
  receipts: boolean;
  records: boolean;
  readonly jobs: Map<FactoryDeliveryId, number>;
}

const makeFaults = (): Faults => ({
  projection: false,
  outbox: false,
  receipts: false,
  records: false,
  jobs: new Map(),
});

/**
 * `FactoryActivity` over in-memory SQLite, reading core's records through readers that fail while
 * `faults` says so, beside an event sink to seed those records. The worker is a stand-in that
 * reports the jobs `faults` names.
 */
const activityStack = (faults: Faults) => {
  const failing = (operation: string) =>
    new FactoryStoreError({ operation, cause: "disk read failed" });
  const projections = Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.map(ProjectionStore.ProjectionStoreV2, (store) =>
      ProjectionStore.ProjectionStoreV2.of({
        ...store,
        getThreadRecords: (threadId, fields, filter) =>
          faults.projection
            ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
            : store.getThreadRecords(threadId, fields, filter),
      }),
    ),
  ).pipe(Layer.provide(ProjectionStore.layer));
  const outbox = Layer.effect(
    EffectOutbox.EffectOutboxV2,
    Effect.map(EffectOutbox.EffectOutboxV2, (store) =>
      EffectOutbox.EffectOutboxV2.of({
        ...store,
        get: (effectId) =>
          faults.outbox
            ? Effect.fail(new EffectOutbox.EffectOutboxError({ operation: "get", effectId }))
            : store.get(effectId),
      }),
    ),
  ).pipe(Layer.provide(EffectOutbox.layer));
  const receipts = Layer.effect(
    CommandReceiptStore.CommandReceiptStoreV2,
    Effect.map(CommandReceiptStore.CommandReceiptStoreV2, (store) =>
      CommandReceiptStore.CommandReceiptStoreV2.of({
        ...store,
        getByCommandId: (commandId) =>
          faults.receipts
            ? Effect.fail(
                new CommandReceiptStore.CommandReceiptStoreReadError({
                  commandId,
                  cause: "disk read failed",
                }),
              )
            : store.getByCommandId(commandId),
      }),
    ),
  ).pipe(Layer.provide(CommandReceiptStore.layer));
  const records = Layer.effect(
    FactoryAutomaticTurnStore.FactoryAutomaticTurnStore,
    Effect.map(FactoryAutomaticTurnStore.FactoryAutomaticTurnStore, (store) =>
      FactoryAutomaticTurnStore.FactoryAutomaticTurnStore.of({
        ...store,
        get: (key) =>
          faults.records ? Effect.fail(failing("automaticTurns.get")) : store.get(key),
      }),
    ),
  );
  return FactoryActivity.layerOverReaders.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        EventStore.layer,
        receipts,
        outbox,
        records,
        Layer.mock(FactoryWorker.FactoryWorker)({
          jobsInFlight: (deliveryId) => Effect.sync(() => faults.jobs.get(deliveryId) ?? 0),
        }),
      ),
    ),
    Layer.provideMerge(RuntimeLayer.layerEventSink),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

/** Stores a delivery of an item of its own, as the step that left it there did. */
const seed = (
  state: FactoryDeliveryState,
  options: { readonly deliveryId?: string; readonly parentId?: FactoryDeliveryId } = {},
) =>
  Effect.gen(function* () {
    items += 1;
    const deliveryId = FactoryDeliveryId.make(options.deliveryId ?? `delivery-activity-${items}`);
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({
      deliveryId,
      projectId,
      itemRef: { sourceId, itemId: WorkItemId.make(`fd-act${items}`) },
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      state,
    });
    return deliveryId;
  }).pipe(Effect.orDie);

const base = queuedDeliveryState({ branch: "work/activity", baseRef: "HEAD" });
const settle: FactoryEffect = {
  id: 2,
  type: "check_settle",
  threadId: ThreadId.make("thread-settle"),
  runId: RunId.make("run-settle"),
};
const awaitingEffect = (effect: FactoryEffect) => ({ type: "effect", effect }) as const;

const activityOf = (root: FactoryDeliveryId) =>
  Effect.flatMap(FactoryActivity.FactoryActivity, (service) => service.activity(root)).pipe(
    Effect.orDie,
  );
const phaseOf = (root: FactoryDeliveryId) =>
  activityOf(root).pipe(Effect.map(({ phase }) => phase));

describe("FactoryActivity phases", () => {
  it.effect("tells proceeding, parked, terminal and missing deliveries apart", () => {
    const faults = makeFaults();
    return Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, FactoryDeliveryState, string]> = [
        // A queued row whose start step failed: only a start moves it on.
        ["queued", base, "proceeding"],
        [
          "running",
          { ...base, status: "running", stage: "author", awaiting: awaitingEffect(settle) },
          "proceeding",
        ],
        [
          "stopping",
          { ...base, status: "stopping", stage: "author", awaiting: awaitingEffect(settle) },
          "proceeding",
        ],
        [
          "approved, opening its pull request",
          {
            ...base,
            status: "approved",
            stage: "pr",
            awaiting: awaitingEffect({ id: 5, type: "open_pr" }),
          },
          "proceeding",
        ],
        [
          "pr_open, closing out its merge",
          {
            ...base,
            status: "pr_open",
            stage: "pr",
            awaiting: awaitingEffect({ id: 7, type: "close_out" }),
          },
          "proceeding",
        ],
        [
          "waiting at the plan gate",
          { ...base, kind: "parent", status: "waiting", stage: "approve_plan" },
          "parked",
        ],
        [
          "stopped",
          { ...base, status: "stopped", stage: "author", checkpoint: "verify" },
          "parked",
        ],
        [
          "blocked",
          { ...base, status: "blocked", stage: "pr", block: { reason: "watch_ended" } },
          "parked",
        ],
        ["pr_open, idle", { ...base, status: "pr_open", stage: "pr" }, "parked"],
        ["done", { ...base, status: "done", stage: "pr" }, "terminal"],
        ["cancelled", { ...base, status: "cancelled", stage: "author" }, "terminal"],
      ];
      for (const [name, state, phase] of cases) {
        const report = yield* activityOf(yield* seed(state));
        assert.deepStrictEqual(
          report,
          { phase, busy: false, deferred: false, backgroundWaits: 0, unknown: false },
          name,
        );
      }
      assert.deepStrictEqual(yield* activityOf(FactoryDeliveryId.make("delivery-unknown")), {
        phase: "missing",
        busy: false,
        deferred: false,
        backgroundWaits: 0,
        unknown: false,
      });
    }).pipe(Effect.provide(activityStack(faults)));
  });

  it.effect("follows a parent through the child it awaits", () => {
    const faults = makeFaults();
    return Effect.gen(function* () {
      const parentOf = (child: FactoryDeliveryState) =>
        Effect.gen(function* () {
          items += 1;
          const parentId = FactoryDeliveryId.make(`delivery-parent-${items}`);
          const childId = FactoryDeliveryId.make(`delivery-child-${items}`);
          yield* seed(
            {
              ...base,
              kind: "parent",
              status: "running",
              stage: "author",
              planApproved: true,
              children: [childId],
              awaiting: { type: "child", deliveryId: childId },
            },
            { deliveryId: parentId },
          );
          yield* seed({ ...child, kind: "child" }, { deliveryId: childId, parentId });
          return parentId;
        });
      assert.strictEqual(
        yield* phaseOf(
          yield* parentOf({ ...base, status: "blocked", block: { reason: "watch_ended" } }),
        ),
        "parked",
      );
      assert.strictEqual(
        yield* phaseOf(yield* parentOf({ ...base, status: "stopped", checkpoint: "verify" })),
        "parked",
      );
      assert.strictEqual(
        yield* phaseOf(
          yield* parentOf({
            ...base,
            status: "running",
            stage: "author",
            awaiting: awaitingEffect(settle),
          }),
        ),
        "proceeding",
      );
      // A child not started yet starts by the parent's step, and an approved one hands the
      // parent its approval: either way the parent moves on by itself.
      assert.strictEqual(yield* phaseOf(yield* parentOf(base)), "proceeding");
      assert.strictEqual(
        yield* phaseOf(yield* parentOf({ ...base, status: "approved", stage: "record" })),
        "proceeding",
      );
    }).pipe(Effect.provide(activityStack(faults)));
  });

  it.effect(
    "reports jobs in flight as busy and an effect waiting for admission as deferred",
    () => {
      const faults = makeFaults();
      return Effect.gen(function* () {
        const stopped = yield* seed({
          ...base,
          status: "stopped",
          stage: "author",
          checkpoint: "verify",
        });
        faults.jobs.set(stopped, 1);
        assert.deepStrictEqual(yield* activityOf(stopped), {
          phase: "parked",
          busy: true,
          deferred: false,
          backgroundWaits: 0,
          unknown: false,
        });
        faults.jobs.delete(stopped);
        assert.isFalse((yield* activityOf(stopped)).busy);

        const waiting = yield* seed({
          ...base,
          status: "running",
          stage: "author",
          awaiting: awaitingEffect(settle),
          admissionWait: { effectId: settle.id },
        });
        assert.deepStrictEqual(yield* activityOf(waiting), {
          phase: "proceeding",
          busy: false,
          deferred: true,
          backgroundWaits: 0,
          unknown: false,
        });
        // Once a redispatch counts its job, it no longer waits.
        faults.jobs.set(waiting, 1);
        assert.deepStrictEqual(yield* activityOf(waiting), {
          phase: "proceeding",
          busy: true,
          deferred: false,
          backgroundWaits: 0,
          unknown: false,
        });
      }).pipe(Effect.provide(activityStack(faults)));
    },
  );
});

/**
 * A stopped single item whose author thread holds Factory's launch run and a run a pull request
 * watch's sync created, both ended, as core committed them.
 */
const seedRecords = Effect.gen(function* () {
  const deliveryId = yield* seed({
    ...base,
    status: "stopped",
    stage: "author",
    checkpoint: "verify",
    effectsIssued: 1,
  });
  const threadId = launchThreadId(deliveryId, 1);
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
  const commit = (name: string, commandType: string, event: OrchestrationV2DomainEvent) =>
    sink.commitCommand({
      commandId: CommandId.make(name),
      threadId,
      commandType,
      acceptedAt: now,
      events: [event],
      effects: [],
    });
  yield* commit("activity-thread", "thread.create", {
    id: EventId.make("activity-thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId,
      title: "Author",
      createdBy: "system",
      creationSource: "server",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "work/activity",
      worktreePath: "/worktrees/activity",
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
  const run = (id: string, messageId: string, ordinal: number) => ({
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(messageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  });
  yield* commit("activity-launch", "thread.launch", {
    id: EventId.make("activity-launch-run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: run("run-activity-launch", `factory-launch-message:${deliveryId}:1`, 1),
  });
  yield* commit(`server:pr-watch:${threadId}:activity`, WATCH_SYNC_COMMAND, {
    id: EventId.make("activity-watch-run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: run("run-activity-watch", "message:pr-watch:activity", 2),
  });
  return deliveryId;
}).pipe(Effect.orDie);

/** The status of the restart continuation core's outbox holds for the run; none if it holds none. */
const continuationOf = (runId: RunId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_effect_outbox
      WHERE effect_id = ${`effect:restart-continuation:${runId}`}
    `,
  ).pipe(
    Effect.map(([row]) => row?.status),
    Effect.orDie,
  );

/** Every row a report could write, as SQLite holds it. */
const writable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    deliveries: yield* sql`SELECT * FROM fd_factory_deliveries ORDER BY delivery_id`,
    turns: yield* sql`SELECT * FROM fd_factory_automatic_turns`,
    outbox: yield* sql`SELECT * FROM orchestration_v2_effect_outbox`,
    events: yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`,
  };
}).pipe(Effect.orDie);

describe("FactoryActivity background waits", () => {
  it.effect(
    "reports background work its provider threads hold open as a wait, the owner's not",
    () => {
      const faults = makeFaults();
      return Effect.gen(function* () {
        const deliveryId = yield* seedRecords;
        const threadId = launchThreadId(deliveryId, 1);
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const instanceId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId, model: "test-model" };
        const driver = ProviderDriverKind.make("codex");
        const commit = (name: string, events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
          sink.commitCommand({
            commandId: CommandId.make(name),
            threadId,
            commandType: name,
            acceptedAt: now,
            events,
            effects: [],
          });
        const run = (
          id: string,
          messageId: string,
          ordinal: number,
          providerThreadId: ProviderThreadId,
        ) => ({
          id: RunId.make(id),
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(messageId),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        });
        const withOpenTasks = (id: ProviderThreadId) => ({
          id: EventId.make(`open-tasks:${id}`),
          type: "provider-thread.updated" as const,
          threadId,
          occurredAt: now,
          payload: {
            id,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: ProviderSessionId.make("session-activity"),
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `native:${id}`, strength: "strong" as const },
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: 3,
            lastRunOrdinal: 3,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            pendingBackgroundTasks: [{ taskId: `build:${id}`, kind: "command" as const }],
          },
        });
        const factoryThread = ProviderThreadId.make("provider-thread-factory");
        const ownerThread = ProviderThreadId.make("provider-thread-owner");
        yield* commit("activity-repair", [
          {
            id: EventId.make("activity-repair-run"),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: run(
              "run-activity-repair",
              `factory-fix-verify-message:${deliveryId}:4`,
              3,
              factoryThread,
            ),
          },
        ]);
        yield* commit("activity-owner", [
          {
            id: EventId.make("activity-owner-message"),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make("owner-activity"),
              threadId,
              runId: RunId.make("run-activity-owner"),
              nodeId: null,
              role: "user",
              text: "Build it.",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "user",
              creationSource: "web",
            },
          },
          {
            id: EventId.make("activity-owner-run"),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: run("run-activity-owner", "owner-activity", 4, ownerThread),
          },
        ]);
        yield* commit("activity-open-tasks", [
          withOpenTasks(factoryThread),
          withOpenTasks(ownerThread),
        ]);
        // Factory's provider thread waits on its background build; the owner's is theirs.
        assert.deepStrictEqual(yield* activityOf(deliveryId), {
          phase: "parked",
          busy: false,
          deferred: false,
          backgroundWaits: 1,
          unknown: false,
        });
      }).pipe(Effect.provide(activityStack(faults)));
    },
  );
});

describe("FactoryActivity when a record cannot be read", () => {
  it.effect("reports unknown, never idle, for each failing read, and writes nothing", () => {
    const faults = makeFaults();
    return Effect.gen(function* () {
      const deliveryId = yield* seedRecords;
      const idle = {
        phase: "parked",
        busy: false,
        deferred: false,
        backgroundWaits: 0,
        unknown: false,
      };
      // Every reader works: the launch run is Factory's, the wake shows no pull request, and
      // neither ended run has a continuation still to run.
      assert.deepStrictEqual(yield* activityOf(deliveryId), idle);
      const before = yield* writable;
      for (const fault of ["outbox", "projection", "receipts", "records"] as const) {
        faults[fault] = true;
        assert.deepStrictEqual(yield* activityOf(deliveryId), { ...idle, unknown: true }, fault);
        faults[fault] = false;
      }
      assert.deepStrictEqual(yield* activityOf(deliveryId), idle);
      assert.deepStrictEqual(yield* writable, before);
    }).pipe(Effect.provide(activityStack(faults)));
  });

  it.effect("fails only when Factory's own deliveries cannot be read", () => {
    const faults = makeFaults();
    return Effect.gen(function* () {
      const deliveryId = yield* seedRecords;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      assert.isTrue(Option.isSome(yield* store.get(deliveryId)));
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TABLE fd_factory_deliveries`);
      const failure = yield* Effect.flip(
        Effect.flatMap(FactoryActivity.FactoryActivity, (service) => service.activity(deliveryId)),
      );
      assert.strictEqual(failure._tag, "FactoryStoreError");
    }).pipe(Effect.provide(activityStack(faults)));
  });
});

/**
 * A manager of every root, holding back each automatic turn but a native wake, which it runs: a
 * delegated result waits on its cohort, and a native wake's run is the work Factory records.
 */
const holdingPort = () => {
  const reached: Array<{ readonly kind: string; readonly messageId: MessageId }> = [];
  const arrivals = TxRef.makeUnsafe(0);
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed("active"),
    automaticTurn: (turn) =>
      Effect.sync(
        () => void reached.push({ kind: turn.turn.kind, messageId: turn.turn.messageId }),
      ).pipe(
        Effect.andThen(TxRef.update(arrivals, (count) => count + 1)),
        Effect.andThen(
          turn.via === "hand"
            ? Effect.map(turn.dispatch, AutomaticTurnGate.ran)
            : Effect.succeed(AutomaticTurnGate.notNow("deferred")),
        ),
      ),
  };
  /** Waits until `count` turns of `kind` have reached the manager. */
  const arrived = (kind: string, count = 1) =>
    TxRef.get(arrivals).pipe(
      Effect.flatMap(() =>
        reached.filter((turn) => turn.kind === kind).length >= count ? Effect.void : Effect.txRetry,
      ),
      Effect.tx,
    );
  return { reached, port, arrived };
};

const reportOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
    factory.activity(deliveryId),
  ).pipe(Effect.orDie);

const report = (
  phase: FactoryActivity.FactoryActivityPhase,
  fields: Partial<Omit<FactoryActivity.FactoryActivityReport, "phase">> = {},
): FactoryActivity.FactoryActivityReport => ({
  phase,
  busy: false,
  deferred: false,
  backgroundWaits: 0,
  unknown: false,
  ...fields,
});

describe("FactoryService.activity on the server's real stack", () => {
  it.live(
    "counts what Factory cannot show to be the owner's on a parked family's threads, and only that",
    () => {
      const { reached, port, arrived } = holdingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            // The author delegates a task that outlives its turn.
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            const reviewer = yield* reviewPasses(world, author.deliveryId);
            assert.strictEqual((yield* stateOf(author.deliveryId)).status, "pr_open");
            // The delegated task still works for the author's ended turn.
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { busy: true }),
            );
            // Ended, its result waits on the author's cohort for the manager: nothing runs.
            yield* world.endRun(delegate.runId, "completed");
            yield* arrived("delegated_completion");
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { backgroundWaits: 1 }),
            );

            // The owner's own turn is no work of the family's.
            const ownerRun = yield* world.ownerTurn(author.threadId, "Split the export.");
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { backgroundWaits: 1 }),
            );
            // A task its agent delegates is the family's, of unknown origin, outliving the turn.
            const ownersDelegate = yield* delegateFrom(author.threadId, ownerRun);
            yield* world.endRun(ownerRun, "completed");
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { busy: true, backgroundWaits: 1 }),
            );
            // Its result waits on the owner's cohort, which is no wait of the family's.
            yield* world.endRun(ownersDelegate.runId, "completed");
            yield* arrived("delegated_completion", 2);
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { backgroundWaits: 1 }),
            );

            // A native wake on a provider thread both used is recorded unknown, and its run counts.
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            yield* requests.offer({
              threadId: author.threadId,
              providerThreadId: yield* providerThreadOf(author.threadId, author.runId),
              driver: ProviderDriverKind.make("codex"),
              detail: null,
            });
            yield* arrived("background_wake");
            const wakeMessage =
              reached.find(({ kind }) => kind === "background_wake")?.messageId ??
              assert.fail("No native wake reached the manager.");
            const wakeRun =
              (yield* threadProjection(author.threadId).pipe(Effect.orDie)).runs.find(
                (run) => run.userMessageId === wakeMessage,
              )?.id ?? assert.fail("The native wake started no run.");
            yield* runStarted(wakeRun);
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { busy: true, backgroundWaits: 1 }),
            );
            yield* world.endRun(wakeRun, "completed");
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { backgroundWaits: 1 }),
            );

            // A family agent's message queued behind the owner's turn counts while queued, and
            // still once a restart cut that turn and held the queue.
            const ownerAgain = yield* world.ownerTurn(author.threadId, "Rename the button.");
            const queued = yield* agentSends(world.projectId, author.threadId, reviewer);
            assert.deepStrictEqual(
              yield* reportOf(author.deliveryId),
              report("parked", { busy: true, backgroundWaits: 1 }),
            );
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainFactory;
                const runs = (yield* threadProjection(author.threadId).pipe(Effect.orDie)).runs;
                const held = runs.find((run) => run.id === queued);
                assert.strictEqual(held?.status, "queued");
                assert.isTrue(held?.queueHeld === true);
                assert.isTrue(
                  runs.some((run) => run.id === ownerAgain && run.status !== "running"),
                );
                assert.deepStrictEqual(
                  yield* reportOf(author.deliveryId),
                  report("parked", { busy: true, backgroundWaits: 1 }),
                );
              }),
              { orchestration: true },
            );
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
    180_000,
  );

  it.live("counts its own pull request's wake as busy until Factory takes it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* world.boot(openSingle(world));
          // Factory is down while core's watch wakes the author thread.
          const wakeRun = yield* wakeThread(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
          );
          yield* runStarted(wakeRun);
          assert.deepStrictEqual(
            yield* reportOf(opened.deliveryId),
            report("parked", { busy: true }),
          );
          // Ended before Factory took it, the wake is still Factory's to take as a round.
          yield* endWhileDown(world, wakeRun);
          assert.deepStrictEqual(
            yield* reportOf(opened.deliveryId),
            report("parked", { busy: true }),
          );
          yield* world.boot(Effect.void);
          assert.strictEqual((yield* reportOf(opened.deliveryId)).phase, "proceeding");
        }),
      { manualReactor: true },
    ),
  );

  it.live("counts a cut run's continuation as busy while it is pending and while it runs", () => {
    const reachedContinuation = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const port: typeof FactoryAdmission.FactoryAdmission.Service = {
      ...FactoryAdmission.FactoryAdmission.defaultValue(),
      management: () => Effect.succeed("active"),
      automaticTurn: (turn) =>
        turn.turn.kind === "restart_continuation"
          ? Deferred.succeed(reachedContinuation, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(AutomaticTurnGate.notNow("declined")),
            )
          : Effect.succeed(AutomaticTurnGate.notNow("deferred")),
    };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          // Core's shutdown records restart intent for the turn its provider still works on.
          yield* providerTurnRunning(author.threadId);
          const recovery = yield* coreRecovery;
          yield* recovery.prepareForShutdown;
          yield* recovery.reconcile("shutdown");
          yield* world.rebuild(
            Effect.gen(function* () {
              // Core's recovery cut the author's run; Factory blocked on it.
              yield* drainFactory;
              assert.strictEqual(yield* continuationOf(author.runId), "pending");
              assert.deepStrictEqual(
                yield* reportOf(author.deliveryId),
                report("parked", { busy: true }),
              );
              const draining = yield* Effect.forkChild(drainOrchestration);
              yield* Deferred.await(reachedContinuation);
              assert.strictEqual(yield* continuationOf(author.runId), "running");
              assert.deepStrictEqual(
                yield* reportOf(author.deliveryId),
                report("parked", { busy: true }),
              );
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(draining);
              assert.notInclude(["pending", "running"], yield* continuationOf(author.runId));
              assert.deepStrictEqual(yield* reportOf(author.deliveryId), report("parked"));
            }),
            { orchestration: true },
          );
        }),
      { admission: port, automaticTurnGate: true },
    );
  });

  it.live("counts a cancelled delivery's job still running as busy until it ends", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        world.processes.around = (input, run) =>
          input.args.some((arg) => arg.includes("checks passed"))
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(run(input)),
              )
            : run(input);
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
        // The author's turn ends, and verify is held while it runs.
        yield* endTurnOnly(world, author.runId);
        yield* Deferred.await(started);
        const factory = yield* Factory.FactoryService.FactoryService;
        yield* factory.cancel(author.deliveryId);
        assert.deepStrictEqual(
          yield* reportOf(author.deliveryId),
          report("terminal", { busy: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* drainFactory;
        assert.deepStrictEqual(yield* reportOf(author.deliveryId), report("terminal"));
      }).pipe(Effect.orDie),
    ),
  );
});
