import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  FACTORY_WS_METHODS,
  FactoryDelivery,
  FactoryDeliveryId,
  type FactoryStageName,
  type FactoryStageOutcome,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, type WorkItemRef, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import { toolLayer } from "./mcp/handlers.ts";
import { FactoryToolkit } from "./mcp/tools.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import { wsHandlers } from "./rpc/handlers.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  runReached,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeDelivery = Schema.decodeSync(FactoryDelivery);

/** The only keys an attempt may have on the wire. */
const SUMMARY_KEYS = new Set([
  "stage",
  "attempt",
  "outcome",
  "threadId",
  "startedAt",
  "finishedAt",
]);

/** Asserts no attempt on the wire names its run, evidence or fingerprint, or any other key. */
const assertSummariesOnly = (snapshot: FactoryDelivery, hidden: ReadonlyArray<string>) => {
  const wire = encodeDelivery(snapshot);
  const { stageRuns } = wire;
  if (stageRuns === undefined) return assert.fail("The snapshot was encoded without attempts.");
  for (const attempt of stageRuns) {
    expect(Object.keys(attempt as object).filter((key) => !SUMMARY_KEYS.has(key))).toEqual([]);
  }
  const text = JSON.stringify(wire);
  for (const value of ["evidencePath", "fingerprint", "runId", ...hidden]) {
    expect(text).not.toContain(value);
  }
};

const attemptsOf = (delivery: FactoryService.FactoryDeliveryWithRuns) =>
  delivery.stageRuns.map(({ stage, attempt, outcome, threadId }) => [
    stage,
    attempt,
    outcome,
    threadId,
  ]);

