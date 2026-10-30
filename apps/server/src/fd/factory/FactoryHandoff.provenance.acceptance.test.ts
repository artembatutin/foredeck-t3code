import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  type MessageId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { HandoffAdmission } from "../assistant/index.ts";
import * as AssistantHandoff from "../assistant-handoff/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
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
  coreRecovery,
  delegateFrom,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  linkOf,
  linkPullRequest,
  ownerQueues,
  reviewPasses,
  runStarted,
  syncPullRequest,
  watchPullRequest,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  askedOn,
  assertNothingHeld,
  assignmentOf,
  authorizeIdea,
  claimIdea,
  decisionWatch,
  deliverIdea,
  demandsOf,
  driver,
  failOutboxReads,
  fill,
  governedMessages,
  handoffRows,
  makeRetirementProbe,
  managedRootOf,
  nativeOffers,
  offerNative,
  ownerEdits,
  ownerRestores,
  release,
  runOfMessage,
  runsOf,
  runsOfMessage,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  unreadableForAssistant,
  wakeThroughGate,
  writtenRows,
} from "./testkit/handoff.ts";
import {
  type McpCaller,
  refusesAll,
  runCreatingCalls,
  withEndpoint,
} from "./testkit/mcpEndpoint.ts";

// Real Git, verify commands and rebuilt servers on every path: a loaded machine only takes longer,
// and nothing here waits on time, so the limit is just where a real hang fails.
vi.setConfig({ testTimeout: 240_000 });

/**
 * Whose work a turn or a tool call is, judged on the server's real stack by its exact cause: native
 * wakes across runs of different origins, agents' tools through the authenticated MCP endpoint with
 * a credential issued for their thread, and answers to the provider's questions. What is Factory's
 * or cannot be told apart from it waits and counts; what is the owner's runs at once, under any
 * capacity. A decision that cannot be made runs nothing and is asked again.
 */

const factoryService = Factory.FactoryService.FactoryService;
const text = AssistantHandoff.callerPolicyText;

type Spy = ReturnType<typeof spyOnFactoryPort>;

const stack = (spy: Spy, extra: Parameters<typeof withProject>[2] = {}) => ({
  handoff: {},
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
  ...extra,
});

/** Nothing of the root was asked for: no demand, slot or admission row. */
const nothingOfRoot = (root: string) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* demandsOf(root), []);
    assert.isUndefined(yield* slotOf(root));
    assert.deepStrictEqual(yield* admissionsOf(root), []);
  });

