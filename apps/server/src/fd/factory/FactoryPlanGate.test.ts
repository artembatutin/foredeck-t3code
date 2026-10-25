import { assert, describe, it } from "@effect/vitest";
import type { RunId } from "@t3tools/contracts";
import {
  type FactoryDeliveryId,
  FactoryPlan,
  type FactoryPlanTask,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { toFactoryError } from "./wireError.ts";

const decodePlan = Schema.decodeUnknownSync(FactoryPlan);

/** The planner's plan: two tasks, the second building on the first. */
const plannerPlan = decodePlan({
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [
        { criterion: 1, check: "Export two rows and read back the CSV.", paths: ["src/a.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names."],
      testPlan: [
        { criterion: 1, check: "The first CSV line is the header.", paths: ["src/a.test.ts"] },
      ],
      likelyPaths: ["src/export.ts", "src/header.ts"],
      risk: "high",
    },
  ],
  note: "Both tasks change the same module.",
});
const [csvTask, headerTask] = plannerPlan.tasks as readonly [FactoryPlanTask, FactoryPlanTask];

/** The plan the planner submits after the owner's replan. */
const replannedPlan = decodePlan({
  tasks: [
    { ...csvTask, id: "export-rows", title: "Export the visible rows" },
    { ...csvTask, id: "export-columns", title: "Name the columns", risk: "high" },
    { ...headerTask, id: "export-header-row" },
  ],
});

const withTasks = (tasks: ReadonlyArray<FactoryPlanTask>) => ({ ...plannerPlan, tasks });

const service = Factory.FactoryService.FactoryService;

/** The epoch now: a new subscription's first value. */
const currentEpoch = Effect.flatMap(service, (factory) =>
  factory.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
);

const storedDelivery = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.get(deliveryId)).pipe(
    Effect.map(Option.getOrThrow),
    Effect.orDie,
  );

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])));

/** The provider turn that started the run. */
const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((turn) => turn.runId === runId) ??
  assert.fail(`No provider turn started run ${runId}.`);

/** The delivery's `plan.json`, as the planner's submission wrote it. */
const planEvidence = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return JSON.parse(
      yield* fileSystem.readFileString(path.join(world.evidenceDir(deliveryId), "plan.json")),
    );
  }).pipe(Effect.orDie);

/** A started parent whose planner submitted `plannerPlan` and whose run ended: at the gate. */
const atGate = (world: World) =>
  Effect.gen(function* () {
    const planner = yield* world.startWith({ kind: "parent" });
    const factory = yield* service;
    yield* factory.submitPlan({ threadId: planner.threadId, plan: plannerPlan }).pipe(Effect.orDie);
    yield* world.endRun(planner.runId, "completed");
    const state = yield* stateOf(planner.deliveryId);
    assert.strictEqual(state.status, "waiting");
    assert.strictEqual(state.stage, "approve_plan");
    return planner;
  });

/** What the plan gate's actions fail with. */
type PlanActionError = Effect.Error<
  ReturnType<
    Factory.FactoryService.FactoryService["Service"]["updatePlan" | "rejectPlan" | "replan"]
  >
>;

/** Runs a refused action and checks it stored nothing and moved no epoch; returns its error. */
const refused = (
  deliveryId: FactoryDeliveryId,
  action: Effect.Effect<Factory.FactoryService.FactoryDeliveryWithRuns, PlanActionError>,
) =>
  Effect.gen(function* () {
    const before = yield* storedDelivery(deliveryId);
    const epoch = yield* currentEpoch;
    const error = yield* Effect.flip(action);
    assert.deepStrictEqual(yield* storedDelivery(deliveryId), before);
    assert.strictEqual(yield* currentEpoch, epoch);
    return error;
  });

