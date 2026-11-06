import { assert, describe, it, vi } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import * as AssistantHandoff from "../assistant-handoff/index.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  agentSends,
  delegateFrom,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  linkOf,
  ownerQueues,
  runStarted,
  syncPullRequest,
  threadShell,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  agreeAndCapture,
  askedOn,
  assertNothingHeld,
  assignmentOf,
  assignToFactory,
  authorizeIdea,
  consultRunning,
  consultWatch,
  controlAssignment,
  decisionWatch,
  deliverIdea,
  demandsOf,
  dispositionsOf,
  driver,
  failOutboxReads,
  fill,
  grantOutcomesOf,
  handoffRows,
  keptFor,
  makeRetirementProbe,
  managedRootOf,
  nativeOffers,
  noticesOf,
  offerNative,
  ownerEdits,
  questionTask,
  release,
  reviewerOf,
  rootIdOf,
  rootRowOf,
  runOfMessage,
  runsOf,
  runsOfMessage,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  turns,
  turnsWithoutThreads,
  usageLimitFailure,
  wakeThroughGate,
  withLimitSweep,
  withQuestionReactor,
} from "./testkit/handoff.ts";
import { withEndpoint } from "./testkit/mcpEndpoint.ts";

// Real Git, verify commands and rebuilt servers on every path: a loaded machine only takes longer,
// and nothing here waits on time, so the limit is just where a real hang fails.
vi.setConfig({ testTimeout: 240_000 });

/**
 * A governed root's end on the server's real stack, with both slots held by others: everything of
 * every kind that waited on it, from the real producers, ends with one disposition and one notice
 * per key, nothing runs and nothing is left, whatever restarts. What arrives late takes the same
 * path, and a retirement racing an admission never leaves a terminal assignment beside live work.
 */

const factoryService = Factory.FactoryService.FactoryService;
const text = AssistantHandoff.callerPolicyText;

type Spy = ReturnType<typeof spyOnFactoryPort>;

const stack = (
  spy: Spy,
  watch: ReturnType<typeof decisionWatch>,
  consults: ReturnType<typeof consultWatch>,
  extra: Parameters<typeof withProject>[2] = {},
) => ({
  handoff: { admission: watch.admission },
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
  gateConsults: consults.gateConsults,
  ...extra,
});

type Outcome = "done" | "owner-cancel" | "closed-unmerged";

const reasonOf = { done: "completed", "owner-cancel": "cancelled", "closed-unmerged": "cancelled" };

/** Takes the delivery to the terminal outcome, as its owner, its host or its merge does. */
const endDelivery = (outcome: Outcome, root: FactoryDeliveryId, thread: ThreadId) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    if (outcome === "owner-cancel") {
      yield* factory.cancel(root).pipe(Effect.orDie);
    } else {
      yield* syncPullRequest(
        thread,
        yield* linkOf(thread, fakePullRequest.number),
        outcome === "done" ? "merged" : "closed",
      );
    }
    yield* drainFactory;
    yield* drainOrchestration;
    assert.strictEqual((yield* stateOf(root)).status, outcome === "done" ? "done" : "cancelled");
  });

/** Every family thread's run count, to compare steps that must start nothing. */
const familyRuns = (threads: ReadonlyArray<ThreadId>) =>
  Effect.forEach(threads, (threadId) => Effect.map(runsOf(threadId), (runs) => runs.length));

/**
 * What a terminal outcome's retirement must leave: its root retired, having gone through ending,
 * its assignment at its end, one disposition per key and nothing held or waiting.
 */
const retiredAsExpected = (root: FactoryDeliveryId, outcome: Outcome, dispositions: number) =>
  Effect.gen(function* () {
    const row = yield* rootRowOf(root);
    assert.deepStrictEqual(
      { state: row.state, reason: row.reason },
      { state: "retired", reason: reasonOf[outcome] },
    );
    assert.isNotNull(row.ending_at);
    assert.strictEqual(
      (yield* assignmentOf("export")).state,
      outcome === "done" ? "completed" : "cancelled",
    );
    yield* assertNothingHeld(root, "export");
    assert.lengthOf(yield* dispositionsOf(root), dispositions);
    assert.lengthOf(
      (yield* noticesOf("export")).filter((note) => note.includes("after this assignment ended")),
      dispositions,
    );
  });

/** What a repeat of the tick or a rebuild must leave as it found it. */
const unchangedAcrossTwoRebuilds = (
  world: World,
  check: Effect.Effect<void, never, Orchestrator.OrchestratorV2>,
) =>
  Effect.gen(function* () {
    const rows = yield* handoffRows;
    const notices = yield* noticesOf("export");
    const same = Effect.gen(function* () {
      yield* drainOrchestration;
      yield* tick;
      yield* tick;
      assert.deepStrictEqual(yield* handoffRows, rows);
      assert.deepStrictEqual(yield* noticesOf("export"), notices);
      yield* check;
    });
    yield* same;
    yield* world.rebuild(
      Effect.gen(function* () {
        yield* same;
        yield* world.rebuild(same, { orchestration: true });
      }),
      { orchestration: true },
    );
  });

