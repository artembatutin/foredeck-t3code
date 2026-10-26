import { assert, describe, it } from "@effect/vitest";
import { CommandId, type RunId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderRuntimeRecoveryService from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { type FactoryDeliveryState, isTerminalRunStatus } from "./pipeline/state.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  type FactoryDispatch,
  fakePullRequest,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  cancelledRuns,
  closedComment,
  endWhileDown,
  integratedParent,
  interruptedTurns,
  itemStatus,
  linkOf,
  linkPullRequest,
  openParent,
  ownerQueues,
  passingReview,
  providerTurnOf,
  runStarted,
  runStatus,
  syncPullRequest,
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

/** Which delivery the owner cancels: the parent, or its last child, which cancels the parent. */
const targets = [
  { cancelled: "the parent", child: false },
  { cancelled: "its last child", child: true },
] as const;

/** Waits until the provider turn is stored running, as core's shutdown recovery reads it. */
const providerTurnRunning = (providerTurnId: string) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "provider-turn.updated" &&
          event.payload.id === providerTurnId &&
          event.payload.status === "running",
      ),
      Stream.runHead,
    ),
  ).pipe(Effect.orDie);

/** Core's runtime recovery, over the server's stores: its shutdown and startup reconciles. */
const coreRecovery = Effect.service(
  ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService,
).pipe(
  Effect.provide(ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(EffectOutbox.layer))),
);

