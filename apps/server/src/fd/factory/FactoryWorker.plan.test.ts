import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent, FactoryPlanJudgment } from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const deliveryId = FactoryDeliveryId.make("delivery-plan");
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const retryRun = RunId.make("run-plan-retry");
const worktreePath = "/worktrees/item-7";
const planEvidence = "/t3/userdata/fd-factory/delivery-plan/plan.json";

const queued = queuedDeliveryState({ kind: "parent", branch: "feature/item-7", baseRef: "HEAD" });
const plan = {
  tasks: [
    {
      id: FactoryTaskId.make("export-button"),
      title: "Add the export button",
      kind: "feature",
      summary: "Add an export button to the report toolbar.",
      acceptance: ["The toolbar shows Export."],
      testPlan: [{ criterion: 1, check: "Toolbar renders Export.", paths: ["src/a.test.ts"] }],
      likelyPaths: ["src/toolbar.ts"],
      risk: "normal",
    },
  ],
  evidencePath: planEvidence,
} as const;
const accepted: FactoryPlanJudgment = { type: "accepted", plan: { ...plan, source: "mcp" } };
const fallbackAccepted: FactoryPlanJudgment = {
  type: "accepted",
  plan: { ...plan, source: "fallback" },
};
const submitted: FactoryEvent = {
  type: "plan.submitted",
  round: 1,
  threadId: planner,
  runId: planRun,
  judgment: accepted,
};
const completed: FactoryEvent = {
  type: "run.finished",
  threadId: planner,
  runId: planRun,
  status: "completed",
};

/** What the scripted planner effects were asked to do. */
interface PlannerCalls {
  readonly interrupted: Array<ThreadId>;
  readonly retries: Array<{
    readonly threadId: ThreadId;
    readonly problems: ReadonlyArray<string>;
  }>;
}

/** The threads the worker launches, retries and interrupts; anything else is not scripted here. */
const plannerThreads = (calls: PlannerCalls) =>
  Layer.succeed(
    FactoryThreadEffects.FactoryThreadEffects,
    FactoryThreadEffects.FactoryThreadEffects.of({
      launchThread: (_delivery, effect) =>
        effect.role === "planner"
          ? Effect.succeed({
              threadId: planner,
              runId: planRun,
              worktreePath,
              baseline: "b".repeat(40),
            })
          : Effect.die("only the planner launches here"),
      sendFixCommitTurn: () => Effect.die("fix-commit turn not scripted"),
      sendPlanRetryTurn: (_delivery, { threadId, problems }) =>
        Effect.sync(() => calls.retries.push({ threadId, problems })).pipe(
          Effect.as({ runId: retryRun }),
        ),
      // Replans are driven in FactoryPlanGate.test.ts.
      sendReplanTurn: () => Effect.die("replan turn not scripted"),
      sendReviewRetryTurn: () => Effect.die("review retry turn not scripted"),
      sendRepairTurn: () => Effect.die("repair turn not scripted"),
      sendReviewFollowUpTurn: () => Effect.die("review follow-up turn not scripted"),
      launchState: () => Effect.die("launch read not scripted"),
      threadState: () => Effect.die("thread read not scripted"),
      liveRun: () => Effect.die("live run read not scripted"),
      carriesFactoryTurn: () => Effect.die("factory turn read not scripted"),
      liveRunsOn: () => Effect.die("live runs read not scripted"),
      launchedLiveRuns: Effect.die("live runs read not scripted"),
      // Every run is still going; its end arrives as a step.
      runEnded: () => Effect.succeedNone,
      interruptRun: (_delivery, { threadId }) =>
        Effect.sync(() => calls.interrupted.push(threadId)),
    }),
  );

/** Planning judges the planner's first run's fenced plan as `fallback`. */
const fallbackPlanning = (fallback: FactoryPlanJudgment) =>
  Layer.mock(FactoryPlanning.FactoryPlanning)({
    judgeFallback: (_delivery, effect) =>
      effect.threadId === planner && effect.runId === planRun
        ? Effect.succeed(fallback)
        : Effect.die("only the planner's first run is read here"),
  });

/** The worker on in-memory SQLite with a scripted planner; no command, review or PR runs. */
const makeLayer = (calls: PlannerCalls, fallback: FactoryPlanJudgment) =>
  FactoryWorker.layer.pipe(
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(plannerThreads(calls)),
    Layer.provide(Layer.mock(FactoryReview.FactoryReview)({})),
    Layer.provide(fallbackPlanning(fallback)),
    Layer.provide(Layer.mock(FactoryRecord.FactoryRecord)({})),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPullRequest.FactoryPullRequest)({})),
    Layer.provide(Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({})),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-plan-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorker = <A, E, R>(
  body: (calls: PlannerCalls) => Effect.Effect<A, E, R>,
  fallback: FactoryPlanJudgment = fallbackAccepted,
) => {
  const calls: PlannerCalls = { interrupted: [], retries: [] };
  return body(calls).pipe(Effect.provide(makeLayer(calls, fallback)), Effect.scoped);
};

