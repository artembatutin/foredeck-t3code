import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, type ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryStageName } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  type FactoryDeliveryState,
  type FactoryEvent,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-parent");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
// The thread the parent's first launch effect makes, whether or not its result was recorded.
const planner = FactoryThreadEffects.launchThreadId(deliveryId, 1);
const planRun = RunId.make("run-plan");
const retryRun = RunId.make("run-plan-retry");

/** What the scripted thread effects found and were asked to do. */
interface World {
  launchState: "missing" | "deleted" | "unfinished" | "ended";
  readonly launches: Array<number>;
  readonly retries: Array<{ readonly threadId: ThreadId; readonly checkpoint?: FactoryStageName }>;
}

/**
 * The planner launch replays the thread it made; its run ended when the launch read says so.
 * Anything else is not scripted here.
 */
const scriptedThreads = (world: World) =>
  Layer.succeed(
    FactoryThreadEffects.FactoryThreadEffects,
    FactoryThreadEffects.FactoryThreadEffects.of({
      launchThread: (_delivery, effect) =>
        Effect.sync(() => world.launches.push(effect.id)).pipe(
          Effect.as({
            threadId: planner,
            runId: planRun,
            worktreePath: "/worktrees/fd-aaaaaa",
            baseline: "b".repeat(40),
          }),
        ),
      sendFixCommitTurn: () => Effect.die("fix-commit turn not scripted"),
      sendPlanRetryTurn: (_delivery, { threadId, checkpoint }) =>
        Effect.sync(() =>
          world.retries.push({ threadId, ...(checkpoint === undefined ? {} : { checkpoint }) }),
        ).pipe(Effect.as({ runId: retryRun })),
      sendReviewRetryTurn: () => Effect.die("review retry turn not scripted"),
      sendRepairTurn: () => Effect.die("repair turn not scripted"),
      sendReviewFollowUpTurn: () => Effect.die("review follow-up turn not scripted"),
      launchState: (_delivery, effect) =>
        effect.role === "planner" && effect.id === 1
          ? Effect.sync(() => world.launchState)
          : Effect.die("only the planner launch is read here"),
      threadState: () => Effect.die("no thread is recorded"),
      runEnded: (_threadId, runId) =>
        Effect.sync(() =>
          runId === planRun && world.launchState === "ended"
            ? Option.some("completed" as const)
            : Option.none(),
        ),
      interruptRun: () => Effect.die("interrupt not scripted"),
    }),
  );

/** FactoryService and the worker on in-memory SQLite, with the planner's thread effects scripted. */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(scriptedThreads(world)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
        Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(WorkService.WorkService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(
  launchState: World["launchState"],
  body: (world: World) => Effect.Effect<A, E, R>,
) => {
  const world: World = { launchState, launches: [], retries: [] };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

/** A parent blocked because the result of its planner launch was lost, as a restart leaves it. */
const lostPlannerLaunch = Effect.gen(function* () {
  const events: ReadonlyArray<FactoryEvent> = [
    { type: "start" },
    { type: "effect.failed", effectId: 1, detail: "Factory could not launch the planner thread." },
  ];
  const state = events.reduce<FactoryDeliveryState>(
    (current, event) => advance(current, event).delivery,
    queuedDeliveryState({ kind: "parent", branch: "work/fd-aaaaaa", baseRef: "HEAD" }),
  );
  assert.strictEqual(state.status, "blocked");
  assert.strictEqual(state.plannerLaunch?.id, 1);
  yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.insert({ deliveryId, projectId, itemRef, state }),
  );
});

const resume = Effect.flatMap(FactoryService.FactoryService, (service) =>
  service.resume(deliveryId),
);
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));

describe("FactoryService resume of a parent whose planner launch was lost", () => {
  it.effect("blocks again when the owner deleted the thread that launch made", () =>
    withWorld("deleted", (world) =>
      Effect.gen(function* () {
        yield* lostPlannerLaunch;

        const resumed = yield* resume;
        yield* drain;

        assert.strictEqual(resumed.state.status, "blocked");
        assert.deepStrictEqual(resumed.state.block, {
          reason: "thread_deleted",
          threadId: planner,
        });
        assert.deepStrictEqual(world.launches, []);
      }),
    ),
  );

  it.effect("replays the launch and asks for the plan again when its run had ended", () =>
    withWorld("ended", (world) =>
      Effect.gen(function* () {
        yield* lostPlannerLaunch;

        const resumed = yield* resume;
        assert.deepInclude(
          resumed.state.awaiting?.type === "effect" ? resumed.state.awaiting.effect : {},
          {
            id: 1,
            type: "launch_thread",
            role: "planner",
            resumeCheckpoint: "plan",
          },
        );
        yield* drain;

        // The same launch, replayed under its own id, never a second planner.
        assert.deepStrictEqual(world.launches, [1]);
        assert.deepStrictEqual(world.retries, [{ threadId: planner, checkpoint: "plan" }]);
        const state = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.threads.planner, planner);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: planner, runId: retryRun });
      }),
    ),
  );

  it.effect("replays the launch and awaits its run when it is still going", () =>
    withWorld("unfinished", (world) =>
      Effect.gen(function* () {
        yield* lostPlannerLaunch;

        yield* resume;
        yield* drain;

        assert.deepStrictEqual(world.launches, [1]);
        assert.deepStrictEqual(world.retries, []);
        const state = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "plan");
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: planner, runId: planRun });
      }),
    ),
  );
});
