import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission, HandoffBackend, ProjectAssistant } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import { providerThreadOf } from "./testkit/familyThreads.ts";
import { linkOf } from "./testkit/followThrough.ts";
import {
  admissionsOf,
  agreeAndCapture,
  assertNothingHeld,
  assignmentOf,
  assignToFactory,
  controlAssignment,
  handoffRows,
  managedRootOf,
  noticesOf,
  pullRequestWakeTurn,
  queuePositionOf,
  rootIdOf,
  runToPullRequest,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  turns,
} from "./testkit/handoff.ts";

/**
 * Fair progress under a continuous stream of automatic work, on the real stack: two delivered roots
 * wake every round, and a waiting assignment is still claimed within the fair order's bound. A root
 * stopped before its first start holds no slot and takes no turn until it is resumed.
 */

const STARVATION_LIMIT = 2;

type Spy = ReturnType<typeof spyOnFactoryPort>;

/** Every automatic turn that ran, with its root's slot as it ran. */
interface Ran {
  readonly ran: Array<{ readonly message: string; readonly slot: string | undefined }>;
}

const ranks = (world: World, idea: string, rank: number) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: { priority: { rank, reason: "Ranked for the test." } },
    }),
  ).pipe(Effect.orDie);

/** An idea queued, ranked, claimed by a tick and run to its open pull request. */
const delivered = (world: World, idea: string) =>
  Effect.gen(function* () {
    yield* agreeAndCapture(world, idea);
    yield* ranks(world, idea, 1);
    yield* assignToFactory(world, idea);
    yield* tick;
    const root = yield* rootIdOf(idea);
    const opened = yield* runToPullRequest(world, root);
    yield* tick;
    assert.strictEqual((yield* assignmentOf(idea)).state, "needs-input");
    assert.isUndefined(yield* slotOf(root));
    return { idea, root, thread: opened.threadId, runId: opened.runId };
  });

/** A first start ending with no row, then a stop: parked with its delivery absent. */
const parkedAbsent = (world: World, spy: Spy, idea: string) =>
  Effect.gen(function* () {
    yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    spy.control.onStart = () =>
      Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "start" }));
    yield* tick;
    spy.control.onStart = undefined;
    yield* controlAssignment(idea, "stop");
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    return yield* rootIdOf(idea);
  });

