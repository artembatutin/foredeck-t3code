import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
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
  type HostPolicy,
  instanceId,
  runReached,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { awaitedRun, passingReview } from "./testkit/followThrough.ts";
import { offeredModels, reviewNow, setSettings } from "./testkit/reviewed.ts";

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

/** The `effect.failed` detail of a launch refused for its provider's runtime modes. */
const refusedLaunch = (role: "author" | "reviewer") =>
  `Factory could not launch the ${role} thread (FactoryRuntimeModeUnavailableError).`;

// The server runs a mode a provider does not advertise as one it does, which can be broader.
describe("A delivery's runtime mode ceiling under the server's runtime policy", () => {
  it.live("leaves an uncapped launch to the runtime policy, as before", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "approval-required");
          const author = yield* world.start;

          // The thread asks for the default; the provider runs the only mode it offers.
          assert.deepStrictEqual(yield* shellModes(author.threadId), authored("approval-required"));
          assert.deepStrictEqual(turnModes(world, author.runId), authored("full-access"));
        }),
      { supportedRuntimeModes: ["full-access"] },
    ),
  );

  it.live("refuses a capped author on a full-access-only provider, also on resume", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const started = yield* factory.start({
            itemRef: world.itemRef,
            runtimeModeCeiling: "approval-required",
          });
          yield* drainFactory;
          const refused = yield* stateOf(started.deliveryId);
          const launch = refused.authorLaunch;
          if (launch === null) return assert.fail("The start recorded no author launch.");
          // The resume issues the same launch again, and it is refused again.
          const resumed = yield* factory.resume(started.deliveryId);
          assert.deepStrictEqual(resumed.state.awaiting, { type: "effect", effect: launch });
          yield* drainFactory;
          yield* drainOrchestration;

          for (const state of [refused, yield* stateOf(started.deliveryId)]) {
            assert.strictEqual(state.status, "blocked");
            assert.strictEqual(state.stage, "author");
            assert.deepInclude(state.block, {
              reason: "effect_failed",
              detail: refusedLaunch("author"),
            });
            assert.deepStrictEqual(state.threads, {});
          }
          // Nothing was launched, the first time or the resume's replay: no thread, no turn.
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const launched = FactoryThreadEffects.launchThreadId(started.deliveryId, 1);
          assert.isNull(yield* orchestrator.getThreadShell(launched));
          assert.deepStrictEqual(world.provider.started, []);
        }),
      { supportedRuntimeModes: ["full-access"] },
    ).pipe(Effect.orDie),
  );

  it.live("refuses a reviewer the narrowed default leaves no mode for, until it widens", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          yield* setProjectDefault(world, "auto");
          const author = yield* world.startWith({ runtimeModeCeiling: "auto" });
          assert.deepStrictEqual(turnModes(world, author.runId), authored("auto"));

          // The owner narrows the default: the provider would run the reviewer in auto.
          yield* setProjectDefault(world, "approval-required");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const refused = yield* stateOf(author.deliveryId);
          assert.strictEqual(refused.status, "blocked");
          assert.strictEqual(refused.stage, "review");
          assert.deepInclude(refused.block, {
            reason: "effect_failed",
            detail: refusedLaunch("reviewer"),
          });
          assert.deepStrictEqual(refused.threads, { author: author.threadId });
          assert.deepStrictEqual(
            world.provider.started.map(({ runId }) => runId),
            [author.runId],
          );

          // Widened again, the resume verifies afresh and the reviewer launches within it.
          yield* setProjectDefault(world, "auto");
          yield* factory.resume(author.deliveryId);
          yield* drainFactory;
          const reviewer = yield* runningReviewer(world, author.deliveryId);
          assert.deepStrictEqual(yield* shellModes(reviewer.threadId), reviewing("auto"));
          assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing("auto"));
        }),
      { supportedRuntimeModes: ["auto", "full-access"] },
    ).pipe(Effect.orDie),
  );

  it.live("steps a capped launch down to the broadest mode its provider offers within", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.startWith({ runtimeModeCeiling: "auto" });
          assert.deepStrictEqual(yield* shellModes(author.threadId), authored("auto-accept-edits"));
          assert.deepStrictEqual(turnModes(world, author.runId), authored("auto-accept-edits"));

          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const reviewer = yield* runningReviewer(world, author.deliveryId);
          assert.deepStrictEqual(
            yield* shellModes(reviewer.threadId),
            reviewing("auto-accept-edits"),
          );
          assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing("auto-accept-edits"));
        }),
      // Listed first, full access is what the server would run an unoffered auto as.
      { supportedRuntimeModes: ["full-access", "auto-accept-edits"] },
    ),
  );
});

