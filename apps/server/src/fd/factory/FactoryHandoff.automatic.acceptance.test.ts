import { assert, describe, it, vi } from "@effect/vitest";
import { CommandId, type RunId, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { HandoffAdmission } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
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
  reviewPasses,
  runStarted,
  syncPullRequest,
  twoTaskPlan,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  askedOn,
  assertNothingHeld,
  assignmentOf,
  claimIdea,
  completionSteerFellBack,
  decisionWatch,
  deliverIdea,
  demandsOf,
  dispositionsOf,
  failOutboxReads,
  fill,
  grantOutcomesOf,
  managedRootOf,
  nativeOffers,
  noticesOf,
  offerNative,
  ownerEdits,
  ownerRestores,
  release,
  reviewerOf,
  runOfMessage,
  runsOf,
  runsOfMessage,
  runToPullRequest,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  usageLimitFailure,
  wakeThroughGate,
  withLimitSweep,
  withQuestionReactor,
} from "./testkit/handoff.ts";

// Real Git, verify commands and rebuilt servers on every path: a loaded machine only takes longer,
// and nothing here waits on time, so the limit is just where a real hang fails.
vi.setConfig({ testTimeout: 240_000 });

/**
 * Core's own follow-ups on a Factory family, produced by the real producers on the server's real
 * stack: its continuation worker's native wakes and results, its usage-limit sweep, its question
 * reactor, its restart recovery and pull request wakes as the watch presents them. Each one asks the
 * gate the assistant answers: with both slots held by others it creates no run, and when a slot
 * frees it runs one counted quantum. A restart keeps only what the database holds.
 */

const factoryService = Factory.FactoryService.FactoryService;

type Spy = ReturnType<typeof spyOnFactoryPort>;

/** Everything composed, with the admission's decisions visible to `watch`. */
const stack = (
  spy: Spy,
  watch: ReturnType<typeof decisionWatch>,
  extra: Parameters<typeof withProject>[2] = {},
) => ({
  handoff: { admission: watch.admission },
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
  ...extra,
});

/**
 * The turn's run is counted under the root's held slot until it ends; then a pass sees it ended,
 * releases the slot, and grants whatever waits next for its own quantum.
 */
const oneQuantum = (world: World, root: string, runId: RunId) =>
  Effect.gen(function* () {
    yield* runStarted(runId);
    assert.strictEqual((yield* slotOf(root))?.state, "held");
    yield* tick;
    assert.strictEqual((yield* slotOf(root))?.state, "held", "a running turn keeps its slot");
    yield* world.endRun(runId, "completed");
    yield* tick;
    assert.notStrictEqual((yield* slotOf(root))?.state, "held");
    assert.deepStrictEqual(yield* admissionsOf(root), []);
  });

const answerAsOwner = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`owner-answer:${requestId}`),
      threadId,
      requestId,
      answers: { format: "CSV" },
    }),
  ).pipe(Effect.orDie);