/** The automatic turn recorded for the message, if any: an owner's run inline is not. */
const recordedClass = (threadId: ThreadId, messageId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly class: string }>`SELECT class FROM fd_factory_automatic_turns
      WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.class),
  );

describe("a native wake's origin, across the runs on its provider thread", () => {
  it.effect(
    "Factory's background work, then the owner's turn, then the delayed wake: unknown, so it waits",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } = yield* claimIdea(world, "export");
            const author = yield* world.launched(root);
            const turn =
              world.provider.started.find((candidate) => candidate.runId === author.runId) ??
              assert.fail("The author's turn did not start.");
            // Factory's run leaves background work going, and reaches its open pull request.
            yield* world.provider.startCommand(turn, "vp run dev");
            yield* providerTurnRunning(author.threadId);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, root);
            yield* tick;
            assert.isUndefined(yield* slotOf(root));
            const providerThread = yield* providerThreadOf(author.threadId, author.runId);

            // The owner's turn runs on the same provider thread, under any capacity.
            const [filler] = yield* fill(world, 2);
            const ownerRun = yield* world.ownerTurn(author.threadId, "Rename the button.");
            yield* world.endRun(ownerRun, "completed");
            yield* drainOrchestration;
            assert.deepStrictEqual(yield* demandsOf(root), []);
            const runs = (yield* runsOf(author.threadId)).length;

            // The delayed wake is either's: no run, one demand, counted as the delivery's.
            const native = nativeOffers();
            const wake = yield* offerNative(author.threadId, providerThread, "plain", native);
            yield* watch.decided("background_wake", "demand");
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ kind, provenance }) => [kind, provenance]),
              [["background_wake", "unknown"]],
            );
            assert.strictEqual(yield* recordedClass(author.threadId, wake), "unknown");
            assert.strictEqual((yield* runsOf(author.threadId)).length, runs);

            // With the root edited, its grant's fresh read blocks it, and still nothing runs.
            yield* ownerEdits(ref);
            yield* release(filler!);
            yield* tick;
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ blockedReason }) => blockedReason),
              ["scope_changed"],
            );
            assert.isUndefined(yield* slotOf(root));
            assert.strictEqual((yield* runsOf(author.threadId)).length, runs);

            // Restored with a slot free, the next check due runs it once, under the family's slot.
            yield* ownerRestores(ref);
            yield* TestClock.adjust("3 minutes");
            yield* tick;
            const run = yield* runOfMessage(wake);
            yield* runStarted(run);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepStrictEqual(yield* demandsOf(root), []);
            assert.lengthOf(yield* runsOfMessage(author.threadId, wake), 1);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* world.endRun(run, "completed");
            yield* tick;
            yield* nothingOfRoot(root);
            assert.lengthOf(yield* runsOfMessage(author.threadId, wake), 1);
          }),
        stack(spy, { handoff: { admission: watch.admission } }),
      );
    },
    240_000,
  );

  it.live(
    "the owner's background work, then Factory's turn, then the wake takes the same path",
    () => {
      const spy = spyOnFactoryPort();
      const watch = decisionWatch();
      return withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { root } = yield* claimIdea(world, "export");
            const author = yield* world.launched(root);
            const providerThread = yield* providerThreadOf(author.threadId, author.runId);
            yield* fill(world, 1);

            // The owner's turn runs first, leaving its background work; Factory's repair follows it.
            const ownerRun = yield* ownerQueues(author.threadId, "Rename the button.");
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* runStarted(ownerRun);
            const ownerTurn =
              world.provider.started.find((candidate) => candidate.runId === ownerRun) ??
              assert.fail("The owner's turn did not start.");
            yield* world.provider.startCommand(ownerTurn, "vp run dev");
            yield* world.endRun(ownerRun, "completed");
            const { awaiting } = yield* stateOf(root);
            if (awaiting?.type !== "run" || awaiting.threadId !== author.threadId) {
              return assert.fail("Factory's repair turn does not run on the author's thread.");
            }

            // Held by its own repair, the wake still waits for a grant of its own.
            const native = nativeOffers();
            const wake = yield* offerNative(author.threadId, providerThread, "callbacks", native);
            yield* watch.decided("background_wake", "demand");
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ provenance }) => provenance),
              ["unknown"],
            );
            assert.deepStrictEqual(native.dispatched, []);
            assert.deepStrictEqual(yield* runsOfMessage(author.threadId, wake), []);

            // The repair ends the delivery's work: its slot goes, and the grant runs the wake once.
            yield* runStarted(awaiting.runId);
            yield* world.endRun(awaiting.runId, "completed");
            yield* tick;
            assert.strictEqual((yield* stateOf(root)).status, "blocked");
            yield* tick;
            assert.deepStrictEqual(native.dispatched, [wake]);
            const run = yield* runOfMessage(wake);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* runStarted(run);
            yield* world.endRun(run, "completed");
            yield* tick;
            assert.lengthOf(yield* runsOfMessage(author.threadId, wake), 1);
            assert.deepStrictEqual(yield* demandsOf(root), []);
            assert.deepStrictEqual(native.cleared, []);
          }),
        stack(spy, { handoff: { admission: watch.admission }, limits: { maxFixRounds: 1 } }),
      );
    },
  );

  it.live(
    "a wake on a provider thread only the owner's turns used runs inline at full capacity",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread } = yield* deliverIdea(world);
            yield* fill(world, 2);
            // The owner delegates a task themselves: its provider thread carries only theirs.
            const ownerRun = yield* world.ownerTurn(thread, "Split the export.");
            const task = yield* delegateFrom(thread, ownerRun, "user");
            const native = nativeOffers();
            const wake = yield* offerNative(
              task.childThreadId,
              yield* providerThreadOf(task.childThreadId, task.runId),
              "plain",
              native,
            );
            // Queued at once behind the child's own turn, asking nothing of the family's capacity.
            const run = yield* runOfMessage(wake);
            assert.strictEqual(yield* recordedClass(task.childThreadId, wake), "explicit");
            yield* nothingOfRoot(root);
            yield* world.endRun(task.runId, "completed");
            yield* runStarted(run);
            yield* world.endRun(run, "completed");
            assert.lengthOf(yield* runsOfMessage(task.childThreadId, wake), 1);
            yield* tick;
            assert.deepStrictEqual(
              (yield* demandsOf(root)).filter(({ kind }) => kind === "background_wake"),
              [],
            );
            assert.isUndefined(yield* slotOf(root));
          }),
        stack(spy),
      );
    },
  );

  it.live(
    "an unrelated owner pull request's wake and its continuation run inline, holding nothing",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread, opened } = yield* deliverIdea(world);
            yield* fill(world, 2);
            // The owner watches another pull request on the author's thread, right after its run.
            const owned = {
              host: "github.com",
              repository: "acme/alpha",
              number: 8,
              url: "https://github.com/acme/alpha/pull/8",
            };
            yield* linkPullRequest(thread, owned);
            yield* watchPullRequest(thread, owned);
            const wake = yield* wakeThroughGate(thread, yield* linkOf(thread, 8));
            assert.strictEqual(wake.outcome._tag, "Ran");
            const runId = wake.runId ?? assert.fail("The owner's wake started no run.");
            yield* runStarted(runId);
            assert.strictEqual(yield* recordedClass(thread, wake.turn.messageId), "explicit");
            yield* nothingOfRoot(root);
            yield* tick;
            yield* nothingOfRoot(root);
            assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");
            assert.isDefined(opened);

            // A restart cuts it, and core's continuation of it is the owner's too.
            yield* providerTurnRunning(thread);
            const recovery = yield* coreRecovery;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                const continued = (yield* runsOf(thread)).filter(
                  (run) => run.restartContinuationOfRunId === runId,
                );
                assert.lengthOf(continued, 1);
                yield* runStarted(continued[0]!.id);
                yield* nothingOfRoot(root);
                yield* tick;
                yield* nothingOfRoot(root);
                yield* world.endRun(continued[0]!.id, "completed");
                yield* tick;
                yield* nothingOfRoot(root);
              }),
              { orchestration: true },
            );
          }),
        stack(spy),
      );
    },
  );
});

describe("a managed delivery's agents and their run-creating tools", () => {
  it.live(
    "a worker and its owned child are refused each one, under full capacity and changed Work",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } = yield* claimIdea(world, "export");
            const author = yield* world.launched(root);
            const child = yield* delegateFrom(author.threadId, author.runId);
            yield* fill(world, 1);
            const outsideFamily = yield* startOwnerThread(world);
            const matrix = (callers: ReadonlyArray<McpCaller>) =>
              Effect.forEach(
                callers,
                (caller) =>
                  refusesAll(
                    caller,
                    runCreatingCalls(world, {
                      own: caller.threadId,
                      family:
                        caller.threadId === author.threadId ? child.childThreadId : author.threadId,
                      owner: outsideFamily,
                    }),
                    text.active,
                  ),
                { discard: true },
              );
            const unchangedBy = (callers: ReadonlyArray<McpCaller>, label: string) =>
              Effect.gen(function* () {
                const before = yield* writtenRows;
                yield* matrix(callers);
                yield* drainOrchestration;
                yield* drainFactory;
                assert.deepStrictEqual(yield* writtenRows, before, label);
              });

            yield* withEndpoint(driver, (endpoint) =>
              Effect.gen(function* () {
                const callers = [
                  yield* endpoint.callerOn(author.threadId),
                  yield* endpoint.callerOn(child.childThreadId),
                ];
                yield* unchangedBy(callers, "full capacity");
                yield* ownerEdits(ref);
                yield* unchangedBy(callers, "full capacity and changed Work");
              }),
            );
            assert.deepStrictEqual(yield* governedMessages(root), []);

            // A rebuilt server issues new credentials, and refuses them the same way.
            yield* world.rebuild(
              withEndpoint(driver, (endpoint) =>
                Effect.gen(function* () {
                  yield* drainOrchestration;
                  yield* drainFactory;
                  yield* unchangedBy(
                    [
                      yield* endpoint.callerOn(author.threadId),
                      yield* endpoint.callerOn(child.childThreadId),
                    ],
                    "rebuilt",
                  );
                  assert.deepStrictEqual(yield* governedMessages(root), []);
                }),
              ),
              { orchestration: true },
            );
          }),
        stack(spy),
      );
    },
    300_000,
  );
});

/** An ordinary thread of the owner's, on a project of its own, outside every family. */
const startOwnerThread = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(path.dirname(world.root), "owner-thread");
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    const { threadId } = yield* world.ownerThreadAt(folder, "Plan the export with me.");
    return threadId;
  }).pipe(Effect.orDie);

const childrenOf = (threadId: ThreadId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ subagents }) => subagents.length),
    Effect.orDie,
  );

describe("delegate_task from a managed delivery's threads", () => {
  it.live(
    "runs once and counted under a held slot, and is refused without fresh authority",
    () =>
      Effect.flatMap(makeRetirementProbe, (probe) => {
        const spy = spyOnFactoryPort();
        const reads = { on: false };
        return withProject(
          verifyCommands.passes,
          (world) =>
            withEndpoint(driver, (endpoint) =>
              probe.guarded(
                Effect.gen(function* () {
                  const factory = yield* factoryService;
                  const admission = yield* HandoffAdmission.HandoffAdmission;
                  yield* startAssistantThread(world);
                  const { ref, root } = yield* claimIdea(world, "export");
                  const author = yield* world.launched(root);
                  yield* providerTurnRunning(author.threadId);
                  const agent = yield* endpoint.callerOn(author.threadId);
                  const delegate = (task: string) => agent.call("delegate_task", { task });

                  const refusedWith = (label: string, expected: string) =>
                    Effect.gen(function* () {
                      const before = yield* writtenRows;
                      const refused = yield* delegate(`Refused while ${label}.`);
                      assert.isTrue(refused.isError, label);
                      assert.include(refused.text, expected, label);
                      yield* drainOrchestration;
                      assert.deepStrictEqual(yield* writtenRows, before, label);
                    });

                  // Refused for each thing that takes its authority away, leaving the holding as it was.
                  yield* authorizeIdea(world, "export", false);
                  yield* refusedWith(
                    "revoked",
                    Factory.FactoryAdmission.admissionRefusalText.revoked,
                  );
                  yield* authorizeIdea(world, "export");
                  yield* ownerEdits(ref);
                  yield* refusedWith(
                    "changed",
                    Factory.FactoryAdmission.admissionRefusalText.scope_changed,
                  );
                  yield* ownerRestores(ref);
                  reads.on = true;
                  yield* refusedWith(
                    "unreadable",
                    Factory.FactoryAdmission.admissionRefusalText.unreadable,
                  );
                  reads.on = false;
                  assert.strictEqual(yield* childrenOf(author.threadId), 0);

                  // Under its held slot with fresh Work it is admitted, and from that commit it keeps the
                  // slot: the release pass frees nothing, and no child exists yet.
                  probe.armed.admitted = true;
                  const delegating = yield* delegate("Check the CSV export.").pipe(
                    Effect.forkChild,
                  );
                  yield* Deferred.await(probe.gates.admitted.entered);
                  assert.isTrue(
                    (yield* admissionsOf(root)).some(
                      ({ kind, state }) => kind === "delegation" && state === "dispatching",
                    ),
                  );
                  const holding = (yield* slotOf(root)) ?? assert.fail("The root holds no slot.");
                  assert.strictEqual(yield* admission.release(root, holding.entry_seq), "kept");
                  assert.strictEqual(yield* childrenOf(author.threadId), 0);
                  yield* Deferred.succeed(probe.gates.admitted.go, undefined);

                  // Let go: one child, a family thread, counted.
                  const answered = yield* Fiber.join(delegating);
                  assert.isFalse(answered.isError, answered.text);
                  yield* drainOrchestration;
                  assert.strictEqual(yield* childrenOf(author.threadId), 1);
                  const { subagents } = yield* threadProjection(author.threadId);
                  const childThread =
                    subagents[0]?.childThreadId ?? assert.fail("The delegation made no thread.");
                  assert.strictEqual(yield* factory.familyRoot(childThread), root);
                  assert.isTrue(
                    (yield* admissionsOf(root)).some(
                      ({ kind, state }) => kind === "delegation" && state === "dispatched",
                    ),
                  );
                  const childRuns = yield* runsOf(childThread);
                  assert.lengthOf(childRuns, 1);
                  yield* runStarted(childRuns[0]!.id);

                  // The delegation counts: with its author done and parked, its slot stays until it ends.
                  yield* authorCommits(author.worktreePath, "feat: add the export button");
                  yield* world.endRun(author.runId, "completed");
                  yield* reviewPasses(world, root);
                  assert.strictEqual((yield* stateOf(root)).status, "pr_open");
                  yield* tick;
                  assert.strictEqual((yield* slotOf(root))?.state, "held");
                  const activity = yield* factory.activity(root);
                  assert.strictEqual(activity.phase, "parked");
                  assert.isTrue(activity.busy);
                  yield* world.endRun(childRuns[0]!.id, "completed");
                  yield* tick;

                  // The result of the child takes a quantum of its own, then nothing holds the slot.
                  const [result] = yield* demandsOf(root);
                  if (result?.messageId != null) {
                    yield* tick;
                    const run = yield* runOfMessage(result.messageId);
                    yield* runStarted(run);
                    yield* world.endRun(run, "completed");
                    yield* tick;
                  }
                  assert.isUndefined(yield* slotOf(root));

                  // Parked, with no slot to run under: refused, with nothing made, whoever's turn runs.
                  yield* world.ownerTurn(author.threadId, "Look into a CSV option.");
                  const parked = yield* endpoint.callerOn(author.threadId);
                  const before = yield* writtenRows;
                  const refused = yield* parked.call("delegate_task", {
                    task: "Refused while parked.",
                  });
                  assert.isTrue(refused.isError);
                  assert.include(refused.text, text.notHolding);
                  assert.deepStrictEqual(yield* writtenRows, before);
                  assert.strictEqual(yield* childrenOf(author.threadId), 1);
                }),
              ),
            ),
          stack(spy, { handoff: { probe: probe.probe }, work: unreadableForAssistant(reads) }),
        );
      }),
    300_000,
  );

  it.live("is refused once its root is ending, and once it is retired", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        withEndpoint(driver, (endpoint) =>
          Effect.gen(function* () {
            const { root, thread } = yield* deliverIdea(world);
            yield* syncPullRequest(thread, yield* linkOf(thread, fakePullRequest.number), "merged");
            yield* drainFactory;
            assert.strictEqual((yield* stateOf(root)).status, "done");
            const agent = yield* endpoint.callerOn(thread);
            const refused = (label: string) =>
              Effect.gen(function* () {
                const before = yield* handoffRows;
                assert.deepStrictEqual(
                  yield* agent.call("delegate_task", { task: "Check the export." }),
                  { isError: true, text: text.retired },
                  label,
                );
                assert.deepStrictEqual(yield* handoffRows, before, label);
                assert.strictEqual(yield* childrenOf(thread), 0, label);
              });

            const restore = yield* failOutboxReads;
            yield* tick;
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "ending",
              reason: "completed",
            });
            yield* refused("ending");
            yield* restore;
            yield* tick;
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: "completed",
            });
            yield* refused("retired");
            assert.strictEqual(yield* childrenOf(thread), 0);
          }),
        ),
      stack(spy),
    );
  });
});

const requestOf = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  threadProjection(threadId).pipe(
    Effect.map(
      ({ runtimeRequests }) =>
        runtimeRequests.find((request) => request.id === requestId) ??
        assert.fail(`Request ${requestId} is gone.`),
    ),
    Effect.orDie,
  );

const respondedTo = (world: World, requestId: RuntimeRequestId) =>
  world.provider.responded.filter((response) => response.requestId === requestId).length;

const answering = (caller: McpCaller, threadId: ThreadId) => (requestId: RuntimeRequestId) =>
  caller.call("t3_pending_request_respond", {
    threadId,
    requestId,
    answers: { format: "CSV" },
  });

/** The answer is refused with `expected`, and nothing moves, the request still pending. */
const refusedUnchanged = (
  world: World,
  answer: (requestId: RuntimeRequestId) => ReturnType<McpCaller["call"]>,
  target: ThreadId,
  requestId: RuntimeRequestId,
  expected: string,
  label: string,
) =>
  Effect.gen(function* () {
    const before = yield* writtenRows;
    const responses = world.provider.responded.length;
    assert.deepStrictEqual(yield* answer(requestId), { isError: true, text: expected }, label);
    yield* drainOrchestration;
    yield* drainFactory;
    assert.deepStrictEqual(yield* writtenRows, before, label);
    assert.strictEqual((yield* requestOf(target, requestId)).status, "pending", label);
    assert.strictEqual(world.provider.responded.length, responses, label);
  });

/** The live answer continues the run once: one provider response, no message and no run. */
const continuedOnce = (
  world: World,
  answer: (requestId: RuntimeRequestId) => ReturnType<McpCaller["call"]>,
  target: ThreadId,
  requestId: RuntimeRequestId,
) =>
  Effect.gen(function* () {
    const before = yield* threadProjection(target);
    const answered = yield* answer(requestId);
    assert.isFalse(answered.isError, answered.text);
    yield* drainOrchestration;
    assert.strictEqual(respondedTo(world, requestId), 1);
    const after = yield* threadProjection(target);
    assert.strictEqual(after.messages.length, before.messages.length);
    assert.strictEqual(after.runs.length, before.runs.length);
    assert.strictEqual(
      after.runtimeRequests.find((request) => request.id === requestId)?.status,
      "resolved",
    );
  }).pipe(Effect.orDie);

describe("a governed parent's answers to its child", () => {
  it.live(
    "a message-capable question is refused in every condition, and a live one continues once",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              yield* startAssistantThread(world);
              const { ref, root } = yield* claimIdea(world, "export");
              const author = yield* world.launched(root);
              const child = yield* delegateFrom(author.threadId, author.runId);
              const parent = yield* endpoint.callerOn(author.threadId);
              const answer = answering(parent, child.childThreadId);
              const refuse = (requestId: RuntimeRequestId, expected: string, label: string) =>
                refusedUnchanged(world, answer, child.childThreadId, requestId, expected, label);

              // The provider would take this answer as a new turn, with the child's turn steerable.
              const message = yield* askedOn(world, child.runId, "message");
              const messageText = text.message(child.childThreadId);
              yield* refuse(message, messageText, "steerable target");
              yield* fill(world, 1);
              yield* refuse(message, messageText, "full capacity");
              yield* authorizeIdea(world, "export", false);
              yield* refuse(message, messageText, "revoked");
              yield* authorizeIdea(world, "export");
              yield* ownerEdits(ref);
              yield* refuse(message, messageText, "changed");
              yield* ownerRestores(ref);

              // A live question of the counted running child is continued, exactly once.
              const live = yield* askedOn(world, child.runId, "live");
              yield* continuedOnce(world, answer, child.childThreadId, live);
              yield* refuse(message, messageText, "after a live answer");

              // The child completes; its question stays pending, and stays refused, across a rebuild.
              const turn =
                world.provider.started.find((candidate) => candidate.runId === child.runId) ??
                assert.fail("The child's turn did not start.");
              yield* world.provider.endTurn(turn, "completed");
              yield* runReached(child.runId, ["waiting", ...ended]);
              yield* drainOrchestration;
              yield* drainFactory;
              yield* refuse(message, messageText, "completed child");
              assert.deepStrictEqual(yield* governedMessages(root), []);
              yield* world.rebuild(
                withEndpoint(driver, (rebuilt) =>
                  Effect.gen(function* () {
                    yield* drainOrchestration;
                    yield* drainFactory;
                    yield* refusedUnchanged(
                      world,
                      answering(yield* rebuilt.callerOn(author.threadId), child.childThreadId),
                      child.childThreadId,
                      message,
                      messageText,
                      "rebuilt",
                    );
                    assert.deepStrictEqual(yield* governedMessages(root), []);
                  }),
                ),
                { orchestration: true },
              );
            }),
          ),
        stack(spy),
      );
    },
    300_000,
  );

  it.live.each([{ origin: "factory" as const }, { origin: "unknown" as const }])(
    "on an ending root still holding its slot, a $origin run's live question is answered once",
    ({ origin }) =>
      Effect.flatMap(makeRetirementProbe, (probe) => {
        const spy = spyOnFactoryPort();
        return withProject(
          verifyCommands.passes,
          (world) =>
            withEndpoint(driver, (endpoint) =>
              probe.guarded(
                Effect.gen(function* () {
                  const { root, thread, opened } = yield* deliverIdea(world);
                  const providerThread = yield* providerThreadOf(thread, opened.runId);
                  const { threads } = yield* stateOf(root);
                  const reviewer = threads.reviewer ?? assert.fail("No reviewer ran.");
                  // An owner's turn on the provider thread clouds the origin of what wakes it next.
                  if (origin === "unknown") {
                    yield* world.endRun(
                      yield* world.ownerTurn(thread, "Rename the button."),
                      "completed",
                    );
                  }
                  yield* syncPullRequest(
                    thread,
                    yield* linkOf(thread, fakePullRequest.number),
                    "closed",
                  );
                  yield* drainFactory;
                  assert.strictEqual((yield* stateOf(root)).status, "cancelled");

                  // A native wake commits its admission just as the retirement observes the root.
                  probe.armed.released = true;
                  const ticking = yield* tick.pipe(Effect.forkChild);
                  yield* Deferred.await(probe.gates.released.entered);
                  probe.armed.admitted = true;
                  const native = nativeOffers();
                  const wake = yield* offerNative(thread, providerThread, "plain", native);
                  yield* Deferred.await(probe.gates.admitted.entered);
                  assert.strictEqual((yield* slotOf(root))?.state, "held");
                  yield* Deferred.succeed(probe.gates.released.go, undefined);
                  yield* Fiber.join(ticking);
                  assert.deepStrictEqual(yield* managedRootOf(root), {
                    state: "ending",
                    reason: "cancelled",
                  });
                  yield* Deferred.succeed(probe.gates.admitted.go, undefined);
                  const counted = yield* runOfMessage(wake);
                  yield* runStarted(counted);
                  assert.strictEqual((yield* slotOf(root))?.state, "held");
                  assert.strictEqual(yield* recordedClass(thread, wake), origin);

                  // The agent of the counted run, whose thread's credential is its own.
                  const agent = yield* endpoint.callerOn(thread);
                  const answer = answering(agent, thread);
                  // A live question of the counted run: one provider response, no message or run.
                  const live = yield* askedOn(world, counted, "live");
                  yield* continuedOnce(world, answer, thread, live);
                  assert.deepStrictEqual(yield* governedMessages(root), []);

                  // A question whose answer would start a turn is refused, as ever.
                  const message = yield* askedOn(world, counted, "message");
                  yield* refusedUnchanged(
                    world,
                    answer,
                    thread,
                    message,
                    text.message(thread),
                    "ending, message-capable",
                  );

                  // The owner's turn on another family thread is no work of the root's.
                  const ownerRun = yield* world.ownerTurn(reviewer, "Also check a header.");
                  const explicit = yield* askedOn(world, ownerRun, "live");
                  yield* refusedUnchanged(
                    world,
                    answering(agent, reviewer),
                    reviewer,
                    explicit,
                    text.liveOnly(reviewer),
                    "ending, explicit run",
                  );

                  // Its completed child's message-capable question is refused too, unchanged.
                  const child = yield* delegateFrom(reviewer, ownerRun, "user");
                  const completedAsked = yield* askedOn(world, child.runId, "message");
                  yield* world.endRun(child.runId, "completed");
                  yield* drainOrchestration;
                  yield* refusedUnchanged(
                    world,
                    answering(agent, child.childThreadId),
                    child.childThreadId,
                    completedAsked,
                    text.message(child.childThreadId),
                    "ending, a completed child's message-capable question",
                  );

                  // Drained, it retires, and every answer is refused unchanged from then on.
                  yield* world.endRun(counted, "completed");
                  yield* tick;
                  assert.deepStrictEqual(yield* managedRootOf(root), {
                    state: "retired",
                    reason: "cancelled",
                  });
                  assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
                  yield* assertNothingHeld(root, "export");
                  yield* refusedUnchanged(
                    world,
                    answering(agent, reviewer),
                    reviewer,
                    explicit,
                    text.retired,
                    "retired, live",
                  );
                  const late = yield* askedOn(world, ownerRun, "live");
                  yield* refusedUnchanged(
                    world,
                    answering(agent, reviewer),
                    reviewer,
                    late,
                    text.retired,
                    "retired, a new live question",
                  );
                  const lateMessage = yield* askedOn(world, ownerRun, "message");
                  yield* refusedUnchanged(
                    world,
                    answering(agent, reviewer),
                    reviewer,
                    lateMessage,
                    text.retired,
                    "retired, message-capable",
                  );
                  assert.deepStrictEqual(yield* governedMessages(root), []);
                  yield* world.endRun(ownerRun, "completed");
                }),
              ),
            ),
          stack(spy, { handoff: { probe: probe.probe } }),
        );
      }),
    300_000,
  );
});

describe("everyone else's answers and sends", () => {
  it.live(
    "the owner's client and an ordinary thread's agent run inline, as explicit",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const { root, thread } = yield* deliverIdea(world);
              yield* fill(world, 2);
              const ownerThread = yield* startOwnerThread(world);
              const ownerAgent = yield* endpoint.callerOn(ownerThread);

              // An ordinary thread's agent sends to the family's thread: it runs inline, once.
              const runs = (yield* runsOf(thread)).length;
              const sent = yield* ownerAgent.call("t3_thread_send", {
                threadId: thread,
                message: "Also add a CSV option.",
                mode: "queue",
              });
              assert.isFalse(sent.isError, sent.text);
              yield* drainOrchestration;
              const after = yield* runsOf(thread);
              assert.strictEqual(after.length, runs + 1);
              const run = after.at(-1) ?? assert.fail("The send started no run.");
              yield* nothingOfRoot(root);
              yield* runStarted(run.id);
              yield* world.endRun(run.id, "completed");
              yield* tick;
              yield* nothingOfRoot(root);

              // A child of the owner's turn asks: each of them answers, under the same capacity.
              const ownerRun = yield* world.ownerTurn(thread, "Split the export.");
              const child = yield* delegateFrom(thread, ownerRun, "user");
              const fromAgent = yield* askedOn(world, child.runId, "message");
              const fromOwner = yield* askedOn(world, child.runId, "message");
              const fromOutside = yield* askedOn(world, child.runId, "message");
              const live = yield* askedOn(world, child.runId, "live");
              const asyncAnswer = (requestId: RuntimeRequestId) => `async-answer:${requestId}`;
              const answered = (requestId: RuntimeRequestId) =>
                threadProjection(child.childThreadId).pipe(
                  Effect.map(({ messages }) =>
                    messages.some(({ id }) => id === asyncAnswer(requestId)),
                  ),
                  Effect.orDie,
                );

              // Its live question, by the ordinary agent: the provider's one response.
              yield* continuedOnce(
                world,
                answering(ownerAgent, child.childThreadId),
                child.childThreadId,
                live,
              );

              const answerAgent = yield* answering(ownerAgent, child.childThreadId)(fromAgent);
              assert.isFalse(answerAgent.isError, answerAgent.text);
              assert.isTrue(yield* answered(fromAgent));
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* orchestrator
                .dispatch({
                  type: "runtime-request.respond",
                  commandId: CommandId.make("owner-answer"),
                  threadId: child.childThreadId,
                  requestId: fromOwner,
                  answers: { format: "CSV" },
                })
                .pipe(Effect.orDie);
              assert.isTrue(yield* answered(fromOwner));
              const outside = yield* endpoint.outsideClient;
              const outsideAnswer = yield* outside.call("t3_pending_request_respond", {
                threadId: child.childThreadId,
                requestId: fromOutside,
                answers: { format: "CSV" },
              });
              assert.isFalse(outsideAnswer.isError, outsideAnswer.text);
              assert.isTrue(yield* answered(fromOutside));
              yield* drainOrchestration;
              // None of them took a slot or waited.
              assert.deepStrictEqual(
                (yield* demandsOf(root)).filter(({ kind }) => kind !== "delegated_completion"),
                [],
              );
              assert.isUndefined(yield* slotOf(root));
              assert.sameMembers(yield* governedMessages(root), [
                asyncAnswer(fromAgent),
                asyncAnswer(fromOwner),
                asyncAnswer(fromOutside),
              ]);
            }),
          ),
        stack(spy),
      );
    },
    240_000,
  );

  it.live(
    "agents of a delivery no assistant manages send, delegate and answer as ever",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const factory = yield* factoryService;
              const author = yield* world.start;
              assert.isUndefined(yield* managedRootOf(author.deliveryId));
              yield* providerTurnRunning(author.threadId);
              const agent = yield* endpoint.callerOn(author.threadId);
              const before = (yield* runsOf(author.threadId)).length;
              const sent = yield* agent.call("t3_thread_send", {
                threadId: author.threadId,
                message: "Note for later.",
                mode: "queue",
              });
              assert.isFalse(sent.isError, sent.text);
              assert.strictEqual((yield* runsOf(author.threadId)).length, before + 1);

              const delegated = yield* agent.call("delegate_task", { task: "Check the export." });
              assert.isFalse(delegated.isError, delegated.text);
              yield* drainOrchestration;
              const { subagents } = yield* threadProjection(author.threadId);
              const childThread =
                subagents[0]?.childThreadId ?? assert.fail("The delegation made no thread.");
              const childRun = (yield* runsOf(childThread))[0] ?? assert.fail("No child run.");
              yield* runStarted(childRun.id);
              const message = yield* askedOn(world, childRun.id, "message");
              const answered = yield* answering(agent, childThread)(message);
              assert.isFalse(answered.isError, answered.text);
              // No assistant row was written for any of it.
              const rows = yield* handoffRows;
              assert.isTrue(Object.values(rows).every((table) => table.length === 0));
              assert.strictEqual(yield* factory.familyRoot(childThread), author.deliveryId);
              assert.strictEqual(spy.count("start"), 0);
            }),
          ),
        stack(spy),
      );
    },
    240_000,
  );
});

const refuseRecords = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER acceptance_refuses_record BEFORE INSERT ON fd_factory_automatic_turns
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
).pipe(Effect.orDie);
const allowRecords = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER acceptance_refuses_record`,
).pipe(Effect.orDie);

