import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { advance } from "./pipeline/engine.ts";
import type { FactoryDeliveryState } from "./pipeline/state.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  type FactoryDispatch,
  fakePullRequest,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  cancelledRuns,
  endWhileDown,
  interruptedTurns,
  linkOf,
  linkPullRequest,
  openSingle,
  ownerQueues,
  providerTurnOf,
  reviewPasses,
  runStarted,
  runStatus,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

/**
 * Which watch is Factory's, and what a cancel releases, on the server's real stack: the watches
 * Factory's own commands started are read from those commands' records, so a PR stage whose
 * result was lost still knows them; a cancel takes the wakes its watch committed before the
 * release, to stop their runs; and the release ends that watch only while core still has it.
 * With `manualReactor`, Factory's reactor runs only while a server boots it, so a wake core's
 * watch commits between two boots reaches a cancel before any reactor hands it on.
 */

const service = Factory.FactoryService.FactoryService;

/**
 * What the store holds while the PR stage's next stacked action publishes: what a server that
 * stopped after the stage's watch command, before its result was stored, leaves behind.
 */
const stateAtPublish = (world: World) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const held: { state?: FactoryDeliveryState | undefined } = {};
    world.publishHooks.push(
      deliveries.listActive().pipe(
        Effect.map(([delivery]) => {
          held.state = delivery?.state;
        }),
        Effect.orDie,
      ),
    );
    return held;
  });

/**
 * Stores `lost`, what a server that stopped after the PR stage's watch command left, then steps
 * what a new process's boot steps for the effect it cut short (see
 * `FactoryWorker.failInterruptedEffect`): the harness's worker outlives a boot, so it would take
 * that effect as still running.
 */
const losePublish = (deliveryId: FactoryDeliveryId, lost: FactoryDeliveryState | undefined) =>
  Effect.gen(function* () {
    const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const worker = yield* Factory.FactoryWorker.FactoryWorker;
    const awaiting = lost?.awaiting;
    if (lost === undefined || awaiting?.type !== "effect" || awaiting.effect.type !== "open_pr") {
      return assert.fail("The PR stage was not publishing.");
    }
    yield* deliveries.update(deliveryId, lost);
    yield* worker.step(deliveryId, {
      type: "effect.failed",
      effectId: awaiting.effect.id,
      detail: "Factory could not open the pull request: a server restart interrupted it.",
    });
  }).pipe(Effect.orDie);

/** The record of the watch command the delivery's effect sent, if it sent one. */
const watchCommand = (deliveryId: FactoryDeliveryId, effectId: number) =>
  Effect.flatMap(CommandReceiptStore.CommandReceiptStoreV2, (receipts) =>
    receipts.getByCommandId(CommandId.make(`factory-pr-watch:${deliveryId}:${effectId}`)),
  ).pipe(Effect.orDie);

/** Resumes the delivery as its owner does, with a server running Factory. */
const resumeBooted = (world: World, deliveryId: FactoryDeliveryId) =>
  world.boot(
    Effect.gen(function* () {
      yield* Effect.flatMap(service, (factory) => factory.resume(deliveryId)).pipe(Effect.orDie);
      yield* drainFactory;
    }),
  );

/** Cancels the delivery as its owner does, with a server running Factory. */
const cancelBooted = (world: World, deliveryId: FactoryDeliveryId) =>
  world.boot(
    Effect.gen(function* () {
      yield* Effect.flatMap(service, (factory) => factory.cancel(deliveryId)).pipe(Effect.orDie);
      yield* drainFactory;
      yield* drainOrchestration;
    }),
  );

