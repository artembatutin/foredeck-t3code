import { assert, describe, it } from "@effect/vitest";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Factory from "./index.ts";
import {
  drainFactory,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  agreeAndCapture,
  assignmentOf,
  assignToFactory,
  controlAssignment,
  demandsOf,
  fill,
  grantOutcomesOf,
  noticesOf,
  release,
  rootIdOf,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
} from "./testkit/handoff.ts";

/**
 * An effect waiting for a project assistant slot across a mark that could not be stored and across
 * a restart, on the real stack: a parent's `create_children`, whose children show how many times it
 * ran.
 */

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

const factoryService = Factory.FactoryService.FactoryService;

/** A parent at its plan gate, its slot released, both slots then held by others. */
const atGateWithFullCapacity = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    yield* startAssistantThread(world);
    yield* agreeAndCapture(world, "big", "parent");
    yield* assignToFactory(world, "big");
    yield* tick;
    const root = yield* rootIdOf("big");
    const planner = yield* world.launched(root);
    yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
    yield* world.endRun(planner.runId, "completed");
    yield* tick;
    assert.isUndefined(yield* slotOf(root));
    const [first] = yield* fill(world, 2);
    return { root, filler: first! };
  });

const refuseMarks = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER recovery_refuses_mark BEFORE UPDATE ON fd_factory_deliveries
    WHEN json_extract(NEW.state_json, '$.admissionWait') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
).pipe(Effect.orDie);
const allowMarks = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER recovery_refuses_mark`,
).pipe(Effect.orDie);

const hideDemands = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE fd_assistant_admission_demands RENAME TO hidden_demands`,
).pipe(Effect.orDie);
const showDemands = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`ALTER TABLE hidden_demands RENAME TO fd_assistant_admission_demands`,
).pipe(Effect.orDie);

/** The effect the delivery awaits, while it is one. */
const awaitedEffect = (root: FactoryDeliveryId) =>
  Effect.map(stateOf(root), (state) =>
    state.awaiting?.type === "effect" ? state.awaiting.effect : undefined,
  );