// A review's ceiling is what its owner saw: never a step down to a mode nobody reviewed.
describe("A reviewed delivery's runtime ceiling", () => {
  const startReviewed = (
    world: World,
    runtimeCeiling: RuntimeMode,
    verifyCommand = verifyCommands.passes,
  ) =>
    Effect.gen(function* () {
      yield* setSettings(world, { verifyCommand });
      const reviewed = yield* reviewNow(world, { runtimeCeiling });
      const { deliveryId } = yield* Effect.flatMap(
        Factory.FactoryService.FactoryService,
        (factory) => factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
      );
      return { deliveryId, reviewed };
    }).pipe(Effect.orDie);

  const assertRefused = (deliveryId: FactoryDeliveryId, text: string) =>
    Effect.gen(function* () {
      yield* drainFactory;
      const state = yield* stateOf(deliveryId);
      assert.strictEqual(state.status, "blocked");
      assert.strictEqual(state.block?.reason, "effect_failed");
      if (state.block?.reason === "effect_failed") assert.include(state.block.detail, text);
      return state;
    });

  it.live("narrows to the project's default and the provider's modes when reviewed", () => {
    const modes: Array<RuntimeMode> = ["approval-required", "auto-accept-edits", "full-access"];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "auto");
          yield* setSettings(world, { verifyCommand: verifyCommands.passes });
          // Its default is auto, which this provider runs as full access: the review says lower.
          const reviewed = yield* reviewNow(world, { runtimeCeiling: "full-access" });
          assert.strictEqual(reviewed.runtimeCeiling, "auto-accept-edits");
        }).pipe(Effect.orDie),
      { providers: offeredModels(), supportedRuntimeModes: modes },
    );
  });

  it.live("launches at the ceiling after the default is raised, and never above it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "auto-accept-edits");
          const { deliveryId, reviewed } = yield* startReviewed(world, "full-access");
          assert.strictEqual(reviewed.runtimeCeiling, "auto-accept-edits");
          assert.strictEqual((yield* stateOf(deliveryId)).runtimeModeCeiling, "auto-accept-edits");
          yield* setProjectDefault(world, "full-access");
          const author = yield* world.launched(deliveryId);
          assert.deepStrictEqual(turnModes(world, author.runId), authored("auto-accept-edits"));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const reviewer = yield* runningReviewer(world, deliveryId);
          assert.deepStrictEqual(turnModes(world, reviewer.runId), reviewing("auto-accept-edits"));
        }),
      { providers: offeredModels() },
    ),
  );

  it.live("launches nothing once its provider stops offering the reviewed mode", () => {
    const modes: Array<RuntimeMode> = ["auto-accept-edits", "full-access"];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setSettings(world, { verifyCommand: verifyCommands.passes });
          const reviewed = yield* reviewNow(world, { runtimeCeiling: "auto-accept-edits" });
          modes.splice(0, 1);
          const { deliveryId } = yield* Effect.flatMap(
            Factory.FactoryService.FactoryService,
            (factory) => factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
          );
          const state = yield* assertRefused(deliveryId, "no longer offers auto-accept-edits");
          assert.deepStrictEqual(state.threads, {});
          assert.deepStrictEqual(world.provider.started, []);
          // The review still names it; only what it reviewed runs, and nothing else was tried.
          assert.strictEqual(state.reviewedExecution?.runtimeCeiling, "auto-accept-edits");
        }).pipe(Effect.orDie),
      { providers: offeredModels(), supportedRuntimeModes: modes },
    );
  });

  it.live("launches no reviewer once its provider stops offering the mode between stages", () => {
    const modes: Array<RuntimeMode> = ["auto-accept-edits", "full-access"];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* startReviewed(world, "auto-accept-edits");
          const author = yield* world.launched(deliveryId);
          modes.splice(0, 1);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const state = yield* assertRefused(deliveryId, "no longer offers auto-accept-edits");
          // Not a verify first: the next effect is what the narrowing stops.
          assert.deepStrictEqual(state.receipts, []);
          assert.isUndefined(state.threads.reviewer);
          assert.lengthOf(world.provider.started, 1);
        }).pipe(Effect.orDie),
      { providers: offeredModels(), supportedRuntimeModes: modes },
    );
  });

  it.live("runs no verify once its provider stops offering the mode across a restart", () => {
    const modes: Array<RuntimeMode> = ["auto-accept-edits", "full-access"];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* startReviewed(world, "auto-accept-edits");
          const author = yield* world.launched(deliveryId);
          yield* Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
            factory.stop(deliveryId),
          );
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(deliveryId)).status, "stopped");

          yield* world.rebuild(
            Effect.gen(function* () {
              modes.splice(0, 1);
              yield* Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
                factory.resume(deliveryId),
              );
              const state = yield* assertRefused(deliveryId, "no longer offers auto-accept-edits");
              assert.deepStrictEqual(state.receipts, []);
              assert.lengthOf(world.provider.started, 1);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      { providers: offeredModels(), supportedRuntimeModes: modes },
    );
  });

  it.live("publishes nothing once its provider stops offering the mode during the review", () => {
    const modes: Array<RuntimeMode> = ["auto-accept-edits", "full-access"];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId } = yield* startReviewed(world, "auto-accept-edits");
          const author = yield* world.launched(deliveryId);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(deliveryId);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          modes.splice(0, 1);
          yield* world.endRun(review.runId, "completed");
          const state = yield* assertRefused(deliveryId, "no longer offers auto-accept-edits");
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.pullRequestCalls, []);
        }).pipe(Effect.orDie),
      { providers: offeredModels(), supportedRuntimeModes: modes },
    );
  });

  it.live("sends no turn on a thread its owner raised above the ceiling", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* startReviewed(
            world,
            "auto-accept-edits",
            verifyCommands.fails,
          );
          const author = yield* world.launched(deliveryId);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("owner-raises-mode"),
            threadId: author.threadId,
            runtimeMode: "full-access",
          });
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* assertRefused(deliveryId, "runs broader than auto-accept-edits");
          assert.lengthOf(world.provider.started, 1);
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("keeps running what it reviewed when a turn's thread narrowed below the ceiling", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* startReviewed(world, "full-access", verifyCommands.fails);
          const author = yield* world.launched(deliveryId);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("owner-narrows-mode"),
            threadId: author.threadId,
            runtimeMode: "approval-required",
          });
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const fix = yield* awaitedRun(deliveryId);
          assert.deepStrictEqual(turnModes(world, fix.runId), authored("approval-required"));
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );
});