describe("Factory follow-through: a PR stage whose result was lost after its watch command", () => {
  it.live("recovers the watch it started and where: at boot, resume, its wake and a cancel", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const publishing = yield* stateAtPublish(world);
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          const link = yield* linkOf(author, fakePullRequest.number);
          const watch = link.watch ?? assert.fail("The PR stage started no watch.");
          const armed = Option.getOrThrow(
            yield* watchCommand(deliveryId, opened.state.effectsIssued),
          );
          // The server stopped after the watch command, before the PR stage's result was stored.
          const lost = publishing.state ?? assert.fail("Nothing was published.");
          assert.deepStrictEqual(lost.awaiting, {
            type: "effect",
            effect: { id: opened.state.effectsIssued, type: "open_pr" },
          });
          assert.isNull(lost.pullRequest);
          assert.isUndefined(lost.followThrough);

          // The next boot finds that effect cut short and blocks; the watch goes on.
          yield* losePublish(deliveryId, lost);
          yield* world.boot(Effect.void);
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.strictEqual(blocked.block?.reason, "effect_failed");
          assert.isUndefined(blocked.followThrough);
          assert.strictEqual(
            (yield* linkOf(author, link.number)).watch?.startedAt,
            watch.startedAt,
          );

          // That watch wakes the author thread while the delivery is blocked, and its run ends.
          const wake = yield* wakeThread(author, yield* linkOf(author, link.number));
          yield* runStarted(wake);
          yield* endWhileDown(world, wake);

          // The owner's resume publishes again. Its PR stage reads the watch the first command
          // started, starts none, and takes the wake committed since that command as a round.
          yield* resumeBooted(world, deliveryId);
          const resumed = yield* stateOf(deliveryId);
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr", "create_pr"],
          );
          assert.isTrue(Option.isNone(yield* watchCommand(deliveryId, blocked.effectsIssued + 1)));
          assert.strictEqual(resumed.followThrough?.watchStartedAt, watch.startedAt);
          assert.strictEqual(resumed.followThrough?.watchedAfter, armed.resultSequence);
          assert.deepStrictEqual(resumed.followThrough?.runs, [wake]);
          assert.strictEqual(resumed.status, "running");
          assert.strictEqual(resumed.stage, "review");
          assert.strictEqual(
            (yield* linkOf(author, link.number)).watch?.startedAt,
            watch.startedAt,
          );

          // A cancel ends the watch Factory started.
          yield* cancelBooted(world, deliveryId);
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          assert.isUndefined((yield* linkOf(author, link.number)).watch);
        }),
      { manualReactor: true },
    ),
  );

  it.live("keeps an owner's watch its lost command found on, through a resume and a cancel", () =>
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
          const publishing = yield* stateAtPublish(world);
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          const owners = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.isDefined(owners);
          assert.isNull(opened.state.followThrough?.watchStartedAt);
          const armed = yield* watchCommand(deliveryId, opened.state.effectsIssued);
          assert.strictEqual(Option.getOrThrow(armed).status, "accepted");
          yield* losePublish(deliveryId, publishing.state);
          yield* world.boot(Effect.void);
          assert.strictEqual((yield* stateOf(deliveryId)).block?.reason, "effect_failed");

          // Resumed, Factory follows the owner's watch without taking it as its own.
          yield* resumeBooted(world, deliveryId);
          const resumed = yield* stateOf(deliveryId);
          assert.strictEqual(resumed.status, "pr_open");
          assert.isNull(resumed.followThrough?.watchStartedAt);
          assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, owners);

          yield* cancelBooted(world, deliveryId);
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, owners);
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through: a cancel with a wake its watch committed before the release", () => {
  it.live("stops the wake running as the cancel releases, leaving the owner's turn queued", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const worker = yield* Factory.FactoryWorker.FactoryWorker;
          const { deliveryId, threadId: author } = yield* world.boot(openSingle(world));
          // No reactor hands it on: the watch Factory started wakes the idle author thread.
          const wake = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* runStarted(wake);
          assert.strictEqual(yield* runReached(wake, ["running", ...ended]), "running");
          const ownerRun = yield* ownerQueues(author, "Summarize the review comments.");
          assert.notInclude((yield* stateOf(deliveryId)).followThrough?.runs ?? [], wake);

          yield* factory.cancel(deliveryId).pipe(Effect.orDie);
          yield* worker.drain;
          yield* drainOrchestration;
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.include(cancelled.followThrough?.runs ?? [], wake);
          assert.isUndefined(cancelled.releaseWatch);
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wake]);
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
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wake]);
          assert.strictEqual(yield* runStatus(author, ownerRun), "running");
        }),
      { manualReactor: true },
    ),
  );

  it.live("stops a wake queued behind the owner's turn once it starts, never that turn", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const worker = yield* Factory.FactoryWorker.FactoryWorker;
          const { deliveryId, threadId: author } = yield* world.boot(openSingle(world));
          const ownerRun = yield* world.ownerTurn(author, "Rename the export button.");
          const wake = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* drainOrchestration;
          assert.strictEqual(yield* runStatus(author, wake), "queued");

          yield* factory.cancel(deliveryId).pipe(Effect.orDie);
          yield* worker.drain;
          yield* drainOrchestration;
          assert.include((yield* stateOf(deliveryId)).followThrough?.runs ?? [], wake);
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), []);
          assert.strictEqual(yield* runStatus(author, ownerRun), "running");

          // The owner's turn ends with a server running Factory: the wake starts, and is stopped.
          yield* world.boot(
            Effect.gen(function* () {
              assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
              yield* drainFactory;
              yield* drainOrchestration;
            }),
          );
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wake]);
          assert.notInclude(interruptedTurns(world), providerTurnOf(world, ownerRun));
        }),
      { manualReactor: true },
    ),
  );

  it.live("takes and stops at the next boot a wake committed after the cancel was stored", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          // A server stored the cancel and stopped before the release; the watch then woke the
          // author thread, and the owner queued a turn behind that wake.
          const stored = advance(opened.state, { type: "cancel" }).delivery;
          yield* deliveries.update(deliveryId, stored).pipe(Effect.orDie);
          const wake = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
          yield* runStarted(wake);
          assert.strictEqual(yield* runReached(wake, ["running", ...ended]), "running");
          const ownerRun = yield* ownerQueues(author, "Summarize the review comments.");

          yield* world.boot(Effect.void);
          const released = yield* stateOf(deliveryId);
          assert.strictEqual(released.status, "cancelled");
          assert.include(released.followThrough?.runs ?? [], wake);
          assert.isUndefined(released.releaseWatch);
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
          yield* drainOrchestration;
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wake]);
          assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wake)]);

          yield* world.boot(
            Effect.gen(function* () {
              yield* world.endRun(wake, "cancelled");
              yield* runStarted(ownerRun);
              yield* drainFactory;
              yield* drainOrchestration;
            }),
          );
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), [wake]);
          assert.strictEqual(yield* runStatus(author, ownerRun), "running");
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through: a release racing the owner's watch", () => {
  it.live(
    "ends only the watch Factory started: one the owner put in its place meanwhile stays",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { deliveryId, threadId: author } = yield* openSingle(world);
          const link = yield* linkOf(author, fakePullRequest.number);
          const started = link.watch ?? assert.fail("The PR stage started no watch.");
          // After everything the release read, right before its command runs, the owner stops
          // Factory's watch and starts their own.
          const sent: Array<FactoryDispatch> = [];
          world.factoryDispatch.before = (command) => {
            if (!command.commandId.startsWith("factory-pr-unwatch:")) return Effect.void;
            sent.push(command);
            world.factoryDispatch.before = undefined;
            return Effect.gen(function* () {
              yield* watchPullRequest(author, link, false);
              yield* watchPullRequest(author, link);
            }).pipe(Effect.provideService(Orchestrator.OrchestratorV2, orchestrator));
          };

          yield* factory.cancel(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const owners = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.isDefined(owners);
          assert.notStrictEqual(owners?.startedAt, started.startedAt);
          // Core ended the watch only while it was the one Factory started, and refused it then.
          assert.strictEqual(sent.length, 1);
          const [release] = sent;
          assert.deepInclude(release, {
            type: "thread.pull-request-watch.sync",
            threadId: author,
            number: link.number,
            startedAt: started.startedAt,
            watch: null,
          });
          assert.notProperty(release, "wake");
          const receipt = yield* Effect.flatMap(
            CommandReceiptStore.CommandReceiptStoreV2,
            (store) =>
              store.getByCommandId(release?.commandId ?? assert.fail("Nothing was released.")),
          ).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
          assert.strictEqual(receipt.status, "rejected");
          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          // Where the watch Factory started ended: the owner's stop.
          assert.strictEqual(cancelled.followThrough?.watchStartedAt, started.startedAt);
          assert.isAbove(
            cancelled.followThrough?.heldUntil ?? 0,
            cancelled.followThrough?.armedAt ?? 0,
          );
        }),
      ),
  );
});

