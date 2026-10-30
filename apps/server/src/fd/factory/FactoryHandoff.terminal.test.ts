import { assert, describe, it } from "@effect/vitest";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission, HandoffBackend, ProjectAssistant } from "../assistant/index.ts";
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
import { delegateFrom, providerThreadOf } from "./testkit/familyThreads.ts";
import {
  awaitedRun,
  linkOf,
  openSingle,
  ownerQueues,
  syncPullRequest,
  threadShell,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  agreeAndCapture,
  assertNothingHeld,
  assignmentOf,
  assignToFactory,
  consult,
  controlAssignment,
  decisionWatch,
  demandsOf,
  dispositionsOf,
  fill,
  grantOutcomesOf,
  handoffRows,
  keptFor,
  manage,
  type Managed,
  managedRootOf,
  noticesOf,
  pullRequestWakeTurn,
  questionTask,
  rootIdOf,
  rootRowOf,
  runsOf,
  runToPullRequest,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  turns,
  turnsWithoutThreads,
  usageLimitFailure,
  wakeThroughGate,
  withLimitSweep,
} from "./testkit/handoff.ts";

/**
 * A governed root's retirement on the real stack, with both slots held by others: whatever waits
 * ends with one disposition and one notice per key, nothing runs and nothing is left. Late arrivals
 * after it take the same path; only the owner's own turns run.
 */

const factoryService = Factory.FactoryService.FactoryService;

type Outcome = "done" | "owner-cancel" | "closed-unmerged";

interface Record {
  readonly ran: Array<string>;
  readonly dropped: Array<string>;
}

/** Whether what waits on a root waits for a slot, or is blocked by a revocation since restored. */
type Waiting = "waiting" | "blocked";

/**
 * A governed single item at its open pull request, released, with both slots held by others, and
 * one demand of every automatic kind, kept native wakes of both shapes among them, all waiting for
 * a slot or all blocked by a revocation that has since been restored, plus an effect's demand.
 * Returns what was seeded and the record of what ran or was cleared.
 */
const seeded = (world: World, mode: Waiting) =>
  Effect.gen(function* () {
    const admission = yield* HandoffAdmission.HandoffAdmission;
    const assistant = yield* ProjectAssistant.ProjectAssistant;
    const opened = yield* openSingle(world);
    const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
    yield* fill(world, 2);
    const record: Record = { ran: [], dropped: [] };
    const thread = opened.threadId;
    const providerThread = yield* providerThreadOf(thread, opened.runId);
    const task = { childThreadId: thread, taskId: questionTask };
    const waiting = [
      pullRequestWakeTurn(thread, yield* linkOf(thread, fakePullRequest.number)),
      turns.usageLimitResume(thread, opened.runId),
      turns.delegatedQuestion(thread, task, opened.runId),
      turns.delegatedCompletion(thread, opened.runId, providerThread),
      turns.backgroundWake(thread, providerThread, true),
      turns.backgroundWake(thread, providerThread, false),
    ];
    const authorize = (executionAuthorized: boolean) =>
      assistant.revise({
        projectId: world.projectId,
        ideaId: managed.ideaId,
        patch: { executionAuthorized },
      });
    if (mode === "blocked") yield* authorize(false);
    for (const turn of waiting) {
      assert.deepStrictEqual(
        yield* consult(turn, record),
        AutomaticTurnGate.notNow("deferred"),
        turn.kind,
      );
    }
    if (mode === "blocked") yield* authorize(true);
    // Each kind's own demand, blocked or not as asked; both native wakes are kept.
    const demands = yield* demandsOf(managed.root);
    assert.deepStrictEqual(
      demands.map(({ kind }) => kind),
      waiting.map(({ kind }) => kind),
    );
    assert.isTrue(
      demands.every(({ blockedReason }) => (blockedReason !== null) === (mode === "blocked")),
    );
    // An effect demand: effect history is retired, with no disposition.
    yield* admission.ensureEffectDemand({
      root: managed.root,
      deliveryId: managed.root,
      effectId: 999,
    });
    return { opened, managed, record, thread, waiting, runs: (yield* runsOf(thread)).length };
  });