describe("a governed root reaching a terminal outcome, with both slots held by others", () => {
  it.live.each(
    (["waiting", "scope-blocked"] as const).flatMap((mode) => [
      { mode, outcome: "done" as const },
      { mode, outcome: "owner-cancel" as const },
      { mode, outcome: "closed-unmerged" as const },
    ]),
  )(
    "$outcome with one demand of every kind $mode: zero runs, and one disposition per key",
    ({ mode, outcome }) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      const decision = mode === "waiting" ? "demand" : "blocked";
      return withProject(
        verifyCommands.passes,
        (world) =>
          withLimitSweep((sweep) =>
            withQuestionReactor(
              Effect.gen(function* () {
                const admission = yield* HandoffAdmission.HandoffAdmission;
                const { ref, root, opened, thread } = yield* deliverIdea(world);
                const reviewer = yield* reviewerOf(root);
                if (mode === "waiting") yield* fill(world, 2);
                else yield* ownerEdits(ref);

                // The owner's turn delegates a task, which asks a question and then ends.
                const ownerRun = yield* world.ownerTurn(thread, "Check it before you merge.");
                const child = yield* delegateFrom(thread, ownerRun, "user");
                const question = yield* askedOn(world, child.runId, "message");
                yield* watch.decided("delegated_question", decision);
                yield* world.endRun(ownerRun, "completed");
                yield* world.endRun(child.runId, "completed");
                yield* watch.decided("delegated_completion", decision);

                // Native wakes of both shapes, on provider threads of their own, kept.
                const native = nativeOffers();
                const clearable = yield* offerNative(
                  thread,
                  yield* providerThreadOf(thread, opened.runId),
                  "callbacks",
                  native,
                );
                yield* watch.decided("background_wake", decision);
                yield* watch.forget;
                yield* offerNative(
                  reviewer.thread,
                  yield* providerThreadOf(reviewer.thread, reviewer.run),
                  "plain",
                  native,
                );
                yield* watch.decided("background_wake", decision);

                // Pull request feedback, and a resume the limit sweep finds due.
                const link = yield* linkOf(thread, fakePullRequest.number);
                assert.deepStrictEqual(
                  (yield* wakeThroughGate(thread, link)).outcome,
                  AutomaticTurnGate.notNow("deferred"),
                );
                yield* usageLimitFailure(reviewer.thread, reviewer.run);
                yield* sweep;
                yield* sweep;
                yield* watch.decided("usage_limit_resume", decision);
                if (mode !== "waiting") yield* fill(world, 2);

                // An effect's demand too: its history retires, with no disposition.
                yield* admission.ensureEffectDemand({
                  root,
                  deliveryId: root,
                  effectId: 999,
                });

                const waiting = yield* demandsOf(root);
                assert.deepStrictEqual(waiting.map(({ kind }) => kind).toSorted(), [
                  "background_wake",
                  "background_wake",
                  "delegated_completion",
                  "delegated_question",
                  "effect",
                  "pull_request_wake",
                  "usage_limit_resume",
                ]);
                assert.isTrue(
                  waiting
                    .filter(({ kind }) => kind !== "effect")
                    .every(({ blockedReason }) =>
                      mode === "waiting" ? blockedReason === null : blockedReason !== null,
                    ),
                );
                const threads = [thread, reviewer.thread, child.childThreadId];
                const runs = yield* familyRuns(threads);
                const turnsBefore = world.provider.started.length;

                yield* endDelivery(outcome, root, thread);
                yield* tick;

                // Nothing ran, and each key has its one disposition and one notice.
                yield* retiredAsExpected(root, outcome, 6);
                const dispositions = yield* dispositionsOf(root);
                assert.deepStrictEqual(
                  dispositions.map(({ kind }) => kind),
                  [
                    "background_wake",
                    "background_wake",
                    "delegated_completion",
                    "delegated_question",
                    "pull_request_wake",
                    "usage_limit_resume",
                  ],
                );
                assert.deepStrictEqual(
                  dispositions
                    .filter(({ kind }) => kind === "background_wake")
                    .map(({ adapter_clear }) => adapter_clear)
                    .toSorted(),
                  ["requested", "unavailable"],
                );
                // The kept dispatches are gone: only the offer that can be cleared was cleared.
                assert.deepStrictEqual(native.cleared, [clearable]);
                assert.deepStrictEqual(native.dispatched, []);
                assert.deepInclude(yield* grantOutcomesOf(root), {
                  kind: "effect",
                  outcome: "retired",
                });
                assert.deepStrictEqual(yield* familyRuns(threads), runs);
                assert.strictEqual(world.provider.started.length, turnsBefore);
                // The question stays with its thread for the owner.
                const { runtimeRequests } = yield* threadProjection(child.childThreadId);
                assert.strictEqual(
                  runtimeRequests.find(({ id }) => id === question)?.status,
                  "pending",
                );

                // Its sweep, its watch and two rebuilds add nothing.
                yield* sweep;
                assert.strictEqual(
                  (yield* threadShell(reviewer.thread)).limitRecovery?.autoResume,
                  false,
                );
                yield* unchangedAcrossTwoRebuilds(
                  world,
                  Effect.gen(function* () {
                    assert.deepStrictEqual(native.cleared, [clearable]);
                    assert.deepStrictEqual(native.dispatched, []);
                    assert.deepStrictEqual(yield* familyRuns(threads), runs);
                    assert.strictEqual(world.provider.started.length, turnsBefore);
                  }).pipe(Effect.orDie),
                );
              }),
            ),
          ),
        stack(spy, watch, consults),
      );
    },
    300_000,
  );

  it.live.each(["waiting", "scope-blocked"] as const)(
    "a pre-delivery refusal with every kind %s retires it failed, disposing of what waits",
    (mode) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            yield* startAssistantThread(world);
            yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            // Claimed, and held by a filler with it, so the other slot is taken too.
            const root = "7e2aa85e-9347-44ce-b019-cb8dfd365b22" as FactoryDeliveryId;
            const claimed = yield* admission.claim({ assignmentId: "export", deliveryId: root });
            if (claimed.type !== "claimed") return assert.fail("The assignment was not claimed.");
            yield* admission.markDispatched(claimed.admitted);
            yield* fill(world, 1);

            // No thread of a delivery that never was can reach the gate, which finds no family:
            // what its manager would be asked is asked of the admission directly.
            const dropped: Array<string> = [];
            if (mode === "scope-blocked") yield* authorizeIdea(world, "export", false);
            const waiting = turnsWithoutThreads("seeded");
            for (const turn of waiting) {
              const decided = yield* admission.decideTurn({
                root,
                provenance: turn.kind === "delegated_question" ? "unknown" : "factory",
                turn,
                ...keptFor(turn, dropped),
              });
              assert.strictEqual(
                decided.type,
                mode === "waiting" ? "demand" : "blocked",
                turn.kind,
              );
            }
            if (mode === "scope-blocked") yield* authorizeIdea(world, "export");
            yield* admission.ensureEffectDemand({ root, deliveryId: root, effectId: 999 });

            spy.control.onStart = () =>
              Effect.fail(
                new HandoffBackend.HandoffFactoryRefused({
                  operation: "start",
                  reason: "no_base_commit",
                }),
              );
            yield* tick;
            spy.control.onStart = undefined;
            assert.strictEqual(spy.count("start"), 1);
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");
            const row = yield* rootRowOf(root);
            assert.deepStrictEqual(
              { state: row.state, reason: row.reason },
              { state: "retired", reason: "failed" },
            );
            yield* assertNothingHeld(root, "export");
            const dispositions = yield* dispositionsOf(root);
            assert.lengthOf(dispositions, waiting.length);
            assert.lengthOf(
              (yield* noticesOf("export")).filter((note) =>
                note.includes("after this assignment ended"),
              ),
              waiting.length,
            );
            assert.deepStrictEqual(
              dispositions
                .filter(({ kind }) => kind === "background_wake")
                .map(({ adapter_clear }) => adapter_clear),
              ["requested", "unavailable"],
            );
            const clearable =
              waiting.find((turn) => turn.kind === "background_wake" && turn.clearable)
                ?.messageId ?? assert.fail("No clearable wake was seeded.");
            assert.deepStrictEqual(dropped, [clearable]);

            // Whatever arrives late is declined, and adds nothing, across two rebuilds.
            const rows = yield* handoffRows;
            const notices = yield* noticesOf("export");
            const late = [...waiting, ...turnsWithoutThreads("late")];
            const firstPass = Effect.gen(function* () {
              const current = yield* HandoffAdmission.HandoffAdmission;
              for (const turn of late.slice(waiting.length)) {
                const decided = yield* current.decideTurn({ root, provenance: "factory", turn });
                assert.strictEqual(decided.type, "declined", turn.kind);
              }
            });
            yield* firstPass;
            const settledRows = yield* handoffRows;
            const settledNotices = yield* noticesOf("export");
            assert.lengthOf(settledNotices, notices.length + waiting.length);
            const present = Effect.gen(function* () {
              const current = yield* HandoffAdmission.HandoffAdmission;
              for (const turn of late) {
                const decided = yield* current.decideTurn({
                  root,
                  provenance: "factory",
                  turn,
                });
                assert.strictEqual(decided.type, "declined", turn.kind);
              }
              yield* tick;
              assert.deepStrictEqual(yield* handoffRows, settledRows);
              assert.deepStrictEqual(yield* noticesOf("export"), settledNotices);
            });
            yield* present;
            assert.notDeepEqual(settledRows, rows);
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* present;
                yield* world.rebuild(present, { orchestration: true });
              }),
              { orchestration: true },
            );
          }),
        stack(spy, watch, consults),
      );
    },
    240_000,
  );
});

