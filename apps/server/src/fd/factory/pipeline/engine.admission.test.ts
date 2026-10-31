import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "./state.ts";

const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const wakeRun = RunId.make("run-wake");
const pullRequestUrl = "https://github.com/acme/alpha/pull/7";

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const deferred = (effectId: number): FactoryEvent => ({ type: "admission.deferred", effectId });
const granted = (effectId: number): FactoryEvent => ({ type: "admission.granted", effectId });

const queued = queuedDeliveryState({ branch: "feature/item-7", baseRef: "main" });
/** Started: awaiting its author's launch, effect 1. */
const launching = fold(queued, { type: "start" });
/** The author's launch waits for admission. */
const waiting = fold(launching, deferred(1));
/** Awaiting the author's first run. */
const authoring = fold(launching, {
  type: "thread.launched",
  effectId: 1,
  threadId: author,
  runId: authorRun,
  worktreePath: "/worktrees/item-7",
  baseline: "b".repeat(40),
});

/**
 * A follow-through round of an open pull request whose settle check (effect 9) waits for
 * admission: the pull request can merge meanwhile.
 */
const followingWaiting: FactoryDeliveryState = {
  ...authoring,
  status: "pr_open",
  stage: "follow_through",
  pullRequest: { number: 7, url: pullRequestUrl, headBranch: "feature/item-7" },
  awaiting: {
    type: "effect",
    effect: { id: 9, type: "check_settle", threadId: author, runId: wakeRun },
  },
  effectsIssued: 9,
  admissionWait: { effectId: 9 },
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

describe("admission marks in the engine", () => {
  it("marks the awaited effect once, issuing nothing", () => {
    const marked = advance(launching, deferred(1));
    assert.deepStrictEqual(marked.delivery, { ...launching, admissionWait: { effectId: 1 } });
    assert.deepStrictEqual(marked.effects, []);
    // Marked already: the very same state.
    const again = advance(waiting, deferred(1));
    assert.strictEqual(again.delivery, waiting);
    assert.deepStrictEqual(again.effects, []);
  });

  it("marks nothing for an effect the delivery does not await", () => {
    // An earlier (stale) effect and a later one.
    for (const effectId of [0, 2]) {
      assert.strictEqual(advance(launching, deferred(effectId)).delivery, launching);
      assert.strictEqual(advance(waiting, deferred(effectId)).delivery, waiting);
    }
    // Awaiting a run, or nothing at all.
    assert.strictEqual(advance(authoring, deferred(1)).delivery, authoring);
    assert.strictEqual(advance(queued, deferred(1)).delivery, queued);
  });

  it("clears only the awaited effect's mark when it is granted", () => {
    const cleared = advance(waiting, granted(1));
    assert.deepStrictEqual(cleared.delivery, launching);
    assert.notProperty(cleared.delivery, "admissionWait");
    assert.deepStrictEqual(cleared.effects, []);
    // Another effect's grant, or one with no mark to clear, changes nothing.
    assert.strictEqual(advance(waiting, granted(2)).delivery, waiting);
    assert.strictEqual(advance(waiting, granted(0)).delivery, waiting);
    assert.strictEqual(advance(launching, granted(1)).delivery, launching);
  });

  it("keeps the mark while the delivery still awaits that effect", () => {
    const stopping = advance(waiting, { type: "stop" }).delivery;
    assert.strictEqual(stopping.status, "stopping");
    assert.deepStrictEqual(stopping.admissionWait, { effectId: 1 });
    const running = advance(stopping, { type: "resume", check: null }).delivery;
    assert.deepStrictEqual(running, waiting);
    // Results and failures of another effect are stale.
    assert.strictEqual(
      advance(waiting, { type: "effect.failed", effectId: 2, detail: "Not this one." }).delivery,
      waiting,
    );
    assert.strictEqual(
      advance(waiting, { type: "settle.checked", effectId: 1, result: { status: "settled" } })
        .delivery,
      waiting,
    );
  });

  it("drops the mark when the delivery is cancelled", () => {
    const cancelled = advance(waiting, { type: "cancel" });
    assert.strictEqual(cancelled.delivery.status, "cancelled");
    assert.isNull(cancelled.delivery.awaiting);
    assert.notProperty(cancelled.delivery, "admissionWait");
  });

  it("drops the mark when the delivery issues another effect", () => {
    // The pull request merged while the round's settle check waited: the close-out is issued.
    const merged = advance(followingWaiting, {
      type: "pr.merged",
      number: 7,
      url: pullRequestUrl,
    });
    assert.deepStrictEqual(merged.effects, [{ id: 10, type: "close_out" }]);
    assert.deepStrictEqual(merged.delivery.awaiting, {
      type: "effect",
      effect: { id: 10, type: "close_out" },
    });
    assert.notProperty(merged.delivery, "admissionWait");
    // Closed instead, it ends cancelled without the mark.
    const closed = advance(followingWaiting, {
      type: "pr.closed",
      number: 7,
      url: pullRequestUrl,
    }).delivery;
    assert.strictEqual(closed.status, "cancelled");
    assert.notProperty(closed, "admissionWait");
  });

  it("drops the mark when the delivery stops awaiting the effect any other way", () => {
    // A refusal blocks it.
    const refused = advance(waiting, {
      type: "effect.failed",
      effectId: 1,
      detail: "Factory did not launch the author thread.",
    }).delivery;
    assert.strictEqual(refused.status, "blocked");
    assert.notProperty(refused, "admissionWait");
    // A result of the marked effect itself leaves it awaiting the run.
    const answered = advance(waiting, {
      type: "thread.launched",
      effectId: 1,
      threadId: author,
      runId: authorRun,
      worktreePath: "/worktrees/item-7",
      baseline: "b".repeat(40),
    }).delivery;
    assert.deepStrictEqual(answered, authoring);
  });

  it.each([
    ["a deferral", launching, deferred(1)],
    ["a grant", waiting, granted(1)],
    ["a cancel", waiting, { type: "cancel" }],
    ["a merge", followingWaiting, { type: "pr.merged", number: 7, url: pullRequestUrl }],
  ] as const)("never mutates its input: %s", (_, state, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(state));
    const first = advance(input, deepFreeze(structuredClone(event)));
    assert.deepStrictEqual(advance(structuredClone(state), structuredClone(event)), first);
    assert.deepStrictEqual(input, state);
  });
});

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemId = WorkItemId.make("fd-aaaaaa");
const deliveryId = FactoryDeliveryId.make("delivery-admission");

