import { assert, describe, it } from "@effect/vitest";
import { CommandId, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
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
import { agentSteers, delegateFrom, providerThreadOf } from "./testkit/familyThreads.ts";
import { linkOf, openSingle, reviewPasses, runStarted } from "./testkit/followThrough.ts";
import {
  admissionsOf,
  completionSteerFellBack,
  consult,
  consultRunning,
  decisionWatch,
  demandsOf,
  dispositionsOf,
  fill,
  grantOutcomesOf,
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
 * What waits for a project assistant slot across a restart, on the real stack. Each rebuild runs
 * core's startup recovery in the server's order before the first tick, and every instance of
 * Factory and the assistant is new: only durable rows, and core's own re-offers, carry anything
 * across. Afterwards no slot, reservation or admission row of it remains.
 */

const gated = { handoff: {}, automaticTurnGate: true };

const nothingLeft = (root: string) =>
  Effect.gen(function* () {
    assert.isUndefined(yield* slotOf(root));
    assert.deepStrictEqual(yield* admissionsOf(root), []);
    assert.deepStrictEqual(yield* demandsOf(root), []);
  });

/** The provider's question in the run's turn, once core stores it pending. */
const asked = (world: World, runId: Parameters<World["endRun"]>[0], mode: "live" | "message") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const turn =
      world.provider.started.find((candidate) => candidate.runId === runId) ??
      assert.fail(`No provider turn started run ${runId}.`);
    const requestId = yield* world.provider.ask(turn, mode);
    yield* sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "pending",
      ),
      Stream.runHead,
    );
    yield* drainOrchestration;
    return requestId;
  }).pipe(Effect.orDie);

const answer = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`test-answer:${requestId}`),
      threadId,
      requestId,
      answers: { format: "CSV" },
    }),
  ).pipe(Effect.orDie);

/**
 * The family at its open pull request and released, a delegate that ended leaving its question
 * unanswered, with that delegate's result already delivered and both slots full.
 */
const questionWaiting = (world: World, watch: ReturnType<typeof decisionWatch>) =>
  Effect.gen(function* () {
    const author = yield* world.start;
    const managed = yield* manage(world, author.deliveryId, { holding: true, state: "running" });
    const delegate = yield* delegateFrom(author.threadId, author.runId);
    const requestId = yield* asked(world, delegate.runId, "message");
    yield* world.endRun(delegate.runId, "completed");
    yield* watch.decided("delegated_completion", "demand");
    const result =
      (yield* demandsOf(managed.root))[0]?.messageId ?? assert.fail("No completion waits.");
    yield* authorCommits(author.worktreePath, "feat: add the export button");
    yield* world.endRun(author.runId, "completed");
    yield* reviewPasses(world, author.deliveryId);
    yield* drainOrchestration;
    yield* tick;
    const delivered = yield* runOfMessage(result);
    yield* runStarted(delivered);
    yield* world.endRun(delivered, "completed");
    yield* tick;
    assert.isUndefined(yield* slotOf(managed.root));
    const fillers = yield* fill(world, 2);
    const turn: AutomaticTurnGate.DelegatedQuestionTurn = {
      ...turns.delegatedQuestion(
        author.threadId,
        { childThreadId: delegate.childThreadId, taskId: delegate.taskId },
        author.runId,
      ),
      requestId,
      key: `${delegate.childThreadId}:${requestId}`,
    };
    const ran: Array<string> = [];
    assert.deepStrictEqual(yield* consult(turn, { ran }), AutomaticTurnGate.notNow("deferred"));
    assert.deepStrictEqual(ran, []);
    return { author, managed, delegate, requestId, fillers };
  });

