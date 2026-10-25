import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent, FactoryPlanJudgment } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-plan");
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const retryRun = RunId.make("run-plan-retry");

const task: FactoryPlanTask = {
  id: FactoryTaskId.make("export-button"),
  title: "Add the export button",
  kind: "feature",
  summary: "Add an export button to the report toolbar.",
  acceptance: ["The toolbar shows Export.", "Export downloads a CSV."],
  testPlan: [
    { criterion: 1, check: "Toolbar renders Export.", paths: ["src/toolbar.test.ts"] },
    { criterion: 2, check: "Export writes the CSV.", paths: ["src/export.test.ts"] },
  ],
  likelyPaths: ["src/toolbar.ts", "src/export.ts"],
  risk: "high",
};
const accepted = (tasks: ReadonlyArray<FactoryPlanTask>, note?: string): FactoryPlanJudgment => ({
  type: "accepted",
  plan: {
    tasks,
    ...(note === undefined ? {} : { note }),
    source: "fallback",
    evidencePath: "/t3/userdata/fd-factory/delivery-plan/plan-1.json",
  },
});

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

const queued = queuedDeliveryState({ kind: "parent", branch: "fd/item-a", baseRef: "HEAD" });
const planning = fold(
  queued,
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath: "/worktrees/item-a",
    baseline: "b".repeat(40),
  },
);
const finished = (runId: RunId): FactoryEvent => ({
  type: "run.finished",
  threadId: planner,
  runId,
  status: "completed",
});
const awaitingFallback = fold(planning, finished(planRun));
const awaitingRetryTurn = fold(awaitingFallback, {
  type: "plan.read",
  effectId: 2,
  judgment: { type: "invalid", problems: ["No fenced block."] },
});
const waiting = fold(awaitingFallback, {
  type: "plan.read",
  effectId: 2,
  judgment: accepted([task]),
});
const empty = fold(awaitingFallback, {
  type: "plan.read",
  effectId: 2,
  judgment: accepted([], "Already shipped.\n  See #12."),
});
const blockedAtLaunch = fold(
  queued,
  { type: "start" },
  { type: "effect.failed", effectId: 1, detail: "No." },
);
const resumeRetry = fold(
  fold(planning, { type: "run.finished", threadId: planner, runId: planRun, status: "failed" }),
  {
    type: "resume",
    check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null },
  },
);

/** Inserts the queued parent, updates it to `state`, and reads it back. */
const throughStore = (state: FactoryDeliveryState) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const inserted = yield* store.insert({ deliveryId, projectId, itemRef, state: queued });
    assert.deepStrictEqual(inserted.state, queued);
    assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, queued);
    const updated = Option.getOrThrow(yield* store.update(deliveryId, state));
    assert.deepStrictEqual(updated.state, state);
    return Option.getOrThrow(yield* store.get(deliveryId)).state;
  }).pipe(Effect.provide(persistence));

describe("FactoryDeliveryStore with planning", () => {
  it("holds the fixtures it stores", () => {
    assert.deepStrictEqual(
      [awaitingFallback, awaitingRetryTurn, waiting, empty, blockedAtLaunch, resumeRetry].map(
        ({ status, stage, awaiting, block }) => [
          status,
          stage,
          awaiting?.type === "effect" ? awaiting.effect.type : (awaiting?.type ?? null),
          block?.reason ?? null,
        ],
      ),
      [
        ["running", "plan", "read_fallback_plan", null],
        ["running", "plan", "send_plan_retry_turn", null],
        ["waiting", "approve_plan", null, null],
        ["blocked", "plan", null, "plan_empty"],
        ["blocked", "plan", null, "effect_failed"],
        ["running", "plan", "send_plan_retry_turn", null],
      ],
    );
  });

  it.effect.each([
    ["awaiting the fallback plan read", awaitingFallback],
    ["awaiting the plan retry turn", awaitingRetryTurn],
    ["waiting at the gate with the plan recorded", waiting],
    ["blocked on an empty plan with its note", empty],
    ["blocked on the planner launch, which it keeps", blockedAtLaunch],
    ["awaiting a resume's retry turn naming its checkpoint", resumeRetry],
  ] as const)("round-trips a parent %s", ([, state]) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* throughStore(state), state);
    }),
  );

  it.effect("round-trips the planner's retry run, awaited after the turn started", () =>
    Effect.gen(function* () {
      const retrying = fold(awaitingRetryTurn, {
        type: "turn.started",
        effectId: 3,
        runId: retryRun,
      });
      assert.deepStrictEqual(retrying.awaiting, {
        type: "run",
        threadId: planner,
        runId: retryRun,
      });
      assert.deepStrictEqual(yield* throughStore(retrying), retrying);
    }),
  );

  it.effect("loads a row stored before planning as a single item that never planned", () =>
    Effect.gen(function* () {
      const single = fold(queuedDeliveryState({ branch: "fd/item-a", baseRef: "HEAD" }), {
        type: "start",
      });
      const {
        kind: _kind,
        plannerLaunch: _launch,
        planRound: _round,
        plan: _plan,
        ...before
      } = single;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state: single });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fd_factory_deliveries SET state_json = ${JSON.stringify(before)}`;
      const loaded = Option.getOrThrow(yield* store.get(deliveryId)).state;
      assert.deepStrictEqual(loaded, {
        ...before,
        kind: "single",
        plannerLaunch: null,
        planRound: 0,
        plan: null,
      });
      assert.deepStrictEqual(loaded, single);
    }).pipe(Effect.provide(persistence)),
  );
});