describe("Factory plan gate edits", () => {
  it.live("stores the owner's valid edits and shows them on the snapshot", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* atGate(world);
        const factory = yield* service;

        // The snapshot of the waiting delivery carries the plan it waits on.
        const gate = toFactoryDelivery(yield* storedDelivery(deliveryId));
        assert.deepStrictEqual(gate.plan, plannerPlan);
        assert.strictEqual(gate.needsYou, "A plan of 2 tasks awaits your approval.");

        // A new title, a reworded criterion with a second one and their test plan, and the
        // header task first.
        const edited = withTasks([
          {
            ...headerTask,
            title: "Write the column names first",
            acceptance: ["The CSV starts with the column names.", "An empty table exports them."],
            testPlan: [
              { criterion: 1, check: "Read the first CSV line.", paths: ["src/a.test.ts"] },
              { criterion: 2, check: "Export an empty table.", paths: ["src/b.test.ts"] },
            ],
          },
          { ...csvTask, summary: "Export what the table shows, nothing hidden." },
        ]);
        const epoch = yield* currentEpoch;
        const snapshot = toFactoryDelivery(
          yield* factory.updatePlan({ deliveryId, plan: edited }).pipe(Effect.orDie),
        );
        assert.strictEqual(yield* currentEpoch, epoch + 1);
        assert.deepStrictEqual(snapshot.plan, edited);
        assert.strictEqual(snapshot.status, "waiting");
        const state = yield* stateOf(deliveryId);
        assert.deepStrictEqual(state.plan?.tasks, edited.tasks);
        // Still the round's plan from the planner's tool; its evidence keeps what it submitted.
        assert.strictEqual(state.plan?.round, 1);
        assert.strictEqual(state.plan?.source, "mcp");
        assert.deepStrictEqual((yield* planEvidence(world, deliveryId)).plan, plannerPlan);

        // Removing a task keeps the rest.
        const removed = yield* factory
          .updatePlan({ deliveryId, plan: withTasks([csvTask]) })
          .pipe(Effect.orDie);
        assert.strictEqual(yield* currentEpoch, epoch + 2);
        assert.deepStrictEqual(toFactoryDelivery(removed).plan?.tasks, [csvTask]);
        assert.strictEqual(
          toFactoryDelivery(removed).needsYou,
          "A plan of 1 task awaits your approval.",
        );

        // Nothing ran meanwhile: the gate's attempt is open and no turn was sent.
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", null],
        ]);
        assert.strictEqual(world.provider.started.length, 1);
      }),
    ),
  );

  it.live("refuses an edit that changes what the planner owns, changing nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* atGate(world);
        const factory = yield* service;
        const refusals = [
          withTasks([csvTask, headerTask, { ...csvTask, id: FactoryTaskId.make("export-json") }]),
          withTasks([{ ...csvTask, id: FactoryTaskId.make("export-table") }, headerTask]),
          withTasks([{ ...csvTask, kind: "refactor" }, headerTask]),
          withTasks([csvTask, { ...headerTask, risk: "normal" }]),
          withTasks([csvTask, { ...headerTask, likelyPaths: ["src/export.ts"] }]),
          withTasks([{ ...csvTask, acceptance: [...csvTask.acceptance, "It is fast."] }]),
          withTasks([csvTask, csvTask]),
          withTasks([]),
          { tasks: plannerPlan.tasks, note: "The owner's own note." },
          { tasks: plannerPlan.tasks },
        ];
        for (const plan of refusals) {
          const error = yield* refused(deliveryId, factory.updatePlan({ deliveryId, plan }));
          assert.strictEqual(error._tag, "FactoryPlanEditInvalidError", JSON.stringify(plan));
          assert.strictEqual(toFactoryError(error).reason, "invalid_request");
        }
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.deepStrictEqual(state.plan?.tasks, plannerPlan.tasks);
      }),
    ),
  );
});

describe("Factory plan gate refusals", () => {
  it.live("refuses every plan action while the planner runs, and once blocked", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId, runId } = yield* world.startWith({ kind: "parent" });
        const factory = yield* service;
        const actions = [
          factory.updatePlan({ deliveryId, plan: plannerPlan }),
          factory.rejectPlan(deliveryId),
          factory.replan({ deliveryId, note: "Split it." }),
        ];

        // Running the plan stage, before and after its plan is accepted.
        for (const action of actions) {
          const error = yield* refused(deliveryId, action);
          assert.deepInclude(error, { _tag: "FactoryPlanGateRefusedError", status: "running" });
        }
        yield* factory.submitPlan({ threadId, plan: plannerPlan }).pipe(Effect.orDie);
        for (const action of actions) {
          assert.strictEqual(
            (yield* refused(deliveryId, action))._tag,
            "FactoryPlanGateRefusedError",
          );
        }

        // Blocked: the planner's run failed after submitting.
        yield* world.endRun(runId, "failed");
        assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
        for (const action of actions) {
          const error = yield* refused(deliveryId, action);
          assert.deepInclude(error, { _tag: "FactoryPlanGateRefusedError", status: "blocked" });
          assert.strictEqual(toFactoryError(error).reason, "refused");
        }
        assert.strictEqual(world.provider.started.length, 1);
      }),
    ),
  );
});

