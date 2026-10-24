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
const deliveryId = FactoryDeliveryId.make("delivery-pr");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");

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
  logPath: "/t3/userdata/fd-factory/delivery-pr/verify-1.log",
  outputHash: "output-1",
};

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/** A delivery whose passing review's run completed: record (effect 5) is under way. */
const recording = fold(
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
  { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
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
  {
    type: "review.submitted",
    round: 1,
    threadId: reviewer,
    runId: reviewRun,
    judgment: {
      type: "accepted",
      review: {
        source: "mcp",
        summary: {
          headSha: receipt.headSha,
          verdict: "pass",
          blocking: false,
          findings: { high: 0, medium: 0, low: 1 },
          reviewedAt: "2026-10-24T10:05:00.000Z",
        },
        evidencePath: "/t3/review-1.json",
      },
    },
  },
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
);
const opening = fold(recording, {
  type: "approval.recorded",
  effectId: 5,
  outcome: { type: "approved", evidencePath: "/t3/approval-item.json" },
});

/**
 * A row exactly as a server stored an approved delivery before the PR stage existed: approved
 * at record, awaiting nothing, with no pull request field.
 */
const { pullRequest: _absent, ...beforePr } = { ...recording, status: "approved", awaiting: null };
const beforePrStateJson = JSON.stringify(beforePr);

const insertBeforePrRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO fd_factory_deliveries (
      delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
      created_at, updated_at
    )
    VALUES (
      ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'approved',
      ${beforePrStateJson}, '2026-10-24T10:06:00.000Z', '2026-10-24T10:06:00.000Z'
    )
  `;
});

/** States with every PR field, effect and block the stored schema has to carry. */
const prStates: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["approved, opening its pull request", opening],
  [
    "with its pull request open",
    fold(opening, {
      type: "pr.opened",
      effectId: 6,
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/alpha/pull/42",
        headBranch: "fd/item-a",
      },
    }),
  ],
  [
    "blocked when its pull request could not be opened",
    fold(opening, {
      type: "effect.failed",
      effectId: 6,
      detail: "Factory could not open the pull request (GitManagerError).",
    }),
  ],
];

describe("FactoryDeliveryStore with PR state", () => {
  it("covers the states it names", () => {
    assert.deepStrictEqual(
      prStates.map(([, state]) => [state.status, state.stage, state.awaiting?.type ?? null]),
      [
        ["approved", "pr", "effect"],
        ["pr_open", "pr", null],
        ["blocked", "pr", null],
      ],
    );
    assert.notProperty(JSON.parse(beforePrStateJson), "pullRequest");
  });

  it.effect("loads an approved row stored before the PR stage, with no pull request", () =>
    Effect.gen(function* () {
      yield* insertBeforePrRow;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, { ...JSON.parse(beforePrStateJson), pullRequest: null });
      assert.strictEqual(loaded.state.stage, "record");
      assert.deepStrictEqual(
        (yield* store.listActive()).map((delivery) => delivery.deliveryId),
        [deliveryId],
      );
      // It awaits nothing, so no PR result or failure moves it.
      for (const event of [
        { type: "pr.opened", effectId: 6, pullRequest: { number: 1, url: "u", headBranch: "b" } },
        { type: "effect.failed", effectId: 5, detail: "No." },
      ] as const) {
        const step = advance(loaded.state, event);
        assert.strictEqual(step.delivery, loaded.state);
        assert.deepStrictEqual(step.effects, []);
      }
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(prStates)("round-trips a delivery %s", ([, state]) =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
    }).pipe(Effect.provide(persistence)),
  );
});
