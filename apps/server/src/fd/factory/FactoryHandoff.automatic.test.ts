import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  coreRecovery,
  delegateFrom,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  linkOf,
  openSingle,
  ownerQueues,
  reviewPasses,
  runStarted,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  completionSteerFellBack,
  consult,
  consultRunning,
  decisionWatch,
  demandsOf,
  fill,
  manage,
  noticesOf,
  release,
  runOfMessage,
  runsOf,
  slotOf,
  tick,
  turns,
  wakeThroughGate,
} from "./testkit/handoff.ts";

/**
 * A released family's automatic work on the real stack, with both slots held by others: core's
 * producers present each turn to the gate, it waits as one demand with no run, and as capacity
 * frees each runs exactly one counted quantum. Only the owner's turns never wait.
 */

const gated = { handoff: {}, automaticTurnGate: true };

/** A governed item at its open pull request, released, both slots then held by others. */
const parkedFull = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openSingle(world);
    const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
    yield* tick;
    assert.isUndefined(yield* slotOf(managed.root));
    const fillers = yield* fill(world, 2);
    return { opened, managed, fillers };
  });

/**
 * The turn's run, counted under a held slot, ended; then a pass that sees it ended and releases the
 * slot, and grants whatever waits next for its own quantum.
 */
const endAndRelease = (world: World, root: string, runId: Parameters<World["endRun"]>[0]) =>
  Effect.gen(function* () {
    yield* runStarted(runId);
    assert.strictEqual((yield* slotOf(root))?.state, "held");
    yield* world.endRun(runId, "completed");
    yield* tick;
    assert.notStrictEqual((yield* slotOf(root))?.state, "held");
    assert.deepStrictEqual(yield* admissionsOf(root), []);
  });

