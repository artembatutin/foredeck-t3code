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
  wakeThroughGate,
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

/**
 * A governed single item at its open pull request, released, with both slots held by others, and
 * one waiting demand of every automatic kind, a scope-blocked one, and kept native wakes of both
 * shapes. Returns what was seeded and the record of what ran or was cleared.
 */
const seeded = (world: World) =>
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
    for (const turn of waiting) {
      assert.deepStrictEqual(
        yield* consult(turn, record),
        AutomaticTurnGate.notNow("deferred"),
        turn.kind,
      );
    }
    // A demand blocked by a revocation stays blocked once the brief is restored.
    yield* assistant.revise({
      projectId: world.projectId,
      ideaId: managed.ideaId,
      patch: { executionAuthorized: false },
    });
    assert.deepStrictEqual(
      yield* consult(turns.usageLimitResume(thread, opened.runId), record),
      AutomaticTurnGate.notNow("deferred"),
    );
    yield* assistant.revise({
      projectId: world.projectId,
      ideaId: managed.ideaId,
      patch: { executionAuthorized: true },
    });
    assert.isTrue((yield* demandsOf(managed.root)).some((demand) => demand.blockedReason !== null));
    // An effect demand: effect history is retired, with no disposition.
    yield* admission.ensureEffectDemand({
      root: managed.root,
      deliveryId: managed.root,
      effectId: 999,
    });
    return { opened, managed, record, thread, waiting, runs: (yield* runsOf(thread)).length };
  });

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
  it.live.each([
    { outcome: "done" as const, reason: "completed" as const },
    { outcome: "owner-cancel" as const, reason: "cancelled" as const },
    { outcome: "closed-unmerged" as const, reason: "cancelled" as const },
  ])(
    "$outcome retires it with zero runs and one disposition per key, under full capacity",
    ({ outcome, reason }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { opened, managed, record, thread, waiting, runs } = yield* seeded(world);
            yield* endDelivery(world, outcome, opened.deliveryId, thread);

            yield* tick;
            // Every automatic kind's disposition, with the two native wakes one per provider
            // thread, plus the blocked usage-limit resume's.
            const native = waiting.filter(({ kind }) => kind === "background_wake");
            yield* retiredAsExpected(managed, reason, waiting.length - native.length + 2);
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
            assert.lengthOf(notices, waiting.length - native.length + 2);

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

  it.live("a pre-delivery failure retires it failed, disposing of what waits", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const root = "7e2aa85e-9347-44ce-b019-cb8dfd365b20" as FactoryDeliveryId;
          const claimed = yield* admission.claim({ assignmentId: "export", deliveryId: root });
          assert.strictEqual(claimed.type, "claimed");
          if (claimed.type === "claimed") yield* admission.markDispatched(claimed.admitted);
          yield* fill(world, 1);

          // What waits on the root of a delivery that never was: both shapes of native wake.
          const dropped: Array<string> = [];
          const thread = "factory-thread:missing:1" as never;
          const clearable = turns.backgroundWake(thread, "provider-thread" as never, true);
          const plain = turns.backgroundWake(thread, "provider-thread-2" as never, false);
          for (const turn of [clearable, plain]) {
            const decided = yield* admission.decideTurn({
              root,
              provenance: "factory",
              turn,
              kept: {
                dispatch: Effect.die("A failed root's wake never runs."),
                ...(turn.clearable
                  ? { drop: Effect.sync(() => void dropped.push(turn.messageId)) }
                  : {}),
              },
            });
            assert.strictEqual(decided.type, "demand");
          }

          spy.control.onStart = () =>
            Effect.fail(
              new HandoffBackend.HandoffFactoryRefused({
                operation: "start",
                reason: "no_base_commit",
              }),
            );
          yield* tick;
          assert.strictEqual(spy.count("start"), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          yield* assertNothingHeld(root, "export");
          assert.deepStrictEqual(
            (yield* dispositionsOf(root)).map(({ adapter_clear }) => adapter_clear),
            ["requested", "unavailable"],
          );
          assert.deepStrictEqual(dropped, [clearable.messageId]);

          const rows = yield* handoffRows;
          yield* tick;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.deepStrictEqual(yield* handoffRows, rows);
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

  it.live("an armed limit resume is declined and its producer told to disarm it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* endDelivery(world, "owner-cancel", opened.deliveryId, opened.threadId);
          yield* tick;
          const record: Record = { ran: [], dropped: [] };
          const resume = turns.usageLimitResume(opened.threadId, opened.runId);
          // `declined` is what core's worker answers with its one limit-disarm command.
          assert.deepStrictEqual(
            yield* consult(resume, record),
            AutomaticTurnGate.notNow("declined"),
          );
          assert.deepStrictEqual(record.ran, []);
          assert.lengthOf(
            (yield* dispositionsOf(managed.root)).filter(
              ({ kind }) => kind === "usage_limit_resume",
            ),
            1,
          );
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );
});
