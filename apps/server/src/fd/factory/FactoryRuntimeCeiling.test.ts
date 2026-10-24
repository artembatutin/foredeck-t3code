import { assert, describe, it } from "@effect/vitest";
import type {
  ProjectSettingsOverrides,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  instanceId,
  runReached,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

interface Modes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Replaces the project's overrides of the environment settings. */
const overrideProject = (world: World, overrides: ProjectSettingsOverrides) =>
  Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
    settings.updateSettings({ projectSettingsOverrides: { [world.projectId]: overrides } }),
  ).pipe(Effect.orDie);

const setProjectDefault = (world: World, defaultRuntimeMode: RuntimeMode) =>
  overrideProject(world, { defaultRuntimeMode });

/** The modes the thread's recorded shell names. */
const shellModes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orDie);
    if (shell === null) return assert.fail(`Thread ${threadId} has no shell.`);
    return { runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode };
  });

/** The modes the provider was asked to run the run's turn in. */
const turnModes = (world: World, runId: RunId): Modes => {
  const turn = world.provider.started.find((candidate) => candidate.runId === runId);
  if (turn === undefined) return assert.fail(`No provider turn started run ${runId}.`);
  const { runtimeMode, interactionMode } = turn.runtimePolicy;
  return { runtimeMode, interactionMode };
};

/** The reviewer the delivery launched once verify passed, with its first turn running. */
const runningReviewer = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const state = yield* stateOf(deliveryId);
    assert.strictEqual(state.stage, "review");
    const { awaiting } = state;
    if (awaiting?.type !== "run") return assert.fail("The reviewer launch recorded no run.");
    assert.strictEqual(state.threads.reviewer, awaiting.threadId);
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);

const authored = (runtimeMode: RuntimeMode): Modes => ({ runtimeMode, interactionMode: "default" });
const reviewing = (runtimeMode: RuntimeMode): Modes => ({ runtimeMode, interactionMode: "plan" });

/**
 * A delivery whose author launch went through while the server lost its result: started, its
 * launch recorded, then stored back as it was before the result and failed as the next boot's
 * sweep fails an effect it finds awaited. The author's run is starting.
 */
const lostLaunch = (world: World, runtimeModeCeiling: RuntimeMode) =>
  Effect.gen(function* () {
    const factory = yield* Factory.FactoryService.FactoryService;
    const worker = yield* Factory.FactoryWorker.FactoryWorker;
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const queued = yield* factory.start({ itemRef: world.itemRef, runtimeModeCeiling });
    const { deliveryId } = queued;
    yield* drainFactory;
    const { awaiting, worktreePath } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run" || worktreePath === null) {
      return assert.fail("The author launch recorded no run and worktree.");
    }
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;

    yield* store.update(deliveryId, queued.state);
    yield* worker.step(deliveryId, {
      type: "effect.failed",
      effectId: 1,
      detail: "Factory could not launch the author thread: a server restart interrupted it.",
    });
    const lost = yield* stateOf(deliveryId);
    assert.strictEqual(lost.status, "blocked");
    assert.deepStrictEqual(lost.threads, {});
    return { deliveryId, author: awaiting, worktreePath };
  }).pipe(Effect.orDie);

