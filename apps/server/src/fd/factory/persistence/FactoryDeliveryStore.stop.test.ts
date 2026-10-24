import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-stop");
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-stop/verify-1.log",
  outputHash: "output-1",
};

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/** A delivery awaiting its author's first run. */
const authoring = fold(
  queuedDeliveryState({ branch: "fd/item-a", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath: "/worktrees/item-a",
    baseline: "b".repeat(40),
  },
);
const stopping = fold(authoring, { type: "stop" });
const settling = fold(stopping, {
  type: "run.finished",
  threadId: author,
  runId: authorRun,
  status: "completed",
});

/** A row exactly as a server stored a running delivery before stop after step existed. */
const { checkpoint: _absent, ...beforeStop } = authoring;
const beforeStopStateJson = JSON.stringify(beforeStop);

const insertBeforeStopRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO fd_factory_deliveries (
      delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
      created_at, updated_at
    )
    VALUES (
      ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'running',
      ${beforeStopStateJson}, '2026-10-24T10:06:00.000Z', '2026-10-24T10:06:00.000Z'
    )
  `;
});

/** States with every stop and cancel field the stored schema has to carry. */
const stopStates: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["stopping, awaiting its author's run", stopping],
  ["stopping, awaiting its settle check", settling],
  [
    "stopped at its verify checkpoint",
    fold(settling, { type: "settle.checked", effectId: 2, result: { status: "settled" } }),
  ],
  [
    "stopped at its review checkpoint with its receipt",
    fold(
      authoring,
      { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
      { type: "settle.checked", effectId: 2, result: { status: "settled" } },
      { type: "stop" },
      { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
    ),
  ],
  ["cancelled while stopping", fold(stopping, { type: "cancel" })],
];

describe("FactoryDeliveryStore with stop and cancel state", () => {
  it("covers the states it names", () => {
    assert.deepStrictEqual(
      stopStates.map(([, state]) => [state.status, state.checkpoint, state.awaiting?.type ?? null]),
      [
        ["stopping", null, "run"],
        ["stopping", null, "effect"],
        ["stopped", "verify", null],
        ["stopped", "review", null],
        ["cancelled", null, null],
      ],
    );
    assert.notProperty(JSON.parse(beforeStopStateJson), "checkpoint");
  });

  it.effect("loads a row stored before stop after step with no checkpoint, and stops it", () =>
    Effect.gen(function* () {
      yield* insertBeforeStopRow;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, {
        ...JSON.parse(beforeStopStateJson),
        checkpoint: null,
      });
      assert.deepStrictEqual(loaded.state, authoring);

      // It can stop like any running delivery, and the stop is stored with the new field.
      const step = advance(loaded.state, { type: "stop" });
      assert.strictEqual(step.delivery.status, "stopping");
      yield* store.update(deliveryId, step.delivery);
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, stopping);
      const [row] = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{
            readonly status: string;
            readonly state: string;
          }>`SELECT status, state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      );
      assert.strictEqual(row?.status, "stopping");
      assert.propertyVal(JSON.parse(row?.state ?? "{}"), "checkpoint", null);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(stopStates)("round-trips a delivery %s", ([, state]) =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(["verify", "review", "repair", "record", "pr"] as const)(
    "round-trips a delivery stopped at %s",
    (checkpoint) =>
      Effect.gen(function* () {
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        const state: FactoryDeliveryState = {
          ...authoring,
          status: "stopped",
          awaiting: null,
          receipts: [receipt],
          checkpoint,
        };
        yield* store.insert({ deliveryId, projectId, itemRef, state });
        assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
      }).pipe(Effect.provide(persistence)),
  );
});