describe("what arrives after a delivery's end", () => {
  it.live.each([
    { outcome: "done" as const, origin: "factory" as const },
    { outcome: "owner-cancel" as const, origin: "factory" as const },
    { outcome: "closed-unmerged" as const, origin: "unknown" as const },
  ])(
    "$outcome: each late turn of $origin origin is declined once, and the limit resume disarmed",
    ({ outcome, origin }) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withLimitSweep((sweep) =>
            withQuestionReactor(
              Effect.gen(function* () {
                const { root, opened, thread } = yield* deliverIdea(world);
                const reviewer = yield* reviewerOf(root);
                const link = yield* linkOf(thread, fakePullRequest.number);
                yield* fill(world, 2);
                const providerThread = yield* providerThreadOf(thread, opened.runId);
                // An owner's turn on the provider thread leaves a late wake's origin unknown.
                if (origin === "unknown") {
                  yield* world.endRun(
                    yield* world.ownerTurn(thread, "Rename the button."),
                    "completed",
                  );
                }
                // Armed before the end: a sweep arms it, and the next would find it due.
                yield* usageLimitFailure(reviewer.thread, reviewer.run);
                yield* sweep;
                assert.strictEqual(
                  (yield* threadShell(reviewer.thread)).limitRecovery?.autoResume,
                  true,
                );

                // Factory's watch release fails, so core's sweep keeps presenting the wake.
                if (outcome === "owner-cancel") {
                  world.factoryDispatch.before = (command) =>
                    command.type === "thread.pull-request-watch.sync"
                      ? Effect.die("The watch release failed.")
                      : Effect.void;
                }
                yield* endDelivery(outcome, root, thread);
                world.factoryDispatch.before = undefined;
                yield* tick;
                yield* retiredAsExpected(root, outcome, 0);
                const threads = [thread, reviewer.thread];
                const runs = yield* familyRuns(threads);

                // Native wakes of both shapes, on one provider thread: one disposition between them.
                const native = nativeOffers();
                const clearable = yield* offerNative(thread, providerThread, "callbacks", native);
                yield* consults.ended(clearable);
                yield* consults.ended(yield* offerNative(thread, providerThread, "plain", native));
                assert.deepStrictEqual(native.cleared, [clearable]);
                assert.deepStrictEqual(native.dispatched, []);

                // The limit resume, due: declined once, disarmed by its worker, and asked no more.
                const presented = watch.presentations("usage_limit_resume");
                yield* sweep;
                assert.strictEqual(yield* presented, 1);
                const disarmed = (yield* threadShell(reviewer.thread)).limitRecovery;
                assert.strictEqual(disarmed?.autoResume, false);
                assert.include(disarmed?.requestId ?? "", "limit-disarm:");
                yield* sweep;
                yield* sweep;
                assert.strictEqual(yield* presented, 1);

                // Pull request feedback, whose watch can still be going.
                let expected = 2;
                if (outcome === "owner-cancel") {
                  const wake = yield* wakeThroughGate(thread, link);
                  assert.deepStrictEqual(wake.outcome, AutomaticTurnGate.notNow("declined"));
                  assert.isUndefined(wake.runId);
                  expected += 1;
                }
                assert.deepStrictEqual(yield* familyRuns(threads), runs);

                // The owner's own message runs at once, under full capacity: nothing gates it.
                const ownerRun = yield* ownerQueues(reviewer.thread, "Check the header once more.");
                assert.strictEqual(yield* slotOf(root), undefined);
                assert.deepStrictEqual(yield* admissionsOf(root), []);
                if (outcome === "done") {
                  // Its worktree went with the close-out, so no turn starts there to delegate from:
                  // a question and a result arrive late as their producers present them.
                  const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
                  const task = { childThreadId: reviewer.thread, taskId: questionTask };
                  for (const turn of [
                    turns.delegatedQuestion(reviewer.thread, task, reviewer.run),
                    turns.delegatedCompletion(reviewer.thread, reviewer.run, providerThread),
                  ]) {
                    assert.deepStrictEqual(
                      yield* gate.admit(turn, Effect.die("A late turn never runs.")),
                      AutomaticTurnGate.notNow("declined"),
                    );
                    expected += 1;
                  }
                } else {
                  // The cancelled delivery's worktree stays: the turn delegates a child of its own,
                  // whose question and result are declined and stay in the child's thread.
                  yield* runStarted(ownerRun);
                  const child = yield* delegateFrom(reviewer.thread, ownerRun, "user");
                  yield* askedOn(world, child.runId, "message");
                  yield* watch.decided("delegated_question", "declined");
                  expected += 1;
                  yield* world.endRun(ownerRun, "completed");
                  yield* world.endRun(child.runId, "completed");
                  yield* watch.decided("delegated_completion", "declined");
                  expected += 1;
                }

                yield* retiredAsExpected(root, outcome, expected);
                const after = yield* familyRuns(threads);
                assert.deepStrictEqual(after, [runs[0]!, runs[1]! + 1]);
                const rows = yield* handoffRows;
                const notices = yield* noticesOf("export");

                // Rebuilt twice, core's boot re-offers what is open, and it is declined again.
                const asked = watch.presentations("delegated_completion");
                const before = yield* asked;
                yield* watch.forget;
                yield* world.rebuild(
                  withQuestionReactor(
                    Effect.gen(function* () {
                      if (outcome !== "done") {
                        yield* watch.decided("delegated_completion", "declined");
                        assert.isAbove(yield* asked, before);
                      }
                      yield* drainOrchestration;
                      yield* tick;
                      assert.deepStrictEqual(yield* handoffRows, rows);
                      assert.deepStrictEqual(yield* noticesOf("export"), notices);
                      assert.deepStrictEqual(yield* familyRuns(threads), after);
                      yield* withLimitSweep((rebuilt) =>
                        Effect.gen(function* () {
                          yield* rebuilt;
                          assert.strictEqual(yield* presented, 1);
                        }),
                      );
                      yield* world.rebuild(
                        Effect.gen(function* () {
                          yield* drainOrchestration;
                          yield* tick;
                          assert.deepStrictEqual(yield* handoffRows, rows);
                          assert.deepStrictEqual(yield* noticesOf("export"), notices);
                          assert.deepStrictEqual(yield* familyRuns(threads), after);
                        }),
                        { orchestration: true },
                      );
                    }),
                  ),
                  { orchestration: true },
                );
              }),
            ),
          ),
        stack(spy, watch, consults),
      );
    },
    300_000,
  );

  it.live(
    "after a retry the old root's wakes stay declined, and the new root's are counted",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root: oldRoot, opened, thread } = yield* deliverIdea(world);
            yield* controlAssignment("export", "cancel");
            yield* drainFactory;
            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
            assert.deepStrictEqual(yield* managedRootOf(oldRoot), {
              state: "retired",
              reason: "cancelled",
            });

            const retried = yield* controlAssignment("export", "retry");
            assert.strictEqual(retried.state, "queued");
            yield* tick;
            const newRoot = yield* rootIdOf("export");
            assert.notStrictEqual(newRoot, oldRoot);
            const author = yield* world.launched(newRoot);
            assert.deepStrictEqual(yield* managedRootOf(newRoot), {
              state: "active",
              reason: null,
            });
            // Its deliveries: the old as it ended, the new one running, under the one assignment.
            assert.strictEqual((yield* stateOf(oldRoot)).status, "cancelled");
            assert.strictEqual((yield* stateOf(newRoot)).status, "running");
            yield* fill(world, 1);

            const native = nativeOffers();
            const oldProvider = yield* providerThreadOf(thread, opened.runId);
            const oldRuns = (yield* runsOf(thread)).length;
            const presentOld = Effect.gen(function* () {
              yield* consults.ended(yield* offerNative(thread, oldProvider, "callbacks", native));
              assert.strictEqual((yield* runsOf(thread)).length, oldRuns);
            });
            yield* presentOld;
            assert.lengthOf(yield* dispositionsOf(oldRoot), 1);

            // The new root holds its slot; its wake waits for a grant of its own, and is counted.
            const wake = yield* offerNative(
              author.threadId,
              yield* providerThreadOf(author.threadId, author.runId),
              "plain",
              native,
            );
            yield* consults.ended(wake);
            assert.deepStrictEqual(
              (yield* demandsOf(newRoot)).map(({ kind, messageId }) => [kind, messageId]),
              [["background_wake", wake]],
            );
            assert.deepStrictEqual(yield* demandsOf(oldRoot), []);
            assert.strictEqual((yield* slotOf(newRoot))?.state, "held");
            assert.deepStrictEqual(yield* runsOfMessage(author.threadId, wake), []);

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* presentOld;
                assert.lengthOf(yield* dispositionsOf(oldRoot), 1);
                assert.deepStrictEqual(
                  (yield* noticesOf("export")).filter((note) =>
                    note.includes("finished after this assignment ended"),
                  ).length,
                  1,
                );
              }),
            );
          }),
        stack(spy, watch, consults),
      );
    },
  );
});