const fencedReview = (review: unknown) =>
  `Reviewed.\n\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``;

describe("stage attempts of a delivery that ran", () => {
  it.live("lists author, verify and review in start order with outcomes and threads", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        const factory = yield* FactoryService.FactoryService;
        const read = factory
          .get(author.deliveryId)
          .pipe(Effect.map(Option.getOrThrow), Effect.orDie);

        // The author's attempt is active, on the author thread, while its turn runs.
        expect(attemptsOf(yield* read)).toEqual([["author", 1, null, author.threadId]]);

        yield* authorCommits(author.worktreePath, "feat: add the export button");
        assert.strictEqual(yield* world.endRun(author.runId, "completed"), "completed");

        const reviewing = yield* read;
        const { awaiting } = reviewing.state;
        if (awaiting?.type !== "run") return assert.fail("The reviewer launch recorded no run.");
        const reviewer = awaiting.threadId;
        assert.notStrictEqual(reviewer, author.threadId);
        expect(attemptsOf(reviewing)).toEqual([
          ["author", 1, "passed", author.threadId],
          ["verify", 1, "passed", null],
          ["review", 1, null, reviewer],
        ]);
        const active = toFactoryDelivery(reviewing).stageRuns.at(-1);
        expect(active).toMatchObject({ stage: "review", outcome: null, threadId: reviewer });
        expect(active).not.toHaveProperty("finishedAt");

        // The reviewer passes through its last message, so record and the PR follow.
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        const turn = world.provider.started.find(({ runId }) => runId === awaiting.runId);
        if (turn === undefined) return assert.fail("The reviewer's turn never started.");
        yield* world.provider.say(
          turn,
          fencedReview({
            verdict: "pass",
            findings: [],
            acceptance: [
              {
                criterion: 1,
                status: "verified",
                evidence: "The export module is committed.",
                paths: ["export.ts"],
              },
            ],
            missing_evidence: [],
          }),
        );
        assert.strictEqual(yield* world.endRun(awaiting.runId, "completed"), "completed");

        const delivered = yield* read;
        assert.strictEqual(delivered.state.status, "pr_open");
        expect(attemptsOf(delivered)).toEqual([
          ["author", 1, "passed", author.threadId],
          ["verify", 1, "passed", null],
          ["review", 1, "passed", reviewer],
          ["record", 1, "passed", null],
          ["pr", 1, "passed", null],
        ]);
        const startedAt = delivered.stageRuns.map((run) => run.startedAt);
        expect(startedAt).toEqual(startedAt.toSorted());

        // The stored attempts point at their evidence; the snapshot carries none of it.
        const evidence = world.evidenceDir(author.deliveryId);
        const stored = (stage: FactoryStageName) =>
          delivered.stageRuns.find((run) => run.stage === stage);
        expect(stored("verify")?.evidencePath).toContain(evidence);
        expect(stored("review")?.evidencePath).toContain(evidence);
        const snapshot = toFactoryDelivery(delivered);
        expect(snapshot.stageRuns).toEqual(
          delivered.stageRuns.map((run) => ({
            stage: run.stage,
            attempt: run.attempt,
            outcome: run.outcome,
            ...(run.threadId === null ? {} : { threadId: run.threadId }),
            startedAt: run.startedAt,
            ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
          })),
        );
        assertSummariesOnly(snapshot, [evidence, "verify-1", "review-1", "approval-item"]);
      }),
    ),
  );
});

const deliveryId = FactoryDeliveryId.make("delivery-long");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = (itemId: string): WorkItemRef => ({ sourceId, itemId: WorkItemId.make(itemId) });
const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const evidence = "/home/owner/.t3/userdata/fd-factory/delivery-long";

const firstAttemptAt = DateTime.makeUnsafe("2026-10-24T10:00:00.000Z");

/** A delivery resumed so often that it made more attempts than a snapshot carries. */
const longAttempts = (count: number): Array<FactoryStageRunStore.StoredFactoryStageRun> =>
  Array.from({ length: count }, (_, index) => {
    const stage: FactoryStageName = index % 2 === 0 ? "verify" : "review";
    const at = DateTime.formatIso(DateTime.add(firstAttemptAt, { minutes: index }));
    const last = index === count - 1;
    return {
      deliveryId,
      stage,
      attempt: Math.floor(index / 2) + 1,
      threadId: stage === "review" ? reviewer : null,
      runId: stage === "review" ? RunId.make(`run-${index}`) : null,
      outcome: last ? null : "failed",
      evidencePath: last ? null : `${evidence}/${stage}-${index}.json`,
      fingerprint: last ? null : `fingerprint-${index}`,
      startedAt: at,
      finishedAt: last ? null : at,
    };
  });

const longDelivery = (
  stageRuns: ReadonlyArray<FactoryStageRunStore.StoredFactoryStageRun>,
): FactoryService.FactoryDeliveryWithRuns => ({
  deliveryId,
  projectId: alpha,
  itemRef: itemRef("fd-aaaaaa"),
  parentId: null,
  state: {
    ...queuedDeliveryState({ branch: "work/fd-aaaaaa", baseRef: "HEAD" }),
    status: "running",
    stage: "review",
    threads: { author, reviewer },
  },
  stageRuns,
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T12:00:00.000Z",
});

describe("the stage attempt cap", () => {
  it("keeps only the newest attempts the schema allows, in start order", () => {
    const overCap = FACTORY_SNAPSHOT_STAGE_RUNS_MAX + 7;
    const runs = longAttempts(overCap);
    const snapshot = toFactoryDelivery(longDelivery(runs));

    expect(snapshot.stageRuns).toHaveLength(FACTORY_SNAPSHOT_STAGE_RUNS_MAX);
    const kept = runs.slice(-FACTORY_SNAPSHOT_STAGE_RUNS_MAX);
    expect(
      snapshot.stageRuns.map(({ stage, attempt, startedAt }) => [stage, attempt, startedAt]),
    ).toEqual(kept.map(({ stage, attempt, startedAt }) => [stage, attempt, startedAt]));
    // The newest is the active attempt; the oldest kept is the eighth attempt made.
    const newest = snapshot.stageRuns.at(-1);
    expect(newest).toMatchObject({ stage: runs.at(-1)?.stage, outcome: null });
    expect(newest).not.toHaveProperty("finishedAt");
    expect(snapshot.stageRuns[0]?.startedAt).toBe(runs[7]?.startedAt);
    assertSummariesOnly(snapshot, [evidence, "fingerprint-", "run-"]);
    expect(decodeDelivery(encodeDelivery(snapshot))).toEqual(snapshot);
  });

  it("keeps every attempt of a delivery at or under the cap", () => {
    for (const count of [0, 1, FACTORY_SNAPSHOT_STAGE_RUNS_MAX]) {
      expect(toFactoryDelivery(longDelivery(longAttempts(count))).stageRuns).toHaveLength(count);
    }
  });
});

/** The stage-run reads the service made, in order. */
const stageRunReads: Array<"listByDelivery" | "listByDeliveries"> = [];

/** The real stage-run store, recording each read the service makes of it. */
const recordedStageRuns = Layer.effect(
  FactoryStageRunStore.FactoryStageRunStore,
  Effect.gen(function* () {
    const store = yield* FactoryStageRunStore.FactoryStageRunStore;
    return FactoryStageRunStore.FactoryStageRunStore.of({
      ...store,
      listByDelivery: (id) =>
        Effect.sync(() => stageRunReads.push("listByDelivery")).pipe(
          Effect.andThen(store.listByDelivery(id)),
        ),
      listByDeliveries: (ids) =>
        Effect.sync(() => stageRunReads.push("listByDeliveries")).pipe(
          Effect.andThen(store.listByDeliveries(ids)),
        ),
    });
  }),
);

/** The real service over real stores; nothing here launches, reviews or reads Git. */
const layer = FactoryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(FactoryWorker.FactoryWorker)({}),
      FactoryChanges.layer,
      Layer.mock(FactoryReview.FactoryReview)({}),
      Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      recordedStageRuns,
    ),
  ),
  Layer.provideMerge(
    Layer.mock(WorkService.WorkService)({ canonicalRef: (ref) => Effect.succeed(ref) }),
  ),
  Layer.provideMerge(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

/** Runs every command at once, as a server past its startup does. */
const readyStartup = ServerRuntimeStartup.ServerRuntimeStartup.of({
  awaitCommandReady: Effect.void,
  markHttpListening: Effect.void,
  enqueueCommand: (effect) => effect,
});

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  thread: undefined,
  client: { sessionId: "client-session", label: "Outside client", access: "read-only" },
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

/** `factory_status` as a read-only MCP client calls it; the result an agent receives. */
const status = (params: Record<string, string>) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    const result = yield* toolkit.handle("factory_status", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
    assert.isFalse(result.isFailure, JSON.stringify(result.result));
    return result.result as {
      readonly delivery?: FactoryDelivery;
      readonly deliveries?: ReadonlyArray<FactoryDelivery>;
    };
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, readOnlyClient),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
  );

const ids = {
  old: FactoryDeliveryId.make("delivery-old"),
  mid: FactoryDeliveryId.make("delivery-mid"),
  idle: FactoryDeliveryId.make("delivery-idle"),
  newer: FactoryDeliveryId.make("delivery-newer"),
};

/**
 * Four deliveries a second apart, so they list newest first: `old` and `newer` of one item in
 * project alpha, `mid` in beta, and `idle` without attempts. Their attempts interleave, as
 * deliveries running at once append them.
 */
const seed = Effect.gen(function* () {
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
  const insert = (id: FactoryDeliveryId, projectId: ProjectId, item: string, status = "running") =>
    Effect.gen(function* () {
      yield* deliveries.insert({
        deliveryId: id,
        projectId,
        itemRef: itemRef(item),
        state: {
          ...queuedDeliveryState({ branch: `work/${item}`, baseRef: "HEAD" }),
          status: status as "running" | "cancelled",
        },
      });
      yield* TestClock.adjust("1 second");
    });
  yield* insert(ids.old, alpha, "fd-aaaaaa", "cancelled");
  yield* insert(ids.mid, beta, "fd-bbbbbb");
  yield* insert(ids.idle, alpha, "fd-cccccc");
  yield* insert(ids.newer, alpha, "fd-aaaaaa");

  const attempt = (
    id: FactoryDeliveryId,
    stage: FactoryStageName,
    threadId: ThreadId | undefined,
    outcome?: FactoryStageOutcome,
  ) =>
    Effect.gen(function* () {
      const run = yield* runs.append({
        deliveryId: id,
        stage,
        ...(threadId === undefined ? {} : { threadId, runId: RunId.make(`run-${id}-${stage}`) }),
      });
      if (outcome === undefined) return;
      yield* runs.finish({
        deliveryId: id,
        stage,
        attempt: run.attempt,
        outcome,
        evidencePath: `/t3/userdata/fd-factory/${id}/${stage}-${run.attempt}.json`,
        ...(outcome === "failed" ? { fingerprint: `fingerprint-${id}` } : {}),
      });
    });
  yield* attempt(ids.old, "author", ThreadId.make("thread-old-author"), "passed");
  yield* attempt(ids.mid, "author", ThreadId.make("thread-mid-author"), "passed");
  yield* attempt(ids.old, "verify", undefined, "failed");
  yield* attempt(ids.newer, "author", ThreadId.make("thread-newer-author"), "passed");
  yield* attempt(ids.mid, "verify", undefined, "passed");
  yield* attempt(ids.old, "repair", ThreadId.make("thread-old-author"), "cancelled");
  yield* attempt(ids.newer, "verify", undefined);
});

const expectedAttempts = {
  [ids.newer]: [
    ["author", 1, "passed", "thread-newer-author"],
    ["verify", 1, null, null],
  ],
  [ids.idle]: [],
  [ids.mid]: [
    ["author", 1, "passed", "thread-mid-author"],
    ["verify", 1, "passed", null],
  ],
  [ids.old]: [
    ["author", 1, "passed", "thread-old-author"],
    ["verify", 1, "failed", null],
    ["repair", 1, "cancelled", "thread-old-author"],
  ],
};

describe("stage attempts of listed deliveries", () => {
  it.effect("gives each delivery its own attempts from one read of the store", () =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* FactoryService.FactoryService;
      /** Runs a read and returns it with the stage-run reads it made. */
      const reading = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          stageRunReads.length = 0;
          const value = yield* effect;
          return { value, reads: [...stageRunReads] };
        });

      const all = yield* reading(factory.list({}));
      expect(all.value.map(({ deliveryId: id }) => id)).toEqual([
        ids.newer,
        ids.idle,
        ids.mid,
        ids.old,
      ]);
      for (const delivery of all.value) {
        expect(attemptsOf(delivery)).toEqual(expectedAttempts[delivery.deliveryId]);
      }
      expect(all.reads).toEqual(["listByDeliveries"]);

      // One read however many deliveries the list holds.
      const alphaOnly = yield* reading(factory.list({ projectId: alpha }));
      expect(alphaOnly.value.map(({ deliveryId: id }) => id)).toEqual([
        ids.newer,
        ids.idle,
        ids.old,
      ]);
      expect(alphaOnly.reads).toEqual(["listByDeliveries"]);
      const item = yield* reading(factory.listByItem(itemRef("fd-aaaaaa")));
      expect(item.value.deliveries.map(attemptsOf)).toEqual([
        expectedAttempts[ids.newer],
        expectedAttempts[ids.old],
      ]);
      expect(item.reads).toEqual(["listByDeliveries"]);
      const none = yield* reading(factory.list({ projectId: ProjectId.make("project-none") }));
      expect(none.value).toEqual([]);
      expect(none.reads).toEqual(["listByDeliveries"]);

      const one = yield* reading(factory.get(ids.old));
      expect(attemptsOf(Option.getOrThrow(one.value))).toEqual(expectedAttempts[ids.old]);
      expect(one.reads).toEqual(["listByDelivery"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("carries the attempts through the RPC methods and factory_status", () =>
    Effect.gen(function* () {
      yield* seed;
      const factory = yield* FactoryService.FactoryService;
      const settings = yield* FactorySettings.FactorySettings;
      const rpc = wsHandlers({ factory, settings, startup: readyStartup });
      const expected = Option.getOrThrow(yield* factory.get(ids.old));
      const snapshot = toFactoryDelivery(expected);
      expect(snapshot.stageRuns.map(({ stage, outcome }) => [stage, outcome])).toEqual([
        ["author", "passed"],
        ["verify", "failed"],
        ["repair", "cancelled"],
      ]);

      expect(yield* rpc[FACTORY_WS_METHODS.factoryDeliveriesGet]({ deliveryId: ids.old })).toEqual(
        snapshot,
      );
      const listed = yield* rpc[FACTORY_WS_METHODS.factoryDeliveriesList]({ projectId: beta });
      expect(listed.deliveries.map(({ stageRuns }) => stageRuns.map(({ stage }) => stage))).toEqual(
        [["author", "verify"]],
      );
      assertSummariesOnly(snapshot, ["fd-factory", "fingerprint-", "run-"]);

      expect((yield* status({ delivery: ids.old })).delivery?.stageRuns).toEqual(
        snapshot.stageRuns,
      );
      const byItem = yield* status({ item: `${sourceId}:fd-aaaaaa` });
      expect(byItem.deliveries?.map(({ stageRuns }) => stageRuns.length)).toEqual([2, 3]);
      expect(byItem.deliveries?.[1]?.stageRuns).toEqual(snapshot.stageRuns);
      for (const delivery of byItem.deliveries ?? []) {
        assertSummariesOnly(delivery, ["fd-factory", "fingerprint-", "run-"]);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends at most the cap of a long delivery's attempts through get", () =>
    Effect.gen(function* () {
      yield* seed;
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
      for (let index = 0; index < FACTORY_SNAPSHOT_STAGE_RUNS_MAX + 3; index++) {
        const run = yield* runs.append({ deliveryId: ids.mid, stage: "review" });
        yield* runs.finish({
          deliveryId: ids.mid,
          stage: "review",
          attempt: run.attempt,
          outcome: "failed",
          fingerprint: `fingerprint-${index}`,
        });
      }
      const factory = yield* FactoryService.FactoryService;
      const settings = yield* FactorySettings.FactorySettings;
      const rpc = wsHandlers({ factory, settings, startup: readyStartup });

      const snapshot = yield* rpc[FACTORY_WS_METHODS.factoryDeliveriesGet]({ deliveryId: ids.mid });
      expect(snapshot.stageRuns).toHaveLength(FACTORY_SNAPSHOT_STAGE_RUNS_MAX);
      // The two oldest attempts, author and verify, and the first three reviews fall off.
      expect(snapshot.stageRuns[0]).toMatchObject({ stage: "review", attempt: 4 });
      expect(snapshot.stageRuns.at(-1)).toMatchObject({
        stage: "review",
        attempt: FACTORY_SNAPSHOT_STAGE_RUNS_MAX + 3,
      });
    }).pipe(Effect.provide(layer)),
  );
});