describe("Factory follow-through: another pull request's watch on the author thread", () => {
  it.live(
    "leaves a cancelled delivery off the wakes of a watch that started at the same moment",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { deliveryId, threadId: author } = yield* openSingle(world);
          const link = yield* linkOf(author, fakePullRequest.number);
          const started = link.watch ?? assert.fail("The PR stage started no watch.");
          // The owner watches another pull request on the author thread. Core stamps a watch with
          // its command's millisecond, so two commands can start two watches at once; core's own
          // sync gives that watch Factory's start here.
          const otherUrl = "https://github.com/acme/alpha/pull/8";
          yield* watchPullRequest(author, { ...link, number: 8, url: otherUrl });
          const owners = (yield* linkOf(author, 8, otherUrl)).watch ?? assert.fail("Not watched.");
          yield* orchestrator
            .dispatch({
              type: "thread.pull-request-watch.sync",
              commandId: CommandId.make("owner-pr-watch:same-start"),
              threadId: author,
              host: link.host,
              repository: link.repository,
              number: 8,
              startedAt: owners.startedAt,
              watch: { ...owners, startedAt: started.startedAt },
            })
            .pipe(Effect.orDie);
          assert.strictEqual(
            (yield* linkOf(author, 8, otherUrl)).watch?.startedAt,
            started.startedAt,
          );

          // The cancel releases Factory's watch only.
          yield* factory.cancel(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
          assert.strictEqual(
            (yield* linkOf(author, 8, otherUrl)).watch?.startedAt,
            started.startedAt,
          );

          // The other watch wakes the author thread: that turn is the owner's, and goes on.
          const foreign = yield* wakeThread(author, yield* linkOf(author, 8, otherUrl));
          yield* runStarted(foreign);
          assert.strictEqual(yield* runReached(foreign, ["running", ...ended]), "running");
          yield* drainFactory;
          yield* drainOrchestration;
          assert.notInclude((yield* stateOf(deliveryId)).followThrough?.runs ?? [], foreign);
          assert.deepStrictEqual(yield* cancelledRuns(author, deliveryId), []);
          assert.notInclude(interruptedTurns(world), providerTurnOf(world, foreign));
          assert.strictEqual(yield* runStatus(author, foreign), "running");
          assert.strictEqual(yield* world.endRun(foreign, "completed"), "completed");
        }),
      ),
  );
});