/** The assignment queued for its first claim, claimed directly: its start has not been called. */
const claimedForFailure = Effect.gen(function* () {
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const root = "7e2aa85e-9347-44ce-b019-cb8dfd365b20" as FactoryDeliveryId;
  const claimed = yield* admission.claim({ assignmentId: "export", deliveryId: root });
  if (claimed.type !== "claimed") return assert.fail("The assignment was not claimed.");
  yield* admission.markDispatched(claimed.admitted);
  return { root };
});

/** Factory refuses the start before writing a row, so no delivery can exist. */
const refuseTheStart = (spy: ReturnType<typeof spyOnFactoryPort>) => {
  spy.control.onStart = () =>
    Effect.fail(
      new HandoffBackend.HandoffFactoryRefused({
        operation: "start",
        reason: "no_base_commit",
      }),
    );
};

/** Takes the delivery to the terminal outcome, as its owner, its host or its merge does. */
const endDelivery = (
  world: World,
  outcome: Outcome,
  root: FactoryDeliveryId,
  thread: Parameters<typeof linkOf>[0],
) =>
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
    assert.strictEqual(
      (yield* stateOf(root)).status,
      outcome === "done" ? "done" : "cancelled",
      outcome,
    );
  });

/** What a retirement must leave, and what a repeat of the tick must leave unchanged. */
const retiredAsExpected = (
  managed: Managed,
  reason: "completed" | "cancelled",
  expectedDispositions: number,
) =>
  Effect.gen(function* () {
    const row = yield* rootRowOf(managed.root);
    assert.strictEqual(row.state, "retired");
    assert.strictEqual(row.reason, reason);
    assert.isNotNull(row.ending_at);
    assert.strictEqual(
      (yield* assignmentOf(managed.assignmentId)).state,
      reason === "completed" ? "completed" : "cancelled",
    );
    yield* assertNothingHeld(managed.root, managed.assignmentId);
    assert.lengthOf(yield* dispositionsOf(managed.root), expectedDispositions);
  });

const stableAcrossTicksAndRebuilds = (world: World, check: Effect.Effect<void, never, never>) =>
  Effect.gen(function* () {
    const rows = yield* handoffRows;
    yield* tick;
    yield* tick;
    assert.deepStrictEqual(yield* handoffRows, rows);
    yield* check;
    yield* world.rebuild(
      Effect.gen(function* () {
        yield* tick;
        assert.deepStrictEqual(yield* handoffRows, rows);
        yield* world.rebuild(
          Effect.gen(function* () {
            yield* drainOrchestration;
            yield* tick;
            assert.deepStrictEqual(yield* handoffRows, rows);
          }),
          { orchestration: true },
        );
      }),
    );
  });

