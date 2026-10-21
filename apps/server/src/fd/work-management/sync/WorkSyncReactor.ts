import type { ProjectId } from "@t3tools/contracts";
import type { WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../../../serverActivation.ts";
import * as WorkSourceStore from "../persistence/WorkSourceStore.ts";
import type { WorkSourceAdapter } from "../sources/WorkSourceAdapter.ts";
import * as WorkService from "../WorkService.ts";

/** How long after a watcher's stream ends on its own before the reactor starts it again. */
const WATCHER_RESTART_DELAY_MS = 5_000;
/** A stream that keeps ending without ever reporting (a deleted directory) backs off to this. */
const WATCHER_RESTART_DELAY_MAX_MS = 5 * 60_000;

/**
 * Keeps Work honest without polling lists: it runs one change watcher per source that can
 * report changes (Markdown directories), retires the sources of deleted projects, and bumps the
 * refresh epoch for both. Thread and run events arrive with the execution phase.
 */
export class WorkSyncReactor extends Context.Service<
  WorkSyncReactor,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every queued reconcile has run; tests await this instead of sleeping. */
    readonly drain: Effect.Effect<void>;
    /** Re-reads the active sources and starts or stops watchers to match. */
    readonly reconcileWatchers: Effect.Effect<void>;
    /** Retires sources whose project no longer exists. */
    readonly sweepDeletedProjects: Effect.Effect<void>;
  }
>()("t3/fd/work-management/sync/WorkSyncReactor") {}

interface Watcher {
  readonly key: string;
  /** Identifies one start, so a finished fiber only clears its own entry. */
  readonly token: object;
  readonly fiber: Fiber.Fiber<void>;
}

