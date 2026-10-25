import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryPlanTask,
  FactoryProjectSettings,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";
import * as FactorySettingsStore from "./FactorySettingsStore.ts";
import * as FactoryStageRunStore from "./FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./FactoryTaskStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemA = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const itemB = { sourceId, itemId: WorkItemId.make("fd-bbbbbb") };
const delivery1 = FactoryDeliveryId.make("delivery-1");
const delivery2 = FactoryDeliveryId.make("delivery-2");
const delivery3 = FactoryDeliveryId.make("delivery-3");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const firstRun = RunId.make("run-1");
const fixRun = RunId.make("run-2");

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const settingsA = decodeSettings({
  verifyCommand: { executable: "vp", args: ["test", "run"] },
  roles: { reviewer: { instanceId: "codex", model: "gpt-6-astra" } },
});
const settingsB = decodeSettings({
  verifyCommand: { executable: "make", args: ["check"] },
  setupCommand: { executable: "vp", args: ["i"] },
  limits: { maxReviewRounds: 4 },
  blockingSeverities: ["high", "medium"],
});

const decodePlanTask = Schema.decodeUnknownSync(FactoryPlanTask);
const planTask = (id: string) =>
  decodePlanTask({
    id,
    title: `Task ${id}`,
    kind: "feature",
    summary: "Add the thing.",
    acceptance: ["The thing works."],
    testPlan: [{ criterion: 1, check: "Run the thing.", paths: ["src/thing.test.ts"] }],
    likelyPaths: ["src/thing.ts"],
    risk: "normal",
  });

/** Feeds events in order and returns the last state. */
const fold = (state: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const queued = queuedDeliveryState({ branch: "fd/item-a", baseRef: "main" });
const launched: FactoryEvent = {
  type: "thread.launched",
  effectId: 1,
  threadId: author,
  runId: firstRun,
  worktreePath: "/worktrees/item-a",
  baseline: "b".repeat(40),
};
const receipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:01:00.000Z",
  code: 1,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};
/** Awaiting the launch effect (with its workspace). */
const awaitingLaunch = fold(queued, { type: "start" });
/** Blocked on a failed verify after a fix-commit turn: threads, receipts and a block. */
const verifyFailed = fold(
  awaitingLaunch,
  launched,
  { type: "run.finished", threadId: author, runId: firstRun, status: "completed" },
  { type: "settle.checked", effectId: 2, result: { status: "repairable", problems: ["Dirty."] } },
  { type: "turn.started", effectId: 3, runId: fixRun },
  { type: "run.finished", threadId: author, runId: fixRun, status: "completed" },
  { type: "settle.checked", effectId: 4, result: { status: "settled" } },
  { type: "command.finished", effectId: 5, outcome: { type: "receipt", receipt } },
);
/** Blocked with the failed effect recorded in the block. */
const effectFailed = fold(awaitingLaunch, {
  type: "effect.failed",
  effectId: 1,
  detail: "The worktree could not be created.",
});
const done: FactoryDeliveryState = { ...verifyFailed, status: "done", block: null };

describe("FactorySettingsStore", () => {
  it.effect("returns none until set, then round-trips and replaces per project", () =>
    Effect.gen(function* () {
      const store = yield* FactorySettingsStore.FactorySettingsStore;
      assert.deepStrictEqual(yield* store.get(alpha), Option.none());

      yield* store.set(alpha, settingsA);
      assert.deepStrictEqual(yield* store.get(alpha), Option.some(settingsA));
      assert.deepStrictEqual(yield* store.get(beta), Option.none());

      yield* store.set(alpha, settingsB);
      yield* store.set(beta, settingsA);
      assert.deepStrictEqual(yield* store.get(alpha), Option.some(settingsB));
      assert.deepStrictEqual(yield* store.get(beta), Option.some(settingsA));
    }).pipe(Effect.provide(persistence)),
  );
});