describe("what waits for a slot across a restart", () => {
  it.live(
    "a message-capable question on a completed child is delivered once, after a rebuild",
    () => {
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { author, managed, requestId, fillers } = yield* questionWaiting(world, watch);
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                assert.lengthOf(yield* demandsOf(managed.root), 1);
                yield* release(fillers[0]!);
                yield* tick;
                const messageId = `message:delegated-task-question:${author.threadId}:${requestId}`;
                const run = yield* runOfMessage(messageId);
                assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
                yield* tick;
                yield* tick;
                assert.lengthOf(
                  (yield* runsOf(author.threadId)).filter((row) => row.userMessageId === messageId),
                  1,
                );
                yield* runStarted(run);
                yield* world.endRun(run, "completed");
                yield* tick;
                yield* nothingLeft(managed.root);
              }),
              { orchestration: true },
            );
          }),
        { ...gated, handoff: { admission: watch.admission } },
      );
    },
  );

  it.live(
    "a question reserved at the restart is redelivered by the next instance's first tick",
    () => {
      const watch = decisionWatch();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { author, managed, requestId, fillers } = yield* questionWaiting(world, watch);
            const sql = yield* SqlClient.SqlClient;
            // A reservation the last instance made, whose redelivery never happened.
            yield* release(fillers[0]!);
            const [demand] = yield* demandsOf(managed.root);
            yield* sql`INSERT INTO fd_assistant_slots (
              root_delivery_id, assignment_id, state, entry_seq, granted_at, reserved_demand_id,
              lease_until, redelivered_by
            ) VALUES (
              ${managed.root}, ${managed.assignmentId}, 'reserved', 9000,
              '2026-10-30T12:00:00.000Z', ${demand?.id ?? 0}, '2099-01-01T00:00:00.000Z', 'dead'
            )`;
            yield* sql`UPDATE fd_assistant_admission_demands SET state = 'reserved'
            WHERE id = ${demand?.id ?? 0}`;
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* tick;
                const messageId = `message:delegated-task-question:${author.threadId}:${requestId}`;
                const run = yield* runOfMessage(messageId);
                assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
                yield* tick;
                assert.lengthOf(
                  (yield* runsOf(author.threadId)).filter((row) => row.userMessageId === messageId),
                  1,
                );
                yield* runStarted(run);
                yield* world.endRun(run, "completed");
                yield* tick;
                yield* nothingLeft(managed.root);
              }),
              { orchestration: true },
            );
          }),
        { ...gated, handoff: { admission: watch.admission } },
      );
    },
  );

  it.live("a question answered before its delivery leaves nothing", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { author, managed, delegate, requestId, fillers } = yield* questionWaiting(
            world,
            watch,
          );
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* answer(delegate.childThreadId, requestId);
              yield* drainOrchestration;
              const before = (yield* runsOf(author.threadId)).length;
              yield* release(fillers[0]!);
              yield* tick;
              yield* drainOrchestration;
              yield* nothingLeft(managed.root);
              assert.strictEqual((yield* runsOf(author.threadId)).length, before);
              assert.deepInclude(yield* grantOutcomesOf(managed.root), {
                kind: "delegated_question",
                outcome: "moot",
              });
            }),
            { orchestration: true },
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a completion waiting at a restart converges once with core's boot re-offers", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          const [filler] = yield* fill(world, 1);
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "demand");
          const messageId =
            (yield* demandsOf(managed.root))[0]?.messageId ?? assert.fail("No demand.");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* reviewPasses(world, author.deliveryId);
          assert.strictEqual((yield* stateOf(author.deliveryId)).status, "pr_open");

          yield* world.rebuild(
            Effect.gen(function* () {
              // Core re-offered it at boot: the same demand, and still no run.
              yield* drainOrchestration;
              assert.lengthOf(yield* demandsOf(managed.root), 1);
              yield* tick;
              yield* tick;
              const run = yield* runOfMessage(messageId);
              yield* runStarted(run);
              yield* world.endRun(run, "completed");
              yield* tick;
              yield* nothingLeft(managed.root);
              assert.lengthOf(
                (yield* runsOf(author.threadId)).filter((row) => row.userMessageId === messageId),
                1,
              );
              assert.isDefined(filler);
            }),
            { orchestration: true },
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a completion acknowledged before its grant is moot once its lease ends", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          const [filler] = yield* fill(world, 1);
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          yield* world.endRun(delegate.runId, "completed");
          yield* watch.decided("delegated_completion", "demand");
          const [demand] = yield* demandsOf(managed.root);
          const messageId = demand?.messageId ?? assert.fail("No demand.");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* reviewPasses(world, author.deliveryId);

          // The owner reads the result, so the delivery is acknowledged.
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make("test-acknowledge"),
            parentThreadId: author.threadId,
            taskId: delegate.taskId,
            observedByRunId: null,
          });
          yield* drainOrchestration;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              const before = (yield* runsOf(author.threadId)).length;
              yield* tick;
              yield* tick;
              // Reserved, and redelivery finds it no longer current; the lease ends it.
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE fd_assistant_slots SET lease_until = '2000-01-01T00:00:00.000Z'
                WHERE root_delivery_id = ${managed.root}`;
              yield* tick;
              yield* nothingLeft(managed.root);
              assert.deepInclude(yield* grantOutcomesOf(managed.root), {
                kind: "delegated_completion",
                outcome: "moot",
              });
              assert.strictEqual((yield* runsOf(author.threadId)).length, before);
              assert.isFalse(
                (yield* runsOf(author.threadId)).some((row) => row.userMessageId === messageId),
              );
              assert.isDefined(filler);
            }),
            { orchestration: true },
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a steered result that fell back converges once with core's boot re-offer", () => {
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
          const before = yield* demandsOf(managed.root);
          yield* watch.forget;

          yield* world.rebuild(
            Effect.gen(function* () {
              // Core offers the settled steer's cohort again at boot: the same demand, no run.
              yield* watch.decided("delegated_completion", "demand");
              yield* drainOrchestration;
              assert.deepStrictEqual(
                (yield* demandsOf(managed.root)).map(({ id, seq }) => [id, seq]),
                before.map(({ id, seq }) => [id, seq]),
              );
              yield* tick;
              assert.isUndefined(yield* slotOf(managed.root));
              assert.isFalse(
                (yield* runsOf(opened.threadId)).some((run) => run.userMessageId === messageId),
              );

              yield* release(fillers[0]!);
              yield* tick;
              const run = yield* runOfMessage(messageId);
              yield* runStarted(run);
              assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
              yield* world.endRun(run, "completed");
              yield* tick;
              yield* nothingLeft(managed.root);
              assert.lengthOf(
                (yield* runsOf(opened.threadId)).filter((row) => row.userMessageId === messageId),
                1,
              );
            }),
            { orchestration: true },
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("a steered result acknowledged before its grant is moot, across a rebuild", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          const { fillers, messageId, taskId } = yield* completionSteerFellBack(
            world,
            watch,
            opened,
            managed,
          );
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make("test-acknowledge-steer"),
            parentThreadId: opened.threadId,
            taskId,
            observedByRunId: null,
          });
          yield* drainOrchestration;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              yield* release(fillers[0]!);
              yield* tick;
              // Reserved, and the redelivery finds nothing current; its lease ends it.
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE fd_assistant_slots SET lease_until = '2000-01-01T00:00:00.000Z'
                WHERE root_delivery_id = ${managed.root}`;
              yield* tick;
              yield* nothingLeft(managed.root);
              assert.deepInclude(yield* grantOutcomesOf(managed.root), {
                kind: "delegated_completion",
                outcome: "moot",
              });
              assert.isFalse(
                (yield* runsOf(opened.threadId)).some((run) => run.userMessageId === messageId),
              );
            }),
            { orchestration: true },
          );
        }),
      { ...gated, handoff: { admission: watch.admission } },
    );
  });

  it.live("an owner thread agent's steer that fell back runs once, inline, across a rebuild", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          yield* fill(world, 2);
          const thread = opened.threadId;

          // The owner's turn runs on the family's thread; an agent of the owner's steers into it.
          const ownerRun = yield* world.ownerTurn(thread, "Rename the button.");
          const turn =
            world.provider.started.find((candidate) => candidate.runId === ownerRun) ??
            assert.fail("The owner's turn did not start.");
          // Steerable once its provider turn runs; the thread's earlier turns do not count.
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.stream().pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-turn.updated" &&
                event.payload.runAttemptId === turn.attemptId &&
                event.payload.status === "running",
            ),
            Stream.runHead,
          );
          const messageId = yield* agentSteers(world.projectId, thread, managed.manager);
          const steered = (yield* runsOf(thread)).filter((run) => run.userMessageId === messageId);
          assert.deepStrictEqual(steered, []);

          // The turn ends before the steer reaches its provider: core's follow-up runs at once.
          yield* world.provider.endTurn(turn, "completed");
          yield* runReached(ownerRun, ["waiting", ...ended]);
          yield* drainOrchestration;
          const followUp = yield* runOfMessage(messageId);
          yield* runStarted(followUp);
          // Core's own follow-up for the steer that missed its turn, not a queued message.
          const created = yield* sink.stream().pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.created" && event.payload.userMessageId === messageId,
            ),
            Stream.runHead,
          );
          assert.isTrue(
            Option.exists(created, ({ commandId }) =>
              String(commandId).startsWith("command:steer-follow-up:"),
            ),
          );

          // Never gated: no demand, slot or admission of the root, with both slots full.
          const nothingOfRoot = Effect.gen(function* () {
            yield* nothingLeft(managed.root);
            assert.lengthOf(
              (yield* runsOf(thread)).filter((run) => run.userMessageId === messageId),
              1,
            );
          });
          yield* tick;
          yield* nothingOfRoot;
          yield* world.endRun(followUp, "completed");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              yield* tick;
              yield* nothingOfRoot;
            }),
            { orchestration: true },
          );
        }),
      gated,
    ),
  );

  it.live("a native wake waiting at a restart is lost, with one disposition and notice", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          const [filler] = yield* fill(world, 2);
          const providerThread = yield* providerThreadOf(opened.threadId, opened.runId);
          const ran: Array<string> = [];
          const wake = turns.backgroundWake(opened.threadId, providerThread);
          assert.deepStrictEqual(
            yield* consult(wake, { ran }),
            AutomaticTurnGate.notNow("deferred"),
          );
          const runs = (yield* runsOf(opened.threadId)).length;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              yield* nothingLeft(managed.root);
              const dispositions = yield* dispositionsOf(managed.root);
              assert.deepStrictEqual(
                dispositions.map(({ kind, outcome, adapter_clear, wake_key }) => [
                  kind,
                  outcome,
                  adapter_clear,
                  wake_key,
                ]),
                [["background_wake", "lost_on_restart", "unavailable", wake.messageId]],
              );
              assert.deepInclude(yield* grantOutcomesOf(managed.root), {
                kind: "background_wake",
                outcome: "lost_on_restart",
              });
              const lost = (yield* noticesOf(managed.assignmentId)).filter((note) =>
                note.includes("the server restarted before it could continue"),
              );
              assert.lengthOf(lost, 1);
              assert.deepStrictEqual(ran, []);
              assert.strictEqual((yield* runsOf(opened.threadId)).length, runs);

              // Nothing more comes of it, whatever frees up.
              yield* release(filler!);
              yield* tick;
              yield* tick;
              yield* nothingLeft(managed.root);
              assert.lengthOf(yield* dispositionsOf(managed.root), 1);
            }),
            { orchestration: true },
          );
        }),
      gated,
    ),
  );

  it.live("pull request and limit demands survive, and their producers ask again", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId, { state: "needs-input" });
          yield* tick;
          const thread = opened.threadId;
          const [filler] = yield* fill(world, 2);
          const link = yield* linkOf(thread, fakePullRequest.number);
          const limit = turns.usageLimitResume(thread, opened.runId);
          yield* consultRunning(world, limit);
          const wake = yield* wakeThroughGate(thread, link);
          assert.deepStrictEqual(wake.outcome, AutomaticTurnGate.notNow("deferred"));

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainOrchestration;
              assert.deepStrictEqual(
                (yield* demandsOf(managed.root)).map(({ kind }) => kind),
                ["usage_limit_resume", "pull_request_wake"],
              );
              yield* release(filler!);
              yield* tick;
              assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");

              // The worker's next sweep asks again, under the reservation.
              assert.strictEqual((yield* consultRunning(world, limit))._tag, "Ran");
              yield* drainOrchestration;
              const resumed = yield* runOfMessage(limit.messageId);
              yield* runReached(resumed, ["starting", ...ended]);
              yield* drainOrchestration;
              yield* world.endRun(resumed, "completed");
              yield* tick;

              // Then the watch's next sweep, under its own reservation; Factory takes it as a round.
              assert.strictEqual((yield* slotOf(managed.root))?.state, "reserved");
              const swept = yield* wakeThroughGate(thread, link);
              assert.strictEqual(swept.outcome._tag, "Ran");
              yield* drainFactory;
              yield* world.endRun(swept.runId!, "completed");
              yield* reviewPasses(world, opened.deliveryId);
              yield* tick;
              yield* nothingLeft(managed.root);
            }),
            { orchestration: true },
          );
        }),
      gated,
    ),
  );
});