describe("a governed root reaching a terminal outcome", () => {
  it.live.each(
    (["waiting", "blocked"] as const).flatMap((mode) => [
      { mode, outcome: "done" as const, reason: "completed" as const },
      { mode, outcome: "owner-cancel" as const, reason: "cancelled" as const },
      { mode, outcome: "closed-unmerged" as const, reason: "cancelled" as const },
    ]),
  )(
    "$outcome with every kind $mode retires it with zero runs and one disposition per key",
    ({ mode, outcome, reason }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { opened, managed, record, thread, waiting, runs } = yield* seeded(world, mode);
            yield* endDelivery(world, outcome, opened.deliveryId, thread);

            yield* tick;
            // Every automatic kind's disposition, with the two native wakes one per provider
            // thread.
            const native = waiting.filter(({ kind }) => kind === "background_wake");
            const expected = waiting.length - native.length + 1;
            yield* retiredAsExpected(managed, reason, expected);
            assert.deepStrictEqual(record.ran, []);
            assert.strictEqual((yield* runsOf(thread)).length, runs);
            // The kept dispatches are gone; only the offer that can be cleared was.
            assert.deepStrictEqual(record.dropped, [native[0]!.messageId]);
            assert.deepInclude(yield* grantOutcomesOf(managed.root), {
              kind: "effect",
              outcome: "retired",
            });
            const notices = (yield* noticesOf(managed.assignmentId)).filter((note) =>
              note.includes("after this assignment ended"),
            );
            assert.lengthOf(notices, expected);

            yield* stableAcrossTicksAndRebuilds(
              world,
              Effect.sync(() => {
                assert.deepStrictEqual(record.ran, []);
                assert.deepStrictEqual(record.dropped, [native[0]!.messageId]);
              }),
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );

  it.live.each(["waiting", "blocked"] as const)(
    "a pre-delivery failure with every kind %s retires it failed, disposing of what waits",
    (mode) => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* startAssistantThread(world);
            yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            const { root } = yield* claimedForFailure;
            yield* fill(world, 1);

            // What waits on the root of a delivery that never was, of every automatic kind.
            const dropped: Array<string> = [];
            const authorize = (executionAuthorized: boolean) =>
              assistant.revise({
                projectId: world.projectId,
                ideaId: "export",
                patch: { executionAuthorized },
              });
            if (mode === "blocked") yield* authorize(false);
            const waiting = turnsWithoutThreads("seeded");
            for (const turn of waiting) {
              const decided = yield* admission.decideTurn({
                root,
                // A question of Factory's own would land in the claim's holding.
                provenance: turn.kind === "delegated_question" ? "unknown" : "factory",
                turn,
                ...keptFor(turn, dropped),
              });
              assert.strictEqual(
                decided.type,
                mode === "blocked" ? "blocked" : "demand",
                turn.kind,
              );
            }
            if (mode === "blocked") yield* authorize(true);
            yield* admission.ensureEffectDemand({ root, deliveryId: root, effectId: 999 });

            refuseTheStart(spy);
            yield* tick;
            assert.strictEqual(spy.count("start"), 1);
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");
            const row = yield* rootRowOf(root);
            assert.strictEqual(row.state, "retired");
            assert.strictEqual(row.reason, "failed");
            yield* assertNothingHeld(root, "export");
            // One disposition per key; the two native wakes differ by provider thread here.
            const dispositions = yield* dispositionsOf(root);
            assert.lengthOf(dispositions, waiting.length);
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
            assert.deepInclude(yield* grantOutcomesOf(root), {
              kind: "effect",
              outcome: "retired",
            });
            assert.lengthOf(
              (yield* noticesOf("export")).filter((note) =>
                note.includes("after this assignment ended"),
              ),
              waiting.length,
            );

            yield* stableAcrossTicksAndRebuilds(
              world,
              Effect.sync(() => {
                assert.deepStrictEqual(dropped, [clearable]);
              }),
            );
          }),
        { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
      );
    },
  );
});

