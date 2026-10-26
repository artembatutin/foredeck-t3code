import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import type { FactoryDeliveryState } from "./pipeline/state.ts";
import {
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
  awaitedRun,
  cancelledRuns,
  endWhileDown,
  integratedParent,
  interruptedTurns,
  linkOf,
  openParent,
  ownerQueues,
  passingReview,
  providerTurnOf,
  runStarted,
  runStatus,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

/**
 * A parent's follow-through across restarts, on the server's real stack. With `manualReactor`,
 * Factory's reactor runs only while a server boots it, so a wake core's watch queues on the last
 * child's author thread between two boots reaches the parent only through the next boot sweep,
 * which reads that thread's log and sends each wake to the parent as the tail would. A PR stage
 * whose result a restart lost leaves its watch command's record, from which the parent's resume
 * and cancel know the watch, and the thread, as Factory's. Nothing sleeps or polls.
 */

const service = Factory.FactoryService.FactoryService;

/** The parent's last child, whose author thread its pull request is linked to. */
const lastChild = <A>(parent: { readonly children: ReadonlyArray<A> }) =>
  parent.children.at(-1) ?? assert.fail("The parent has no children.");

/** The delivery's row and stage attempts, as the database holds them. */
const rowsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${deliveryId}`,
    };
  }).pipe(Effect.orDie);

/** The rows of each of the parent's children. */
const childRows = (parent: {
  readonly children: ReadonlyArray<{ readonly deliveryId: FactoryDeliveryId }>;
}) => Effect.forEach(parent.children, ({ deliveryId }) => rowsOf(deliveryId));

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.orDie);

/** The record of the watch command the delivery's effect `effectId` sent, if it sent one. */
const watchCommand = (deliveryId: FactoryDeliveryId, effectId: number) =>
  Effect.flatMap(CommandReceiptStore.CommandReceiptStoreV2, (receipts) =>
    receipts.getByCommandId(CommandId.make(`factory-pr-watch:${deliveryId}:${effectId}`)),
  ).pipe(Effect.orDie);

/** How many watch commands of the delivery's effects core accepted. */
const acceptedWatchCommands = (deliveryId: FactoryDeliveryId, effectsIssued: number) =>
  Effect.gen(function* () {
    let accepted = 0;
    for (let effectId = 1; effectId <= effectsIssued; effectId += 1) {
      const receipt = Option.getOrUndefined(yield* watchCommand(deliveryId, effectId));
      if (receipt?.status === "accepted") accepted += 1;
    }
    return accepted;
  });

/**
 * A parent run to its open pull request by one server, with the state the store held while its
 * PR stage published: what a server that stopped after the stage's watch command, before its
 * result was stored, leaves behind.
 */
const publishedParent = (world: World) =>
  world.boot(
    Effect.gen(function* () {
      const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const { integrate, ...parent } = yield* integratedParent(world);
      const held: { state?: FactoryDeliveryState | undefined } = {};
      world.publishHooks.push(
        deliveries.get(parent.deliveryId).pipe(
          Effect.map((stored) => {
            held.state = Option.getOrUndefined(stored)?.state;
          }),
          Effect.orDie,
        ),
      );
      yield* world.endRun(integrate.runId, "completed");
      const state = yield* stateOf(parent.deliveryId);
      assert.strictEqual(state.status, "pr_open");
      const lost = held.state ?? assert.fail("Nothing was published.");
      return { ...parent, last: lastChild(parent), state, lost };
    }),
  );

/**
 * Stores `lost`, then steps what a new process's boot steps for the PR effect it cut short (see
 * `FactoryWorker.failInterruptedEffect`): the harness's worker outlives a boot, so it would take
 * that effect as still running.
 */
const losePublish = (deliveryId: FactoryDeliveryId, lost: FactoryDeliveryState) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const worker = yield* Factory.FactoryWorker.FactoryWorker;
    const { awaiting } = lost;
    if (awaiting?.type !== "effect" || awaiting.effect.type !== "open_pr") {
      return assert.fail("The PR stage was not publishing.");
    }
    assert.isNull(lost.pullRequest);
    assert.isUndefined(lost.pullRequestThread);
    assert.isUndefined(lost.followThrough);
    yield* deliveries.update(deliveryId, lost);
    yield* worker.step(deliveryId, {
      type: "effect.failed",
      effectId: awaiting.effect.id,
      detail: "Factory could not open the pull request: a server restart interrupted it.",
    });
  }).pipe(Effect.orDie);

/** Cancels the delivery as its owner does, with a server running Factory. */
const cancelBooted = (world: World, deliveryId: FactoryDeliveryId) =>
  world.boot(
    Effect.gen(function* () {
      yield* Effect.flatMap(service, (factory) => factory.cancel(deliveryId)).pipe(Effect.orDie);
      yield* drainFactory;
      yield* drainOrchestration;
    }),
  );

describe("Factory follow-through of a parent across restarts", () => {
  it.live(
    "adopts the first wake committed on its last child's author thread while Factory was down and keeps the next pending, once however often it boots",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const parent = yield* world.boot(openParent(world));
            const { deliveryId } = parent;
            const last = lastChild(parent);
            const children = yield* childRows(parent);

            // While no server runs Factory, core's watch wakes the last child's author thread
            // twice: the first wake's run starts, the second queues behind it.
            const first = yield* wakeThread(
              last.author,
              yield* linkOf(last.author, fakePullRequest.number),
            );
            yield* runStarted(first);
            const second = yield* wakeThread(
              last.author,
              yield* linkOf(last.author, fakePullRequest.number),
              "remarks",
            );
            yield* drainOrchestration;
            assert.strictEqual(yield* runStatus(last.author, second), "queued");
            assert.deepStrictEqual(yield* stateOf(deliveryId), parent.state);

            // The next boot's sweep reads that thread's log: the parent adopts the first as a
            // round and keeps the second pending, as the tail would have.
            yield* world.boot(Effect.void);
            const adopted = yield* stateOf(deliveryId);
            assert.strictEqual(adopted.status, "running");
            assert.strictEqual(adopted.stage, "follow_through");
            assert.deepStrictEqual(adopted.awaiting, {
              type: "run",
              threadId: last.author,
              runId: first,
            });
            assert.deepStrictEqual(adopted.followThrough?.runs, [first, second]);
            assert.deepStrictEqual(adopted.followThrough?.pending, [second]);
            const rows = yield* rowsOf(deliveryId);
            const rounds = (yield* attemptsOf(deliveryId)).filter(
              ({ stage }) => stage === "follow_through",
            );
            assert.deepStrictEqual(
              rounds.map(({ outcome, threadId, runId }) => [outcome, threadId, runId]),
              [[null, last.author, first]],
            );
            // The approved children, whose launch the thread's id names, take nothing.
            assert.deepStrictEqual(yield* childRows(parent), children);

            // Another boot steps nothing new and records no attempt.
            yield* world.boot(Effect.void);
            assert.deepStrictEqual(yield* rowsOf(deliveryId), rows);
            assert.deepStrictEqual(yield* childRows(parent), children);

            // Once the first ends, the round runs the pending wake before it judges the branch.
            yield* world.boot(world.endRun(first, "completed"));
            const waiting = yield* stateOf(deliveryId);
            assert.deepStrictEqual(waiting.awaiting, {
              type: "run",
              threadId: last.author,
              runId: second,
            });
            assert.deepStrictEqual(waiting.followThrough?.pending, []);
            assert.strictEqual(waiting.receipts.length, parent.state.receipts.length);
            assert.deepStrictEqual(yield* childRows(parent), children);
          }),
        { manualReactor: true },
      ),
  );
});

describe("Factory follow-through of a parent whose PR stage result was lost", () => {
  it.live(
    "holds the watch that command started, through a boot, a resume, its wake and a cancel",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { deliveryId, last, state, lost } = yield* publishedParent(world);
            const link = yield* linkOf(last.author, fakePullRequest.number);
            const watch = link.watch ?? assert.fail("The PR stage started no watch.");
            const armed = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
            assert.strictEqual(armed.status, "accepted");
            assert.strictEqual(armed.threadId, last.author);

            // The next boot finds that effect cut short and blocks; the watch goes on.
            yield* losePublish(deliveryId, lost);
            yield* world.boot(Effect.void);
            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.status, "blocked");
            assert.strictEqual(blocked.block?.reason, "effect_failed");
            assert.isUndefined(blocked.pullRequestThread);
            assert.isUndefined(blocked.followThrough);
            assert.strictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch?.startedAt,
              watch.startedAt,
            );

            // That watch wakes the thread while the parent is blocked, and its run ends.
            const wake = yield* wakeThread(last.author, yield* linkOf(last.author, link.number));
            yield* runStarted(wake);
            yield* endWhileDown(world, wake);

            // The owner's resume integrates afresh and publishes again. Its PR stage reads the
            // watch the first command started there, starts none, and takes the wake committed
            // since that command as a round.
            yield* world.boot(
              Effect.gen(function* () {
                yield* factory.resume(deliveryId).pipe(Effect.orDie);
                yield* drainFactory;
              }),
            );
            yield* world.boot(
              Effect.gen(function* () {
                const reviewer = yield* awaitedRun(deliveryId);
                yield* factory
                  .submitReview({ threadId: reviewer.threadId, review: passingReview(2) })
                  .pipe(Effect.orDie);
                yield* world.endRun(reviewer.runId, "completed");
              }),
            );
            const resumed = yield* stateOf(deliveryId);
            assert.deepStrictEqual(
              world.pullRequestCalls.map(({ input }) => input.action),
              ["create_pr", "create_pr"],
            );
            assert.strictEqual(yield* acceptedWatchCommands(deliveryId, resumed.effectsIssued), 1);
            assert.strictEqual(resumed.pullRequestThread, last.author);
            assert.strictEqual(resumed.followThrough?.watchStartedAt, watch.startedAt);
            assert.strictEqual(resumed.followThrough?.watchedAfter, armed.resultSequence);
            assert.deepStrictEqual(resumed.followThrough?.runs, [wake]);
            assert.strictEqual(resumed.status, "running");
            assert.strictEqual(resumed.stage, "integrate");
            assert.strictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch?.startedAt,
              watch.startedAt,
            );

            // A cancel ends the watch Factory started.
            yield* cancelBooted(world, deliveryId);
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
          }),
        { manualReactor: true },
      ),
  );

  it.live(
    "ends that watch on a cancel, and stops the wake it set off, never the owner's turn",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const parent = yield* publishedParent(world);
            const { deliveryId, last } = parent;
            const children = yield* childRows(parent);
            const watch = (yield* linkOf(last.author, fakePullRequest.number)).watch;
            assert.isDefined(watch);
            yield* losePublish(deliveryId, parent.lost);
            yield* world.boot(Effect.void);
            assert.strictEqual((yield* stateOf(deliveryId)).block?.reason, "effect_failed");

            // While no server runs Factory, the watch wakes the thread; the owner queues a turn
            // behind that wake.
            const wake = yield* wakeThread(
              last.author,
              yield* linkOf(last.author, fakePullRequest.number),
            );
            yield* runStarted(wake);
            assert.strictEqual(yield* runReached(wake, ["running", ...ended]), "running");
            const ownerRun = yield* ownerQueues(last.author, "Summarize the review comments.");

            // The parent recorded no thread; its release finds it in the watch command's record,
            // ends Factory's watch there and stops the wake as the parent's.
            yield* cancelBooted(world, deliveryId);
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            assert.strictEqual(cancelled.pullRequestThread, last.author);
            assert.strictEqual(cancelled.followThrough?.watchStartedAt, watch?.startedAt);
            assert.deepStrictEqual(cancelled.followThrough?.runs, [wake]);
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
            assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [wake]);
            assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wake)]);

            // The owner's turn runs next, with a server running Factory, and goes on.
            yield* world.boot(
              Effect.gen(function* () {
                yield* world.endRun(wake, "cancelled");
                yield* runStarted(ownerRun);
                yield* drainFactory;
                yield* drainOrchestration;
              }),
            );
            assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [wake]);
            assert.strictEqual(yield* runStatus(last.author, ownerRun), "running");
            assert.deepStrictEqual(yield* childRows(parent), children);
          }),
        { manualReactor: true },
      ),
  );

  it.live("keeps an owner's watch that command found on through a cancel", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          // The owner watches the pull request right before Factory's watch command, which keeps
          // that watch; then the PR stage's result is lost.
          world.factoryDispatch.before = (command) => {
            if (command.type !== "thread.pull-request.watch") return Effect.void;
            world.factoryDispatch.before = undefined;
            const { url } = command.link ?? assert.fail("The watch command links nothing.");
            return watchPullRequest(command.threadId, { ...command, url }).pipe(
              Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
            );
          };
          const { deliveryId, last, state, lost } = yield* publishedParent(world);
          const owners = (yield* linkOf(last.author, fakePullRequest.number)).watch;
          assert.isDefined(owners);
          assert.isNull(state.followThrough?.watchStartedAt);
          const armed = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
          assert.strictEqual(armed.status, "accepted");
          yield* losePublish(deliveryId, lost);
          yield* world.boot(Effect.void);

          yield* cancelBooted(world, deliveryId);
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          assert.deepStrictEqual(
            (yield* linkOf(last.author, fakePullRequest.number)).watch,
            owners,
          );
        }),
      { manualReactor: true },
    ),
  );
});
