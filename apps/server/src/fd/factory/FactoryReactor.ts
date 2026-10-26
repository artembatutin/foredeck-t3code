import type {
  OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { launchDeliveryId } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import { type RunCreated, runCreated, wakeOf } from "./followThrough.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import {
  type FactoryEvent,
  type FactoryThreadEvent,
  isTerminal,
  isTerminalRunStatus,
} from "./pipeline/state.ts";

/**
 * Feeds what happens to Factory's threads into their deliveries: a terminal run becomes
 * `run.finished` and a deleted thread `thread.deleted` for the delivery whose active stage
 * attempt owns the thread (any delivery recording it, for a deletion); other threads pass by.
 * A pull request link that core's sync stored merged or closed on the thread a delivery's open
 * pull request is linked to becomes `pr.merged` or `pr.closed` for that delivery; nothing polls.
 * A run that core's pull request watch queued as a wake on a thread a Factory launch made becomes
 * `pr.feedback` for the delivery whose pull request it may be (see `takeWake`), which the engine
 * adopts as a follow-through round or not.
 * A boot sweep catches up the deliveries that awaited something when the previous server stopped,
 * the pull requests that merged or closed meanwhile and the wakes queued for open ones, and posts
 * the Work comments it recorded and never finished. The tail starts at the event log position
 * read before the sweep, so no event falls between the two.
 */
export class FactoryReactor extends Context.Service<
  FactoryReactor,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Resolves once the boot sweep and every thread event committed before the call have been
     * handled, including the steps they fed; the effects those steps queued are
     * `FactoryWorker.drain`'s. Waits for `start` to read its log position. Tests await this
     * instead of sleeping.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryReactor") {}

/** A run going live on a thread a Factory launch made; see `FactoryWorker.stopCancelledRun`. */
interface LiveRun {
  readonly type: "run.live";
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

/** A pull request event for the deliveries whose pull request is linked to the thread. */
interface PullRequestEnded {
  readonly type: "pr.ended";
  readonly threadId: ThreadId;
  readonly event: Extract<FactoryEvent, { readonly type: "pr.merged" | "pr.closed" }>;
}

/** A run created by a command on a thread a Factory launch made, which may be a watch's wake. */
type Job = "boot" | FactoryThreadEvent | LiveRun | PullRequestEnded | RunCreated;

/**
 * The event a link's stored snapshot makes: its pull request merged or closed, by number and URL.
 * None while it is open, or before its first sync.
 */
const pullRequestEnded = (link: ThreadPullRequestLink): PullRequestEnded["event"] | undefined => {
  const state = link.snapshot?.state;
  if (state !== "merged" && state !== "closed") return undefined;
  return {
    type: state === "merged" ? "pr.merged" : "pr.closed",
    number: link.number,
    url: link.url,
  };
};

/**
 * A restart continuation goes live as it starts. A launch's run is left alone while it prepares
 * the workspace: a cancelled delivery's launch still makes its branch and worktree, and its run is
 * interrupted once its launch reports (see `FactoryWorker`).
 */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const ready = yield* Deferred.make<void>();
  // The sequence of the last event the tail has read; jobs for events up to it are queued.
  const handled = yield* TxRef.make(0);