describe("an effect waiting for a slot", () => {
  it.live("is marked again by the next tick after a failed mark, then runs once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, filler } = yield* atGateWithFullCapacity(world);
          yield* refuseMarks;
          yield* factory.approvePlan(root);
          yield* drainFactory;
          // The demand committed; the mark did not. Nothing ran and nothing is lost.
          const unmarked = yield* stateOf(root);
          assert.notProperty(unmarked, "admissionWait");
          assert.lengthOf(yield* demandsOf(root), 1);
          assert.strictEqual((yield* awaitedEffect(root))?.type, "create_children");
          yield* allowMarks;

          yield* tick;
          assert.isDefined((yield* stateOf(root)).admissionWait);
          assert.deepStrictEqual((yield* stateOf(root)).children, []);
          assert.isUndefined(yield* slotOf(root));

          yield* release(filler);
          yield* tick;
          yield* drainFactory;
          assert.lengthOf((yield* stateOf(root)).children, 1);
          assert.deepStrictEqual(yield* demandsOf(root), []);
          assert.strictEqual((yield* slotOf(root))?.state, "held");
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });

  it.live("keeps awaiting across a rebuild through its demand, and runs once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, filler } = yield* atGateWithFullCapacity(world);
          yield* factory.approvePlan(root);
          yield* drainFactory;
          assert.isDefined((yield* stateOf(root)).admissionWait);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              const state = yield* stateOf(root);
              assert.strictEqual(state.status, "running");
              assert.strictEqual((yield* awaitedEffect(root))?.type, "create_children");
              assert.isDefined(state.admissionWait);
              assert.lengthOf(yield* demandsOf(root), 1);
              yield* tick;
              assert.deepStrictEqual((yield* stateOf(root)).children, []);

              yield* release(filler);
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
            }),
          );
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });

  it.live("a mark lost with the process is recovered through its demand after a rebuild", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, filler } = yield* atGateWithFullCapacity(world);
          yield* refuseMarks;
          yield* factory.approvePlan(root);
          yield* drainFactory;
          assert.notProperty(yield* stateOf(root), "admissionWait");
          assert.lengthOf(yield* demandsOf(root), 1);
          yield* allowMarks;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              // The boot sweep found the demand, so it marked the effect rather than block it.
              assert.isDefined((yield* stateOf(root)).admissionWait);
              assert.strictEqual((yield* stateOf(root)).status, "running");
              yield* release(filler);
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
            }),
          );
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });

  it.live("a demand a resume's new effect took over survives the check of its old effect", () => {
    const spy = spyOnFactoryPort();
    const hook: { duringStale: Effect.Effect<void> | undefined } = { duringStale: undefined };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, filler } = yield* atGateWithFullCapacity(world);
          yield* refuseMarks;
          yield* factory.approvePlan(root);
          yield* drainFactory;
          yield* allowMarks;
          yield* hideDemands;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              assert.strictEqual((yield* stateOf(root)).status, "blocked");
              yield* showDemands;
              const rebuilt = yield* factoryService;
              const [oldDemand] = yield* demandsOf(root);
              const oldEffect = oldDemand?.effectId ?? assert.fail("No demand waits.");

              // While the tick checks the old effect, the owner resumes in Factory: a new effect
              // waits in the same row, and the mark on it cannot be stored.
              const context = yield* Effect.context<
                SqlClient.SqlClient | Factory.FactoryWorker.FactoryWorker
              >();
              hook.duringStale = Effect.gen(function* () {
                yield* refuseMarks;
                yield* rebuilt.resume(root).pipe(Effect.orDie);
                const worker = yield* Factory.FactoryWorker.FactoryWorker;
                yield* worker.drain;
                yield* allowMarks;
              }).pipe(Effect.provideContext(context), Effect.orDie);
              yield* tick;

              // The replacement stands, unmarked, with no note that it was lost.
              const [kept] = yield* demandsOf(root);
              const newEffect = kept?.effectId ?? assert.fail("The replacement was dropped.");
              assert.isAbove(newEffect, oldEffect);
              assert.strictEqual(kept?.id, oldDemand?.id);
              const replaced = yield* stateOf(root);
              assert.strictEqual(replaced.status, "running");
              assert.notProperty(replaced, "admissionWait");
              assert.isFalse(
                (yield* noticesOf("big")).some((note) => note.includes("Resume it to go on")),
              );

              // The next tick repairs the mark, since its demand is still there to check.
              yield* tick;
              assert.deepStrictEqual((yield* stateOf(root)).admissionWait, {
                effectId: newEffect,
              });
              assert.deepStrictEqual((yield* stateOf(root)).children, []);

              // A slot frees: granted, it runs once.
              yield* release(filler);
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
              assert.deepStrictEqual(yield* demandsOf(root), []);
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
            }),
          );
        }),
      {
        handoff: {},
        automaticTurnGate: true,
        assistantFactory: (service) => {
          const wrapped = spy.wrap(service);
          return {
            ...wrapped,
            ensureDeferred: (deliveryId, effectId) =>
              Effect.tap(wrapped.ensureDeferred(deliveryId, effectId), (outcome) =>
                Effect.suspend(() => {
                  const during = hook.duringStale;
                  if (outcome !== "stale" || during === undefined) return Effect.void;
                  hook.duringStale = undefined;
                  return during;
                }),
              ),
          };
        },
      },
    );
  });

  it.live("a boot read failure blocks it; the tick drops the demand, and Resume goes on", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, filler } = yield* atGateWithFullCapacity(world);
          yield* refuseMarks;
          yield* factory.approvePlan(root);
          yield* drainFactory;
          assert.lengthOf(yield* demandsOf(root), 1);
          assert.notProperty(yield* stateOf(root), "admissionWait");
          yield* allowMarks;

          // With no mark to go by, the boot sweep cannot read whether the effect has a demand.
          yield* hideDemands;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              assert.strictEqual((yield* stateOf(root)).status, "blocked");
              yield* showDemands;
              assert.lengthOf(yield* demandsOf(root), 1);

              yield* tick;
              assert.deepStrictEqual(yield* demandsOf(root), []);
              assert.isUndefined(yield* slotOf(root));
              assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
              const notes = yield* noticesOf("big");
              assert.isTrue(notes.some((note) => note.includes("Resume it to go on")));
              assert.deepInclude(yield* grantOutcomesOf(root), {
                kind: "effect",
                outcome: "stale",
              });
              // Repeated, it adds no second notice.
              yield* tick;
              assert.strictEqual(
                (yield* noticesOf("big")).filter((note) => note.includes("Resume it to go on"))
                  .length,
                1,
              );

              // Resumed with a slot free, the effect runs once, in a counted holding.
              yield* release(filler);
              yield* controlAssignment("big", "resume");
              assert.strictEqual(spy.count("resume"), 1);
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              yield* tick;
              yield* drainFactory;
              assert.lengthOf((yield* stateOf(root)).children, 1);
            }),
          );
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });
});
