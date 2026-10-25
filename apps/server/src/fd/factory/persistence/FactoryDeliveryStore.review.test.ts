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
const deliveryId = FactoryDeliveryId.make("delivery-gate-1");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-gate-1/verify-1.log",
  outputHash: "output-1",
};

/**
 * A row exactly as a gate-1 server stored a delivery that stopped at its verified checkpoint:
 * the state has none of the review fields.
 */
const gate1StateJson = JSON.stringify({
  status: "stopped",
  stage: "verify",
  branch: "work/fd-aaaaaa-add-the-export-button",
  baseRef: "HEAD",
  worktreePath: "/t3/worktrees/alpha/work-fd-aaaaaa",
  baseline: "b".repeat(40),
  threads: { author },
  awaiting: null,
  fixCommitTurns: 0,
  effectsIssued: 3,
  receipts: [receipt],
  block: null,
});

const insertGate1Row = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO fd_factory_deliveries (
      delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
      created_at, updated_at
    )
    VALUES (
      ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'stopped',
      ${gate1StateJson}, '2026-10-23T10:02:00.000Z', '2026-10-23T10:02:00.000Z'
    )
  `;
});

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const summary = {
  headSha: receipt.headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 2, low: 0 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
} as const;
const reviewRun = RunId.make("run-review");
const reviewing = fold(
  queuedDeliveryState({ branch: "fd/item-a", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: RunId.make("run-author"),
    worktreePath: "/worktrees/item-a",
    baseline: "b".repeat(40),
  },
  { type: "run.finished", threadId: author, runId: RunId.make("run-author"), status: "completed" },
  { type: "settle.checked", effectId: 2, result: { status: "settled" } },
  { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
  {
    type: "thread.launched",
    effectId: 4,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath: "/worktrees/item-a",
    baseline: receipt.headSha,
  },
);
const submitted = (
  judgment: Extract<FactoryEvent, { readonly type: "review.submitted" }>["judgment"],
): FactoryEvent => ({
  type: "review.submitted",
  round: 1,
  threadId: reviewer,
  runId: reviewRun,
  judgment,
});
const reviewRunEnded: FactoryEvent = {
  type: "run.finished",
  threadId: reviewer,
  runId: reviewRun,
  status: "completed",
};
const invalid = { type: "invalid", problems: ["No fenced block."] } as const;

/** States with every review field, effect and block the stored schema has to carry. */
const reviewStates: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["awaiting the reviewer's run", reviewing],
  [
    "blocked on a review that requires changes",
    fold(
      { ...reviewing, limits: { maxFixRounds: 0, maxReviewRounds: 0 } },
      submitted({
        type: "accepted",
        review: { source: "mcp", summary, evidencePath: "/t3/review-1.json" },
      }),
      reviewRunEnded,
    ),
  ],
  [
    "awaiting the retry turn",
    fold(reviewing, reviewRunEnded, { type: "review.read", effectId: 5, judgment: invalid }),
  ],
  [
    "blocked on a failed fallback read",
    fold(reviewing, reviewRunEnded, { type: "effect.failed", effectId: 5, detail: "No." }),
  ],
  [
    "blocked on changed code",
    fold(reviewing, submitted({ type: "code_changed", changes: ["head_changed", "tree_dirty"] })),
  ],
  ["blocked on invalid submissions", fold(reviewing, submitted(invalid), submitted(invalid))],
];

describe("FactoryDeliveryStore with review state", () => {
  it.effect("loads a gate-1 row without review fields, with none recorded", () =>
    Effect.gen(function* () {
      yield* insertGate1Row;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, {
        ...JSON.parse(gate1StateJson),
        reviewRound: 0,
        invalidSubmissions: 0,
        reviews: [],
        // Nor the repair fields, added after review.
        limits: { maxFixRounds: 2, maxReviewRounds: 2 },
        risk: "normal",
        rounds: { fix: 0, review: 0 },
        fingerprints: [],
        reviewResponse: null,
        // Nor the pull request, added after record.
        pullRequest: null,
        // Nor a checkpoint, added with stop after step: stopped before it, it names none.
        checkpoint: null,
        // Nor the author launch, recorded since resume: the row predates it.
        authorLaunch: null,
        // Nor the planning fields: a gate-1 row is a single item that never planned.
        kind: "single",
        plannerLaunch: null,
        planRound: 0,
        plan: null,
      });
      assert.deepStrictEqual(
        (yield* store.listActive()).map((delivery) => delivery.deliveryId),
        [deliveryId],
      );
      // Stopped is not running: no event moves it until the owner resumes it.
      const step = advance(loaded.state, {
        type: "command.finished",
        effectId: 3,
        outcome: { type: "receipt", receipt },
      });
      assert.strictEqual(step.delivery, loaded.state);
      assert.deepStrictEqual(step.effects, []);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("writes the review fields back once a gate-1 row is updated", () =>
    Effect.gen(function* () {
      yield* insertGate1Row;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const loaded = Option.getOrThrow(yield* store.get(deliveryId));

      yield* store.update(deliveryId, { ...loaded.state, status: "blocked" });

      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly state: string }>`
        SELECT state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}
      `;
      const written = JSON.parse(row?.state ?? "{}");
      assert.strictEqual(written.reviewRound, 0);
      assert.strictEqual(written.invalidSubmissions, 0);
      assert.deepStrictEqual(written.reviews, []);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(reviewStates)("round-trips a delivery %s", ([, state]) =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
    }).pipe(Effect.provide(persistence)),
  );
});