describe("a released family's follow-ups under full capacity", () => {
  it.live(
    "a native wake, a limit resume, PR feedback and a result create no run, then one quantum each",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withLimitSweep((sweep) =>
            Effect.gen(function* () {
              const { root, opened, thread } = yield* deliverIdea(world);
              const reviewer = yield* reviewerOf(root);
              const fillers = yield* fill(world, 2);
              const providerThread = yield* providerThreadOf(thread, opened.runId);
              const native = nativeOffers();
              const runs = (yield* runsOf(thread)).length;
              const reviewerRuns = (yield* runsOf(reviewer.thread)).length;
              const turnsBefore = world.provider.started.length;

              // The provider's background work, on its queue: the worker keeps it, as a demand.
              const wake = yield* offerNative(thread, providerThread, "plain", native);
              yield* watch.decided("background_wake", "demand");
              // The reviewer's turn ended on a usage limit: armed by a sweep, due at the next.
              yield* usageLimitFailure(reviewer.thread, reviewer.run);
              yield* sweep;
              yield* sweep;
              yield* watch.decided("usage_limit_resume", "demand");
              // The pull request's feedback, however often the watch asks.
              const link = yield* linkOf(thread, fakePullRequest.number);
              assert.deepStrictEqual(
                (yield* wakeThroughGate(thread, link)).outcome,
                AutomaticTurnGate.notNow("deferred"),
              );
              // The owner delegated on the thread; the delegate's result comes back.
              const ownerRun = yield* world.ownerTurn(thread, "Check the export before you merge.");
              const delegate = yield* delegateFrom(thread, ownerRun, "user");
              yield* world.endRun(ownerRun, "completed");
              yield* world.endRun(delegate.runId, "completed");
              yield* watch.decided("delegated_completion", "demand");

              // One demand each, in order, and no run but the owner's own.
              const waiting = yield* demandsOf(root);
              assert.deepStrictEqual(
                waiting.map(({ kind }) => kind),
                [
                  "background_wake",
                  "usage_limit_resume",
                  "pull_request_wake",
                  "delegated_completion",
                ],
              );
              yield* sweep;
              yield* wakeThroughGate(thread, link);
              yield* tick;
              assert.lengthOf(yield* demandsOf(root), 4);
              assert.isUndefined(yield* slotOf(root));
              assert.strictEqual((yield* runsOf(thread)).length, runs + 1);
              assert.strictEqual((yield* runsOf(reviewer.thread)).length, reviewerRuns);
              // Only the owner's turn and its delegate started anything with the provider.
              assert.strictEqual(world.provider.started.length, turnsBefore + 2);

              // A slot frees: the wake's kept dispatch, one quantum, in one slot.
              yield* release(fillers[0]!);
              yield* tick;
              const first = yield* runOfMessage(wake);
              assert.lengthOf(yield* demandsOf(root), 3);
              yield* oneQuantum(world, root, first);
              assert.lengthOf(yield* runsOfMessage(thread, wake), 1);

              // The resume is reserved, and the sweep's next pass runs it.
              assert.strictEqual((yield* slotOf(root))?.state, "reserved");
              yield* sweep;
              const resumed =
                (yield* runsOf(reviewer.thread)).at(-1) ?? assert.fail("No resume ran.");
              assert.isTrue(resumed.userMessageId.startsWith("limit-resume:"));
              assert.strictEqual((yield* runsOf(reviewer.thread)).length, reviewerRuns + 1);
              assert.lengthOf(yield* demandsOf(root), 2);
              yield* oneQuantum(world, root, resumed.id);

              // The pull request's feedback is reserved, and the watch's next pass is one round.
              assert.strictEqual((yield* slotOf(root))?.state, "reserved");
              const round = yield* wakeThroughGate(thread, link);
              assert.strictEqual(round.outcome._tag, "Ran");
              assert.lengthOf(yield* demandsOf(root), 1);
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              yield* drainFactory;
              yield* world.endRun(round.runId!, "completed");
              yield* reviewPasses(world, root);
              assert.strictEqual((yield* stateOf(root)).status, "pr_open");

              // Last, the result, offered on the shared queue again, into the next run.
              const result = (yield* demandsOf(root))[0]?.messageId ?? assert.fail("No result.");
              yield* tick;
              const delivering = yield* runOfMessage(result);
              yield* oneQuantum(world, root, delivering);
              assert.lengthOf(yield* runsOfMessage(thread, result), 1);

              assert.deepStrictEqual(yield* demandsOf(root), []);
              assert.isUndefined(yield* slotOf(root));
              assert.deepStrictEqual(native.dispatched, []);
              assert.deepStrictEqual(native.cleared, []);
            }),
          ),
        stack(spy, watch, { limits: { maxReviewRounds: 5 } }),
      );
    },
    300_000,
  );
});

