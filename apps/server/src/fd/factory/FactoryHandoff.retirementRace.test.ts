import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission } from "../assistant/index.ts";
import {
  fakePullRequest,
  drainFactory,
  drainOrchestration,
  runReached,
  ended,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import { delegateFrom, providerThreadOf } from "./testkit/familyThreads.ts";
import { linkOf, openSingle, syncPullRequest } from "./testkit/followThrough.ts";
import {
  admissionsOf,
  assertNothingHeld,
  assignmentOf,
  consult,
  consultRunning,
  demandsOf,
  dispositionsOf,
  failOutboxReads,
  fill,
  freshRead,
  makeRetirementProbe,
  manage,
  type Managed,
  managedRootOf,
  questionTask,
  release,
  type RetirementProbe,
  runsOf,
  slotOf,
  tick,
  turns,
} from "./testkit/handoff.ts";

/**
 * The race between a family's automatic turns and its root's retirement, when a pull request closes
 * unmerged and Factory has already cancelled the delivery before the assistant sees it. Probes hold
 * the retirement after its release pass or its observation, and an admission right after it
 * commits, each on a Deferred. Whatever the order, no terminal assignment coexists with live family
 * work or an admission row, and no slot leaks.
 */

/**
 * A governed single item at its open pull request, its slot released, Work Ready and no control
 * set, whose pull request then closes unmerged, so Factory has cancelled it.
 */
const cancelledBeforeObserved = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openSingle(world);
    const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
    yield* tick;
    assert.isUndefined(yield* slotOf(managed.root));
    yield* syncPullRequest(
      opened.threadId,
      yield* linkOf(opened.threadId, fakePullRequest.number),
      "closed",
    );
    yield* drainFactory;
    assert.strictEqual((yield* stateOf(opened.deliveryId)).status, "cancelled");
    return {
      opened,
      managed,
      providerThread: yield* providerThreadOf(opened.threadId, opened.runId),
    };
  });

/** The turn the case presents, as its producer would, on the delivery's thread. */
const presented = (
  shape: "native-clearable" | "native-plain" | "completion" | "question",
  threadId: Parameters<typeof turns.backgroundWake>[0],
  runId: Parameters<typeof turns.delegatedCompletion>[1],
  providerThread: Parameters<typeof turns.backgroundWake>[1],
) => {
  switch (shape) {
    case "native-clearable":
      return turns.backgroundWake(threadId, providerThread, true);
    case "native-plain":
      return turns.backgroundWake(threadId, providerThread, false);
    case "completion":
      return turns.delegatedCompletion(threadId, runId, providerThread);
    case "question":
      return turns.delegatedQuestion(
        threadId,
        { childThreadId: threadId, taskId: questionTask },
        runId,
      );
  }
};

/** Nothing terminal while something of the root still counts. */
const notTerminalYet = (managed: Managed) =>
  Effect.gen(function* () {
    const { state } = yield* assignmentOf(managed.assignmentId);
    assert.notInclude(["completed", "cancelled", "failed"], state);
    assert.strictEqual((yield* managedRootOf(managed.root))?.state, "ending");
  });

const shapes = ["native-clearable", "native-plain", "completion", "question"] as const;