const shapes = ["native-plain", "native-callbacks", "completion", "question"] as const;

describe("a pull request closed unmerged, racing an automatic admission", () => {
  /** A governed item at its open pull request, Work Ready and no control set, then closed. */
  const closedBeforeObserved = (world: World) =>
    Effect.gen(function* () {
      const delivered = yield* deliverIdea(world);
      assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
      yield* syncPullRequest(
        delivered.thread,
        yield* linkOf(delivered.thread, fakePullRequest.number),
        "closed",
      );
      yield* drainFactory;
      assert.strictEqual((yield* stateOf(delivered.root)).status, "cancelled");
      return {
        ...delivered,
        providerThread: yield* providerThreadOf(delivered.thread, delivered.opened.runId),
      };
    });

  /** Nothing terminal while something of the root still counts. */
  const notTerminalYet = (root: string) =>
    Effect.gen(function* () {
      assert.notInclude(
        ["completed", "cancelled", "failed"],
        (yield* assignmentOf("export")).state,
      );
      assert.strictEqual((yield* managedRootOf(root))?.state, "ending");
    });

  describe.each([{ stage: "released" as const }, { stage: "observed" as const }])(
    "with an admission at the $stage probe",
    ({ stage }) => {
      it.live.each(shapes.map((shape) => ({ shape })))(
        "$shape: admission wins, is counted, runs once, and the root retires after its drain",
        ({ shape }) =>
          Effect.flatMap(makeRetirementProbe, (probe) => {
            const spy = spyOnFactoryPort();
            const watch = decisionWatch();
            const consults = consultWatch();
            return withProject(
              verifyCommands.passes,
              (world) =>
                probe.guarded(
                  Effect.gen(function* () {
                    const { root, thread, opened, providerThread } =
                      yield* closedBeforeObserved(world);
                    const native = nativeOffers();

                    // The retirement pauses, having judged nothing the admission changes.
                    probe.armed[stage] = true;
                    const ticking = yield* tick.pipe(Effect.forkChild);
                    yield* Deferred.await(probe.gates[stage].entered);

                    // The turn is admitted at the free head and pauses before its dispatch.
                    probe.armed.admitted = true;
                    const turn =
                      shape === "completion"
                        ? turns.delegatedCompletion(thread, opened.runId, providerThread)
                        : turns.delegatedQuestion(
                            thread,
                            { childThreadId: thread, taskId: questionTask },
                            opened.runId,
                          );
                    const isNative = shape === "native-plain" || shape === "native-callbacks";
                    // A native wake's worker runs it itself; these two go through their producers'
                    // own consult, each proven from its producer in the scenarios above.
                    const messageId = isNative
                      ? yield* offerNative(
                          thread,
                          providerThread,
                          shape === "native-plain" ? "plain" : "callbacks",
                          native,
                        )
                      : turn.messageId;
                    const consulting = isNative
                      ? undefined
                      : yield* consultRunning(world, turn).pipe(Effect.forkChild);
                    yield* Deferred.await(probe.gates.admitted.entered);
                    assert.strictEqual((yield* slotOf(root))?.state, "held");

                    // The attempt commits only the fence: nothing retires, nothing is disposed of.
                    yield* Deferred.succeed(probe.gates[stage].go, undefined);
                    yield* Fiber.join(ticking);
                    yield* notTerminalYet(root);
                    assert.strictEqual((yield* slotOf(root))?.state, "held");
                    assert.deepStrictEqual(
                      (yield* admissionsOf(root)).map(({ state }) => state),
                      ["dispatching"],
                    );
                    assert.deepStrictEqual(yield* dispositionsOf(root), []);
                    assert.deepStrictEqual(native.cleared, []);

                    // Later turns of the fenced root get dispositions and no run.
                    const later = { ran: [] as Array<string> };
                    const resume = turns.usageLimitResume(thread, opened.runId);
                    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
                    assert.deepStrictEqual(
                      yield* gate.admit(
                        resume,
                        Effect.sync(() => void later.ran.push(resume.messageId)),
                      ),
                      AutomaticTurnGate.notNow("declined"),
                    );
                    assert.deepStrictEqual(later.ran, []);
                    assert.lengthOf(yield* dispositionsOf(root), 1);

                    // Let go, the admitted turn runs exactly once, and stays counted while it runs.
                    const before = (yield* runsOf(thread)).length;
                    yield* Deferred.succeed(probe.gates.admitted.go, undefined);
                    if (consulting !== undefined) yield* Fiber.join(consulting);
                    const run = yield* runOfMessage(messageId);
                    yield* drainOrchestration;
                    assert.strictEqual((yield* runsOf(thread)).length, before + 1);
                    yield* tick;
                    yield* notTerminalYet(root);
                    assert.strictEqual((yield* slotOf(root))?.state, "held");

                    yield* runReached(run, ["starting", ...ended]);
                    yield* drainOrchestration;
                    yield* world.endRun(run, "completed");
                    yield* tick;
                    assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
                    assert.deepStrictEqual(yield* managedRootOf(root), {
                      state: "retired",
                      reason: "cancelled",
                    });
                    yield* assertNothingHeld(root, "export");
                    assert.lengthOf(yield* runsOfMessage(thread, messageId), 1);
                  }),
                ),
              stack(spy, watch, consults, {
                handoff: { admission: watch.admission, probe: probe.probe },
              }),
            );
          }),
        240_000,
      );
    },
  );

  it.live.each(shapes.map((shape) => ({ shape })))(
    "$shape: retirement wins, so it gets a disposition and zero runs",
    ({ shape }) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread, opened, providerThread } = yield* closedBeforeObserved(world);
            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: "cancelled",
            });
            const before = (yield* runsOf(thread)).length;
            const native = nativeOffers();
            if (shape === "native-plain" || shape === "native-callbacks") {
              const offered = yield* offerNative(
                thread,
                providerThread,
                shape === "native-plain" ? "plain" : "callbacks",
                native,
              );
              yield* consults.ended(offered);
              assert.deepStrictEqual(native.cleared, shape === "native-plain" ? [] : [offered]);
            } else {
              const turn =
                shape === "completion"
                  ? turns.delegatedCompletion(thread, opened.runId, providerThread)
                  : turns.delegatedQuestion(
                      thread,
                      { childThreadId: thread, taskId: questionTask },
                      opened.runId,
                    );
              assert.deepStrictEqual(
                yield* consultRunning(world, turn),
                AutomaticTurnGate.notNow("declined"),
              );
            }
            assert.deepStrictEqual(native.dispatched, []);
            assert.strictEqual((yield* runsOf(thread)).length, before);
            assert.lengthOf(yield* dispositionsOf(root), 1);
            yield* assertNothingHeld(root, "export");
          }),
        stack(spy, watch, consults),
      );
    },
  );

  it.live(
    "a reservation still unused is dropped by compare-and-delete, and retirement follows",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, opened, thread } = yield* deliverIdea(world);
            const [filler] = yield* fill(world, 2);
            const resume = turns.usageLimitResume(thread, opened.runId);
            yield* consultRunning(world, resume);
            yield* release(filler!);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "reserved");

            const runs = (yield* runsOf(thread)).length;
            yield* syncPullRequest(thread, yield* linkOf(thread, fakePullRequest.number), "closed");
            yield* drainFactory;
            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
            yield* assertNothingHeld(root, "export");
            assert.deepStrictEqual(
              (yield* dispositionsOf(root)).map(({ kind }) => kind),
              ["usage_limit_resume"],
            );
            assert.strictEqual((yield* runsOf(thread)).length, runs);
          }),
        stack(spy, watch, consults),
      );
    },
  );

  it.live("a reservation converted first is kept and counted, and retirement waits for it", () =>
    Effect.flatMap(makeRetirementProbe, (probe) => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          probe.guarded(
            Effect.gen(function* () {
              const { root, opened, thread } = yield* deliverIdea(world);
              const [filler] = yield* fill(world, 2);
              const resume = turns.usageLimitResume(thread, opened.runId);
              yield* consultRunning(world, resume);
              yield* release(filler!);
              yield* tick;
              assert.strictEqual((yield* slotOf(root))?.state, "reserved");

              // Presented again, the reservation converts, and its dispatch pauses.
              probe.armed.admitted = true;
              const admitting = yield* consultRunning(world, resume).pipe(Effect.forkChild);
              yield* Deferred.await(probe.gates.admitted.entered);
              assert.strictEqual((yield* slotOf(root))?.state, "held");

              yield* syncPullRequest(
                thread,
                yield* linkOf(thread, fakePullRequest.number),
                "closed",
              );
              yield* drainFactory;
              yield* tick;
              yield* notTerminalYet(root);
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              assert.lengthOf(yield* admissionsOf(root), 1);

              yield* Deferred.succeed(probe.gates.admitted.go, undefined);
              assert.strictEqual((yield* Fiber.join(admitting))._tag, "Ran");
              yield* drainOrchestration;
              const run = yield* runOfMessage(resume.messageId);
              yield* tick;
              yield* notTerminalYet(root);
              yield* runReached(run, ["starting", ...ended]);
              yield* drainOrchestration;
              yield* world.endRun(run, "completed");
              yield* tick;
              assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
              yield* assertNothingHeld(root, "export");
            }),
          ),
        stack(spy, watch, consults, {
          handoff: { admission: watch.admission, probe: probe.probe },
        }),
      );
    }),
  );

  it.live(
    "a delegation before the fence is counted, one after it refused, and retirement waits",
    () =>
      Effect.flatMap(makeRetirementProbe, (probe) => {
        const spy = spyOnFactoryPort();
        const watch = decisionWatch();
        const consults = consultWatch();
        return withProject(
          verifyCommands.passes,
          (world) =>
            withEndpoint(driver, (endpoint) =>
              probe.guarded(
                Effect.gen(function* () {
                  const { root, thread, providerThread } = yield* closedBeforeObserved(world);
                  // The owner works on the thread, whose agent delegates through the endpoint.
                  const ownerRun = yield* world.ownerTurn(thread, "Look into a CSV option.");
                  yield* providerTurnRunning(thread);
                  const agent = yield* endpoint.callerOn(thread);

                  probe.armed.released = true;
                  const ticking = yield* tick.pipe(Effect.forkChild);
                  yield* Deferred.await(probe.gates.released.entered);
                  probe.armed.admitted = true;
                  const native = nativeOffers();
                  const wake = yield* offerNative(thread, providerThread, "plain", native);
                  yield* Deferred.await(probe.gates.admitted.entered);

                  // Before the fence, the holding admits a delegation: one child, counted.
                  const before = yield* agent.call("delegate_task", { task: "Check the CSV." });
                  assert.isFalse(before.isError, before.text);
                  yield* drainOrchestration;
                  const { subagents } = yield* threadProjection(thread);
                  const childThread =
                    subagents[0]?.childThreadId ?? assert.fail("The delegation made no thread.");
                  const childRun =
                    (yield* runsOf(childThread))[0]?.id ?? assert.fail("No child run.");
                  assert.lengthOf(subagents, 1);

                  yield* Deferred.succeed(probe.gates.released.go, undefined);
                  yield* Fiber.join(ticking);
                  yield* notTerminalYet(root);

                  // After it, one is refused, making nothing.
                  const after = yield* agent.call("delegate_task", { task: "Refused." });
                  assert.deepStrictEqual(after, { isError: true, text: text.retired });
                  assert.lengthOf((yield* threadProjection(thread)).subagents, 1);

                  yield* Deferred.succeed(probe.gates.admitted.go, undefined);
                  const wakeRun = yield* runOfMessage(wake);
                  yield* drainOrchestration;
                  yield* world.endRun(ownerRun, "completed");
                  yield* runStarted(wakeRun);
                  yield* world.endRun(wakeRun, "completed");

                  // Retirement waits for the child as well as the run.
                  yield* tick;
                  yield* notTerminalYet(root);
                  assert.strictEqual((yield* slotOf(root))?.state, "held");
                  yield* runStarted(childRun);
                  yield* world.endRun(childRun, "completed");
                  yield* drainOrchestration;
                  yield* tick;
                  assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
                  yield* assertNothingHeld(root, "export");
                }),
              ),
            ),
          stack(spy, watch, consults, {
            handoff: { admission: watch.admission, probe: probe.probe },
          }),
        );
      }),
  );

  it.live(
    "a failing activity read keeps it ending, and a rebuild after the fence converges",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      const consults = consultWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread, opened } = yield* closedBeforeObserved(world);
            const restore = yield* failOutboxReads;
            yield* tick;
            yield* tick;
            yield* notTerminalYet(root);
            assert.deepStrictEqual(yield* dispositionsOf(root), []);
            yield* restore;

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                // The fence stands across the restart: a late turn is declined, not admitted.
                const record = { ran: [] as Array<string> };
                const resume = turns.usageLimitResume(thread, opened.runId);
                const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
                assert.deepStrictEqual(
                  yield* gate.admit(
                    resume,
                    Effect.sync(() => void record.ran.push(resume.messageId)),
                  ),
                  AutomaticTurnGate.notNow("declined"),
                );
                yield* tick;
                assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
                assert.deepStrictEqual(yield* managedRootOf(root), {
                  state: "retired",
                  reason: "cancelled",
                });
                yield* assertNothingHeld(root, "export");
                assert.deepStrictEqual(record.ran, []);
                const rows = yield* dispositionsOf(root);
                assert.lengthOf(rows, 1);
                yield* tick;
                assert.deepStrictEqual(yield* dispositionsOf(root), rows);
              }),
              { orchestration: true },
            );
          }),
        stack(spy, watch, consults),
      );
    },
  );

  it.live("no terminal assignment ever sits beside a live or waiting run of its family", () => {
    const spy = spyOnFactoryPort();
    const watch = decisionWatch();
    const consults = consultWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, thread } = yield* closedBeforeObserved(world);
          // An agent's message from the family's own thread: not shown to be the owner's or
          // Factory's. Its run is still going as the delivery ends, and nothing can interrupt it.
          const unknownRun = yield* agentSends(world.projectId, thread, thread);
          yield* runStarted(unknownRun);
          for (const _ of [1, 2, 3]) {
            yield* tick;
            const { state } = yield* assignmentOf("export");
            assert.notInclude(["completed", "cancelled", "failed"], state);
            yield* notTerminalYet(root);
          }
          assert.isTrue(
            (yield* noticesOf("export")).some((note) =>
              note.includes("Stop it in the thread to finish cancelling"),
            ),
          );
          yield* world.endRun(unknownRun, "completed");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          yield* assertNothingHeld(root, "export");
        }),
      stack(spy, watch, consults),
    );
  });
});