describe("a released family's automatic work", () => {
  it.live(
    "factory and unknown native wakes, a limit resume and PR feedback wait, then each runs once",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { opened, managed, fillers } = yield* parkedFull(world);
            const thread = opened.threadId;
            const providerThread = yield* providerThreadOf(thread, opened.runId);
            const runs = (yield* runsOf(thread)).length;

            const factoryWake = turns.backgroundWake(thread, providerThread);
            const limit = turns.usageLimitResume(thread, opened.runId);
            assert.deepStrictEqual(
              yield* consultRunning(world, factoryWake),
              AutomaticTurnGate.notNow("deferred"),
            );
            assert.deepStrictEqual(
              yield* consultRunning(world, limit),
              AutomaticTurnGate.notNow("deferred"),
            );
            const link = yield* linkOf(thread, fakePullRequest.number);
            const feedback = yield* wakeThroughGate(thread, link);
            assert.deepStrictEqual(feedback.outcome, AutomaticTurnGate.notNow("deferred"));
            assert.isUndefined(feedback.runId);

            // The owner's turn on the same provider thread runs at once, and clouds what follows.
            const ownerRun = yield* world.ownerTurn(thread, "Rename the button.");
            assert.strictEqual((yield* runsOf(thread)).length, runs + 1);
            yield* world.endRun(ownerRun, "completed");
            const unknownWake = turns.backgroundWake(thread, providerThread);
            assert.deepStrictEqual(
              yield* consultRunning(world, unknownWake),
              AutomaticTurnGate.notNow("deferred"),
            );
            const waiting = yield* demandsOf(managed.root);
            assert.deepStrictEqual(
              waiting.map(({ kind, provenance }) => [kind, provenance]),
              [
                ["background_wake", "factory"],
                ["usage_limit_resume", "factory"],
                ["pull_request_wake", "factory"],
                ["background_wake", "unknown"],
              ],
            );
            assert.strictEqual((yield* runsOf(thread)).length, runs + 1);

            // Each kind's wait is said, the unknown origin included.
            yield* tick;
            const notes = yield* noticesOf(managed.assignmentId);
            assert.isTrue(notes.some((note) => note.includes("cannot tell whether it came")));
            assert.isTrue(notes.some((note) => note.includes("Pull request feedback on")));

            // A slot frees: the first in order is granted, and its kept dispatch runs once.
            yield* release(fillers[0]!);
            yield* tick;
            const first = yield* runOfMessage(factoryWake.messageId);
            assert.lengthOf(yield* demandsOf(managed.root), 3);
            yield* endAndRelease(world, managed.root, first);

            // Next: the resume reserved, and its producer's next pass runs it.
            assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");
            assert.strictEqual((yield* consultRunning(world, limit))._tag, "Ran");
            yield* drainOrchestration;
            const resumed = yield* runOfMessage(limit.messageId);
            yield* endAndRelease(world, managed.root, resumed);

            // Next: the pull request's feedback, in its producer's next sweep. Factory adopts it.
            assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");
            const swept = yield* wakeThroughGate(thread, link);
            assert.strictEqual(swept.outcome._tag, "Ran");
            assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
            yield* drainFactory;
            yield* world.endRun(swept.runId!, "completed");
            yield* reviewPasses(world, opened.deliveryId);
            assert.strictEqual((yield* stateOf(opened.deliveryId)).status, "pr_open");

            // Last: the wake of unknown origin, counted the same.
            yield* tick;
            const last = yield* runOfMessage(unknownWake.messageId);
            yield* endAndRelease(world, managed.root, last);
            assert.deepStrictEqual(yield* demandsOf(managed.root), []);
            for (const messageId of [
              factoryWake.messageId,
              limit.messageId,
              unknownWake.messageId,
            ]) {
              assert.lengthOf(
                (yield* runsOf(thread)).filter((run) => run.userMessageId === messageId),
                1,
              );
            }
          }),
        gated,
      ),
    240_000,
  );

  it.live("a result presented to a released family under full capacity runs one quantum", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          assert.isUndefined(yield* slotOf(managed.root));
          const thread = opened.threadId;
          const ownerRun = yield* world.ownerTurn(thread, "Check the export before you merge.");
          const delegate = yield* delegateFrom(thread, ownerRun, "user");
          const fillers = yield* fill(world, 2);
          yield* world.endRun(ownerRun, "completed");

          // Released, with both slots held by others: it waits, one demand and no run.
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "demand");
          const [demand] = yield* demandsOf(managed.root);
          assert.strictEqual(demand?.kind, "delegated_completion");
          assert.lengthOf(yield* demandsOf(managed.root), 1);
          const messageId = demand?.messageId ?? assert.fail("No completion waits.");
          const noRun = (yield* runsOf(thread)).filter((run) => run.userMessageId === messageId);
          assert.deepStrictEqual(noRun, []);
          assert.isUndefined(yield* slotOf(managed.root));

          yield* tick;
          assert.lengthOf(yield* demandsOf(managed.root), 1);
          assert.isUndefined(yield* slotOf(managed.root));

          // A slot frees: one grant, one run, counted under the family's slot until it ends.
          yield* release(fillers[0]!);
          yield* tick;
          const run = yield* runOfMessage(messageId);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          yield* endAndRelease(world, managed.root, run);
          assert.isUndefined(yield* slotOf(managed.root));
          assert.lengthOf(
            (yield* runsOf(thread)).filter((row) => row.userMessageId === messageId),
            1,
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a steered result that fell back on a released family runs one quantum", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          const { fillers, messageId } = yield* completionSteerFellBack(
            world,
            watch,
            opened,
            managed,
          );
          yield* tick;
          assert.lengthOf(yield* demandsOf(managed.root), 1);
          assert.isUndefined(yield* slotOf(managed.root));

          yield* release(fillers[0]!);
          yield* tick;
          const run = yield* runOfMessage(messageId);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          yield* endAndRelease(world, managed.root, run);
          assert.isUndefined(yield* slotOf(managed.root));
          assert.lengthOf(
            (yield* runsOf(opened.threadId)).filter((row) => row.userMessageId === messageId),
            1,
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a delegated result waits while its root holds, and runs once after release", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          yield* fill(world, 1);
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "demand");
          const [demand] = yield* demandsOf(managed.root);
          assert.strictEqual(demand?.kind, "delegated_completion");
          const messageId = demand?.messageId ?? assert.fail("No completion message.");

          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* reviewPasses(world, author.deliveryId);
          yield* tick;
          yield* tick;
          const run = yield* runOfMessage(messageId);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          yield* endAndRelease(world, managed.root, run);
          assert.lengthOf(
            (yield* runsOf(author.threadId)).filter((row) => row.userMessageId === messageId),
            1,
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a steered result whose target ended first waits as its demand, and runs once", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId);
          yield* fill(world, 1);
          const authorTurn =
            world.provider.started.find((candidate) => candidate.runId === author.runId) ??
            assert.fail("The author's turn did not start.");
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          // The result is admitted at the free head and steered into the author's running turn.
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "admitted");
          assert.strictEqual((yield* slotOf(managed.root))?.state, "held");

          // The author's turn ends before the steer reaches its provider: the follow-up waits.
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.provider.endTurn(authorTurn, "completed");
          yield* runReached(author.runId, ["waiting", ...ended]);
          yield* drainOrchestration;
          yield* watch.decided("delegated_completion", "demand");
          const [demand] = yield* demandsOf(managed.root);
          assert.strictEqual(demand?.kind, "delegated_completion");
          const messageId = demand?.messageId ?? assert.fail("No completion message.");
          yield* drainFactory;

          yield* reviewPasses(world, author.deliveryId);
          assert.strictEqual((yield* stateOf(author.deliveryId)).status, "pr_open");
          yield* tick;
          yield* tick;
          const run = yield* runOfMessage(messageId);
          yield* endAndRelease(world, managed.root, run);
          assert.lengthOf(
            (yield* runsOf(author.threadId)).filter((row) => row.userMessageId === messageId),
            1,
          );
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live(
    "an owned child still at work keeps the family held, and its question lands there",
    () => {
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, author.deliveryId);
            assert.strictEqual((yield* stateOf(author.deliveryId)).status, "pr_open");

            // Parked, but its delegate works on: the slot stays, and the wait is said.
            yield* tick;
            assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
            assert.isTrue(
              (yield* noticesOf(managed.assignmentId)).some((note) =>
                note.includes("still running"),
              ),
            );

            // The other slot taken, the child's question still lands in the family's own holding.
            yield* fill(world, 1);
            const ran: Array<string> = [];
            const question = turns.delegatedQuestion(
              author.threadId,
              { childThreadId: delegate.childThreadId, taskId: delegate.taskId },
              author.runId,
            );
            assert.deepStrictEqual(
              yield* consult(question, { ran }),
              AutomaticTurnGate.ran(undefined),
            );
            assert.deepStrictEqual(ran, [question.messageId]);
            assert.deepStrictEqual(yield* demandsOf(managed.root), []);

            // The child ends, and its result waits for a grant of its own once the family is quiet.
            yield* world.endRun(delegate.runId, "completed");
            yield* watch.decided("delegated_completion", "demand");
            const messageId =
              (yield* demandsOf(managed.root))[0]?.messageId ?? assert.fail("No completion waits.");
            yield* tick;
            const result = yield* runOfMessage(messageId);
            yield* endAndRelease(world, managed.root, result);
            assert.isUndefined(yield* slotOf(managed.root));
            assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          }),
        { ...gated, handoff: { admission: watch.admission } },
      );
    },
  );

  it.live("the owner's turns and what proves its own origin never wait", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { opened, managed } = yield* parkedFull(world);
          const thread = opened.threadId;
          const queued = yield* ownerQueues(thread, "Rename the button.");
          yield* runStarted(queued);
          // What the owner's own run carries on is the owner's, wherever capacity stands.
          const ran: Array<string> = [];
          const resume = turns.usageLimitResume(thread, queued);
          assert.deepStrictEqual(yield* consult(resume, { ran }), AutomaticTurnGate.ran(undefined));
          assert.deepStrictEqual(ran, [resume.messageId]);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          assert.isUndefined(yield* slotOf(managed.root));
          yield* world.endRun(queued, "completed");
        }),
      gated,
    ),
  );

  it.live("after a rebuild a completed run's continuation is declined, keeping its note", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          const turn =
            world.provider.started.find((candidate) => candidate.runId === author.runId) ??
            assert.fail("The author's turn did not start.");
          yield* providerTurnRunning(author.threadId);
          // The run ends while a native subagent it started still works.
          yield* world.provider.reportSubagent(turn, "running");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const recovery = yield* coreRecovery;
          yield* recovery.prepareForShutdown;
          yield* recovery.reconcile("shutdown");
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              yield* drainFactory;
              const runs = yield* runsOf(author.threadId);
              assert.isTrue(runs.every((run) => run.restartContinuationOfRunId !== author.runId));
              const source = runs.find((run) => run.id === author.runId);
              assert.isDefined(source?.restartCancelledBackgroundWork);
              assert.deepStrictEqual(
                (yield* demandsOf(managed.root)).map(({ kind }) => kind),
                [],
              );
            }),
            { orchestration: true },
          );
        }),
      gated,
    ),
  );
});