describe("FactoryDeliveryStore", () => {
  it.effect("round-trips the engine state and updates it in place", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const created = yield* store.insert({
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        state: awaitingLaunch,
      });
      assert.deepStrictEqual(created, {
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        parentId: null,
        state: awaitingLaunch,
        createdAt: created.createdAt,
        updatedAt: created.createdAt,
      });
      assert.deepStrictEqual(yield* store.get(delivery1), Option.some(created));

      yield* TestClock.adjust(Duration.seconds(5));
      for (const state of [verifyFailed, effectFailed]) {
        const updated = Option.getOrThrow(yield* store.update(delivery1, state));
        assert.deepStrictEqual(updated, { ...created, state, updatedAt: updated.updatedAt });
        assert.isTrue(updated.updatedAt > created.createdAt);
        assert.deepStrictEqual(yield* store.get(delivery1), Option.some(updated));
      }

      const child = yield* store.insert({
        deliveryId: delivery2,
        projectId: alpha,
        itemRef: itemB,
        parentId: delivery1,
        state: queued,
      });
      assert.strictEqual(child.parentId, delivery1);
      assert.deepStrictEqual(yield* store.get(delivery2), Option.some(child));

      assert.deepStrictEqual(yield* store.update(delivery3, verifyFailed), Option.none());
      assert.deepStrictEqual(yield* store.get(delivery3), Option.none());
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("lists only deliveries that are not done or cancelled, oldest first", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const first = yield* store.insert({
        deliveryId: delivery2,
        projectId: alpha,
        itemRef: itemA,
        state: verifyFailed,
      });
      yield* TestClock.adjust(Duration.seconds(1));
      const second = yield* store.insert({
        deliveryId: delivery1,
        projectId: beta,
        itemRef: itemB,
        state: queued,
      });
      assert.deepStrictEqual(yield* store.listActive(), [first, second]);

      const cancelled = Option.getOrThrow(
        yield* store.update(delivery2, { ...verifyFailed, status: "cancelled" }),
      );
      assert.deepStrictEqual(yield* store.listActive(), [second]);
      assert.deepStrictEqual(yield* store.get(delivery2), Option.some(cancelled));
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("allows one active delivery per Work item, and a new one once it is terminal", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        state: queued,
      });

      const refused = yield* store
        .insert({ deliveryId: delivery2, projectId: alpha, itemRef: itemA, state: queued })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "FactoryDeliveryActive");
      if (refused._tag !== "FactoryDeliveryActive") return;
      assert.strictEqual(refused.deliveryId, delivery1);
      assert.deepStrictEqual(refused.itemRef, itemA);
      assert.strictEqual(
        refused.message,
        "Work item fd-aaaaaa already has an active Factory delivery (delivery-1).",
      );
      assert.deepStrictEqual(yield* store.get(delivery2), Option.none());

      // A stopped or blocked delivery is still active; only done and cancelled free the item.
      yield* store.update(delivery1, effectFailed);
      const stillRefused = yield* store
        .insert({ deliveryId: delivery2, projectId: alpha, itemRef: itemA, state: queued })
        .pipe(Effect.flip);
      assert.strictEqual(stillRefused._tag, "FactoryDeliveryActive");

      yield* store.update(delivery1, done);
      const next = yield* store.insert({
        deliveryId: delivery2,
        projectId: alpha,
        itemRef: itemA,
        state: queued,
      });
      assert.deepStrictEqual(yield* store.listActive(), [next]);

      // The database refuses a second active row even when the store's check is bypassed.
      const sql = yield* SqlClient.SqlClient;
      const bypass = yield* sql`UPDATE fd_factory_deliveries SET status = 'running'`.pipe(
        Effect.flip,
      );
      assert.strictEqual(bypass._tag, "SqlError");
    }).pipe(Effect.provide(persistence)),
  );
});

