import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { isTerminalRunStatus } from "./pipeline/state.ts";
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
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  awaitedRun,
  linkOf,
  openSingle,
  passingReview,
  reviewPasses,
  type WakeReport,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

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

describe("Factory follow-through: a wake that comes during a round, across restarts", () => {
  /**
   * A round adopted by one server, and a second wake queued behind its run while no server runs
   * Factory, kept pending by the next boot. Returns both runs.
   */
  const pendingAcrossBoot = (world: World) =>
    Effect.gen(function* () {
      const opened = yield* world.boot(openSingle(world));
      const { deliveryId, threadId: author } = opened;
      const first = yield* world.boot(
        Effect.gen(function* () {
          const runId = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* started(runId);
          yield* drainFactory;
          return runId;
        }),
      );
      const second = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
      yield* drainOrchestration;
      assert.strictEqual(yield* runStatus(author, second), "queued");
      yield* world.boot(Effect.void);
      return { opened, deliveryId, author, first, second };
    });

  it.live("keeps it as the delivery's own once however often it boots, then runs it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId, author, first, second } = yield* pendingAcrossBoot(world);
          const kept = yield* stateOf(deliveryId);
          assert.deepStrictEqual(kept.awaiting, { type: "run", threadId: author, runId: first });
          assert.deepStrictEqual(kept.followThrough?.runs, [first, second]);
          assert.deepStrictEqual(kept.followThrough?.pending, [second]);

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), kept);

          // The round waits for it once the first answer ends, then judges the branch once.
          yield* world.boot(world.endRun(first, "completed"));
          const waiting = yield* stateOf(deliveryId);
          assert.deepStrictEqual(waiting.awaiting, {
            type: "run",
            threadId: author,
            runId: second,
          });
          assert.deepStrictEqual(waiting.followThrough?.pending, []);
          yield* world.boot(
            Effect.gen(function* () {
              yield* started(second);
              yield* world.endRun(second, "completed");
              yield* reviewPasses(world, deliveryId);
            }),
          );
          const reopened = yield* stateOf(deliveryId);
          assert.strictEqual(reopened.status, "pr_open");
          assert.deepStrictEqual(reopened.followThrough?.runs, [first, second]);
        }),
      { manualReactor: true },
    ),
  );

  it.live("stops it as Factory's turn once it starts after a cancel", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId, author, first, second } = yield* pendingAcrossBoot(world);
          yield* world.boot(
            Effect.gen(function* () {
              const factory = yield* Factory.FactoryService.FactoryService;
              // Its provider turn runs, so the stop reaches the provider and the run goes on.
              assert.strictEqual(yield* runReached(first, ["running", ...ended]), "running");
              yield* factory.cancel(deliveryId).pipe(Effect.orDie);
              yield* drainFactory;
              yield* drainOrchestration;
              assert.include(yield* cancelledRuns(author, deliveryId), first);
              assert.include(interruptedTurns(world), providerTurnOf(world, first));
              // The awaited answer stops (core may end it before its provider reports); the wake
              // queued behind it then starts, and is stopped too, as Factory's turn.
              if (!isTerminalRunStatus(yield* runStatus(author, first))) {
                yield* world.endRun(first, "cancelled");
              }
              yield* drainFactory;
              yield* drainOrchestration;
              assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [first, second]);
              const stopped = yield* runStatus(author, second);
              assert.isTrue(
                stopped === "interrupted" ||
                  interruptedTurns(world).includes(providerTurnOf(world, second)),
                `The queued wake went on as ${stopped}.`,
              );
            }),
          );
          assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through cancelled while the owner works on the author thread", () => {
  it.live("leaves the owner's turn alone when cancelled during the round's review", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* started(wakeRun);
        yield* drainFactory;
        yield* world.endRun(wakeRun, "completed");
        const reviewer = yield* awaitedRun(deliveryId);
        assert.strictEqual(yield* runReached(reviewer.runId, ["running", ...ended]), "running");
        // The owner's own turn runs on the author thread, now idle.
        const ownerRun = yield* world.ownerTurn(author, "Explain the export format.");
        assert.strictEqual(yield* runReached(ownerRun, ["running", ...ended]), "running");

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), []);
        assert.deepStrictEqual(yield* cancelledRuns(reviewer.threadId, deliveryId), [
          reviewer.runId,
        ]);
        assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, reviewer.runId)]);
        assert.strictEqual(yield* runStatus(author, ownerRun), "running");
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
      }),
    ),
  );

  it.live("leaves it alone with the pull request open again, and ends Factory's watch", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* started(wakeRun);
        yield* drainFactory;
        yield* world.endRun(wakeRun, "completed");
        yield* reviewPasses(world, deliveryId);
        assert.strictEqual((yield* stateOf(deliveryId)).status, "pr_open");
        assert.isDefined((yield* linkOf(author, fakePullRequest.number)).watch);
        const ownerRun = yield* world.ownerTurn(author, "Explain the export format.");
        assert.strictEqual(yield* runReached(ownerRun, ["running", ...ended]), "running");

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), []);
        assert.notInclude(interruptedTurns(world), providerTurnOf(world, ownerRun));
        assert.strictEqual(yield* runStatus(author, ownerRun), "running");
        // The watch it started would wake the thread to new work: it ends.
        assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
      }),
    ),
  );

  it.live("keeps a watch the owner started since on cancel", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const link = yield* linkOf(author, fakePullRequest.number);
        const factoryWatch = link.watch;
        // The owner stops Factory's watch and starts one of their own.
        yield* watchPullRequest(author, link, false);
        yield* watchPullRequest(author, link);
        const owners = (yield* linkOf(author, fakePullRequest.number)).watch;
        assert.notStrictEqual(owners?.startedAt, factoryWatch?.startedAt);

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, owners);
      }),
    ),
  );
});