type Job = "watchers" | "sweep" | { readonly retire: ProjectId };

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const sources = yield* WorkSourceStore.WorkSourceStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const scope = yield* Effect.scope;

  const watchers = new Map<WorkSourceId, Watcher>();
  /** The next restart delay per source; cleared once a stream reports a change. */
  const restartDelays = new Map<WorkSourceId, number>();
  let reconcileQueued = false;

  const logSkipped = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, cause).pipe(Effect.asVoid);

  /** The directory a Markdown source watches; a moved source is a different watch. */
  const keyOf = (source: WorkService.ResolvedSource) =>
    `${source.runtime.rootPath}\0${source.stored.identity}`;

  const stopWatcher = (sourceId: WorkSourceId) =>
    Effect.suspend(() => {
      const watcher = watchers.get(sourceId);
      if (watcher === undefined) return Effect.void;
      watchers.delete(sourceId);
      return Fiber.interrupt(watcher.fiber).pipe(Effect.asVoid);
    });

  const startWatcher = (
    sourceId: WorkSourceId,
    source: WorkService.ResolvedSource,
    watch: NonNullable<WorkSourceAdapter["watch"]>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const token = {};
      let reported = false;
      // The stream waits until its entry exists, so a stream that ends at once still clears it.
      const registered = yield* Deferred.make<void>();
      const fiber = yield* Deferred.await(registered).pipe(
        Effect.andThen(
          Stream.runForEach(watch(source.runtime), () =>
            Effect.suspend(() => {
              reported = true;
              return work.bumpEpoch;
            }),
          ),
        ),
        Effect.catchCause(logSkipped("work source watcher stopped")),
        // A stream that ends on its own (a deleted directory, a failed fs.watch) is restarted by
        // the next reconcile; one is scheduled so an idle server does not stay blind, later each
        // time the stream ends without having reported anything.
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (watchers.get(sourceId)?.token !== token) return Effect.void;
            watchers.delete(sourceId);
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
            const previous = restartDelays.get(sourceId);
            const delay =
              reported || previous === undefined
                ? WATCHER_RESTART_DELAY_MS
                : Math.min(previous * 2, WATCHER_RESTART_DELAY_MAX_MS);
            restartDelays.set(sourceId, delay);
            return reconcileWatchers.pipe(
              Effect.delay(Duration.millis(delay)),
              Effect.forkIn(scope),
              Effect.asVoid,
            );
          }),
        ),
        Effect.forkIn(scope),
      );
      watchers.set(sourceId, { key: keyOf(source), token, fiber });
      yield* Deferred.succeed(registered, undefined);
    });

  const reconcileWatchersOnce = Effect.gen(function* () {
    reconcileQueued = false;
    const watchable = yield* work.watchableSources;
    const wanted = new Map(watchable.map((entry) => [entry.stored.sourceId, entry]));
    for (const [sourceId, watcher] of watchers) {
      const next = wanted.get(sourceId);
      if (next === undefined) {
        restartDelays.delete(sourceId);
        yield* stopWatcher(sourceId);
      } else if (next.resolved !== null && keyOf(next.resolved) !== watcher.key) {
        // An unresolved source keeps its watcher: the failure may be passing, and a vanished
        // project is retired separately.
        yield* stopWatcher(sourceId);
      }
    }
    for (const [sourceId, { resolved }] of wanted) {
      if (resolved === null || watchers.has(sourceId)) continue;
      const watch = resolved.adapter.watch;
      if (watch !== undefined) yield* startWatcher(sourceId, resolved, watch);
    }
  }).pipe(Effect.catchCause(logSkipped("work watcher reconcile failed")));

  const sweepDeletedProjectsOnce = Effect.gen(function* () {
    const projectIds = yield* sources.listProjectIds();
    if (projectIds.length === 0) return;
    const live = yield* projects.list({ projectIds });
    const liveIds = new Set(live.map((project) => project.projectId));
    for (const projectId of projectIds) {
      if (!liveIds.has(projectId)) yield* work.retireProject(projectId);
    }
  }).pipe(Effect.catchCause(logSkipped("work deleted-project sweep failed")));

  const worker = yield* makeDrainableWorker((job: Job) =>
    job === "watchers"
      ? reconcileWatchersOnce
      : job === "sweep"
        ? sweepDeletedProjectsOnce
        : work
            .retireProject(job.retire)
            .pipe(Effect.catchCause(logSkipped("work project retirement failed"))),
  );

  // Every epoch bump asks for a reconcile; one queued job serves all of them.
  const reconcileWatchers: Effect.Effect<void> = Effect.suspend(() => {
    if (reconcileQueued) return Effect.void;
    reconcileQueued = true;
    return worker.enqueue("watchers");
  });
  const sweepDeletedProjects = worker.enqueue("sweep");

  const start: WorkSyncReactor["Service"]["start"] = Effect.gen(function* () {
    // Read the sequence before the sweep, so a deletion between the two still reaches the tail.
    const latest = yield* events.latestApplicationSequence.pipe(
      Effect.catchCause(() => Effect.succeed(0)),
    );
    yield* sweepDeletedProjects;
    yield* reconcileWatchers;
    // Every epoch bump may mean a source was added, removed or moved.
    yield* forkParked(
      Stream.runForEach(work.subscribeRefreshes, () => reconcileWatchers).pipe(
        Effect.catchCause(logSkipped("work refresh stream failed")),
      ),
    );
    // Live project deletions only: deletions missed while down are caught by the boot sweep.
    yield* forkParked(
      Stream.runForEach(
        events.streamProjectedApplicationEvents({
          afterSequence: latest,
          // Only the deleted project's id survives the projection; thread events carry nothing.
          project: (event) => ({
            sequence: event.sequence,
            deletedProjectId:
              "type" in event && event.type === "project.deleted" ? event.payload.projectId : null,
          }),
        }),
        (event) =>
          event.deletedProjectId === null
            ? Effect.void
            : worker.enqueue({ retire: event.deletedProjectId }),
      ).pipe(Effect.catchCause(logSkipped("work project event stream failed"))),
    );
  });

  return WorkSyncReactor.of({
    start,
    drain: worker.drain,
    reconcileWatchers,
    sweepDeletedProjects,
  });
});

export const layer = Layer.effect(WorkSyncReactor, make);