/**
 * A host policy refusing Supervised, as Codex reports one allowing only `never` and `on-request`.
 * Only what such a read named is refused, so nothing here can be a provider's silent fallback.
 */
const refusesSupervised = (): HostPolicy => ({
  restrictions: [
    {
      runtimeMode: "approval-required",
      status: "disallowed",
      detail: "It allows only these approval policies: never, on-request.",
    },
    { runtimeMode: "auto-accept-edits", status: "allowed" },
    { runtimeMode: "auto", status: "allowed" },
    { runtimeMode: "full-access", status: "allowed" },
  ],
});

const onePlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "One task.",
};

/** The thread's recorded shell, which a refusal must leave as it was. */
const threadShell = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orDie);
    if (shell === null) return assert.fail(`Thread ${threadId} has no shell.`);
    return shell;
  });

describe("A mode the provider's host refuses", () => {
  const blockedOf = (deliveryId: FactoryDeliveryId) =>
    Effect.gen(function* () {
      yield* drainFactory;
      yield* drainOrchestration;
      const state = yield* stateOf(deliveryId);
      assert.strictEqual(state.status, "blocked");
      const { block } = state;
      if (block?.reason !== "effect_failed") return assert.fail("The launch was not refused.");
      return { state, block };
    });

  it.live(
    "says so before anything runs, and launches only in the mode the owner then chooses",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "approval-required");
            const factory = yield* Factory.FactoryService.FactoryService;
            const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
            const { state, block } = yield* blockedOf(deliveryId);

            assert.include(block.detail, "host policy refuses Supervised");
            assert.include(block.detail, "Choose Auto-accept edits, Auto or Full access instead.");
            assert.include(block.detail, "Nothing ran and no mode changed.");
            assert.include(
              block.detail,
              "Change the project's default permission mode, then resume.",
            );
            // A delivery's reason is cut to 280 characters, which must not cost the owner this.
            assert.isAtMost(block.detail.length, 280);
            assert.include(block.hostRefused?.detail, "never, on-request");
            assert.deepStrictEqual(block.hostRefused?.alternatives, [
              "auto-accept-edits",
              "auto",
              "full-access",
            ]);
            // Nothing was launched, and nothing chose for the owner.
            assert.deepStrictEqual(state.threads, {});
            assert.deepStrictEqual(world.provider.started, []);
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            assert.isNull(
              yield* orchestrator.getThreadShell(
                FactoryThreadEffects.launchThreadId(deliveryId, 1),
              ),
            );
            const settings = yield* Effect.flatMap(
              ServerSettings.ServerSettingsService,
              (service) => service.getSettings.pipe(Effect.orDie),
            );
            assert.strictEqual(
              settings.projectSettingsOverrides[world.projectId]?.defaultRuntimeMode,
              "approval-required",
            );

            // The list every surface reads says the same, with what each mode would mean.
            const listed = yield* factory.listForClients({ projectId: world.projectId });
            assert.deepStrictEqual(listed[0]?.pendingActions, {
              items: [
                {
                  kind: "host_policy",
                  runClass: null,
                  threadId: null,
                  projectId: world.projectId,
                  requestId: null,
                  capability: "live",
                  item: world.itemRef,
                  runtimeMode: "approval-required",
                  refused: {
                    provider: block.hostRefused?.provider ?? "",
                    driver: block.hostRefused?.driver ?? "",
                    detail: "It allows only these approval policies: never, on-request.",
                    choose: "resume",
                    alternatives: ["auto-accept-edits", "auto", "full-access"],
                  },
                },
              ],
              omitted: 0,
              complete: true,
            });

            // Resuming without a choice refuses again, and starts nothing.
            yield* factory.resume(deliveryId);
            yield* blockedOf(deliveryId);
            assert.deepStrictEqual(world.provider.started, []);

            // The owner chooses, and only that mode runs.
            yield* setProjectDefault(world, "auto-accept-edits");
            yield* factory.resume(deliveryId);
            yield* drainFactory;
            yield* drainOrchestration;
            const resumed = yield* stateOf(deliveryId);
            const { awaiting } = resumed;
            if (awaiting?.type !== "run") return assert.fail("The launch did not run.");
            yield* runReached(awaiting.runId, ["running"]);
            assert.strictEqual(turnModes(world, awaiting.runId).runtimeMode, "auto-accept-edits");
            assert.isUndefined(
              (yield* factory.listForClients({ projectId: world.projectId }))[0]?.pendingActions,
            );
          }).pipe(Effect.orDie),
        { hostPolicy: refusesSupervised() },
      ),
  );

  it.live("offers nothing past a delivery's ceiling, which a project default could not raise", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "approval-required");
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId } = yield* factory.start({
            itemRef: world.itemRef,
            runtimeModeCeiling: "approval-required",
          });
          const { block } = yield* blockedOf(deliveryId);
          assert.deepStrictEqual(block.hostRefused?.alternatives, []);
          assert.include(block.detail, "nothing can run here until that policy changes");
          assert.deepStrictEqual(world.provider.started, []);
        }).pipe(Effect.orDie),
      { hostPolicy: refusesSupervised() },
    ),
  );

  it.live("launches as ever while the policy is unknown, as after a failed read", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "approval-required");
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
          yield* drainFactory;
          yield* drainOrchestration;
          const { awaiting } = yield* stateOf(deliveryId);
          if (awaiting?.type !== "run") return assert.fail("The launch did not run.");
          yield* runReached(awaiting.runId, ["running"]);
          assert.strictEqual(turnModes(world, awaiting.runId).runtimeMode, "approval-required");
        }).pipe(Effect.orDie),
      {
        hostPolicy: {
          restrictions: [{ runtimeMode: "approval-required", status: "unknown" }],
        },
      },
    ),
  );

  it.live("refuses a review that could never launch, before anything is started", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setProjectDefault(world, "approval-required");
          yield* setSettings(world, { verifyCommand: verifyCommands.passes });
          const factory = yield* Factory.FactoryService.FactoryService;
          const preview = yield* factory.previewReviewedExecution({
            projectId: world.projectId,
            runtimeCeiling: "full-access",
          });
          assert.isNull(preview.execution);
          assert.include(preview.refusal, "host policy refuses Supervised");
          assert.include(preview.refusal, "then review again");
          assert.deepStrictEqual(world.provider.started, []);
        }).pipe(Effect.orDie),
      { providers: offeredModels(), hostPolicy: refusesSupervised() },
    ),
  );

  describe("on a thread that already exists", () => {
    const setThreadMode = (threadId: ThreadId, runtimeMode: RuntimeMode, label: string) =>
      Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(label),
          threadId,
          runtimeMode,
        }),
      );

    it.live(
      "sends no repair turn in a mode its owner changed to, and keeps mode and provider",
      () =>
        withProject(
          verifyCommands.fails,
          (world) =>
            Effect.gen(function* () {
              yield* setProjectDefault(world, "auto-accept-edits");
              const factory = yield* Factory.FactoryService.FactoryService;
              const author = yield* world.start;
              const before = yield* threadShell(author.threadId);
              yield* setThreadMode(author.threadId, "approval-required", "owner-supervises");
              yield* authorCommits(author.worktreePath, "feat: add the export button");
              yield* world.endRun(author.runId, "completed");
              const { block } = yield* blockedOf(author.deliveryId);

              assert.include(block.detail, "host policy refuses Supervised");
              assert.include(block.detail, "Change this thread's permission mode, then resume.");
              assert.strictEqual(block.hostRefused?.threadId, author.threadId);
              assert.strictEqual(block.hostRefused?.choose, "thread");
              assert.lengthOf(world.provider.started, 1);
              // Refused rather than stepped: what the thread runs on is as its owner left it.
              const after = yield* threadShell(author.threadId);
              assert.strictEqual(after.runtimeMode, "approval-required");
              assert.deepStrictEqual(after.modelSelection, before.modelSelection);
              // It is decided on that thread.
              const listed = yield* factory.listForClients({ projectId: world.projectId });
              assert.deepInclude(listed[0]?.pendingActions?.items[0], {
                kind: "host_policy",
                threadId: author.threadId,
                runtimeMode: "approval-required",
              });

              // The owner chooses, and the repair turn runs in that mode.
              yield* setThreadMode(author.threadId, "auto-accept-edits", "owner-chooses");
              yield* factory.resume(author.deliveryId);
              yield* drainFactory;
              yield* drainOrchestration;
              assert.strictEqual((yield* stateOf(author.deliveryId)).status, "running");
              assert.lengthOf(world.provider.started, 2);
              assert.strictEqual(
                world.provider.started[1]?.runtimePolicy.runtimeMode,
                "auto-accept-edits",
              );
            }).pipe(Effect.orDie),
          { hostPolicy: refusesSupervised() },
        ),
    );

    it.live("charges a reviewed delivery nothing for a repair turn its host refused", () =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "auto-accept-edits");
            yield* setSettings(world, { verifyCommand: verifyCommands.fails });
            const reviewed = yield* reviewNow(world, { runtimeCeiling: "auto-accept-edits" });
            const factory = yield* Factory.FactoryService.FactoryService;
            const { deliveryId } = yield* factory.start({
              itemRef: world.itemRef,
              reviewedExecution: reviewed,
            });
            const author = yield* world.launched(deliveryId);
            // Narrower than reviewed, so the review allows it; only the host refuses it.
            yield* setThreadMode(author.threadId, "approval-required", "owner-narrows");
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            const { block, state } = yield* blockedOf(deliveryId);

            assert.include(block.detail, "host policy refuses Supervised");
            assert.include(block.detail, "Review it again to choose another.");
            assert.strictEqual(block.hostRefused?.choose, "review");
            assert.strictEqual(state.rounds.fix, 0);
            assert.lengthOf(world.provider.started, 1);
          }).pipe(Effect.orDie),
        { providers: offeredModels(), hostPolicy: refusesSupervised() },
      ),
    );

    it.live("sends no fix-commit turn in a mode its host has refused since the launch", () => {
      const hostPolicy: HostPolicy = { restrictions: [] };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "approval-required");
            const author = yield* world.start;
            hostPolicy.restrictions = refusesSupervised().restrictions;
            // No commit, so the settle check asks for a fix-commit turn.
            yield* world.endRun(author.runId, "completed");
            const { block } = yield* blockedOf(author.deliveryId);
            assert.include(block.detail, "host policy refuses Supervised");
            assert.strictEqual(block.effect.type, "send_fix_commit_turn");
            assert.lengthOf(world.provider.started, 1);
            assert.strictEqual(
              (yield* threadShell(author.threadId)).runtimeMode,
              "approval-required",
            );
          }).pipe(Effect.orDie),
        { hostPolicy },
      );
    });

    it.live("sends no replan turn in a mode its host has refused since the plan", () => {
      const hostPolicy: HostPolicy = { restrictions: [] };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "approval-required");
            const factory = yield* Factory.FactoryService.FactoryService;
            const planner = yield* world.startWith({ kind: "parent" });
            yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
            yield* world.endRun(planner.runId, "completed");
            hostPolicy.restrictions = refusesSupervised().restrictions;
            yield* factory.replan({ deliveryId: planner.deliveryId, note: "Split the export." });
            const { block } = yield* blockedOf(planner.deliveryId);
            assert.strictEqual(block.effect.type, "send_replan_turn");
            assert.strictEqual(block.hostRefused?.threadId, planner.threadId);
            assert.lengthOf(world.provider.started, 1);
          }).pipe(Effect.orDie),
        { hostPolicy },
      );
    });

    it.live("refuses a reviewed delivery's automatic turn or delegation the same way", () => {
      const hostPolicy: HostPolicy = { restrictions: [] };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* Factory.FactoryService.FactoryService;
            yield* setSettings(world, { verifyCommand: verifyCommands.passes });
            const reviewed = yield* reviewNow(world, { runtimeCeiling: "auto-accept-edits" });
            const { deliveryId } = yield* factory.start({
              itemRef: world.itemRef,
              reviewedExecution: reviewed,
            });
            const author = yield* world.launched(deliveryId);
            assert.isUndefined(yield* factory.reviewedRefusal(author.threadId));
            hostPolicy.restrictions = [
              { runtimeMode: "auto-accept-edits", status: "disallowed" },
              { runtimeMode: "approval-required", status: "allowed" },
            ];
            assert.include(
              yield* factory.reviewedRefusal(author.threadId),
              "host policy refuses auto-accept-edits",
            );
            assert.lengthOf(world.provider.started, 1);
          }).pipe(Effect.orDie),
        { providers: offeredModels(), hostPolicy },
      );
    });
  });

  it.live(
    "shows a child's refused launch on the parent waiting for it, decided on the child",
    () => {
      const hostPolicy: HostPolicy = { restrictions: [] };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "approval-required");
            const factory = yield* Factory.FactoryService.FactoryService;
            const planner = yield* world.startWith({ kind: "parent" });
            yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
            yield* world.endRun(planner.runId, "completed");
            hostPolicy.restrictions = refusesSupervised().restrictions;
            yield* factory.approvePlan(planner.deliveryId);
            yield* drainFactory;
            yield* drainOrchestration;

            const { awaiting } = yield* stateOf(planner.deliveryId);
            if (awaiting?.type !== "child") return assert.fail("The parent awaits no child.");
            const { block } = yield* blockedOf(awaiting.deliveryId);
            assert.include(block.detail, "host policy refuses Supervised");
            assert.lengthOf(world.provider.started, 1);

            const listed = yield* factory.listForClients({ projectId: world.projectId });
            const shown = (id: FactoryDeliveryId) =>
              listed.find(({ deliveryId }) => deliveryId === id);
            const child = shown(awaiting.deliveryId);
            const parent = shown(planner.deliveryId);
            const onParent = parent?.pendingActions?.items[0];
            assert.deepInclude(onParent, {
              kind: "host_policy",
              threadId: null,
              runtimeMode: "approval-required",
            });
            // The parent's own section lists it, and sends the owner to where its controls are.
            assert.deepStrictEqual(onParent?.item, child?.itemRef);
            assert.notDeepEqual(onParent?.item, parent?.itemRef);
            assert.deepStrictEqual(child?.pendingActions?.items[0]?.item, child?.itemRef);
          }).pipe(Effect.orDie),
        { hostPolicy },
      );
    },
  );

  it.live(
    "blocks a reviewed launch whose mode the host has refused since, and steps to nothing",
    () => {
      const hostPolicy: HostPolicy = { restrictions: [] };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setProjectDefault(world, "approval-required");
            yield* setSettings(world, { verifyCommand: verifyCommands.passes });
            const reviewed = yield* reviewNow(world, { runtimeCeiling: "approval-required" });
            hostPolicy.restrictions = refusesSupervised().restrictions;
            const factory = yield* Factory.FactoryService.FactoryService;
            const { deliveryId } = yield* factory.start({
              itemRef: world.itemRef,
              reviewedExecution: reviewed,
            });
            const { state, block } = yield* blockedOf(deliveryId);
            assert.include(block.detail, "host policy refuses Supervised");
            assert.include(block.detail, "Review it again to choose another.");
            assert.strictEqual(state.reviewedExecution?.runtimeCeiling, "approval-required");
            assert.deepStrictEqual(world.provider.started, []);
          }).pipe(Effect.orDie),
        { providers: offeredModels(), hostPolicy },
      );
    },
  );
});