describe("FactoryStageRunStore", () => {
  const seedDeliveries = Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* deliveries.insert({
      deliveryId: delivery1,
      projectId: alpha,
      itemRef: itemA,
      state: queued,
    });
    yield* deliveries.insert({
      deliveryId: delivery2,
      projectId: alpha,
      itemRef: itemB,
      state: queued,
    });
  });

  it.effect("appends numbered attempts and finds the active one by thread", () =>
    Effect.gen(function* () {
      yield* seedDeliveries;
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;

      const author1 = yield* runs.append({
        deliveryId: delivery1,
        stage: "author",
        threadId: author,
        runId: firstRun,
      });
      assert.deepStrictEqual(author1, {
        deliveryId: delivery1,
        stage: "author",
        attempt: 1,
        threadId: author,
        runId: firstRun,
        outcome: null,
        evidencePath: null,
        fingerprint: null,
        startedAt: author1.startedAt,
        finishedAt: null,
      });
      assert.deepStrictEqual(yield* runs.findActiveByThread(author), Option.some(author1));
      assert.deepStrictEqual(yield* runs.findActiveByThread(reviewer), Option.none());

      yield* TestClock.adjust(Duration.seconds(1));
      const finished1 = Option.getOrThrow(
        yield* runs.finish({
          deliveryId: delivery1,
          stage: "author",
          attempt: 1,
          outcome: "failed",
          fingerprint: "fingerprint-1",
        }),
      );
      assert.strictEqual(finished1.outcome, "failed");
      assert.strictEqual(finished1.fingerprint, "fingerprint-1");
      assert.isNotNull(finished1.finishedAt);
      assert.deepStrictEqual(yield* runs.findActiveByThread(author), Option.none());
      // An attempt finishes once.
      assert.deepStrictEqual(
        yield* runs.finish({
          deliveryId: delivery1,
          stage: "author",
          attempt: 1,
          outcome: "passed",
        }),
        Option.none(),
      );

      const author2 = yield* runs.append({
        deliveryId: delivery1,
        stage: "author",
        threadId: author,
        runId: fixRun,
      });
      assert.strictEqual(author2.attempt, 2);
      assert.deepStrictEqual(yield* runs.findActiveByThread(author), Option.some(author2));
      const finished2 = Option.getOrThrow(
        yield* runs.finish({
          deliveryId: delivery1,
          stage: "author",
          attempt: 2,
          outcome: "passed",
        }),
      );

      // Another delivery's attempts count on their own.
      const otherAuthor = yield* runs.append({ deliveryId: delivery2, stage: "author" });
      assert.strictEqual(otherAuthor.attempt, 1);

      const verify1 = yield* runs.append({ deliveryId: delivery1, stage: "verify" });
      assert.strictEqual(verify1.attempt, 1);
      assert.isNull(verify1.threadId);
      const evidence = "/t3/userdata/fd-factory/delivery-1/verify-1.json";
      const verified1 = Option.getOrThrow(
        yield* runs.finish({
          deliveryId: delivery1,
          stage: "verify",
          attempt: 1,
          outcome: "blocked",
          evidencePath: evidence,
          fingerprint: "fingerprint-2",
        }),
      );
      assert.strictEqual(verified1.evidencePath, evidence);
      const verify2 = yield* runs.append({ deliveryId: delivery1, stage: "verify" });
      assert.strictEqual(verify2.attempt, 2);

      assert.deepStrictEqual(yield* runs.listByDelivery(delivery1), [
        finished1,
        finished2,
        verified1,
        verify2,
      ]);
      assert.deepStrictEqual(yield* runs.listByDelivery(delivery2), [otherAuthor]);
      assert.deepStrictEqual(yield* runs.listByDelivery(delivery3), []);
      assert.deepStrictEqual(
        yield* runs.finish({
          deliveryId: delivery3,
          stage: "verify",
          attempt: 1,
          outcome: "passed",
        }),
        Option.none(),
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("records the thread and run of an active attempt only", () =>
    Effect.gen(function* () {
      yield* seedDeliveries;
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
      const started = yield* runs.append({ deliveryId: delivery1, stage: "author" });
      const attempt = { deliveryId: delivery1, stage: "author", attempt: 1 } as const;

      const assigned = yield* runs.assignRun({ ...attempt, threadId: author, runId: firstRun });
      assert.deepStrictEqual(
        assigned,
        Option.some({ ...started, threadId: author, runId: firstRun }),
      );
      assert.deepStrictEqual(yield* runs.findActiveByThread(author), assigned);
      const reassigned = yield* runs.assignRun({ ...attempt, threadId: author, runId: fixRun });
      assert.strictEqual(Option.getOrThrow(reassigned).runId, fixRun);

      const finished = Option.getOrThrow(yield* runs.finish({ ...attempt, outcome: "passed" }));
      assert.deepStrictEqual(
        yield* runs.assignRun({ ...attempt, threadId: reviewer, runId: firstRun }),
        Option.none(),
      );
      assert.deepStrictEqual(yield* runs.listByDelivery(delivery1), [finished]);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses a second active attempt on one thread", () =>
    Effect.gen(function* () {
      yield* seedDeliveries;
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
      const active = yield* runs.append({
        deliveryId: delivery1,
        stage: "author",
        threadId: author,
      });

      const error = yield* runs
        .append({ deliveryId: delivery2, stage: "author", threadId: author })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "FactoryStoreError");
      assert.strictEqual(error.operation, "stageRuns.append");
      assert.deepStrictEqual(yield* runs.findActiveByThread(author), Option.some(active));
      assert.deepStrictEqual(yield* runs.listByDelivery(delivery2), []);
    }).pipe(Effect.provide(persistence)),
  );
});

describe("FactoryTaskStore", () => {
  it.effect("inserts tasks in order, lists them per delivery and records the reviewed commit", () =>
    Effect.gen(function* () {
      const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* deliveries.insert({
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        state: queued,
      });
      yield* deliveries.insert({
        deliveryId: delivery2,
        projectId: alpha,
        itemRef: itemB,
        state: queued,
      });
      const tasks = yield* FactoryTaskStore.FactoryTaskStore;

      const single = yield* tasks.insert({
        deliveryId: delivery1,
        taskId: FactoryTaskId.make("fd-aaaaaa"),
      });
      assert.deepStrictEqual(single, {
        deliveryId: delivery1,
        taskId: FactoryTaskId.make("fd-aaaaaa"),
        position: 1,
        plan: null,
        lastReviewedSha: null,
        childItemId: null,
        childClaimedAt: null,
        createdAt: single.createdAt,
        updatedAt: single.createdAt,
      });

      const planA = planTask("task-a");
      const planB = planTask("task-b");
      const taskA = yield* tasks.insert({ deliveryId: delivery2, taskId: planA.id, plan: planA });
      const taskB = yield* tasks.insert({ deliveryId: delivery2, taskId: planB.id, plan: planB });
      assert.deepStrictEqual([taskA.position, taskB.position], [1, 2]);
      assert.deepStrictEqual(yield* tasks.listByDelivery(delivery2), [taskA, taskB]);
      assert.deepStrictEqual(yield* tasks.listByDelivery(delivery1), [single]);

      yield* TestClock.adjust(Duration.seconds(1));
      const sha = "d".repeat(40);
      const reviewed = Option.getOrThrow(
        yield* tasks.setLastReviewedSha({ deliveryId: delivery2, taskId: planB.id, sha }),
      );
      assert.strictEqual(reviewed.lastReviewedSha, sha);
      assert.isTrue(reviewed.updatedAt > taskB.updatedAt);
      assert.deepStrictEqual(yield* tasks.listByDelivery(delivery2), [taskA, reviewed]);
      assert.deepStrictEqual(
        yield* tasks.setLastReviewedSha({
          deliveryId: delivery1,
          taskId: FactoryTaskId.make("missing"),
          sha,
        }),
        Option.none(),
      );
    }).pipe(Effect.provide(persistence)),
  );
});

describe("Factory store errors", () => {
  it.effect("wrap constraint failures with the operation and a fixed message", () =>
    Effect.gen(function* () {
      const tasks = yield* FactoryTaskStore.FactoryTaskStore;
      const orphan = yield* tasks
        .insert({ deliveryId: delivery3, taskId: FactoryTaskId.make("orphan-task") })
        .pipe(Effect.flip);
      assert.strictEqual(orphan._tag, "FactoryStoreError");
      assert.strictEqual(orphan.operation, "tasks.insert");
      assert.strictEqual(orphan.message, "Factory storage operation 'tasks.insert' failed.");
      assert.isTrue(SqlError.isSqlError(orphan.cause));
      assert.deepStrictEqual(yield* tasks.listByDelivery(delivery3), []);

      const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* deliveries.insert({
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        state: queued,
      });
      const duplicate = yield* deliveries
        .insert({ deliveryId: delivery1, projectId: beta, itemRef: itemB, state: queued })
        .pipe(Effect.flip);
      assert.strictEqual(duplicate._tag, "FactoryStoreError");
      if (duplicate._tag !== "FactoryStoreError") return;
      assert.strictEqual(duplicate.operation, "deliveries.insert");
      assert.strictEqual(
        duplicate.message,
        "Factory storage operation 'deliveries.insert' failed.",
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("wrap rows that no longer decode without echoing their contents", () =>
    Effect.gen(function* () {
      const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* deliveries.insert({
        deliveryId: delivery1,
        projectId: alpha,
        itemRef: itemA,
        state: queued,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fd_factory_deliveries SET state_json = '{"status":"secret-payload"}'`;

      const error = yield* deliveries.get(delivery1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "FactoryStoreError");
      assert.strictEqual(error.operation, "deliveries.get");
      assert.strictEqual(error.message, "Factory storage operation 'deliveries.get' failed.");
      assert.isTrue(Schema.isSchemaError(error.cause));
    }).pipe(Effect.provide(persistence)),
  );
});
