import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryReviewedExecution } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-reviewed");
const instanceId = ProviderInstanceId.make("codex");

const reviewed: FactoryReviewedExecution = {
  receiptId: "receipt-1",
  reviewVersion: 1,
  roles: {
    planner: { instanceId, model: "plan-model" },
    author: { instanceId, model: "author-model", options: [{ id: "effort", value: "high" }] },
    reviewer: { instanceId, model: "review-model", options: [{ id: "fastMode", value: false }] },
  },
  verifyCommand: { executable: "vp", args: ["test", "run"] },
  setupCommand: null,
  limits: { maxFixRounds: 2, maxReviewRounds: 1, maxFixCommitTurns: 1, verifyTimeoutMinutes: 45 },
  blockingSeverities: ["high", "medium"],
  highRiskEffort: "xhigh",
  pipelineId: "standard",
  repository: {
    projectId,
    workspaceRoot: "/repo/alpha",
    publication: {
      push: [],
      head: [],
      provider: "unknown",
      repository: null,
      remoteConfig: "reviewed-config",
    },
  },
  runtimeCeiling: "auto-accept-edits",
  promptOverrides: {
    plan: "absent",
    author: "a".repeat(64),
    review: "absent",
    "fix-verify": "absent",
    "fix-review": "absent",
    "fix-commit": "absent",
    integrate: "absent",
  },
};

const legacy = queuedDeliveryState({ branch: "fd/item-a", baseRef: "HEAD" });

const insertRow = (state: unknown) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO fd_factory_deliveries (
        delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
        created_at, updated_at
      )
      VALUES (
        ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'queued',
        ${JSON.stringify(state)}, '2026-10-24T10:06:00.000Z', '2026-10-24T10:06:00.000Z'
      )
    `,
  );

describe("FactoryDeliveryStore with a reviewed execution", () => {
  it.effect("round-trips what the owner reviewed, exactly, through later states", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const state = queuedDeliveryState({
        branch: "fd/item-a",
        baseRef: "HEAD",
        reviewedExecution: reviewed,
      });
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(
        Option.getOrThrow(yield* store.get(deliveryId)).state.reviewedExecution,
        reviewed,
      );

      yield* store.update(deliveryId, advance(state, { type: "start" }).delivery);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* store.get(deliveryId)).state.reviewedExecution,
        reviewed,
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("loads a row stored without one exactly as it was, and keeps it without", () =>
    Effect.gen(function* () {
      assert.notProperty(legacy, "reviewedExecution");
      yield* insertRow(legacy);
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, legacy);
      assert.notProperty(loaded.state, "reviewedExecution");

      yield* store.update(deliveryId, advance(loaded.state, { type: "start" }).delivery);
      assert.notProperty(
        Option.getOrThrow(yield* store.get(deliveryId)).state,
        "reviewedExecution",
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("keeps the receipts a fresh review replaced", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const state = queuedDeliveryState({
        branch: "fd/item-a",
        baseRef: "HEAD",
        reviewedExecution: reviewed,
      });
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      const amended = advance(state, {
        type: "reviewed.amended",
        receiptId: "receipt-2",
        reviewVersion: 2,
        allowances: { maxFixRounds: 3, maxReviewRounds: 1, maxFixCommitTurns: 1 },
      }).delivery;
      yield* store.update(deliveryId, amended);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* store.get(deliveryId)).state.supersededReceipts,
        ["receipt-1"],
      );
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("round-trips the new block reasons", () =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state: legacy });
      for (const block of [
        {
          reason: "allowance_exhausted",
          allowance: "fix_commit",
          used: 1,
          approved: 1,
          problems: ["Dirty."],
        },
        { reason: "reviewed_refused", detail: "The review no longer holds." },
      ] as const) {
        yield* store.update(deliveryId, { ...legacy, status: "blocked", block });
        assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state.block, block);
      }
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses a stored review missing a field rather than running on part of it", () =>
    Effect.gen(function* () {
      const { pipelineId: _, ...partial } = reviewed;
      yield* insertRow({ ...legacy, reviewedExecution: partial });
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const error = yield* Effect.flip(store.get(deliveryId));
      assert.strictEqual(error._tag, "FactoryStoreError");
    }).pipe(Effect.provide(persistence)),
  );
});