describe("a callback-free native offer the gate could not decide", () => {
  /**
   * Fails the admission's management read while `reads > 0`, as an ownership read that fails does,
   * and reports each consult of a native wake as it ends, so a test drives the backoff's clock to
   * exactly the attempt it means.
   */
  const faults = () => {
    const control = { reads: 0 };
    const attempts: Array<{
      readonly messageId: MessageId;
      readonly undecided: boolean;
      readonly done: Deferred.Deferred<void>;
    }> = [];
    const waiting: Array<{ readonly count: number; readonly done: Deferred.Deferred<void> }> = [];
    return {
      control,
      attempts,
      /** Waits until the native wake has been consulted `count` times, driving the backoff's clock. */
      consulted: (count: number) =>
        Effect.gen(function* () {
          if (attempts.length >= count) return;
          const done = Deferred.makeUnsafe<void>();
          waiting.push({ count, done });
          while (!(yield* Deferred.isDone(done))) {
            yield* TestClock.adjust("100 millis");
            yield* Effect.yieldNow;
          }
        }),
      admission: (
        service: HandoffAdmission.HandoffAdmission["Service"],
      ): HandoffAdmission.HandoffAdmission["Service"] => ({
        ...service,
        management: (root) =>
          control.reads > 0
            ? Effect.suspend(() => {
                control.reads -= 1;
                return Effect.fail(
                  new HandoffAdmission.HandoffAdmissionError({
                    operation: "management",
                    root,
                    cause: "held by the test",
                  }),
                );
              })
            : service.management(root),
      }),
      gateConsults: (
        turn: AutomaticTurnGate.AutomaticTurn,
        exit: Exit.Exit<unknown, unknown>,
      ): Effect.Effect<void> =>
        turn.kind !== "background_wake"
          ? Effect.void
          : Effect.suspend(() => {
              attempts.push({
                messageId: turn.messageId,
                undecided: Exit.isFailure(exit),
                done: Deferred.makeUnsafe(),
              });
              return Effect.forEach(
                waiting.filter(({ count }) => attempts.length >= count),
                ({ done }) => Deferred.succeed(done, undefined),
                { discard: true },
              );
            }),
    };
  };

  it.effect.each([
    { capacity: "with a slot free", full: false },
    { capacity: "under full capacity", full: true },
  ])(
    "runs nothing and clears nothing, then runs once $capacity under the same id",
    ({ full }) => {
      const spy = spyOnFactoryPort();
      const fault = faults();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, opened, thread } = yield* deliverIdea(world);
            const providerThread = yield* providerThreadOf(thread, opened.runId);
            const [filler] = full ? yield* fill(world, 2) : [];
            const native = nativeOffers();
            const runs = (yield* runsOf(thread)).length;
            const rows = yield* handoffRows;

            // The ownership read fails, then the record's write: undecided twice, nothing moves.
            fault.control.reads = 1;
            yield* refuseRecords;
            yield* offerNative(thread, providerThread, "plain", native, { messageId: false });
            yield* fault.consulted(2);
            assert.isTrue(fault.attempts.every(({ undecided }) => undecided));
            assert.strictEqual((yield* runsOf(thread)).length, runs);
            assert.deepStrictEqual(yield* handoffRows, rows);
            assert.deepStrictEqual(native.cleared, []);
            assert.deepStrictEqual(native.dispatched, []);
            yield* allowRecords;

            // Restored, the same wake under the same id decides at last, by its re-offer.
            yield* fault.consulted(3);
            const [first] = fault.attempts;
            const messageId = first?.messageId ?? assert.fail("The wake was never consulted.");
            assert.deepStrictEqual(
              fault.attempts.map((attempt) => attempt.messageId),
              [messageId, messageId, messageId],
            );
            assert.isFalse(fault.attempts[2]?.undecided);
            yield* drainOrchestration;

            if (full) {
              assert.deepStrictEqual(
                (yield* demandsOf(root)).map(({ kind, messageId: id }) => [kind, id]),
                [["background_wake", messageId]],
              );
              assert.strictEqual((yield* runsOf(thread)).length, runs);
              yield* release(filler!);
              yield* tick;
            }
            const run = yield* runOfMessage(messageId);
            yield* runStarted(run);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepStrictEqual(yield* demandsOf(root), []);
            yield* world.endRun(run, "completed");
            yield* tick;
            assert.lengthOf(yield* runsOfMessage(thread, messageId), 1);
            assert.strictEqual((yield* runsOf(thread)).length, runs + 1);
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(native.cleared, []);

            // Decided, it is offered no more, however far the clock moves.
            const attempts = fault.attempts.length;
            yield* TestClock.adjust("1 hour");
            assert.strictEqual(fault.attempts.length, attempts);
          }),
        stack(spy, {
          handoff: { admission: fault.admission },
          gateConsults: fault.gateConsults,
        }),
      );
    },
    240_000,
  );
});