describe("A delivery's runtime mode ceiling", () => {
  it.live.each([
    {
      name: "an approval-required ceiling under a full-access default",
      ceiling: "approval-required",
      projectDefault: "full-access",
      launched: "approval-required",
    },
    {
      name: "a full-access ceiling over an auto-accept-edits default",
      ceiling: "full-access",
      projectDefault: "auto-accept-edits",
      launched: "auto-accept-edits",
    },
    {
      name: "no ceiling under an auto default",
      ceiling: undefined,
      projectDefault: "auto",
      launched: "auto",
    },
    {
      name: "no ceiling under a full-access default",
      ceiling: undefined,
      projectDefault: "full-access",
      launched: "full-access",
    },
  ] as const)(
    "launches the author and reviewer with $name in $launched mode",
    ({ ceiling, projectDefault, launched }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, projectDefault);
          const author = yield* world.startWith(
            ceiling === undefined ? {} : { runtimeModeCeiling: ceiling },
          );

          const started = yield* stateOf(author.deliveryId);
          if (ceiling === undefined) assert.notProperty(started, "runtimeModeCeiling");
          else assert.strictEqual(started.runtimeModeCeiling, ceiling);
          // Neither broader than the ceiling nor than the project's default, and in the author's
          // own interaction mode.
          assert.deepStrictEqual(yield* shellModes(author.threadId), authored(launched));
          assert.deepStrictEqual(turnModes(world, author.runId), authored(launched));

          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");

          // The reviewer is held to the same mode and still works in plan mode.
          const reviewer = yield* runningReviewer(world, author.deliveryId);
          assert.notStrictEqual(reviewer.threadId, author.threadId);
          assert.deepStrictEqual(yield* shellModes(reviewer.threadId), reviewing(launched));
          assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing(launched));
        }),
      ),
  );

  it.live("keeps a reviewer under the ceiling after the project's default is raised", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        yield* setProjectDefault(world, "approval-required");
        const author = yield* world.startWith({ runtimeModeCeiling: "auto-accept-edits" });
        // The default was the narrower at the author's launch.
        assert.deepStrictEqual(yield* shellModes(author.threadId), authored("approval-required"));

        yield* setProjectDefault(world, "full-access");
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");

        // A later launch takes the default as it is now, but never past the ceiling.
        const reviewer = yield* runningReviewer(world, author.deliveryId);
        assert.deepStrictEqual(
          yield* shellModes(reviewer.threadId),
          reviewing("auto-accept-edits"),
        );
        assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing("auto-accept-edits"));
      }),
    ),
  );

  it.live("resumes a lost author launch, then reviews, never above the ceiling", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        yield* setProjectDefault(world, "approval-required");
        const { deliveryId, author, worktreePath } = yield* lostLaunch(world, "auto-accept-edits");
        yield* authorCommits(worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");

        yield* setProjectDefault(world, "full-access");
        yield* factory.resume(deliveryId);
        yield* drainFactory;

        // The replayed launch found the thread it made, as it was made: no broader author.
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.threads.author, author.threadId);
        assert.strictEqual(state.runtimeModeCeiling, "auto-accept-edits");
        assert.deepStrictEqual(yield* shellModes(author.threadId), authored("approval-required"));
        const reviewer = yield* runningReviewer(world, deliveryId);
        assert.deepStrictEqual(
          yield* shellModes(reviewer.threadId),
          reviewing("auto-accept-edits"),
        );
        assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing("auto-accept-edits"));
      }),
    ),
  );

  it.live(
    "launches a failed author launch again on resume at the ceiling, not the new default",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          // The launch fails before it creates a thread: the project turned its provider off.
          yield* overrideProject(world, {
            defaultRuntimeMode: "approval-required",
            providerInstances: { [instanceId]: { enabled: false } },
          });
          const started = yield* factory.start({
            itemRef: world.itemRef,
            runtimeModeCeiling: "auto-accept-edits",
          });
          yield* drainFactory;
          const failed = yield* stateOf(started.deliveryId);
          assert.strictEqual(failed.status, "blocked");
          assert.strictEqual(failed.block?.reason, "effect_failed");
          assert.deepStrictEqual(failed.threads, {});
          assert.deepStrictEqual(world.provider.started, []);

          yield* overrideProject(world, {
            defaultRuntimeMode: "full-access",
            providerInstances: { [instanceId]: { enabled: true } },
          });
          yield* factory.resume(started.deliveryId);
          yield* drainFactory;

          // The same launch, issued again, creates the author now: within the ceiling.
          const state = yield* stateOf(started.deliveryId);
          const { awaiting } = state;
          if (awaiting?.type !== "run") return assert.fail("The author launch recorded no run.");
          assert.strictEqual(
            awaiting.threadId,
            FactoryThreadEffects.launchThreadId(started.deliveryId, 1),
          );
          assert.strictEqual(state.threads.author, awaiting.threadId);
          assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          assert.deepStrictEqual(
            yield* shellModes(awaiting.threadId),
            authored("auto-accept-edits"),
          );
          assert.deepStrictEqual(turnModes(world, awaiting.runId), authored("auto-accept-edits"));
        }),
      ).pipe(Effect.orDie),
  );
});