describe("Factory plan gate rejection", () => {
  it.live("cancels the delivery with nothing issued, and refuses a second action", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId } = yield* atGate(world);
        const factory = yield* service;

        const epoch = yield* currentEpoch;
        const snapshot = toFactoryDelivery(
          yield* factory.rejectPlan(deliveryId).pipe(Effect.orDie),
        );
        assert.strictEqual(yield* currentEpoch, epoch + 1);
        assert.strictEqual(snapshot.status, "cancelled");
        assert.isUndefined(snapshot.needsYou);
        yield* drainFactory;
        yield* drainOrchestration;

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "cancelled");
        assert.isNull(state.awaiting);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", "cancelled"],
        ]);
        // No turn, launch or interrupt reached the provider: the planner had nothing running.
        assert.deepStrictEqual(
          world.provider.started.map((turn) => turn.threadId),
          [threadId],
        );
        assert.deepStrictEqual(world.provider.interrupted, []);

        for (const action of [
          factory.rejectPlan(deliveryId),
          factory.replan({ deliveryId, note: "Again." }),
          factory.updatePlan({ deliveryId, plan: plannerPlan }),
        ]) {
          const error = yield* refused(deliveryId, action);
          assert.deepInclude(error, { _tag: "FactoryPlanGateRefusedError", status: "cancelled" });
        }
      }),
    ),
  );
});

describe("Factory plan gate replan", () => {
  it.live("sends the note to the planner thread and waits at the gate on the next plan", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId, runId } = yield* atGate(world);
        const factory = yield* service;
        const note = "Split the export into rows and columns.\n\nKeep the header task.";

        const replanned = toFactoryDelivery(
          yield* factory.replan({ deliveryId, note: `  ${note}\n` }).pipe(Effect.orDie),
        );
        assert.strictEqual(replanned.status, "running");
        assert.deepStrictEqual(replanned.stage, { name: "plan", kind: "agent" });
        // The old plan no longer stands for the new round.
        assert.isUndefined(replanned.plan);
        assert.isUndefined(replanned.needsYou);

        // The note reaches the planner thread as its next turn.
        yield* drainFactory;
        const replanning = yield* stateOf(deliveryId);
        assert.strictEqual(replanning.planRound, 2);
        assert.strictEqual(replanning.invalidSubmissions, 0);
        if (replanning.awaiting?.type !== "run")
          return assert.fail("The replan turn is not running.");
        const replan = replanning.awaiting;
        assert.strictEqual(replan.threadId, threadId);
        assert.notStrictEqual(replan.runId, runId);
        assert.strictEqual(yield* runReached(replan.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        const turn = turnOf(world, replan.runId);
        assert.strictEqual(turn.threadId, threadId);
        assert.strictEqual(turn.runtimePolicy.interactionMode, "plan");
        assert.include(
          turn.message.text,
          "> Split the export into rows and columns.\n>\n> Keep the header task.",
        );
        assert.include(turn.message.text, "`factory_submit_plan`");
        assert.deepStrictEqual(
          world.provider.started.map((started) => started.threadId),
          [threadId, threadId],
        );

        // The replan run's plan replaces the one the owner sent back, and waits at the gate.
        yield* factory.submitPlan({ threadId, plan: replannedPlan }).pipe(Effect.orDie);
        yield* world.endRun(replan.runId, "completed");
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.strictEqual(state.plan?.round, 2);
        const snapshot = toFactoryDelivery(yield* storedDelivery(deliveryId));
        assert.deepStrictEqual(snapshot.plan, replannedPlan);
        assert.strictEqual(snapshot.needsYou, "A plan of 3 tasks awaits your approval.");
        assert.deepStrictEqual((yield* planEvidence(world, deliveryId)).plan, replannedPlan);
        // The gate the owner sent back counts as failed; the new one is open.
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", "failed"],
          ["plan", "passed"],
          ["approve_plan", null],
        ]);
        // Each entry into the gate announces it once.
        assert.deepStrictEqual(
          world.commentCalls.map(({ input }) => input.body.split(" Factory delivery ")[0]),
          [
            "Factory is waiting for your decision on this item in Foredeck.",
            "Factory is waiting for your decision on this item in Foredeck.",
          ],
        );

        // The new plan takes the owner's edits like the first.
        const edited = yield* factory
          .updatePlan({ deliveryId, plan: { tasks: replannedPlan.tasks.slice(1) } })
          .pipe(Effect.orDie);
        assert.deepStrictEqual(toFactoryDelivery(edited).plan?.tasks, replannedPlan.tasks.slice(1));
      }),
    ),
  );

  it.live("refuses a blank or overlong note, changing nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId } = yield* atGate(world);
        const factory = yield* service;
        for (const note of ["", " \n\t ", "n".repeat(8001)]) {
          const error = yield* refused(deliveryId, factory.replan({ deliveryId, note }));
          assert.strictEqual(error._tag, "FactoryReplanNoteInvalidError");
          assert.strictEqual(toFactoryError(error).reason, "invalid_request");
        }
        assert.strictEqual(world.provider.started.length, 1);
      }),
    ),
  );
});