describe("Factory follow-through: wakes committed while a republish starts the watch again", () => {
  /**
   * A round run to its republish with its wake `report` committed first but stepped after: one
   * server adopts a round and has its review submitted; while no reactor runs, core's watch
   * commits the wake and the worker, handed the reviewer's end, records, pushes and starts the
   * watch again. Returns the state that left, and the wake's run.
   */
  const republishedOverWake = (world: World, report: WakeReport) =>
    Effect.gen(function* () {
      const factory = yield* Factory.FactoryService.FactoryService;
      const worker = yield* Factory.FactoryWorker.FactoryWorker;
      const opened = yield* world.boot(openSingle(world));
      const { deliveryId, threadId: author } = opened;
      const reviewer = yield* world.boot(
        Effect.gen(function* () {
          const first = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* started(first);
          yield* drainFactory;
          yield* world.endRun(first, "completed");
          const reviewer = yield* awaitedRun(deliveryId);
          yield* factory.submitReview({ threadId: reviewer.threadId, review: passingReview() });
          return reviewer;
        }),
      );
      const wake = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number), report);
      yield* drainOrchestration;
      yield* endWhileDown(world, reviewer.runId);
      yield* worker
        .step(deliveryId, {
          type: "run.finished",
          threadId: reviewer.threadId,
          runId: reviewer.runId,
          status: "completed",
        })
        .pipe(Effect.orDie);
      yield* worker.drain;
      const republished = yield* stateOf(deliveryId);
      assert.strictEqual(republished.status, "pr_open");
      assert.deepStrictEqual(
        world.pullRequestCalls.map(({ input }) => input.action),
        ["create_pr", "push"],
      );
      // The wake has not reached the delivery, and the watch command came after it.
      assert.notInclude(republished.followThrough?.runs ?? [], wake);
      return { deliveryId, author, wake, republished };
    });

  it.live("takes feedback committed before the watch command once it reaches the delivery", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId, author, wake, republished } = yield* republishedOverWake(
            world,
            "checks-failed",
          );
          yield* world.boot(Effect.void);
          const adopted = yield* stateOf(deliveryId);
          assert.strictEqual(adopted.status, "running");
          assert.strictEqual(adopted.stage, "follow_through");
          assert.deepStrictEqual(adopted.awaiting, { type: "run", threadId: author, runId: wake });
          assert.include(adopted.followThrough?.runs ?? [], wake);
          assert.strictEqual(
            adopted.followThrough?.watchedAfter,
            republished.followThrough?.watchedAfter,
          );

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), adopted);
        }),
      { manualReactor: true },
    ),
  );

  it.live("ends the watch it started again over a termination, and blocks", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId, author, wake, republished } = yield* republishedOverWake(
            world,
            "unreadable",
          );
          // Core had ended the watch; the republish's command started a new one.
          const recreated = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.isDefined(recreated);
          assert.strictEqual(republished.followThrough?.watchStartedAt, recreated?.startedAt);

          yield* world.boot(Effect.void);
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, { reason: "watch_ended" });
          assert.include(blocked.followThrough?.runs ?? [], wake);
          assert.isTrue(blocked.followThrough?.watchEnded);
          assert.isNull(blocked.followThrough?.watchStartedAt);
          assert.isFalse(blocked.followThrough?.releaseWatch);
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), blocked);
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through: a cancel stored before its watch was ended", () => {
  it.live.each([
    { watch: "the watch Factory started", owners: false },
    { watch: "a watch the owner started since", owners: true },
  ])("ends $watch at the next boot only if it is Factory's", ({ owners }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          const link = yield* linkOf(author, fakePullRequest.number);
          if (owners) {
            yield* watchPullRequest(author, link, false);
            yield* watchPullRequest(author, link);
          }
          const before = (yield* linkOf(author, fakePullRequest.number)).watch;
          // A server stored the cancel, then stopped before ending the watch: what it left.
          const cancelled = advance(opened.state, { type: "cancel" }).delivery;
          assert.isTrue(cancelled.followThrough?.releaseWatch);
          yield* deliveries.update(deliveryId, cancelled).pipe(Effect.orDie);
          assert.isDefined(before);

          yield* world.boot(Effect.void);
          const released = yield* stateOf(deliveryId);
          assert.strictEqual(released.status, "cancelled");
          assert.isFalse(released.followThrough?.releaseWatch);
          assert.isNull(released.followThrough?.watchStartedAt);
          const after = (yield* linkOf(author, fakePullRequest.number)).watch;
          if (owners) assert.deepStrictEqual(after, before);
          else assert.isUndefined(after);

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), released);
          assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, after);
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through cancelled with the last comment-limit wake", () => {
  it.live("interrupts it while it runs, leaving the owner's turn queued behind it", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const last = yield* wakeThread(
          author,
          yield* linkOf(author, fakePullRequest.number),
          "exhausted",
        );
        yield* started(last);
        assert.strictEqual(yield* runReached(last, ["running", ...ended]), "running");
        yield* drainFactory;
        const blocked = yield* stateOf(deliveryId);
        assert.deepStrictEqual(blocked.block, { reason: "watch_ended" });
        assert.include(blocked.followThrough?.runs ?? [], last);
        const ownerRun = yield* ownerQueues(author, "Summarize the review comments.");

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [last]);
        assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, last)]);

        yield* world.endRun(last, "cancelled");
        yield* started(ownerRun);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [last]);
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
      }),
    ),
  );

  it.live("stops it once it starts after the owner's turn, which goes on", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* Factory.FactoryService.FactoryService;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const ownerRun = yield* world.ownerTurn(author, "Rename the export button.");
        const last = yield* wakeThread(
          author,
          yield* linkOf(author, fakePullRequest.number),
          "exhausted",
        );
        yield* drainOrchestration;
        yield* drainFactory;
        assert.strictEqual(yield* runStatus(author, last), "queued");
        assert.include((yield* stateOf(deliveryId)).followThrough?.runs ?? [], last);

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), []);
        assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");

        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [last]);
        assert.notInclude(interruptedTurns(world), providerTurnOf(world, ownerRun));
      }),
    ),
  );
});

describe("Factory follow-through: the owner's watch through a round", () => {
  it.live(
    "keeps a watch the owner started in place of Factory's, through a republish and cancel",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const { deliveryId, threadId: author } = yield* openSingle(world);
          const link = yield* linkOf(author, fakePullRequest.number);
          yield* watchPullRequest(author, link, false);
          yield* watchPullRequest(author, link);
          const owners = (yield* linkOf(author, fakePullRequest.number)).watch;

          // The owner's watch wakes the author thread; the round runs and republishes.
          const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* started(wakeRun);
          yield* drainFactory;
          yield* world.endRun(wakeRun, "completed");
          yield* reviewPasses(world, deliveryId);
          const reopened = yield* stateOf(deliveryId);
          assert.strictEqual(reopened.status, "pr_open");
          assert.strictEqual(world.pullRequestCalls.length, 2);
          // Core kept the owner's watch, which Factory follows but does not hold.
          const kept = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.strictEqual(kept?.startedAt, owners?.startedAt);
          assert.isNull(reopened.followThrough?.watchStartedAt);

          yield* factory.cancel(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, kept);
        }),
      ),
  );
});