describe("late arrivals after a pre-delivery failure", () => {
  it.live("each is declined once, across two rebuilds, and a retry starts a new root", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const { root } = yield* claimedForFailure;
          refuseTheStart(spy);
          yield* tick;
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          spy.control.onStart = undefined;

          // No thread of a delivery that never was can reach the gate, which finds no family for
          // it: what its manager would be asked is asked of the admission directly.
          const dropped: Array<string> = [];
          const late = turnsWithoutThreads("late");
          const present = Effect.gen(function* () {
            for (const turn of late) {
              const decided = yield* admission.decideTurn({
                root,
                provenance: "factory",
                turn,
                ...keptFor(turn, dropped),
              });
              assert.strictEqual(decided.type, "declined", turn.kind);
            }
            assert.deepStrictEqual(
              yield* admission.enter({
                root,
                deliveryId: root,
                effectId: 1,
                fresh: false,
              }),
              { type: "refuse", category: "ended" },
            );
            assert.deepStrictEqual(
              yield* admission.admitDelegation({
                root,
                threadId: "factory-thread:missing:1",
                messageId: "mcp-delegation:late",
                work: { type: "unreadable" },
              }),
              { type: "refused", category: "ended" },
            );
          });
          yield* present;
          yield* assertNothingHeld(root, "export");
          const dispositions = yield* dispositionsOf(root);
          assert.lengthOf(dispositions, late.length);
          const notices = yield* noticesOf("export");
          assert.strictEqual(
            notices.filter((note) => note.includes("after this assignment ended")).length,
            late.length,
          );

          const rows = yield* handoffRows;
          const unchanged = Effect.gen(function* () {
            yield* present;
            yield* tick;
            assert.deepStrictEqual(yield* handoffRows, rows);
            assert.deepStrictEqual(yield* noticesOf("export"), notices);
            yield* assertNothingHeld(root, "export");
          });
          yield* unchanged;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* unchanged;
              yield* world.rebuild(
                Effect.gen(function* () {
                  yield* unchanged;

                  // A retry takes a new root and id; the failed root stays as it ended.
                  const retried = yield* controlAssignment("export", "retry");
                  assert.strictEqual(retried.state, "queued");
                  yield* tick;
                  const next = yield* rootIdOf("export");
                  assert.notStrictEqual(next, root);
                  assert.deepStrictEqual(yield* managedRootOf(next), {
                    state: "active",
                    reason: null,
                  });
                  const author = yield* world.launched(next);
                  yield* world.endRun(author.runId, "cancelled");
                  assert.deepStrictEqual(yield* managedRootOf(root), {
                    state: "retired",
                    reason: "failed",
                  });
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

describe("late arrivals after a terminal outcome", () => {
  it.live.each([
    { outcome: "done" as const },
    { outcome: "owner-cancel" as const },
    { outcome: "closed-unmerged" as const },
  ])(
    "$outcome: each late turn is declined once, before and after a rebuild, and the owner's runs",
    ({ outcome }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const opened = yield* openSingle(world);
            const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
            const thread = opened.threadId;
            const link = yield* linkOf(thread, fakePullRequest.number);
            yield* fill(world, 2);
            // An owner's turn on the provider thread leaves its wakes' origin unknown.
            const wakeClass = outcome === "closed-unmerged" ? "unknown" : "factory";
            if (wakeClass === "unknown") {
              yield* world.endRun(
                yield* world.ownerTurn(thread, "Rename the button."),
                "completed",
              );
            }
            if (outcome === "owner-cancel") {
              // Factory's watch release fails, so core's sweep keeps presenting the wake.
              world.factoryDispatch.before = (command) =>
                command.type === "thread.pull-request-watch.sync"
                  ? Effect.die("The watch release failed.")
                  : Effect.void;
            }
            yield* endDelivery(world, outcome, opened.deliveryId, thread);
            world.factoryDispatch.before = undefined;
            yield* tick;
            assert.strictEqual((yield* managedRootOf(managed.root))?.state, "retired");

            const record: Record = { ran: [], dropped: [] };
            const providerThread = yield* providerThreadOf(thread, opened.runId);
            const task = { childThreadId: thread, taskId: questionTask };
            const late = [
              turns.usageLimitResume(thread, opened.runId),
              turns.delegatedQuestion(thread, task, opened.runId),
              turns.delegatedCompletion(thread, opened.runId, providerThread),
              turns.backgroundWake(thread, providerThread, true),
              turns.backgroundWake(thread, providerThread, false),
            ];
            const runs = (yield* runsOf(thread)).length;
            const present = Effect.gen(function* () {
              if (outcome === "owner-cancel") {
                const wake = yield* wakeThroughGate(thread, link);
                assert.deepStrictEqual(wake.outcome, AutomaticTurnGate.notNow("declined"));
                assert.isUndefined(wake.runId);
              }
              for (const turn of late) {
                assert.deepStrictEqual(
                  yield* consult(turn, record),
                  AutomaticTurnGate.notNow("declined"),
                  turn.kind,
                );
              }
            });
            yield* present;
            assert.deepStrictEqual(record.ran, []);
            assert.deepStrictEqual(record.dropped, [late[3]!.messageId]);
            assert.strictEqual((yield* runsOf(thread)).length, runs);
            const dispositions = yield* dispositionsOf(managed.root);
            // One per key, with both native wakes one per provider thread.
            assert.lengthOf(dispositions, (outcome === "owner-cancel" ? 1 : 0) + 4);
            assert.strictEqual(
              dispositions.find(({ kind }) => kind === "background_wake")?.class,
              wakeClass,
            );
            const notices = (yield* noticesOf(managed.assignmentId)).length;

            const rows = yield* handoffRows;
            yield* present;
            assert.deepStrictEqual(yield* handoffRows, rows);
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* present;
                yield* tick;
                assert.deepStrictEqual(yield* handoffRows, rows);
                assert.lengthOf(yield* noticesOf(managed.assignmentId), notices);
                assert.deepStrictEqual(record.ran, []);
                assert.strictEqual((yield* runsOf(thread)).length, runs);

                // The owner's own message runs inline, under full capacity: nothing gates it.
                yield* ownerQueues(thread, "Rename the button.");
                assert.strictEqual((yield* runsOf(thread)).length, runs + 1);
                assert.deepStrictEqual(yield* admissionsOf(managed.root), []);
                assert.deepStrictEqual(yield* demandsOf(managed.root), []);
              }),
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );

  it.live("after a retry the old root's wakes stay declined and the new root's are counted", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          yield* tick;
          const oldRoot = yield* rootIdOf("export");
          const opened = yield* runToPullRequest(world, oldRoot);
          yield* tick;
          yield* controlAssignment("export", "cancel");
          yield* drainFactory;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");

          const retried = yield* controlAssignment("export", "retry");
          assert.strictEqual(retried.state, "queued");
          yield* tick;
          const newRoot = yield* rootIdOf("export");
          assert.notStrictEqual(newRoot, oldRoot);
          const author = yield* world.launched(newRoot);
          assert.deepStrictEqual(yield* managedRootOf(newRoot), { state: "active", reason: null });

          const record: Record = { ran: [], dropped: [] };
          const oldThread = opened.threadId;
          const oldWake = turns.backgroundWake(
            oldThread,
            yield* providerThreadOf(oldThread, opened.runId),
          );
          const present = Effect.gen(function* () {
            assert.deepStrictEqual(
              yield* consult(
                { ...oldWake, messageId: `${oldWake.messageId}-again` as never },
                record,
              ),
              AutomaticTurnGate.notNow("declined"),
            );
          });
          yield* present;
          assert.deepStrictEqual(record.ran, []);

          // The new root holds its slot, and its automatic work waits for its own grant.
          yield* fill(world, 1);
          const newWake = turns.backgroundWake(
            author.threadId,
            yield* providerThreadOf(author.threadId, author.runId),
          );
          assert.deepStrictEqual(
            yield* consult(newWake, record),
            AutomaticTurnGate.notNow("deferred"),
          );
          assert.strictEqual((yield* slotOf(newRoot))?.state, "held");
          assert.deepStrictEqual(
            (yield* demandsOf(newRoot)).map(({ kind }) => kind),
            ["background_wake"],
          );
          assert.deepStrictEqual(yield* demandsOf(oldRoot), []);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* present;
              assert.deepStrictEqual(record.ran, []);
              assert.lengthOf(yield* dispositionsOf(oldRoot), 1);
            }),
          );
        }),
      { handoff: {}, automaticTurnGate: true, assistantFactory: spy.wrap },
    );
  });

  it.live("core's boot re-offer of a result left open is declined, with no second notice", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          yield* fill(world, 1);
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "demand");

          // The author completes, so its cohort stays open, and the delivery is cancelled later.
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const reviewer = yield* awaitedRun(author.deliveryId);
          yield* factory.cancel(author.deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          yield* drainOrchestration;
          yield* world.endRun(reviewer.runId, "cancelled");

          // Cancelled and quiet, the root retires, and the waiting result is its disposition.
          yield* tick;
          yield* retiredAsExpected(managed, "cancelled", 1);
          const runs = (yield* runsOf(author.threadId)).length;
          const notices = yield* noticesOf(managed.assignmentId);
          const rows = yield* handoffRows;
          yield* watch.forget;

          // The cohort stays open, so core offers it again at boot, and it is declined again.
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* watch.decided("delegated_completion", "declined");
              yield* drainOrchestration;
              yield* tick;
              assert.deepStrictEqual(yield* handoffRows, rows);
              assert.deepStrictEqual(yield* noticesOf(managed.assignmentId), notices);
              assert.strictEqual((yield* runsOf(author.threadId)).length, runs);
            }),
            { orchestration: true },
          );
        }),
      { handoff: { admission: watch.admission }, automaticTurnGate: true },
    );
  });

  it.live.each([
    { waited: false, label: "armed when it ended" },
    { waited: true, label: "already waiting for a slot when it ended" },
  ])("a usage-limit resume $label is disarmed by its worker, for good", ({ waited }) => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const thread = author.threadId;
          const managed = yield* manage(world, author.deliveryId);
          yield* fill(world, 2);

          // The author's run fails on a usage limit, so the delivery blocks.
          yield* usageLimitFailure(thread, author.runId);
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(author.deliveryId)).status, "blocked");

          const presented = watch.presentations("usage_limit_resume");
          yield* withLimitSweep((sweep) =>
            Effect.gen(function* () {
              // The worker's first sweep arms the recovery, which is no turn and asks nothing.
              yield* sweep;
              const armed = (yield* threadShell(thread)).limitRecovery;
              assert.strictEqual(armed?.autoResume, true);
              assert.strictEqual(yield* presented, 0);

              if (waited) {
                // Due with both slots held by others, it waits as one demand, still armed.
                yield* sweep;
                assert.strictEqual(yield* presented, 1);
                assert.deepStrictEqual(
                  (yield* demandsOf(managed.root)).map(({ kind }) => kind),
                  ["usage_limit_resume"],
                );
                assert.strictEqual((yield* threadShell(thread)).limitRecovery?.autoResume, true);
              }

              yield* endDelivery(world, "owner-cancel", author.deliveryId, thread);
              yield* tick;
              assert.deepStrictEqual(yield* managedRootOf(managed.root), {
                state: "retired",
                reason: "cancelled",
              });
              const runs = (yield* runsOf(thread)).length;

              // The next sweep presents it: declined, and the worker disarms the recovery.
              const before = yield* presented;
              yield* sweep;
              assert.strictEqual(yield* presented, before + 1);
              const disarmed = (yield* threadShell(thread)).limitRecovery;
              assert.strictEqual(disarmed?.autoResume, false);
              assert.include(disarmed?.requestId ?? "", "limit-disarm:");
              assert.strictEqual((yield* threadShell(thread)).lastErrorClass, "usage_limit");
              assert.lengthOf(yield* dispositionsOf(managed.root), 1);
              assert.strictEqual((yield* runsOf(thread)).length, runs);

              // Later sweeps do not present it at all.
              yield* sweep;
              yield* sweep;
              assert.strictEqual(yield* presented, before + 1);
            }),
          );

          // Nor does a worker of a server restarted over the same records.
          const total = yield* presented;
          const notices = yield* noticesOf(managed.assignmentId);
          const rows = yield* handoffRows;
          const stillDisarmed = withLimitSweep((sweep) =>
            Effect.gen(function* () {
              yield* drainOrchestration;
              yield* sweep;
              yield* tick;
              assert.strictEqual(yield* presented, total);
              assert.deepStrictEqual(yield* handoffRows, rows);
              assert.deepStrictEqual(yield* noticesOf(managed.assignmentId), notices);
              assert.strictEqual((yield* threadShell(thread)).limitRecovery?.autoResume, false);
              assert.isFalse(
                (yield* runsOf(thread)).some((run) =>
                  run.userMessageId.startsWith("limit-resume:"),
                ),
              );
            }),
          );
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* stillDisarmed;
              yield* world.rebuild(stillDisarmed, { orchestration: true });
            }),
            { orchestration: true },
          );
        }),
      { handoff: { admission: watch.admission }, automaticTurnGate: true },
    );
  });
});