const storedJson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly state: string }>`
    SELECT state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}
  `;
  return JSON.parse(row?.state ?? "null") as Record<string, unknown>;
});

describe("FactoryDeliveryStore with admission marks", () => {
  it.effect("loads a row stored without a mark unchanged, and round-trips one", () =>
    Effect.gen(function* () {
      // A row as a server stored it before admission existed: its state has no such key.
      const beforeAdmission = JSON.stringify(launching);
      assert.notInclude(beforeAdmission, "admissionWait");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO fd_factory_deliveries (
          delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
          created_at, updated_at
        )
        VALUES (
          ${deliveryId}, ${projectId}, ${sourceId}, ${itemId}, NULL, 'running',
          ${beforeAdmission}, '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z'
        )
      `;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const loaded = Option.getOrThrow(yield* store.get(deliveryId)).state;
      assert.deepStrictEqual(loaded, launching);
      assert.notProperty(loaded, "admissionWait");

      // The mark is stored and read back, and its grant stores the state without the key again.
      yield* store.update(deliveryId, advance(loaded, deferred(1)).delivery);
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, waiting);
      assert.deepStrictEqual((yield* storedJson).admissionWait, { effectId: 1 });
      yield* store.update(deliveryId, advance(waiting, granted(1)).delivery);
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, launching);
      assert.notProperty(yield* storedJson, "admissionWait");
    }).pipe(Effect.provide(persistence)),
  );
});
