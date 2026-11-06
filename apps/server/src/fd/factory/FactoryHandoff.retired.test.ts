import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  consult,
  dispositionsOf,
  endManagement,
  fill,
  freshRead,
  handoffRows,
  manage,
  noticesOf,
  questionTask,
  runsOf,
  turns,
  wakeThroughGate,
} from "./testkit/handoff.ts";
import { coreRecovery, providerThreadOf, providerTurnRunning } from "./testkit/familyThreads.ts";
import { linkOf, openSingle } from "./testkit/followThrough.ts";
import {
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * Late automatic work of a Factory family whose assistant assignment is ending or has ended, on the
 * server's real stack: it never runs and never takes capacity, each key leaves one disposition and
 * notice, and the owner's own turns still run.
 */

const noOwnership = (root: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.all({
      slots: sql`SELECT * FROM fd_assistant_slots WHERE root_delivery_id = ${root}`,
      demands: sql`SELECT * FROM fd_assistant_admission_demands WHERE root_delivery_id = ${root}`,
      admissions: sql`SELECT * FROM fd_assistant_admissions WHERE root_delivery_id = ${root}`,
    }),
  ).pipe(
    Effect.orDie,
    Effect.map(({ slots, demands, admissions }) => {
      assert.deepStrictEqual(slots, []);
      assert.deepStrictEqual(demands, []);
      assert.deepStrictEqual(admissions, []);
    }),
  );

/** Every late automatic kind of Factory's own work on the open delivery's author thread. */
const lateKinds = (world: World, opened: { readonly threadId: never; readonly runId: never }) =>
  Effect.gen(function* () {
    const providerThread = yield* providerThreadOf(opened.threadId, opened.runId);
    const task = { childThreadId: opened.threadId, taskId: questionTask };
    void world;
    return [
      turns.usageLimitResume(opened.threadId, opened.runId),
      turns.delegatedQuestion(opened.threadId, task, opened.runId),
      turns.delegatedCompletion(opened.threadId, opened.runId, providerThread),
      turns.backgroundWake(opened.threadId, providerThread, true),
      turns.backgroundWake(opened.threadId, providerThread, false),
    ];
  });

describe("late automatic work of an ended management", () => {
  it.live.each([{ state: "ending" as const }, { state: "retired" as const }])(
    "declines a $state root's late work once per key, before and after a rebuild",
    ({ state }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const opened = yield* openSingle(world);
            const managed = yield* manage(world, opened.deliveryId);
            yield* fill(world, 2);
            yield* endManagement(managed.root, state);
            const late = yield* lateKinds(world, opened as never);
            const record = { ran: [] as Array<string>, dropped: [] as Array<string> };
            const present = Effect.gen(function* () {
              const wake = yield* wakeThroughGate(
                opened.threadId,
                yield* linkOf(opened.threadId, fakePullRequest.number),
              );
              assert.deepStrictEqual(wake.outcome, AutomaticTurnGate.notNow("declined"));
              assert.isUndefined(wake.runId);
              for (const turn of late) {
                assert.deepStrictEqual(
                  yield* consult(turn, record),
                  AutomaticTurnGate.notNow("declined"),
                  turn.kind,
                );
              }
            });
            const runs = (yield* runsOf(opened.threadId)).length;
            yield* present;
            assert.deepStrictEqual(record.ran, []);
            // Only the offer that can be cleared is.
            assert.deepStrictEqual(record.dropped, [late[3]!.messageId]);
            yield* noOwnership(managed.root);
            const dispositions = yield* dispositionsOf(managed.root);
            assert.deepStrictEqual(
              dispositions.map(({ kind, class: cls, adapter_clear }) => [kind, cls, adapter_clear]),
              [
                ["background_wake", "factory", "requested"],
                ["delegated_completion", "factory", null],
                ["delegated_question", "factory", null],
                ["pull_request_wake", "factory", null],
                ["usage_limit_resume", "factory", null],
              ],
            );
            const notices = yield* noticesOf(managed.assignmentId);
            assert.lengthOf(notices, 5);

            // Repeats write nothing; the clearable offer is cleared again.
            const rows = yield* handoffRows;
            yield* present;
            assert.deepStrictEqual(yield* handoffRows, rows);
            assert.lengthOf(yield* noticesOf(managed.assignmentId), 5);
            assert.deepStrictEqual(record.ran, []);

            // Effects refuse ended, a continuation declines and a delegation is refused.
            const port = yield* Factory.FactoryAdmission.FactoryAdmission;
            assert.deepStrictEqual(
              yield* port.enter({
                root: opened.deliveryId,
                deliveryId: opened.deliveryId,
                effectId: 99,
                effectType: "launch_thread",
                fresh: true,
              }),
              { type: "refuse", category: "ended" },
            );
            assert.deepStrictEqual(
              yield* consult(turns.restartContinuation(opened.threadId, opened.runId), record),
              AutomaticTurnGate.notNow("declined"),
            );
            const admission = yield* HandoffAdmission.HandoffAdmission;
            assert.deepStrictEqual(
              yield* admission.admitDelegation({
                root: managed.root,
                threadId: opened.threadId,
                messageId: "mcp-delegation:late",
                work: yield* freshRead(world),
              }),
              { type: "refused", category: "ended" },
            );
            assert.strictEqual(yield* port.management(opened.deliveryId), "retired");

            // The owner's own turn and what carries it on run inline.
            const ownerRun = yield* world.ownerTurn(opened.threadId, "Rename the button.");
            const ownerResume = turns.usageLimitResume(opened.threadId, ownerRun);
            assert.deepStrictEqual(
              yield* consult(ownerResume, record),
              AutomaticTurnGate.ran(undefined),
            );
            assert.deepStrictEqual(record.ran, [ownerResume.messageId]);
            yield* world.endRun(ownerRun, "completed");
            assert.strictEqual((yield* runsOf(opened.threadId)).length, runs + 1);

            // A rebuilt server finds the dispositions and writes nothing more.
            yield* world.rebuild(
              Effect.gen(function* () {
                const before = yield* handoffRows;
                yield* present;
                assert.deepStrictEqual(yield* handoffRows, before);
                assert.lengthOf(yield* noticesOf(managed.assignmentId), 5);
                yield* noOwnership(managed.root);
                assert.deepStrictEqual(record.ran, [ownerResume.messageId]);
              }),
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );

  it.live(
    "declines an ending root's cut run's continuation across a restart, and fails a turn it cannot dispose of",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId);
            yield* fill(world, 2);
            yield* endManagement(managed.root, "ending");
            yield* providerTurnRunning(author.threadId);
            const recovery = yield* coreRecovery;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                const runs = yield* runsOf(author.threadId);
                assert.isTrue(runs.every((run) => run.restartContinuationOfRunId !== author.runId));
                assert.strictEqual((yield* stateOf(author.deliveryId)).status, "blocked");
                // A continuation declines with no disposition: core keeps its note on the run.
                assert.deepStrictEqual(yield* dispositionsOf(managed.root), []);
                yield* noOwnership(managed.root);

                // A disposition that cannot be written decides nothing, and nothing runs.
                const sql = yield* SqlClient.SqlClient;
                yield* sql`CREATE TRIGGER refuse_disposition
                  BEFORE INSERT ON fd_assistant_dispositions
                  BEGIN SELECT RAISE(ABORT, 'refused'); END`;
                const record = { ran: [] as Array<string> };
                const resume = turns.usageLimitResume(author.threadId, author.runId);
                const failed = yield* Effect.flip(consult(resume, record));
                assert.strictEqual(failed._tag, "AutomaticTurnDecisionError");
                assert.deepStrictEqual(record.ran, []);
                assert.deepStrictEqual(yield* dispositionsOf(managed.root), []);
                yield* sql`DROP TRIGGER refuse_disposition`;
                // Asked again by its producer, it is declined with its disposition.
                assert.deepStrictEqual(
                  yield* consult(resume, record),
                  AutomaticTurnGate.notNow("declined"),
                );
                assert.deepStrictEqual(
                  (yield* dispositionsOf(managed.root)).map(({ kind }) => kind),
                  ["usage_limit_resume"],
                );
                assert.deepStrictEqual(record.ran, []);
              }).pipe(Effect.orDie),
              { orchestration: true },
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    180_000,
  );
});
