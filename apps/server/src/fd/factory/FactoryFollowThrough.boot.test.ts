import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
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
import { linkOf, openSingle, wakeThread } from "./testkit/followThrough.ts";

/**
 * Follow-through rounds across restarts and cancels, on the server's real stack. With
 * `manualReactor`, Factory's reactor runs only while a server boots it, so a wake core's watch
 * queues between two boots reaches Factory only through the next boot sweep, which reads it from
 * the event log. A cancelled delivery stops its adopted wake run as it stops the turns Factory
 * sent, and leaves the owner's own turns on the thread alone. Nothing sleeps or polls.
 */

const started = (runId: RunId) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* runReached(runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
  });

/** Ends the provider turn of the run while no Factory reactor runs: core finishes the run alone. */
const endWhileDown = (world: World, runId: RunId) =>
  Effect.gen(function* () {
    const turn =
      world.provider.started.find((candidate) => candidate.runId === runId) ??
      assert.fail(`No provider turn started run ${runId}.`);
    yield* world.provider.endTurn(turn, "completed");
    yield* runReached(runId, ["waiting", ...ended]);
    yield* drainOrchestration;
  });

const followThroughAttempts = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.filter(({ stage }) => stage === "follow_through")),
  );

/** The provider's id of the turn that started the run, as an interrupt of it names it. */
const providerTurnOf = (world: World, runId: RunId) => {
  const turn = world.provider.started.find((candidate) => candidate.runId === runId);
  return turn === undefined
    ? assert.fail(`No provider turn started run ${runId}.`)
    : `provider-turn:${turn.attemptId}`;
};

const interruptedTurns = (world: World): ReadonlyArray<string> =>
  world.provider.interrupted.map(({ providerTurnId }) => providerTurnId);

/**
 * The runs a Factory cancel sent the thread an interrupt for, from its event log: an interrupt
 * lands whether the provider is asked to stop the turn or the run ends before its turn started.
 */
const cancelledRuns = (threadId: ThreadId, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const latest = yield* sink.latestSequence({ threadId });
    const events = yield* sink.stream({ threadId }).pipe(
      Stream.takeUntil(({ sequence }) => sequence >= latest),
      Stream.runCollect,
    );
    const prefix = `factory-cancel:${deliveryId}:`;
    return [
      ...new Set(
        events.flatMap(({ commandId }) =>
          commandId?.startsWith(prefix) === true ? [commandId.slice(prefix.length)] : [],
        ),
      ),
    ];
  }).pipe(Effect.orDie);

let ownerTurns = 0;

/** Queues the owner's own turn on the thread, as the web client does, behind what it runs. */
const ownerQueues = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    ownerTurns += 1;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sent = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`owner-queued-turn:${ownerTurns}`),
      threadId,
      messageId: MessageId.make(`owner-queued-turn-message:${ownerTurns}`),
      text,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* drainOrchestration;
    const created = sent.storedEvents.flatMap(({ event }) =>
      event.type === "run.created" ? [event.payload.id] : [],
    );
    return created[0] ?? assert.fail("The owner's turn queued no run.");
  }).pipe(Effect.orDie);

const runStatus = (threadId: ThreadId, runId: RunId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ runs }) => runs.find((run) => run.id === runId)?.status),
    Effect.orDie,
  );

describe("Factory follow-through across restarts", () => {
  it.live("adopts a wake queued while Factory was down, once however often it boots", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;

          // While no server runs Factory, core's watch wakes the author thread, and the wake's
          // run starts.
          const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* started(wakeRun);
          assert.deepStrictEqual(yield* stateOf(deliveryId), opened.state);

          // The next boot's sweep finds it in the log and adopts it.
          yield* world.boot(Effect.void);
          const adopted = yield* stateOf(deliveryId);
          assert.strictEqual(adopted.status, "running");
          assert.strictEqual(adopted.stage, "follow_through");
          assert.deepStrictEqual(adopted.awaiting, {
            type: "run",
            threadId: author,
            runId: wakeRun,
          });
          assert.deepStrictEqual(adopted.followThrough?.runs, [wakeRun]);

          // Another boot adopts nothing more.
          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), adopted);
          assert.strictEqual((yield* followThroughAttempts(deliveryId)).length, 1);

          // The round goes on once its run ends.
          yield* world.boot(world.endRun(wakeRun, "completed"));
          const reviewing = yield* stateOf(deliveryId);
          assert.strictEqual(reviewing.stage, "review");
          assert.strictEqual(reviewing.receipts.length, 2);
        }),
      { manualReactor: true },
    ),
  );

  it.live("adopts a wake whose run ended while Factory was down, and goes on with the round", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* started(wakeRun);
          yield* endWhileDown(world, wakeRun);
          assert.strictEqual(yield* runStatus(author, wakeRun), "completed");

          // The sweep adopts it, then hands on the end it finds: settled, verified, and reviewed
          // on a fresh thread.
          yield* world.boot(Effect.void);
          const reviewing = yield* stateOf(deliveryId);
          assert.deepStrictEqual(reviewing.followThrough?.runs, [wakeRun]);
          assert.strictEqual(reviewing.stage, "review");
          assert.strictEqual(reviewing.receipts.length, 2);
          assert.notStrictEqual(reviewing.threads.reviewer, opened.reviewer);
          const attempts = yield* followThroughAttempts(deliveryId);
          assert.deepStrictEqual(
            attempts.map(({ outcome, runId }) => [outcome, runId]),
            [["passed", wakeRun]],
          );

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), reviewing);
          assert.strictEqual((yield* followThroughAttempts(deliveryId)).length, 1);
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through cancelled", () => {
  it.live("interrupts the adopted wake run, never the owner's turn queued behind it", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* started(wakeRun);
        // Its provider turn runs, so a stop reaches the provider.
        assert.strictEqual(yield* runReached(wakeRun, ["running", ...ended]), "running");
        yield* drainFactory;
        assert.strictEqual((yield* stateOf(deliveryId)).status, "running");
        const ownerRun = yield* ownerQueues(author, "Also rename the export button.");
        assert.strictEqual(yield* runStatus(author, ownerRun), "queued");

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
        assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wakeRun)]);
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wakeRun]);

        // The wake's turn stops; the owner's turn then runs, and is left alone.
        yield* world.endRun(wakeRun, "cancelled");
        yield* started(ownerRun);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wakeRun)]);
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wakeRun]);
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
        assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
      }),
    ),
  );

  it.live("interrupts an adopted wake queued behind the owner's turn once it starts", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const ownerRun = yield* world.ownerTurn(author, "Rename the export button.");
        const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* drainOrchestration;
        yield* drainFactory;
        assert.strictEqual(yield* runStatus(author, wakeRun), "queued");
        assert.deepStrictEqual((yield* stateOf(deliveryId)).awaiting, {
          type: "run",
          threadId: author,
          runId: wakeRun,
        });

        // Cancelled while the owner's turn runs: that turn goes on, and the wake run, queued
        // behind it, cannot be stopped before it starts.
        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(interruptedTurns(world), []);
        assert.strictEqual(yield* runStatus(author, wakeRun), "queued");
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");

        // The adopted wake run goes live after it, as Factory's turn, and is stopped then.
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wakeRun]);
        assert.notInclude(interruptedTurns(world), providerTurnOf(world, ownerRun));
        const stopped = yield* runStatus(author, wakeRun);
        assert.isTrue(
          stopped === "interrupted" ||
            interruptedTurns(world).includes(providerTurnOf(world, wakeRun)),
          `The wake run went on as ${stopped}.`,
        );
        assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
      }),
    ),
  );
});