const insert = (state: FactoryDeliveryState) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
    store.insert({ deliveryId, projectId, itemRef, state }),
  );
const stateOf = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const step = (event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(deliveryId, event)).pipe(
    Effect.andThen(Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain)),
  );
/** Each attempt's stage, outcome, thread and evidence, in the order they started. */
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
).pipe(
  Effect.map((runs) =>
    runs.map(({ stage, outcome, threadId, evidencePath }) => ({
      stage,
      outcome,
      threadId,
      evidencePath,
    })),
  ),
);

const planAttempt = (
  outcome: "passed" | "blocked" | null,
  evidencePath: string | null = outcome === "passed" ? planEvidence : null,
) => ({ stage: "plan" as const, outcome, threadId: planner, evidencePath });

/** A started parent whose planner launched and runs. */
const startPlanning = Effect.gen(function* () {
  yield* insert(queued);
  yield* step({ type: "start" });
  const state = yield* stateOf;
  assert.deepStrictEqual(state.awaiting, { type: "run", threadId: planner, runId: planRun });
  assert.strictEqual(state.worktreePath, worktreePath);
});

describe("FactoryWorker planning", () => {
  it.effect("waits at the plan gate with the plan attempt passed and the gate's attempt open", () =>
    withWorker(({ interrupted }) =>
      Effect.gen(function* () {
        yield* startPlanning;
        assert.deepStrictEqual(yield* attempts, [planAttempt(null)]);

        yield* step(submitted);
        yield* step(completed);
        const state = yield* stateOf;
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.isNull(state.awaiting);
        assert.strictEqual(state.plan?.evidencePath, planEvidence);
        assert.deepStrictEqual(yield* attempts, [
          planAttempt("passed"),
          { stage: "approve_plan", outcome: null, threadId: null, evidencePath: null },
        ]);

        // Cancelled at the gate, the gate's attempt ends cancelled and the planner is stopped.
        yield* step({ type: "cancel" });
        assert.strictEqual((yield* stateOf).status, "cancelled");
        assert.deepStrictEqual((yield* attempts).at(-1)?.outcome, "cancelled");
        assert.deepStrictEqual(interrupted, [planner]);
      }),
    ),
  );

  it.effect("stops before the plan gate and opens the gate's attempt only once resumed", () =>
    withWorker(() =>
      Effect.gen(function* () {
        yield* startPlanning;
        yield* step({ type: "stop" });
        yield* step(submitted);
        yield* step(completed);
        const stopped = yield* stateOf;
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(stopped.checkpoint, "approve_plan");
        assert.deepStrictEqual(yield* attempts, [planAttempt("passed")]);

        yield* step({
          type: "resume",
          check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null },
        });
        const resumed = yield* stateOf;
        assert.strictEqual(resumed.status, "waiting");
        assert.deepStrictEqual(resumed.plan, stopped.plan);
        assert.deepStrictEqual(yield* attempts, [
          planAttempt("passed"),
          { stage: "approve_plan", outcome: null, threadId: null, evidencePath: null },
        ]);
      }),
    ),
  );

  it.effect("reads the fallback plan of a run that ended without one and waits at the gate", () =>
    withWorker(() =>
      Effect.gen(function* () {
        yield* startPlanning;
        yield* step(completed);
        const state = yield* stateOf;
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.deepStrictEqual(state.plan, { ...plan, source: "fallback", round: 1 });
        assert.deepStrictEqual(yield* attempts, [
          planAttempt("passed"),
          { stage: "approve_plan", outcome: null, threadId: null, evidencePath: null },
        ]);
      }),
    ),
  );

  it.effect("sends the plan retry turn on the planner thread and awaits its run", () =>
    withWorker(
      ({ retries }) =>
        Effect.gen(function* () {
          yield* startPlanning;
          yield* step(completed);
          assert.deepStrictEqual(retries, [{ threadId: planner, problems: ["No fenced block."] }]);
          const state = yield* stateOf;
          assert.strictEqual(state.status, "running");
          assert.strictEqual(state.invalidSubmissions, 1);
          assert.deepStrictEqual(state.awaiting, {
            type: "run",
            threadId: planner,
            runId: retryRun,
          });
          // The plan round goes on in the same attempt, now on the retry's run.
          const runs = yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (store) =>
            store.listByDelivery(deliveryId),
          );
          assert.deepStrictEqual(
            runs.map(({ stage, outcome, runId }) => ({ stage, outcome, runId })),
            [{ stage: "plan", outcome: null, runId: retryRun }],
          );
        }),
      { type: "invalid", problems: ["No fenced block."] },
    ),
  );
});