describe("a restart's continuation of a Factory run", () => {
  /** Stops the server as a restart does: core's shutdown records what its provider still does. */
  const shutDown = Effect.gen(function* () {
    const recovery = yield* coreRecovery;
    yield* recovery.prepareForShutdown;
    yield* recovery.reconcile("shutdown");
  });

  it.live(
    "a run that settled with work outstanding has its continuation declined, keeping its note",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { root } = yield* claimIdea(world, "export");
            const author = yield* world.launched(root);
            const turn =
              world.provider.started.find((candidate) => candidate.runId === author.runId) ??
              assert.fail("The author's turn did not start.");
            yield* providerTurnRunning(author.threadId);
            // The run ends while a native subagent it started still works, so it settled.
            yield* world.provider.reportSubagent(turn, "running");
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* shutDown;

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                const runs = yield* runsOf(author.threadId);
                assert.isTrue(runs.every((run) => run.restartContinuationOfRunId !== author.runId));
                assert.isDefined(
                  runs.find((run) => run.id === author.runId)?.restartCancelledBackgroundWork,
                );
                // Declined, it waits as nothing: its note goes with the thread's next run.
                assert.deepStrictEqual(
                  (yield* demandsOf(root)).filter(({ kind }) => kind !== "effect"),
                  [],
                );
              }),
              { orchestration: true },
            );
          }),
        stack(spy, watch),
      );
    },
  );

  it.live("a root edited with a continuation pending declines it, creating no run", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* claimIdea(world, "export");
          const author = yield* world.launched(root);
          yield* providerTurnRunning(author.threadId);
          yield* ownerEdits(ref);
          yield* shutDown;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              yield* watch.decided("restart_continuation", "declined");
              yield* drainOrchestration;
              yield* drainFactory;
              const runs = yield* runsOf(author.threadId);
              assert.isTrue(runs.every((run) => run.restartContinuationOfRunId === undefined));
              assert.strictEqual(runs.length, 1);
              assert.lengthOf(
                world.provider.started.filter(({ threadId }) => threadId === author.threadId),
                1,
              );
              yield* tick;
              assert.deepStrictEqual(
                (yield* demandsOf(root)).filter(({ kind }) => kind !== "effect"),
                [],
              );
            }),
            { orchestration: true },
          );
        }),
      stack(spy, watch),
    );
  });
});

describe("a root edited while its pull request is idle", () => {
  // The test clock moves the blocked re-check's interval; nothing else here needs time to pass.
  it.effect("creates no run, and blocked work goes on only once it is restored", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { ref, root, opened, thread } = yield* deliverIdea(world);
          const providerThread = yield* providerThreadOf(thread, opened.runId);
          const native = nativeOffers();
          const link = yield* linkOf(thread, fakePullRequest.number);
          const runs = (yield* runsOf(thread)).length;
          yield* ownerEdits(ref);

          // Slots are free, but the fresh read fails each admitting outcome.
          const feedback = yield* wakeThroughGate(thread, link);
          assert.deepStrictEqual(feedback.outcome, AutomaticTurnGate.notNow("deferred"));
          const wake = yield* offerNative(thread, providerThread, "plain", native);
          yield* watch.decided("background_wake", "blocked");
          yield* tick;

          const blocked = yield* demandsOf(root);
          assert.deepStrictEqual(
            blocked.map(({ kind, blockedReason }) => [kind, blockedReason]),
            [
              ["pull_request_wake", "scope_changed"],
              ["background_wake", "scope_changed"],
            ],
          );
          assert.strictEqual((yield* runsOf(thread)).length, runs);
          assert.isUndefined(yield* slotOf(root));
          assert.isTrue(
            (yield* noticesOf("export")).some(
              (note) => note.includes("is blocked because") && note.includes("Work item changed"),
            ),
          );

          // An edit is nothing to rebind to: the next check, once due, finds it still changed.
          yield* TestClock.adjust("3 minutes");
          yield* tick;
          assert.isTrue(
            (yield* demandsOf(root)).every(
              ({ blockedReason }) => blockedReason === "scope_changed",
            ),
          );
          assert.strictEqual((yield* runsOf(thread)).length, runs);

          // Restored exactly, the next check due unblocks them, each for one quantum.
          yield* ownerRestores(ref);
          yield* tick;
          assert.isTrue(
            (yield* demandsOf(root)).every(
              ({ blockedReason }) => blockedReason === "scope_changed",
            ),
            "the re-check runs at most every two minutes",
          );
          yield* TestClock.adjust("3 minutes");
          yield* tick;
          assert.strictEqual((yield* slotOf(root))?.state, "reserved");
          const swept = yield* wakeThroughGate(thread, link);
          assert.strictEqual(swept.outcome._tag, "Ran");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* drainFactory;
          yield* world.endRun(swept.runId!, "completed");
          yield* reviewPasses(world, root);
          yield* tick;
          const kept = yield* runOfMessage(wake);
          yield* oneQuantum(world, root, kept);
          assert.deepStrictEqual(yield* demandsOf(root), []);
          assert.isUndefined(yield* slotOf(root));
        }),
      stack(spy, watch, { limits: { maxReviewRounds: 5 } }),
    );
  });
});