/** The restart continuation core's outbox holds for the run, by its status; none if it holds none. */
const restartIntent = (runId: RunId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_effect_outbox
      WHERE effect_id = ${`effect:restart-continuation:${runId}`}
        AND effect_type = 'provider-runtime.continue'
    `.pipe(Effect.map((rows) => rows.map(({ status }) => status))),
  ).pipe(Effect.orDie);

/** Writes the delivery's cancel as the step that stores it would, sending no interrupt. */
const storeCancel = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const cancelled = advance(yield* stateOf(deliveryId), { type: "cancel" }).delivery;
    assert.isTrue(cancelled.releaseWatch);
    yield* store.update(deliveryId, cancelled);
  }).pipe(Effect.orDie);

/**
 * Has the owner watch the pull request right before the PR stage's watch command, which then
 * keeps that watch and starts none of Factory's.
 */
const ownerWatchesFirst = (world: World) =>
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) => {
    world.factoryDispatch.before = (command) => {
      if (command.type !== "thread.pull-request.watch") return Effect.void;
      world.factoryDispatch.before = undefined;
      const { url } = command.link ?? assert.fail("The watch command links nothing.");
      return watchPullRequest(command.threadId, { ...command, url }).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
      );
    };
  });

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
    "recovers at boot the pull request, thread and watch its watch command proves, and a resume publishes there",
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

            // The next boot finds that effect cut short and blocks, then records what the watch
            // command's records prove: the pull request, the thread it is linked to, and that the
            // watch on it is Factory's. The watch goes on.
            yield* losePublish(deliveryId, lost);
            yield* world.boot(Effect.void);
            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.status, "blocked");
            assert.strictEqual(blocked.block?.reason, "effect_failed");
            assert.deepStrictEqual(blocked.pullRequest, {
              ...fakePullRequest,
              headBranch: lost.branch,
            });
            assert.strictEqual(blocked.pullRequestThread, last.author);
            assert.deepStrictEqual(blocked.followThrough, {
              watchedAfter: armed.resultSequence,
              armedAt: armed.resultSequence,
              watchStartedAt: watch.startedAt,
              heldUntil: null,
              runs: [],
              pending: [],
              watchEnded: false,
            });
            assert.strictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch?.startedAt,
              watch.startedAt,
            );
            // Another boot recovers nothing more.
            const rows = yield* rowsOf(deliveryId);
            yield* world.boot(Effect.void);
            assert.deepStrictEqual(yield* rowsOf(deliveryId), rows);

            // That watch wakes the thread while the parent is blocked, and its run ends.
            const wake = yield* wakeThread(last.author, yield* linkOf(last.author, link.number));
            yield* runStarted(wake);
            yield* endWhileDown(world, wake);

            // The owner's resume integrates afresh and publishes to the recovered pull request: a
            // push, never a second create. Its PR stage reads the watch the first command started
            // there, starts none, and takes the wake committed since that command as a round.
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
              ["create_pr", "push"],
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

  it.live.each(targets)(
    "ends Factory's watch when $cancelled is cancelled while the resume's integrate review runs",
    ({ child }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const parent = yield* publishedParent(world);
            const { deliveryId, last } = parent;
            const [first] = parent.children;
            if (first === undefined) return assert.fail("The parent has no children.");
            const watch = (yield* linkOf(last.author, fakePullRequest.number)).watch;
            if (watch === undefined) return assert.fail("The PR stage started no watch.");
            yield* losePublish(deliveryId, parent.lost);
            yield* world.boot(Effect.void);

            // Resumed, the parent clears its block and integrates afresh: nothing it awaits is
            // the PR stage any more when the cancel comes.
            yield* world.boot(
              Effect.gen(function* () {
                yield* factory.resume(deliveryId).pipe(Effect.orDie);
                yield* drainFactory;
              }),
            );
            const integrating = yield* stateOf(deliveryId);
            assert.strictEqual(integrating.stage, "integrate");
            assert.isNull(integrating.block);
            assert.strictEqual(integrating.awaiting?.type, "run");
            const firstRows = yield* rowsOf(first.deliveryId);
            const lastState = yield* stateOf(last.deliveryId);
            const lastRows = yield* rowsOf(last.deliveryId);
            const sent: Array<FactoryDispatch> = [];
            world.factoryDispatch.before = (command) => {
              if (command.commandId.startsWith("factory-pr-unwatch:")) sent.push(command);
              return Effect.void;
            };

            const reviewer = yield* world.boot(
              Effect.gen(function* () {
                const reviewer = yield* awaitedRun(deliveryId);
                yield* factory.cancel(child ? last.deliveryId : deliveryId).pipe(Effect.orDie);
                yield* drainFactory;
                yield* drainOrchestration;
                return reviewer;
              }),
            );
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            // Factory's watch ended, by a sync naming its start.
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
            assert.deepStrictEqual(
              sent.map((command) =>
                command.type === "thread.pull-request-watch.sync"
                  ? [command.type, command.threadId, command.startedAt]
                  : [command.type],
              ),
              [["thread.pull-request-watch.sync", last.author, watch.startedAt]],
            );
            // The integrate reviewer stops; the approved children keep their approvals.
            assert.deepStrictEqual(yield* cancelledRuns(reviewer.threadId, deliveryId), [
              reviewer.runId,
            ]);
            assert.deepStrictEqual(yield* rowsOf(first.deliveryId), firstRows);
            if (child) {
              assert.deepStrictEqual(yield* stateOf(last.deliveryId), {
                ...lastState,
                status: "cancelled",
              });
            } else {
              assert.deepStrictEqual(yield* rowsOf(last.deliveryId), lastRows);
            }
          }),
        { manualReactor: true },
      ),
  );

  it.live(
    "ends the recovered watch on a cancel, and stops the wake it set off, never the owner's turn",
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
            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.block?.reason, "effect_failed");
            assert.strictEqual(blocked.pullRequestThread, last.author);

            // While no server runs Factory, the watch wakes the thread; the owner queues a turn
            // behind that wake.
            const wake = yield* wakeThread(
              last.author,
              yield* linkOf(last.author, fakePullRequest.number),
            );
            yield* runStarted(wake);
            assert.strictEqual(yield* runReached(wake, ["running", ...ended]), "running");
            const ownerRun = yield* ownerQueues(last.author, "Summarize the review comments.");

            // The cancel ends Factory's watch there and stops the wake as the parent's.
            yield* cancelBooted(world, deliveryId);
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            assert.strictEqual(cancelled.followThrough?.watchStartedAt, watch?.startedAt);
            assert.include(cancelled.followThrough?.runs ?? [], wake);
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

  it.live(
    "finds the thread in the watch command's record for a cancel no boot recovered first",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const worker = yield* Factory.FactoryWorker.FactoryWorker;
            const parent = yield* publishedParent(world);
            const { deliveryId, last } = parent;
            const watch = (yield* linkOf(last.author, fakePullRequest.number)).watch;
            assert.isDefined(watch);
            // Blocked as a boot blocks it, but cancelled before a boot recovered what the watch
            // command proves, as when the boot could not read the command's records.
            yield* losePublish(deliveryId, parent.lost);
            assert.isUndefined((yield* stateOf(deliveryId)).pullRequestThread);

            yield* Effect.flatMap(service, (factory) => factory.cancel(deliveryId)).pipe(
              Effect.orDie,
            );
            yield* worker.drain;
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            // The release read the thread from the command and recorded it with the watch's end.
            assert.strictEqual(cancelled.pullRequestThread, last.author);
            assert.strictEqual(cancelled.followThrough?.watchStartedAt, watch?.startedAt);
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
          }),
        { manualReactor: true },
      ),
  );

  it.live(
    "records the pull request an owner-watched stage published, holding none of the owner's watch, and a resume pushes to it",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            yield* ownerWatchesFirst(world);
            const { deliveryId, last, state, lost } = yield* publishedParent(world);
            const owners = (yield* linkOf(last.author, fakePullRequest.number)).watch;
            assert.isDefined(owners);
            assert.isNull(state.followThrough?.watchStartedAt);
            const armed = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
            assert.strictEqual(armed.status, "accepted");
            yield* losePublish(deliveryId, lost);

            // That command kept the owner's watch, so it proves no watch of Factory's; it still
            // proves the stage published, and its event names the pull request it watched.
            yield* world.boot(Effect.void);
            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.status, "blocked");
            assert.deepStrictEqual(blocked.pullRequest, {
              ...fakePullRequest,
              headBranch: lost.branch,
            });
            assert.strictEqual(blocked.pullRequestThread, last.author);
            assert.isNull(blocked.followThrough?.watchStartedAt);
            assert.strictEqual(blocked.followThrough?.watchedAfter, armed.resultSequence);

            // Resumed, it publishes to that pull request again: a push, never a second create.
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
            const reopened = yield* stateOf(deliveryId);
            assert.strictEqual(reopened.status, "pr_open");
            assert.deepStrictEqual(
              world.pullRequestCalls.map(({ input }) => input.action),
              ["create_pr", "push"],
            );
            assert.isNull(reopened.followThrough?.watchStartedAt);
            assert.deepStrictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch,
              owners,
            );

            // A cancel leaves the owner's watch on.
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

  it.live.each([{ outcome: "closed" }, { outcome: "merged" }] as const)(
    "takes the pull request an owner-watched stage published as $outcome while Factory was down, publishing nothing again",
    ({ outcome }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* ownerWatchesFirst(world);
            const parent = yield* publishedParent(world);
            const { deliveryId, last } = parent;
            const children = yield* childRows(parent);
            yield* losePublish(deliveryId, parent.lost);

            // While no server runs Factory, core's sync stores the pull request merged or closed.
            yield* syncPullRequest(
              last.author,
              yield* linkOf(last.author, fakePullRequest.number),
              outcome,
              { drain: false },
            );
            yield* world.boot(Effect.void);
            const after = yield* stateOf(deliveryId);
            assert.strictEqual(after.pullRequest?.outcome, outcome);
            assert.deepStrictEqual(
              world.pullRequestCalls.map(({ input }) => input.action),
              ["create_pr"],
            );
            if (outcome === "closed") {
              // Closed without merging: cancelled, with the one comment that says so, keeping
              // its work and its children's approvals.
              assert.strictEqual(after.status, "cancelled");
              assert.deepStrictEqual(
                world.commentCalls
                  .filter(({ input }) => input.body.startsWith(closedComment))
                  .map(({ input }) => input.ref),
                [world.itemRef],
              );
              assert.isTrue(yield* world.exists(parent.worktreePath));
              assert.deepStrictEqual(yield* childRows(parent), children);
            } else {
              // Merged: closed out, every item done and the clean worktree removed.
              assert.strictEqual(after.status, "done");
              for (const ref of [...parent.children.map(({ itemRef }) => itemRef), world.itemRef]) {
                assert.strictEqual(yield* itemStatus(ref), "done");
              }
              assert.deepStrictEqual(world.worktreeRemovals, [
                { cwd: world.root, path: parent.worktreePath },
              ]);
            }

            // Another boot finds nothing more to do.
            const rows = yield* rowsOf(deliveryId);
            yield* world.boot(Effect.void);
            assert.deepStrictEqual(yield* rowsOf(deliveryId), rows);
            assert.strictEqual(world.pullRequestCalls.length, 1);
          }),
        { manualReactor: true },
      ),
  );
});

describe("Factory follow-through of a parent whose lost PR stage watched among other pull requests", () => {
  it.live.each([
    { linkedFirst: false, outcome: "records the one its own link command added" },
    { linkedFirst: true, outcome: "refuses a resume when nothing names which it published" },
  ])("$outcome, and a cancel keeps the owner's watches", ({ linkedFirst }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          // Just before the PR stage's watch command the owner watches its pull request and
          // another one there, so that command keeps a watch on a thread watching two. When
          // the owner linked the pull request just before the stage's link command too, that
          // command added nothing either.
          const other = { number: 8, url: "https://github.com/acme/alpha/pull/8" };
          const owner = (effect: Effect.Effect<void, never, Orchestrator.OrchestratorV2>) =>
            effect.pipe(Effect.provideService(Orchestrator.OrchestratorV2, orchestrator));
          world.factoryDispatch.before = (command) => {
            if (command.type === "thread.pull-request.link") {
              const { host, repository, number, url } = command;
              return linkedFirst
                ? owner(linkPullRequest(command.threadId, { host, repository, number, url }))
                : Effect.void;
            }
            if (command.type !== "thread.pull-request.watch") return Effect.void;
            world.factoryDispatch.before = undefined;
            const { url } = command.link ?? assert.fail("The watch command links nothing.");
            const { host, repository } = command;
            return owner(
              Effect.gen(function* () {
                yield* watchPullRequest(command.threadId, { ...command, url });
                yield* watchPullRequest(command.threadId, { host, repository, ...other });
              }),
            );
          };
          const parent = yield* publishedParent(world);
          const { deliveryId, last, state } = parent;
          const owners = (yield* linkOf(last.author, fakePullRequest.number)).watch;
          const others = (yield* linkOf(last.author, other.number, other.url)).watch;
          assert.isDefined(owners);
          assert.isDefined(others);
          const armed = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
          assert.strictEqual(armed.status, "accepted");
          yield* losePublish(deliveryId, parent.lost);

          yield* world.boot(Effect.void);
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.block?.reason, "effect_failed");
          if (linkedFirst) {
            // The stage published, but nothing says which of the watched pull requests: a
            // resume would publish again, so it is refused, with nothing changed.
            assert.isNull(blocked.pullRequest);
            const rows = yield* rowsOf(deliveryId);
            const refused = yield* world.boot(factory.resume(deliveryId).pipe(Effect.flip));
            assert.strictEqual(refused._tag, "FactoryPullRequestUnknownError");
            assert.deepStrictEqual(yield* rowsOf(deliveryId), rows);
          } else {
            // The pull request its link command added, holding none of the owner's watch.
            assert.strictEqual(blocked.pullRequest?.number, fakePullRequest.number);
            assert.strictEqual(blocked.pullRequest?.url, fakePullRequest.url);
            assert.strictEqual(blocked.pullRequestThread, last.author);
            assert.isNull(blocked.followThrough?.watchStartedAt);
            assert.strictEqual(blocked.followThrough?.watchedAfter, armed.resultSequence);
          }

          // A cancel ends the delivery, ending none of the owner's watches.
          yield* cancelBooted(world, deliveryId);
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          assert.deepStrictEqual(
            (yield* linkOf(last.author, fakePullRequest.number)).watch,
            owners,
          );
          assert.deepStrictEqual(
            (yield* linkOf(last.author, other.number, other.url)).watch,
            others,
          );
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr"],
          );
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through of a parent whose lost PR stage result cannot be read", () => {
  it.live.each([
    { then: "resumes once the records read again", cancel: false },
    { then: "is cancelled while they cannot, and the next boot ends the watch", cancel: true },
  ])("refuses a resume while it cannot recover what the stage published, and $then", ({ cancel }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const parent = yield* publishedParent(world);
          const { deliveryId, last } = parent;
          const watch = (yield* linkOf(last.author, fakePullRequest.number)).watch;
          if (watch === undefined) return assert.fail("The PR stage started no watch.");
          yield* losePublish(deliveryId, parent.lost);
          // Factory cannot read the thread its pull request is linked to for now.
          const unreadable = { on: true };
          world.factoryDispatch.beforeShell = (threadId) =>
            unreadable.on && threadId === last.author
              ? Effect.die("The database is locked.")
              : Effect.void;

          // The next boot cannot recover what the stage published, and leaves it blocked.
          yield* world.boot(Effect.void);
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.block?.reason, "effect_failed");
          assert.isNull(blocked.pullRequest);
          assert.isUndefined(blocked.followThrough);
          const rows = yield* rowsOf(deliveryId);

          // A resume recovers first, so it fails as that read does, with nothing changed.
          const refused = yield* world.boot(factory.resume(deliveryId).pipe(Effect.flip));
          assert.strictEqual(refused._tag, "FactoryStoreError");
          assert.deepStrictEqual(yield* rowsOf(deliveryId), rows);

          if (cancel) {
            // Cancelled meanwhile: the block marks the watch for release, which cannot read the
            // thread either and stays marked; the next boot that can ends Factory's watch.
            yield* cancelBooted(world, deliveryId);
            const marked = yield* stateOf(deliveryId);
            assert.strictEqual(marked.status, "cancelled");
            assert.isTrue(marked.releaseWatch);
            assert.strictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch?.startedAt,
              watch.startedAt,
            );
            unreadable.on = false;
            yield* world.boot(Effect.void);
          } else {
            // Readable again, a resume records the pull request, its thread and Factory's watch
            // before it integrates afresh; a cancel during that integrate then ends the watch.
            unreadable.on = false;
            yield* world.boot(
              Effect.gen(function* () {
                yield* factory.resume(deliveryId).pipe(Effect.orDie);
                yield* drainFactory;
              }),
            );
            const resumed = yield* stateOf(deliveryId);
            assert.strictEqual(resumed.status, "running");
            assert.isNull(resumed.block);
            assert.strictEqual(resumed.pullRequest?.number, fakePullRequest.number);
            assert.strictEqual(resumed.pullRequestThread, last.author);
            assert.strictEqual(resumed.followThrough?.watchStartedAt, watch.startedAt);
            yield* cancelBooted(world, deliveryId);
          }
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          assert.strictEqual(cancelled.pullRequestThread, last.author);
          assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);

          // Another boot changes nothing.
          const settled = yield* rowsOf(deliveryId);
          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* rowsOf(deliveryId), settled);
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr"],
          );
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through of a parent cancelled while a restart carried its wake on", () => {
  it.live.each([{ continuation: "still pending" }, { continuation: "already running" }] as const)(
    "stops the wake's continuation, $continuation as Factory boots, as the parent's, leaving its children approved and the owner's turn",
    ({ continuation }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const recovery = yield* coreRecovery;

            // Server 1: the parent's pull request is open, and it adopted a wake on its last
            // child's author thread as a round, whose provider turn is running.
            const parent = yield* world.boot(
              Effect.gen(function* () {
                const parent = yield* openParent(world);
                const last = lastChild(parent);
                const wake = yield* wakeThread(
                  last.author,
                  yield* linkOf(last.author, fakePullRequest.number),
                );
                yield* runStarted(wake);
                yield* drainFactory;
                yield* providerTurnRunning(providerTurnOf(world, wake));
                return { ...parent, last, wake };
              }),
            );
            const { deliveryId, last, wake } = parent;
            assert.deepStrictEqual((yield* stateOf(deliveryId)).awaiting, {
              type: "run",
              threadId: last.author,
              runId: wake,
            });
            const children = yield* childRows(parent);
            // Its cancel commits, and it stops before interrupting anything or releasing its
            // watch, while core's shutdown records restart intent for the wake's turn.
            yield* storeCancel(deliveryId);
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");

            // Server 2: core recovery runs first; the continuation waits in core's outbox.
            yield* recovery.reconcile("startup");
            assert.deepStrictEqual(yield* restartIntent(wake), ["pending"]);
            if (continuation === "already running") {
              // Core's effect worker delivers it before Factory's sweep runs.
              yield* drainOrchestration;
              const live = (yield* threadProjection(last.author)).runs.find(
                (run) => run.restartContinuationOfRunId === wake,
              );
              assert.isFalse(live === undefined || isTerminalRunStatus(live.status));
            }
            yield* world.boot(
              Effect.gen(function* () {
                // Delivered after the sweep, it goes live while Factory listens.
                yield* drainOrchestration;
                yield* drainFactory;
                yield* drainOrchestration;
              }),
            );
            assert.deepStrictEqual(yield* restartIntent(wake), ["succeeded"]);

            // Core carried the wake's turn on, and Factory interrupted it as the parent's: the
            // approved child, whose id the thread carries, stopped nothing.
            const continued = (yield* threadProjection(last.author)).runs.find(
              (run) => run.restartContinuationOfRunId === wake,
            );
            if (continued === undefined) return assert.fail("Core did not continue the turn.");
            const turns = world.provider.started.filter(({ runId }) => runId === continued.id);
            if (continuation === "already running") assert.strictEqual(turns.length, 1);
            assert.deepStrictEqual(
              interruptedTurns(world),
              turns.map(({ attemptId }) => `provider-turn:${attemptId}`),
            );
            assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [continued.id]);
            assert.deepStrictEqual(yield* cancelledRuns(last.author, last.deliveryId), []);
            if (turns.length > 0) yield* world.boot(world.endRun(continued.id, "cancelled"));
            const settled = (yield* threadProjection(last.author)).runs;
            assert.isTrue(settled.every(({ status }) => isTerminalRunStatus(status)));
            // The boot released the parent's watch; its children stay approved, untouched.
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isUndefined(cancelled.releaseWatch);
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
            assert.deepStrictEqual(yield* childRows(parent), children);

            // Server 3: a repeated recovery finds nothing to carry on, and Factory nothing to do.
            const before = yield* rowsOf(deliveryId);
            yield* recovery.reconcile("startup");
            yield* world.boot(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
              }),
            );
            assert.deepStrictEqual((yield* threadProjection(last.author)).runs, settled);
            assert.strictEqual(world.provider.interrupted.length, turns.length);
            assert.deepStrictEqual(yield* rowsOf(deliveryId), before);
            assert.deepStrictEqual(yield* childRows(parent), children);

            // The owner's own turn on that thread is theirs, and runs on.
            const own = yield* world.boot(
              Effect.gen(function* () {
                const runId = yield* world.ownerTurn(last.author, "Summarize what changed.");
                yield* drainFactory;
                yield* drainOrchestration;
                return runId;
              }),
            );
            const owned = (yield* threadProjection(last.author)).runs.find(({ id }) => id === own);
            assert.isFalse(owned === undefined || isTerminalRunStatus(owned.status));
            assert.strictEqual(world.provider.interrupted.length, turns.length);
            assert.deepStrictEqual(yield* childRows(parent), children);
          }),
        { manualReactor: true },
      ).pipe(Effect.orDie),
  );
});