const withProbe = <A, E, R>(body: (probe: RetirementProbe) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(makeRetirementProbe, body);

describe("a retirement racing an automatic turn", () => {
  describe.each([{ stage: "released" as const }, { stage: "observed" as const }])(
    "with an admission placed at the $stage probe",
    ({ stage }) => {
      it.live.each(shapes.map((shape) => ({ shape })))(
        "$shape: the admission wins, is counted, and the root retires after its run",
        ({ shape }) =>
          withProbe((probe) =>
            withProject(
              verifyCommands.passes,
              (world) =>
                probe.guarded(
                  Effect.gen(function* () {
                    const { opened, managed, providerThread } =
                      yield* cancelledBeforeObserved(world);
                    const thread = opened.threadId;
                    const turn = presented(shape, thread, opened.runId, providerThread);
                    const dropped: Array<string> = [];

                    // The retirement pauses, having judged nothing that the admission changes.
                    probe.armed[stage] = true;
                    const ticking = yield* tick.pipe(Effect.forkChild);
                    yield* Deferred.await(probe.gates[stage].entered);

                    // The turn is admitted at the free head and pauses before its dispatch.
                    probe.armed.admitted = true;
                    const admitting = yield* consultRunning(
                      world,
                      turn,
                      turn.kind === "background_wake" && turn.clearable
                        ? { drop: Effect.sync(() => void dropped.push(turn.messageId)) }
                        : {},
                    ).pipe(Effect.forkChild);
                    yield* Deferred.await(probe.gates.admitted.entered);
                    assert.strictEqual((yield* slotOf(managed.root))?.state, "held");

                    // The attempt commits only the fence.
                    yield* Deferred.succeed(probe.gates[stage].go, undefined);
                    yield* Fiber.join(ticking);
                    yield* notTerminalYet(managed);
                    assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
                    assert.deepStrictEqual(
                      (yield* admissionsOf(managed.root)).map(({ state }) => state),
                      ["dispatching"],
                    );
                    assert.deepStrictEqual(yield* dispositionsOf(managed.root), []);
                    assert.deepStrictEqual(dropped, []);

                    // Other turns of the fenced root get dispositions and no run.
                    const other = { ran: [] as Array<string> };
                    assert.deepStrictEqual(
                      yield* consult(turns.usageLimitResume(thread, opened.runId), other),
                      AutomaticTurnGate.notNow("declined"),
                    );
                    assert.deepStrictEqual(other.ran, []);
                    assert.lengthOf(yield* dispositionsOf(managed.root), 1);

                    // Let go, the admitted turn runs exactly once.
                    const before = (yield* runsOf(thread)).length;
                    yield* Deferred.succeed(probe.gates.admitted.go, undefined);
                    const outcome = yield* Fiber.join(admitting);
                    assert.strictEqual(outcome._tag, "Ran");
                    yield* drainOrchestration;
                    const runs = yield* runsOf(thread);
                    assert.strictEqual(runs.length, before + 1);
                    const run = runs.find(
                      (candidate) => candidate.userMessageId === turn.messageId,
                    );
                    assert.isDefined(run);

                    // It stays counted while it runs.
                    yield* tick;
                    yield* notTerminalYet(managed);
                    assert.strictEqual((yield* slotOf(managed.root))?.state, "held");

                    yield* runReached(run!.id, ["starting", ...ended]);
                    yield* drainOrchestration;
                    yield* world.endRun(run!.id, "completed");
                    yield* tick;
                    assert.strictEqual(
                      (yield* assignmentOf(managed.assignmentId)).state,
                      "cancelled",
                    );
                    assert.deepStrictEqual(yield* managedRootOf(managed.root), {
                      state: "retired",
                      reason: "cancelled",
                    });
                    yield* assertNothingHeld(managed.root, managed.assignmentId);
                  }),
                ),
              { handoff: { probe: probe.probe }, automaticTurnGate: true },
            ),
          ),
      );
    },
  );

  it.live("retirement wins: later arrivals get dispositions, and nothing runs", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { opened, managed, providerThread } = yield* cancelledBeforeObserved(world);
          yield* tick;
          assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
          const record = { ran: [] as Array<string>, dropped: [] as Array<string> };
          const before = (yield* runsOf(opened.threadId)).length;
          for (const shape of shapes) {
            assert.deepStrictEqual(
              yield* consult(
                presented(shape, opened.threadId, opened.runId, providerThread),
                record,
              ),
              AutomaticTurnGate.notNow("declined"),
            );
          }
          assert.deepStrictEqual(record.ran, []);
          assert.strictEqual((yield* runsOf(opened.threadId)).length, before);
          // One per key; both native wakes are one, by their provider thread.
          assert.lengthOf(yield* dispositionsOf(managed.root), 3);
          yield* assertNothingHeld(managed.root, managed.assignmentId);
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live(
    "a reservation at the attempt is dropped by compare-and-delete and retirement follows",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const opened = yield* openSingle(world);
            const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
            yield* tick;
            const [filler] = yield* fill(world, 2);
            const record = { ran: [] as Array<string> };
            const resume = turns.usageLimitResume(opened.threadId, opened.runId);
            yield* consult(resume, record);
            yield* release(filler!);
            yield* tick;
            assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");

            yield* syncPullRequest(
              opened.threadId,
              yield* linkOf(opened.threadId, fakePullRequest.number),
              "closed",
            );
            yield* drainFactory;
            yield* tick;
            assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
            yield* assertNothingHeld(managed.root, managed.assignmentId);
            assert.deepStrictEqual(
              (yield* dispositionsOf(managed.root)).map(({ kind }) => kind),
              ["usage_limit_resume"],
            );
            assert.deepStrictEqual(record.ran, []);
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
  );

  it.live("a reservation converted first is kept and counted, and retirement waits for it", () =>
    withProbe((probe) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          probe.guarded(
            Effect.gen(function* () {
              const opened = yield* openSingle(world);
              const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
              yield* tick;
              const [filler] = yield* fill(world, 2);
              const resume = turns.usageLimitResume(opened.threadId, opened.runId);
              yield* consultRunning(world, resume);
              yield* release(filler!);
              yield* tick;
              assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");

              // Presented again, the reservation converts; its dispatch pauses.
              probe.armed.admitted = true;
              const admitting = yield* consultRunning(world, resume).pipe(Effect.forkChild);
              yield* Deferred.await(probe.gates.admitted.entered);
              assert.strictEqual((yield* slotOf(managed.root))?.state, "held");

              yield* syncPullRequest(
                opened.threadId,
                yield* linkOf(opened.threadId, fakePullRequest.number),
                "closed",
              );
              yield* drainFactory;
              yield* tick;
              yield* notTerminalYet(managed);
              assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
              assert.lengthOf(yield* admissionsOf(managed.root), 1);

              yield* Deferred.succeed(probe.gates.admitted.go, undefined);
              assert.strictEqual((yield* Fiber.join(admitting))._tag, "Ran");
              yield* drainOrchestration;
              const run = (yield* runsOf(opened.threadId)).find(
                (candidate) => candidate.userMessageId === resume.messageId,
              );
              assert.isDefined(run);
              yield* tick;
              yield* notTerminalYet(managed);
              yield* runReached(run!.id, ["starting", ...ended]);
              yield* drainOrchestration;
              yield* world.endRun(run!.id, "completed");
              yield* tick;
              assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
              yield* assertNothingHeld(managed.root, managed.assignmentId);
            }),
          ),
        { handoff: { probe: probe.probe }, automaticTurnGate: true },
      ),
    ),
  );

  it.live(
    "a delegation before the fence is counted, one after it refused, and retirement waits",
    () =>
      withProbe((probe) =>
        withProject(
          verifyCommands.passes,
          (world) =>
            probe.guarded(
              Effect.gen(function* () {
                const admission = yield* HandoffAdmission.HandoffAdmission;
                const { opened, managed, providerThread } = yield* cancelledBeforeObserved(world);
                const thread = opened.threadId;
                const turn = presented("native-plain", thread, opened.runId, providerThread);

                probe.armed.released = true;
                const ticking = yield* tick.pipe(Effect.forkChild);
                yield* Deferred.await(probe.gates.released.entered);
                probe.armed.admitted = true;
                const admitting = yield* consultRunning(world, turn).pipe(Effect.forkChild);
                yield* Deferred.await(probe.gates.admitted.entered);

                // Before the fence, the holding admits a delegation.
                const before = yield* admission.admitDelegation({
                  root: managed.root,
                  threadId: thread,
                  messageId: "mcp-delegation:before",
                  work: yield* freshRead(world),
                });
                assert.strictEqual(before.type, "admitted");

                yield* Deferred.succeed(probe.gates.released.go, undefined);
                yield* Fiber.join(ticking);
                yield* notTerminalYet(managed);

                // After it, one is refused.
                assert.deepStrictEqual(
                  yield* admission.admitDelegation({
                    root: managed.root,
                    threadId: thread,
                    messageId: "mcp-delegation:after",
                    work: yield* freshRead(world),
                  }),
                  { type: "refused", category: "ended" },
                );

                yield* Deferred.succeed(probe.gates.admitted.go, undefined);
                yield* Fiber.join(admitting);
                yield* drainOrchestration;
                const run = (yield* runsOf(thread)).find(
                  (candidate) => candidate.userMessageId === turn.messageId,
                );
                assert.isDefined(run);
                yield* runReached(run!.id, ["starting", ...ended]);
                yield* drainOrchestration;

                // The delegation's handler commits its child, then its admission is marked.
                const child = yield* delegateFrom(thread, run!.id);
                if (before.type === "admitted") yield* admission.markDispatched(before.admitted);

                // Retirement waits for the child as well as the run.
                yield* world.endRun(run!.id, "completed");
                yield* tick;
                yield* notTerminalYet(managed);
                assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
                yield* world.endRun(child.runId, "completed");
                yield* drainOrchestration;
                yield* tick;
                assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
                yield* assertNothingHeld(managed.root, managed.assignmentId);
              }),
            ),
          { handoff: { probe: probe.probe }, automaticTurnGate: true },
        ),
      ),
  );

  it.live("a failing activity read keeps it ending until restored", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { managed } = yield* cancelledBeforeObserved(world);
          const restore = yield* failOutboxReads;
          yield* tick;
          yield* tick;
          yield* notTerminalYet(managed);
          assert.deepStrictEqual(yield* dispositionsOf(managed.root), []);
          yield* restore;
          yield* tick;
          assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
          yield* assertNothingHeld(managed.root, managed.assignmentId);
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live("a rebuild between the fence and the retirement converges", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { opened, managed } = yield* cancelledBeforeObserved(world);
          const record = { ran: [] as Array<string> };
          // The attempt commits only its fence, since the observation knows nothing.
          const restore = yield* failOutboxReads;
          yield* tick;
          yield* restore;
          yield* notTerminalYet(managed);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);

          yield* world.rebuild(
            Effect.gen(function* () {
              assert.deepStrictEqual(
                yield* consult(turns.usageLimitResume(opened.threadId, opened.runId), record),
                AutomaticTurnGate.notNow("declined"),
              );
              yield* tick;
              assert.strictEqual((yield* assignmentOf(managed.assignmentId)).state, "cancelled");
              assert.deepStrictEqual(yield* managedRootOf(managed.root), {
                state: "retired",
                reason: "cancelled",
              });
              yield* assertNothingHeld(managed.root, managed.assignmentId);
              assert.deepStrictEqual(record.ran, []);
              const rows = yield* dispositionsOf(managed.root);
              yield* tick;
              assert.deepStrictEqual(yield* dispositionsOf(managed.root), rows);
            }),
            { orchestration: true },
          );
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );
});