describe("a reservation its producer never comes back for", () => {
  // The test clock moves the lease; nothing else here needs time to pass.
  it.effect(
    "ends with its lease, so its slot is not lost, and the turn takes a fresh place",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          (() =>
            Effect.gen(function* () {
              const { root, thread } = yield* deliverIdea(world);
              const [filler] = yield* fill(world, 2);
              const link = yield* linkOf(thread, fakePullRequest.number);
              assert.deepStrictEqual(
                (yield* wakeThroughGate(thread, link)).outcome,
                AutomaticTurnGate.notNow("deferred"),
              );
              const runs = (yield* runsOf(thread)).length;
              yield* release(filler!);
              yield* tick;
              assert.strictEqual((yield* slotOf(root))?.state, "reserved");

              // The lease has time left: nothing else takes the slot, and it is not lost either.
              yield* TestClock.adjust("4 minutes");
              yield* tick;
              assert.strictEqual((yield* slotOf(root))?.state, "reserved");

              // Its producer stayed away: the lease ends, and with it the reservation and demand.
              yield* TestClock.adjust("2 minutes");
              yield* tick;
              assert.isUndefined(yield* slotOf(root));
              assert.deepStrictEqual(yield* demandsOf(root), []);
              assert.deepInclude(yield* grantOutcomesOf(root), {
                kind: "pull_request_wake",
                outcome: "expired",
              });
              assert.strictEqual((yield* runsOf(thread)).length, runs);

              // The watch's next sweep asks again, and takes a fresh place, running in one slot.
              const swept = yield* wakeThroughGate(thread, link);
              assert.strictEqual(swept.outcome._tag, "Ran");
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              yield* drainFactory;
              yield* world.endRun(swept.runId!, "completed");
              yield* reviewPasses(world, root);
              yield* tick;
              assert.isUndefined(yield* slotOf(root));
            }))(),
        stack(spy, watch, { limits: { maxReviewRounds: 5 } }),
      );
    },
  );
});

describe("an admission paused right after its commit", () => {
  it.live("keeps its slot against the release pass and every other grant", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
      const go = yield* Deferred.make<void>();
      const hold = { armed: false };
      yield* withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const { root, thread } = yield* deliverIdea(world);
            yield* fill(world, 1);
            const link = yield* linkOf(thread, fakePullRequest.number);

            hold.armed = true;
            const waking = yield* wakeThroughGate(thread, link).pipe(Effect.forkChild);
            const admitted = yield* Deferred.await(entered);
            hold.armed = false;
            assert.strictEqual(admitted.root, root);

            // Committed and not yet dispatched: no run yet, and nothing frees its slot.
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepStrictEqual(
              (yield* admissionsOf(root)).map(({ kind, state }) => [kind, state]),
              [["automatic_turn", "dispatching"]],
            );
            assert.strictEqual(yield* admission.release(root, admitted.entrySeq), "kept");
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            const next = yield* admission.next;
            assert.strictEqual(next.free, 0);
            assert.isUndefined(next.head);

            yield* Deferred.succeed(go, undefined);
            const { runId } = yield* Fiber.join(waking);
            assert.isDefined(runId);
            yield* drainFactory;
            assert.deepStrictEqual(
              (yield* admissionsOf(root)).map(({ kind, state }) => [kind, state]),
              [["automatic_turn", "dispatched"]],
            );
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* world.endRun(runId!, "completed");
            yield* reviewPasses(world, root);
            yield* tick;
            assert.isUndefined(yield* slotOf(root));
          }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
        stack(spy, watch, {
          handoff: {
            admission: watch.admission,
            probe: {
              admitted: (admitted) =>
                Effect.suspend(() =>
                  hold.armed && admitted.kind === "automatic_turn"
                    ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
                    : Effect.void,
                ),
              released: () => Effect.void,
              observed: () => Effect.void,
            },
          },
          limits: { maxReviewRounds: 5 },
        }),
      );
    });
  });
});

