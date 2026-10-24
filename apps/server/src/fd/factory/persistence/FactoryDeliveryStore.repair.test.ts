import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const deliveryId = FactoryDeliveryId.make("delivery-repair");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const fixRun = RunId.make("run-fix");

const receipt = (code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-repair/verify-1.log",
  outputHash: "output-1",
});

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const verifying = fold(
  queuedDeliveryState({
    branch: "fd/item-a",
    baseRef: "main",
    limits: { maxFixRounds: 3, maxReviewRounds: 1 },
    risk: "high",
  }),
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
);
const failed = (effectId: number): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: { type: "receipt", receipt: receipt(1), fingerprint: "fp-1" },
});
const awaitingFixVerify = fold(verifying, failed(3));
const repairing = fold(awaitingFixVerify, { type: "turn.started", effectId: 4, runId: fixRun });
const reviewing = fold(
  verifying,
  { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt: receipt(0) } },
  {
    type: "thread.launched",
    effectId: 4,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath: "/worktrees/item-a",
    baseline: "a".repeat(40),
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
          headSha: "a".repeat(40),
          verdict: "changes-required",
          blocking: true,
          findings: { high: 1, medium: 0, low: 0 },
          reviewedAt: "2026-10-24T10:05:00.000Z",
        },
        evidencePath: "/t3/review-1.json",
        fingerprint: "rv-1",
      },
    },
  },
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
);
const awaitingFollowUp = fold(
  reviewing,
  { type: "turn.started", effectId: 5, runId: fixRun },
  { type: "run.finished", threadId: author, runId: fixRun, status: "completed" },
  { type: "settle.checked", effectId: 6, result: { status: "settled" } },
  { type: "command.finished", effectId: 7, outcome: { type: "receipt", receipt: receipt(0) } },
);

/** States with every repair field, effect and block the stored schema has to carry. */
const repairStates: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["awaiting the fix-verify turn", awaitingFixVerify],
  ["awaiting the repair run", repairing],
  ["awaiting the fix-review turn", reviewing],
  ["awaiting the review follow-up turn", awaitingFollowUp],
  [
    "blocked on a repeated failure",
    fold(
      repairing,
      { type: "run.finished", threadId: author, runId: fixRun, status: "completed" },
      { type: "settle.checked", effectId: 5, result: { status: "settled" } },
      failed(6),
    ),
  ],
];

describe("FactoryDeliveryStore with repair state", () => {
  it("covers the states it names", () => {
    assert.deepStrictEqual(
      repairStates.map(([, state]) =>
        state.awaiting?.type === "effect" ? state.awaiting.effect.type : state.block?.reason,
      ),
      [
        "send_repair_turn",
        undefined,
        "send_repair_turn",
        "send_review_follow_up_turn",
        "repeated_failure",
      ],
    );
    assert.deepStrictEqual(awaitingFollowUp.reviewResponse, { threadId: author, runId: fixRun });
  });

  it.effect.each(repairStates)("round-trips a delivery %s", ([, state]) =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
    }).pipe(Effect.provide(persistence)),
  );
});