/** A first start storing its row and failing its step, then a stop: parked with a queued orphan. */
const parkedOrphan = (world: World, idea: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    yield* sql`CREATE TRIGGER fairness_start_step_fails BEFORE UPDATE ON fd_factory_deliveries
      WHEN OLD.status = 'queued'
      BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
    yield* tick;
    yield* controlAssignment(idea, "stop");
    yield* sql`DROP TRIGGER fairness_start_step_fails`;
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    const root = yield* rootIdOf(idea);
    assert.strictEqual((yield* stateOf(root)).status, "queued");
    return root;
  }).pipe(Effect.orDie);

/**
 * Presents the turn as its producer does, with a dispatch that records it ran and the state of its
 * root's slot at that moment. A kept native wake runs on the admission's own fiber.
 */
const presentChecking = (root: string, turn: AutomaticTurnGate.AutomaticTurn, record: Ran) =>
  Effect.gen(function* () {
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const database = yield* Effect.context<SqlClient.SqlClient>();
    const dispatch = slotOf(root).pipe(
      Effect.provideContext(database),
      Effect.flatMap((slot) =>
        Effect.sync(() => void record.ran.push({ message: turn.messageId, slot: slot?.state })),
      ),
    );
    return turn.kind === "background_wake"
      ? yield* gate.hand(turn, dispatch, {})
      : yield* gate.admit(turn, dispatch);
  });

/**
 * One round: a pull request's feedback and a native wake for each root, presented as their
 * producers present them, whose turns end at once. A turn left reserved runs when presented again.
 */
const wakeRound = (
  roots: ReadonlyArray<Effect.Success<ReturnType<typeof delivered>>>,
  record: Ran,
) =>
  Effect.forEach(
    roots,
    ({ root, thread, runId }) =>
      Effect.gen(function* () {
        const providerThread = yield* providerThreadOf(thread, runId);
        const link = yield* linkOf(thread, fakePullRequest.number);
        yield* presentChecking(root, pullRequestWakeTurn(thread, link), record);
        yield* presentChecking(root, turns.backgroundWake(thread, providerThread), record);
      }),
    { discard: true },
  );

/** The grant history's newest number, for counting the grants made after it. */
const historyMark = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly mark: number | null }>`SELECT MAX(grant_number) AS mark
    FROM fd_assistant_grant_history`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]?.mark ?? 0),
);

/** How many grants the fair order made after `mark` and before the assignment's own claim. */
const grantsBeforeClaim = (assignmentId: string, mark: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly passed: number }>`SELECT COUNT(*) AS passed
      FROM fd_assistant_grant_history
      WHERE outcome = 'granted' AND grant_number > ${mark} AND grant_number < (
        SELECT MIN(grant_number) FROM fd_assistant_grant_history
        WHERE assignment_id = ${assignmentId} AND kind = 'claim' AND outcome = 'granted'
          AND grant_number > ${mark}
      )`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.passed ?? assert.fail("It was never claimed.")),
  );

/**
 * Rounds of wakes and ticks until the assignment's claim, each round presenting more work ahead of
 * it, and how many grants passed it: at most the fair order's bound, whatever the wakes do.
 */
const claimUnderWakes = (
  roots: ReadonlyArray<Effect.Success<ReturnType<typeof delivered>>>,
  record: Ran,
  assignmentId: string,
  check: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const mark = yield* historyMark;
    for (let round = 0; round < 12; round += 1) {
      yield* wakeRound(roots, record);
      yield* tick;
      yield* check;
      if ((yield* assignmentOf(assignmentId)).state !== "queued") {
        return yield* grantsBeforeClaim(assignmentId, mark);
      }
    }
    return assert.fail(`${assignmentId} was never claimed.`);
  }).pipe(Effect.orDie);

/**
 * How many candidates wait ahead of the assignment now, its `W` in the bound: one whose family
 * holds its slot is not eligible this moment, and is as soon as that slot goes.
 */
const waitingAhead = (assignmentId: string) =>
  Effect.gen(function* () {
    const admission = yield* HandoffAdmission.HandoffAdmission;
    const { candidates } = yield* admission.next;
    const own = yield* queuePositionOf(assignmentId);
    return candidates.filter(({ seq }) => seq < (own?.seq ?? 0)).length;
  }).pipe(Effect.orDie);

/** Every slot of every parked root is absent, whatever a round did. */
const parkedHoldNothing = (parked: ReadonlyArray<string>) =>
  Effect.forEach(
    parked,
    (root) =>
      Effect.gen(function* () {
        assert.isUndefined(yield* slotOf(root));
        assert.deepStrictEqual(yield* admissionsOf(root), []);
      }),
    { discard: true },
  );

describe("fair progress under continuous automatic work", () => {
  it.live(
    "two roots waking every round cannot keep a waiting assignment from its claim",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const roots = [yield* delivered(world, "first"), yield* delivered(world, "second")];
            // Ranked behind every wake, so only the bound can bring it through.
            yield* agreeAndCapture(world, "third");
            yield* ranks(world, "third", 9);
            yield* assignToFactory(world, "third");

            const record: Ran = { ran: [] };
            assert.strictEqual(yield* waitingAhead("third"), 0);
            const passed = yield* claimUnderWakes(roots, record, "third");
            // Nothing waited before it, so at most K grants pass it and the next is its own.
            assert.isAtMost(passed, STARVATION_LIMIT);
            assert.strictEqual((yield* assignmentOf("third")).state, "running");
            assert.strictEqual((yield* slotOf(yield* rootIdOf("third")))?.state, "held");
            // No automatic turn ran without a slot of its root held.
            assert.isNotEmpty(record.ran);
            assert.isTrue(record.ran.every(({ slot }) => slot === "held"));
          }),
        {
          handoff: {},
          automaticTurnGate: true,
          assistantFactory: spy.wrap,
        },
      );
    },
    240_000,
  );

  it.live(
    "parked roots hold nothing, while a third assignment and a resumed root are each claimed",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const absent = yield* parkedAbsent(world, spy, "absent");
            const orphan = yield* parkedOrphan(world, "orphan");
            const parked = [absent, orphan];
            yield* parkedHoldNothing(parked);

            const roots = [yield* delivered(world, "first"), yield* delivered(world, "second")];
            yield* agreeAndCapture(world, "third");
            yield* ranks(world, "third", 9);
            yield* assignToFactory(world, "third");
            const record: Ran = { ran: [] };

            assert.strictEqual(yield* waitingAhead("third"), 0);
            const third = yield* claimUnderWakes(
              roots,
              record,
              "third",
              parkedHoldNothing(parked).pipe(Effect.orDie),
            );
            assert.isAtMost(third, STARVATION_LIMIT);
            assert.strictEqual((yield* assignmentOf("absent")).state, "stopped");
            assert.isTrue(record.ran.every(({ slot }) => slot === "held"));

            // Let the third park as well, so a resumed root meets only the wakes.
            const thirdRoot = yield* rootIdOf("third");
            const opened = yield* runToPullRequest(world, thirdRoot);
            assert.isDefined(opened);
            yield* tick;

            // A resume waits in the fair order, and only its grant starts the same id.
            const starts = spy.count("start");
            assert.strictEqual((yield* controlAssignment("absent", "resume")).state, "queued");
            assert.strictEqual(spy.count("start"), starts);
            assert.isUndefined(yield* slotOf(absent));
            assert.isTrue(
              (yield* noticesOf("absent")).some((note) => note.includes("once it gets")),
            );
            yield* ranks(world, "absent", 9);
            const ahead = yield* waitingAhead("absent");
            const resumed = yield* claimUnderWakes(roots, record, "absent");
            assert.isAtMost(resumed, STARVATION_LIMIT + ahead);
            assert.strictEqual(yield* rootIdOf("absent"), absent);
            assert.strictEqual(spy.count("resume"), 0);
            assert.strictEqual(spy.count("start"), starts + 1);
            assert.strictEqual((yield* assignmentOf("absent")).state, "running");
            assert.strictEqual((yield* slotOf(absent))?.state, "held");
            assert.strictEqual(yield* slotOf(orphan), undefined);
          }),
        { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
      );
    },
    240_000,
  );

  it.live(
    "an owner's cancel of a parked queued row retires it cancelled, recreating no slot",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* Factory.FactoryService.FactoryService;
            yield* startAssistantThread(world);
            const root = yield* parkedOrphan(world, "orphan");
            yield* factory.cancel(root);
            yield* drainFactory;
            yield* tick;
            assert.strictEqual((yield* assignmentOf("orphan")).state, "cancelled");
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: "cancelled",
            });
            yield* assertNothingHeld(root, "orphan");
            assert.strictEqual(spy.count("start"), 1);
          }),
        { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
      );
    },
  );

  it.live("parked and pending-resume roots persist across two rebuilds and converge", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const absent = yield* parkedAbsent(world, spy, "absent");
          const orphan = yield* parkedOrphan(world, "orphan");
          yield* controlAssignment("orphan", "resume");
          const position = yield* queuePositionOf("orphan");
          assert.isDefined(position);

          // Both slots held by others: nothing of either root moves.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
            assignment_id: "held-1",
            project_id: world.projectId,
            idea_id: "held-1",
            executor: "foredeck",
            attempt: 1,
            state: "running",
            worker_refs_json: "[]",
            progress_json: "[]",
            evidence_json: "[]",
            created_at: "2026-10-30T12:00:00.000Z",
            updated_at: "2026-10-30T12:00:00.000Z",
          })}`;
          yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
            assignment_id: "held-2",
            project_id: world.projectId,
            idea_id: "held-2",
            executor: "foredeck",
            attempt: 1,
            state: "running",
            worker_refs_json: "[]",
            progress_json: "[]",
            evidence_json: "[]",
            created_at: "2026-10-30T12:00:00.000Z",
            updated_at: "2026-10-30T12:00:00.000Z",
          })}`;
          const rows = yield* handoffRows;
          const check = Effect.gen(function* () {
            yield* tick;
            assert.deepStrictEqual(yield* handoffRows, rows);
            assert.strictEqual((yield* assignmentOf("absent")).state, "stopped");
            assert.strictEqual((yield* assignmentOf("orphan")).state, "queued");
            assert.deepStrictEqual(yield* queuePositionOf("orphan"), position);
            yield* parkedHoldNothing([absent, orphan]);
          });
          yield* check;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* check;
              yield* world.rebuild(
                Effect.gen(function* () {
                  yield* check;

                  // A slot frees: the pending resume is re-claimed under the same id.
                  yield* sql`UPDATE fd_assistant_assignments SET state = 'completed'
                    WHERE assignment_id = 'held-1'`;
                  yield* sql`UPDATE fd_assistant_assignments SET state = 'completed'
                    WHERE assignment_id = 'held-2'`;
                  const starts = spy.count("start");
                  yield* tick;
                  yield* drainFactory;
                  assert.strictEqual(spy.count("start"), starts + 1);
                  assert.strictEqual(yield* rootIdOf("orphan"), orphan);
                  assert.strictEqual((yield* slotOf(orphan))?.state, "held");
                  assert.strictEqual((yield* assignmentOf("orphan")).state, "running");
                  assert.strictEqual((yield* assignmentOf("absent")).state, "stopped");
                  assert.isUndefined(yield* slotOf(absent));

                  // Cancelled, the absent root retires abandoned with nothing held.
                  yield* controlAssignment("absent", "cancel");
                  assert.strictEqual((yield* assignmentOf("absent")).state, "cancelled");
                  assert.deepStrictEqual(yield* managedRootOf(absent), {
                    state: "retired",
                    reason: "abandoned",
                  });
                  yield* assertNothingHeld(absent, "absent");
                }),
                { orchestration: true },
              );
            }),
          );
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });
});