describe("a read of what the family is doing that fails", () => {
  it.live("withholds a parked root's release, and its completion, until it reads again", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* claimIdea(world, "export");
          const opened = yield* runToPullRequest(world, root);

          // At its open pull request, an unknown answer keeps the slot, and says why.
          const restoreRelease = yield* failOutboxReads;
          yield* tick;
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.isTrue(
            (yield* noticesOf("export")).some((note) => note.includes("could not be read")),
          );
          yield* restoreRelease;
          yield* tick;
          assert.isUndefined(yield* slotOf(root));

          // Merged and closed out, an unknown answer holds the assignment short of completed.
          yield* syncPullRequest(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
            "merged",
          );
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "done");
          const restore = yield* failOutboxReads;
          yield* tick;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "ending",
            reason: "completed",
          });
          yield* restore;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "completed");
          yield* assertNothingHeld(root, "export");
        }),
      stack(spy, watch),
    );
  });
});

const refuseMarks = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER acceptance_refuses_mark BEFORE UPDATE ON fd_factory_deliveries
    WHEN json_extract(NEW.state_json, '$.admissionWait') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
).pipe(Effect.orDie);
const allowMarks = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER acceptance_refuses_mark`,
).pipe(Effect.orDie);

describe("an effect's mark that could not be written", () => {
  /** A parent approved with both slots held by others, its effect's demand written, its mark not. */
  const unmarked = (world: World) =>
    Effect.gen(function* () {
      const factory = yield* factoryService;
      yield* startAssistantThread(world);
      const { root } = yield* claimIdea(world, "big", "parent");
      const planner = yield* world.launched(root);
      yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTaskPlan });
      yield* world.endRun(planner.runId, "completed");
      yield* tick;
      assert.isUndefined(yield* slotOf(root));
      const [filler] = yield* fill(world, 2);
      yield* refuseMarks;
      yield* factory.approvePlan(root);
      yield* drainFactory;
      const state = yield* stateOf(root);
      assert.notProperty(state, "admissionWait");
      assert.lengthOf(yield* demandsOf(root), 1);
      assert.deepStrictEqual(state.children, []);
      yield* allowMarks;
      return { root, filler: filler! };
    });

  const oneExecution = (root: Parameters<typeof stateOf>[0], filler: string) =>
    Effect.gen(function* () {
      yield* release(filler);
      yield* tick;
      yield* drainFactory;
      assert.lengthOf((yield* stateOf(root)).children, 2);
      assert.deepStrictEqual(yield* demandsOf(root), []);
      assert.strictEqual((yield* slotOf(root))?.state, "held");
      // Again changes nothing: it ran once.
      yield* tick;
      yield* drainFactory;
      assert.lengthOf((yield* stateOf(root)).children, 2);
    });

  it.live("recovers at once in the same process, running the effect once", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, filler } = yield* unmarked(world);
          yield* tick;
          assert.isDefined((yield* stateOf(root)).admissionWait);
          assert.deepStrictEqual((yield* stateOf(root)).children, []);
          yield* oneExecution(root, filler);
        }),
      stack(spy, watch),
    );
  });

  it.live("recovers after a rebuild through its demand, running the effect once", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, filler } = yield* unmarked(world);
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              const state = yield* stateOf(root);
              // The boot sweep found its demand, so it marked the effect rather than block it.
              assert.isDefined(state.admissionWait);
              assert.strictEqual(state.status, "running");
              yield* oneExecution(root, filler);
            }),
            { orchestration: true },
          );
        }),
      stack(spy, watch),
    );
  });
});

describe("a question a child asked, surviving a restart", () => {
  /**
   * A released family under full capacity whose owner-delegated child asks a question the provider
   * takes as a new turn: core's reactor presents it, and it waits as a demand. The child's turn
   * then ends with it unanswered, and its result waits behind the question. Only a question whose
   * turn has ended survives a restart.
   */
  const waitingQuestion = (world: World, watch: ReturnType<typeof decisionWatch>) =>
    Effect.gen(function* () {
      const { root, thread } = yield* deliverIdea(world);
      const ownerRun = yield* world.ownerTurn(thread, "Check the export before you merge.");
      const child = yield* delegateFrom(thread, ownerRun, "user");
      const [filler] = yield* fill(world, 2);
      const requestId = yield* askedOn(world, child.runId, "message");
      yield* watch.decided("delegated_question", "demand");
      const runs = (yield* runsOf(thread)).length;
      // The owner's own turn ends, so the reactor's wake would run at once if it could.
      yield* world.endRun(ownerRun, "completed");
      yield* world.endRun(child.runId, "completed");
      yield* watch.decided("delegated_completion", "demand");
      const [question, result] = yield* demandsOf(root);
      assert.strictEqual(question?.kind, "delegated_question");
      assert.strictEqual(question?.requestId, requestId);
      assert.strictEqual(result?.kind, "delegated_completion");
      assert.strictEqual((yield* runsOf(thread)).length, runs);
      return {
        root,
        thread,
        child,
        requestId,
        result: result?.messageId ?? assert.fail("The result names no message."),
        filler: filler!,
      };
    });

  const questionMessage = (thread: ThreadId, requestId: RuntimeRequestId) =>
    `message:delegated-task-question:${thread}:${requestId}`;

  it.live("is delivered once after the rebuild, in a slot of its own", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        withQuestionReactor(
          Effect.gen(function* () {
            const { root, thread, requestId, result, filler } = yield* waitingQuestion(
              world,
              watch,
            );
            yield* world.rebuild(
              withQuestionReactor(
                Effect.gen(function* () {
                  yield* drainOrchestration;
                  assert.deepStrictEqual(
                    (yield* demandsOf(root)).map(({ kind }) => kind),
                    ["delegated_question", "delegated_completion"],
                  );
                  yield* release(filler);
                  yield* tick;
                  const messageId = questionMessage(thread, requestId);
                  const run = yield* runOfMessage(messageId);
                  assert.strictEqual((yield* slotOf(root))?.state, "held");
                  assert.deepStrictEqual(
                    (yield* demandsOf(root)).map(({ kind }) => kind),
                    ["delegated_completion"],
                  );
                  yield* tick;
                  yield* tick;
                  assert.lengthOf(yield* runsOfMessage(thread, messageId), 1);
                  yield* oneQuantum(world, root, run);
                  assert.lengthOf(yield* runsOfMessage(thread, messageId), 1);
                  // The child's result then takes a quantum of its own.
                  yield* oneQuantum(world, root, yield* runOfMessage(result));
                  assert.deepStrictEqual(yield* demandsOf(root), []);
                  assert.isUndefined(yield* slotOf(root));
                }),
              ),
              { orchestration: true },
            );
          }),
        ),
      stack(spy, watch),
    );
  });

  it.live("is never delivered once the owner answered it first", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        withQuestionReactor(
          Effect.gen(function* () {
            const { root, thread, child, requestId, result, filler } = yield* waitingQuestion(
              world,
              watch,
            );
            yield* world.rebuild(
              withQuestionReactor(
                Effect.gen(function* () {
                  yield* drainOrchestration;
                  yield* answerAsOwner(child.childThreadId, requestId);
                  yield* drainOrchestration;
                  yield* release(filler);
                  yield* tick;
                  yield* drainOrchestration;
                  assert.deepStrictEqual(
                    yield* runsOfMessage(thread, questionMessage(thread, requestId)),
                    [],
                  );
                  assert.deepInclude(yield* grantOutcomesOf(root), {
                    kind: "delegated_question",
                    outcome: "moot",
                  });
                  // Its turn taken, the child's result runs in its own quantum, and nothing is left.
                  yield* oneQuantum(world, root, yield* runOfMessage(result));
                  assert.deepStrictEqual(
                    yield* runsOfMessage(thread, questionMessage(thread, requestId)),
                    [],
                  );
                  assert.deepStrictEqual(yield* demandsOf(root), []);
                  assert.isUndefined(yield* slotOf(root));
                  assert.deepStrictEqual(yield* admissionsOf(root), []);
                }),
              ),
              { orchestration: true },
            );
          }),
        ),
      stack(spy, watch),
    );
  });
});

describe("a completion steer that settled before its turn took it", () => {
  it.live("runs once after a rebuild, converging with core's boot re-offer", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, thread, opened } = yield* deliverIdea(world);
          const { fillers, messageId } = yield* completionSteerFellBack(
            world,
            watch,
            { deliveryId: root, threadId: opened.threadId },
            { root },
          );
          const before = (yield* demandsOf(root)).map(({ id, seq }) => [id, seq]);
          yield* watch.forget;

          yield* world.rebuild(
            Effect.gen(function* () {
              // Core offers the settled steer's cohort again at boot: the same demand, no run.
              yield* watch.decided("delegated_completion", "demand");
              yield* drainOrchestration;
              assert.deepStrictEqual(
                (yield* demandsOf(root)).map(({ id, seq }) => [id, seq]),
                before,
              );
              yield* tick;
              assert.isUndefined(yield* slotOf(root));
              assert.deepStrictEqual(yield* runsOfMessage(thread, messageId), []);

              yield* release(fillers[0]!);
              yield* tick;
              const run = yield* runOfMessage(messageId);
              yield* oneQuantum(world, root, run);
              assert.lengthOf(yield* runsOfMessage(thread, messageId), 1);
              assert.deepStrictEqual(yield* demandsOf(root), []);
            }),
            { orchestration: true },
          );
        }),
      stack(spy, watch),
    );
  });
});

describe("a native wake waiting at a restart", () => {
  it.live.each(["plain", "callbacks"] as const)(
    "ends with the lost notice and no leak (%s offer)",
    (shape) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, opened, thread } = yield* deliverIdea(world);
            const [filler] = yield* fill(world, 2);
            const native = nativeOffers();
            const wake = yield* offerNative(
              thread,
              yield* providerThreadOf(thread, opened.runId),
              shape,
              native,
            );
            yield* watch.decided("background_wake", "demand");
            const runs = (yield* runsOf(thread)).length;

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* tick;
                assert.deepStrictEqual(yield* demandsOf(root), []);
                assert.isUndefined(yield* slotOf(root));
                assert.deepStrictEqual(
                  (yield* dispositionsOf(root)).map(
                    ({ kind, outcome, adapter_clear, wake_key }) => [
                      kind,
                      outcome,
                      adapter_clear,
                      wake_key,
                    ],
                  ),
                  [["background_wake", "lost_on_restart", "unavailable", wake]],
                );
                assert.deepInclude(yield* grantOutcomesOf(root), {
                  kind: "background_wake",
                  outcome: "lost_on_restart",
                });
                assert.lengthOf(
                  (yield* noticesOf("export")).filter((note) =>
                    note.includes("the server restarted before it could continue"),
                  ),
                  1,
                );
                assert.strictEqual((yield* runsOf(thread)).length, runs);
                // The provider's memory is gone with it: nothing runs or clears the old offer.
                assert.deepStrictEqual(native.dispatched, []);
                assert.deepStrictEqual(native.cleared, []);

                // Nothing more comes of it, whatever frees up.
                yield* release(filler!);
                yield* tick;
                yield* tick;
                assert.deepStrictEqual(yield* demandsOf(root), []);
                assert.isUndefined(yield* slotOf(root));
                assert.lengthOf(yield* dispositionsOf(root), 1);
                assert.deepStrictEqual(yield* admissionsOf(root), []);
              }),
              { orchestration: true },
            );
          }),
        stack(spy, watch),
      );
    },
    240_000,
  );
});