describe("Factory follow-through: a release whose command fails", () => {
  it.live("keeps the release marked while Factory's watch is on, and ends it on the next try", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const worker = yield* Factory.FactoryWorker.FactoryWorker;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const started = (yield* linkOf(author, fakePullRequest.number)).watch;
        assert.isDefined(started);
        // The release's command fails before core runs it; the watch stays on.
        world.factoryDispatch.before = (command) => {
          if (!command.commandId.startsWith("factory-pr-unwatch:")) return Effect.void;
          world.factoryDispatch.before = undefined;
          return Effect.die("The database is locked.");
        };

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        const cancelled = yield* stateOf(deliveryId);
        assert.strictEqual(cancelled.status, "cancelled");
        assert.isTrue(cancelled.releaseWatch);
        assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, started);

        // The next boot's sweep releases it.
        yield* worker.releaseWatches.pipe(Effect.orDie);
        const released = yield* stateOf(deliveryId);
        assert.isUndefined(released.releaseWatch);
        assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
      }),
    ),
  );
});

describe("Factory follow-through: a watch whose command's event was compacted away", () => {
  /** Core's public compaction, which keeps only each thread's newest whole-thread event. */
  const compact = Effect.flatMap(
    ProjectionMaintenance.ProjectionMaintenanceV2,
    (maintenance) => maintenance.compactEventStore,
  ).pipe(
    Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provide(EventStore.layer))),
    Effect.orDie,
  );

  it.live("keeps holding the watch it recorded through a round, and ends it on cancel", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const { deliveryId, threadId: author, state } = yield* openSingle(world);
        const started = (yield* linkOf(author, fakePullRequest.number)).watch;
        assert.strictEqual(state.followThrough?.watchStartedAt, started?.startedAt);
        // A later whole-thread event on the author thread, then compaction drops the watch
        // command's own event; its record stays.
        const link = yield* linkOf(author, fakePullRequest.number);
        yield* linkPullRequest(author, {
          ...link,
          number: 8,
          url: "https://github.com/acme/alpha/pull/8",
        });
        yield* compact;
        const armed = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
        const kept = yield* Effect.flatMap(EventStore.EventStoreV2, (events) =>
          events
            .read({
              threadId: author,
              afterSequence: armed.resultSequence - 1,
              throughSequence: armed.resultSequence,
            })
            .pipe(Stream.runCollect),
        ).pipe(Effect.provide(EventStore.layer), Effect.orDie);
        assert.strictEqual(kept.length, 0);

        // A round republishes: Factory still holds the watch it recorded.
        const wakeRun = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* runStarted(wakeRun);
        yield* drainFactory;
        yield* world.endRun(wakeRun, "completed");
        yield* reviewPasses(world, deliveryId);
        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.strictEqual(reopened.followThrough?.watchStartedAt, started?.startedAt);

        // A cancel ends it.
        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        const cancelled = yield* stateOf(deliveryId);
        assert.isUndefined(cancelled.releaseWatch);
        assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
      }),
    ),
  );

  it.live("never takes as its own an owner's watch whose starting event compaction dropped", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          // The owner watches the pull request right before Factory's watch command, a
          // millisecond apart, and that command keeps the watch.
          world.factoryDispatch.before = (command) => {
            if (command.type !== "thread.pull-request.watch") return Effect.void;
            world.factoryDispatch.before = undefined;
            const { url } = command.link ?? assert.fail("The watch command links nothing.");
            return Effect.gen(function* () {
              yield* watchPullRequest(command.threadId, { ...command, url });
              const started = DateTime.formatIso(yield* DateTime.now);
              yield* Effect.repeat(DateTime.now, {
                until: (now) => DateTime.formatIso(now) !== started,
              });
            }).pipe(Effect.provideService(Orchestrator.OrchestratorV2, orchestrator));
          };
          const publishing = yield* stateAtPublish(world);
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author } = opened;
          const owners = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.isDefined(owners);
          assert.isNull(opened.state.followThrough?.watchStartedAt);
          // Compaction keeps Factory's watch command's event, the thread's newest whole-thread
          // event, and drops the owner's that started the watch.
          yield* compact;
          const armed = Option.getOrThrow(
            yield* watchCommand(deliveryId, opened.state.effectsIssued),
          );
          const synced = yield* Effect.flatMap(EventStore.EventStoreV2, (events) =>
            events
              .read({ threadId: author, eventType: "thread.pull-request-synced" })
              .pipe(Stream.runCollect),
          ).pipe(Effect.provide(EventStore.layer), Effect.orDie);
          assert.deepStrictEqual(
            Array.from(synced, ({ sequence }) => sequence),
            [armed.resultSequence],
          );

          // Its result lost, resumed and cancelled, Factory leaves the owner's watch on.
          yield* losePublish(deliveryId, publishing.state);
          yield* world.boot(Effect.void);
          yield* resumeBooted(world, deliveryId);
          const resumed = yield* stateOf(deliveryId);
          assert.strictEqual(resumed.status, "pr_open");
          assert.isNull(resumed.followThrough?.watchStartedAt);
          yield* cancelBooted(world, deliveryId);
          assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
          assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, owners);
        }),
      { manualReactor: true },
    ),
  );
});