  const logSkipped = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, cause).pipe(Effect.asVoid);

  /** How the awaited run or its thread ended, as the projection has it; null while it runs. */
  const projectedEnd = (threadId: ThreadId, runId: RunId) =>
    projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map(({ thread, runs }): FactoryThreadEvent | null => {
        if (thread.deletedAt !== null) return { type: "thread.deleted", threadId };
        const status = runs.find((run) => run.id === runId)?.status;
        return isTerminalRunStatus(status)
          ? { type: "run.finished", threadId, runId, status }
          : null;
      }),
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () =>
          Effect.succeed<FactoryThreadEvent>({ type: "thread.deleted", threadId }),
      }),
    );

  /**
   * The thread a delivery's pull request is linked to: its author's, or for a parent, which has
   * none, its last child's author's (see `FactoryPullRequest`). None without one.
   */
  const pullRequestThread = ({ state }: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      if (state.kind !== "parent") return state.threads.author;
      const last = state.children.at(-1);
      if (last === undefined) return undefined;
      return Option.getOrUndefined(yield* deliveries.get(last))?.state.threads.author;
    });

  /** Whether the delivery recorded its pull request, and has not taken its merge or close. */
  const followsPullRequest = ({ state }: FactoryDeliveryStore.StoredFactoryDelivery) =>
    state.pullRequest !== null && state.pullRequest.outcome === undefined;

  /**
   * Steps the deliveries with an open pull request linked to the thread with the link's merge or
   * close, whatever a follow-through round is doing. The engine takes it only for the pull
   * request a delivery opened, and only once.
   */
  const stepPullRequest = ({ threadId, event }: PullRequestEnded) =>
    Effect.gen(function* () {
      for (const delivery of yield* deliveries.listActive()) {
        if (!followsPullRequest(delivery)) continue;
        if ((yield* pullRequestThread(delivery)) !== threadId) continue;
        yield* worker.step(delivery.deliveryId, event);
      }
    });

  /** The wake a run starts, as `wakeOf` judges it from its command's record and events. */
  const wakeOfRun = (run: RunCreated) =>
    Effect.gen(function* () {
      const receipt = Option.getOrUndefined(yield* receipts.getByCommandId(run.commandId));
      if (receipt?.status !== "accepted") return undefined;
      const events = yield* eventSink
        .readByCommandId({ commandId: run.commandId })
        .pipe(Stream.runCollect);
      return wakeOf(run, receipt.commandType, events);
    });

  /**
   * Steps the delivery whose pull request may be linked to the run's thread with the wake the run
   * starts, if it starts one. The thread's id names the delivery whose launch made it, which for a
   * child is the wrong one: a child opens no pull request, and its parent's is linked to its last
   * child's author thread, so the wake goes to the parent and the approved child is left alone.
   * The engine takes it only on the thread the delivery follows. Stepped whatever the delivery's
   * state as read here: the engine judges it under the delivery's lock, which the PR stage holds
   * from starting the watch until it has stored the pull request and the thread it is linked to.
   */
  const takeWake = (run: RunCreated) =>
    Effect.gen(function* () {
      const launchedBy = launchDeliveryId(run.threadId);
      if (launchedBy === undefined) return;
      const wake = yield* wakeOfRun(run);
      if (wake === undefined) return;
      const launcher = Option.getOrUndefined(yield* deliveries.get(launchedBy));
      yield* worker.step(launcher?.parentId ?? launchedBy, wake);
    });

  /**
   * The wakes core queued for a delivery's open pull request on its author thread while no server
   * ran Factory: each run created there since the delivery's first watch command, stepped in order
   * as the tail would have stepped it. The engine takes each run once, so a sweep run again takes
   * nothing new. Nothing for a delivery whose pull request is not watched, or no longer open.
   */
  const catchUpFeedback = (deliveryId: FactoryDeliveryId) =>
    Effect.gen(function* () {
      const delivery = Option.getOrUndefined(yield* deliveries.get(deliveryId));
      const author = delivery?.state.threads.author;
      const followThrough = delivery?.state.followThrough;
      if (
        delivery === undefined ||
        isTerminal(delivery.state) ||
        !followsPullRequest(delivery) ||
        author === undefined ||
        followThrough === undefined
      ) {
        return;
      }
      const last = yield* eventSink.latestSequence({ threadId: author });
      if (last <= followThrough.watchedAfter) return;
      const read = yield* eventSink
        .stream({ threadId: author, afterSequence: followThrough.watchedAfter })
        .pipe(
          // The log replays every event of the thread up to its last before it goes live.
          Stream.takeUntil((stored) => stored.sequence >= last),
          Stream.runCollect,
        );
      for (const stored of read) {
        const run = runCreated(stored);
        if (run !== undefined) yield* takeWake(run);
      }
    });

  /**
   * The merge or close of a delivery's open pull request that core's sync stored while no server
   * ran Factory, read from its thread's link as the projection has it: the step the tail would
   * have taken. None while the link shows it open.
   */
  const catchUpPullRequest = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { pullRequest } = delivery.state;
      if (!followsPullRequest(delivery)) return;
      const threadId = yield* pullRequestThread(delivery);
      if (pullRequest === null || threadId === undefined) return;
      const shell = yield* projections.getThreadShell(threadId);
      const link = shell?.pullRequests?.find(
        (candidate) => candidate.number === pullRequest.number && candidate.url === pullRequest.url,
      );
      const event = link === undefined ? undefined : pullRequestEnded(link);
      if (event !== undefined) yield* worker.step(delivery.deliveryId, event);
    });

  /**
   * Catches one delivery up with what happened while no server ran it, whatever its status. First
   * what a restart cut short between a parent and its children is completed. One that recorded
   * its open pull request takes its merge or close stored meanwhile, whatever else it awaits, and
   * then the wakes queued for that pull request meanwhile, adopting one or keeping it pending. A
   * delivery awaiting a run then gets the run's end or its thread's deletion, as the tail would
   * have handed them on, so a stopping one stops where the run's end leads it. One awaiting an
   * effect lost it with the previous process and blocks, unless what it did is stored (see
   * `failInterruptedEffect`). A parent awaiting its child takes the child's approval stored
   * before the restart, and otherwise waits for that child. A delivery awaiting nothing else
   * (queued, stopped, blocked) waits for its owner. Each step reads the delivery again, so one
   * cancelled here takes nothing more.
   */
  const reconcile = (listed: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId } = listed;
      yield* worker.finishFamily(deliveryId);
      const read = deliveries.get(deliveryId).pipe(Effect.map(Option.getOrUndefined));
      const delivery = yield* read;
      if (delivery === undefined) return;
      yield* catchUpPullRequest(delivery);
      yield* catchUpFeedback(deliveryId);
      const awaiting = (yield* read)?.state.awaiting;
      if (awaiting === undefined || awaiting === null) return;
      if (awaiting.type === "child") {
        yield* worker.takeChildApproval(deliveryId);
        return;
      }
      if (awaiting.type === "effect") {
        yield* worker.failInterruptedEffect(deliveryId);
        return;
      }
      const ended = yield* projectedEnd(awaiting.threadId, awaiting.runId);
      if (ended !== null) yield* worker.step(deliveryId, ended);
    }).pipe(Effect.catchCause(logSkipped("factory delivery reconcile skipped")));

  // Comments a previous process recorded and never finished go first, in their order. Work a
  // cancelled delivery's thread carried on after the restart is stopped last, once every
  // cancellation the restart cut short is complete, and so are the watches such a cancellation
  // left to end.
  const bootSweep = worker.postUnfinishedComments.pipe(
    Effect.catchCause(logSkipped("factory comment recovery failed")),
    Effect.andThen(deliveries.listActive()),
    Effect.flatMap((active) => Effect.forEach(active, reconcile, { discard: true })),
    Effect.catchCause(logSkipped("factory boot reconcile failed")),
    Effect.andThen(
      worker.releaseWatches.pipe(Effect.catchCause(logSkipped("factory watch release failed"))),
    ),
    Effect.andThen(worker.stopCancelledRuns),
  );

  const jobs = yield* makeDrainableWorker((job: Job) => {
    if (job === "boot") return bootSweep;
    if (job.type === "run.live") return worker.stopCancelledRun(job);
    if (job.type === "pr.ended") {
      return stepPullRequest(job).pipe(
        Effect.catchCause(logSkipped("factory pull request event skipped")),
      );
    }
    if (job.type === "run.created") {
      return takeWake(job).pipe(Effect.catchCause(logSkipped("factory pull request wake skipped")));
    }
    return worker
      .stepThread(job)
      .pipe(Effect.catchCause(logSkipped("factory thread event skipped")));
  });

  /**
   * A run's end, a thread's deletion, a run created or going live on a thread a Factory launch
   * made, and a pull request link stored merged or closed; everything else passes by.
   */
  const onDomainEvent = (stored: OrchestrationV2StoredEvent): Effect.Effect<void> => {
    const { event } = stored;
    switch (event.type) {
      case "run.created":
      case "run.updated": {
        const { id: runId, threadId, status } = event.payload;
        const launched = launchDeliveryId(threadId) !== undefined;
        const created = launched ? runCreated(stored) : undefined;
        const wake = created === undefined ? Effect.void : jobs.enqueue(created);
        if (isTerminalRunStatus(status)) {
          return event.type === "run.updated"
            ? jobs.enqueue({ type: "run.finished", threadId, runId, status })
            : wake;
        }
        return LIVE_RUN_STATUSES.has(status) && launched
          ? wake.pipe(Effect.andThen(jobs.enqueue({ type: "run.live", threadId, runId })))
          : wake;
      }
      case "thread.deleted":
        return jobs.enqueue({ type: "thread.deleted", threadId: event.payload.id });
      case "thread.pull-request-link-updated": {
        const ended = pullRequestEnded(event.payload);
        return ended === undefined
          ? Effect.void
          : jobs.enqueue({ type: "pr.ended", threadId: event.threadId, event: ended });
      }
      default:
        return Effect.void;
    }
  };

  // The log position is read before the sweep, so the sweep reads every event up to it in the
  // projections and the tail replays every later one from the log, however long the sweep takes.
  // Their jobs queue behind the sweep. All of it waits for activation, so no Factory work runs
  // in a server that never takes over.
  const start: FactoryReactor["Service"]["start"] = forkParked(
    Effect.gen(function* () {
      const position = yield* eventSink.latestSequence();
      yield* TxRef.set(handled, position);
      yield* jobs.enqueue("boot");
      yield* Deferred.succeed(ready, undefined);
      yield* Stream.runForEach(eventSink.stream({ afterSequence: position }), (stored) =>
        onDomainEvent(stored).pipe(Effect.andThen(TxRef.set(handled, stored.sequence))),
      );
    }).pipe(
      Effect.catchCause(logSkipped("factory thread event stream failed")),
      // A tail that stopped hands on nothing more; drain must not wait for it.
      Effect.ensuring(
        TxRef.set(handled, Number.POSITIVE_INFINITY).pipe(
          Effect.andThen(Deferred.succeed(ready, undefined)),
        ),
      ),
    ),
  );

  const drain = Effect.gen(function* () {
    yield* Deferred.await(ready);
    const target = yield* eventSink
      .latestSequence()
      .pipe(Effect.catchCause(() => Effect.succeed(0)));
    yield* TxRef.get(handled).pipe(
      Effect.flatMap((sequence) => (sequence >= target ? Effect.void : Effect.txRetry)),
      Effect.tx,
    );
    yield* jobs.drain;
  });

  return FactoryReactor.of({ start, drain });
});

/**
 * The reactor, reading command receipts from the database every orchestration store shares, to
 * tell a watch's wake from any other run.
 */
export const layer = Layer.effect(FactoryReactor, make).pipe(
  Layer.provide(CommandReceiptStore.layer),
);
