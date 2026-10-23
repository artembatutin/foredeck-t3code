import type { OrchestrationV2DomainEvent, ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import { isTerminalRunStatus } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../../../serverActivation.ts";
import { LAUNCH_GRACE_MS, OPEN_LINKS_MAX } from "../model/bounds.ts";
import * as WorkLinkStore from "../persistence/WorkLinkStore.ts";
import * as WorkSourceStore from "../persistence/WorkSourceStore.ts";
import type { WorkSourceAdapter } from "../sources/WorkSourceAdapter.ts";
import * as WorkService from "../WorkService.ts";

/** How long after a watcher's stream ends on its own before the reactor starts it again. */
const WATCHER_RESTART_DELAY_MS = 5_000;
/** A stream that keeps ending without ever reporting (a deleted directory) backs off to this. */
const WATCHER_RESTART_DELAY_MAX_MS = 5 * 60_000;
/** How often open links are reconciled with their threads and items. */
const LINK_SWEEP_INTERVAL = "5 minutes";
/** Items per snapshot read, so one source call stays small. */
const SNAPSHOT_BATCH = 50;

/**
 * Keeps Work honest without polling lists: it runs one change watcher per source that can
 * report changes (Markdown directories), retires the sources of deleted projects, drops the
 * links of deleted and settled threads, records each linked run's last outcome, and bumps the
 * refresh epoch for all of them. A slow sweep reconciles what a live tail missed.
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
    /** Drops links whose thread is gone or settled and refreshes the rest's snapshots. */
    readonly sweepLinks: Effect.Effect<void>;
  }
>()("t3/fd/work-management/sync/WorkSyncReactor") {}

interface Watcher {
  readonly key: string;
  /** Identifies one start, so a finished fiber only clears its own entry. */
  readonly token: object;
  readonly fiber: Fiber.Fiber<void>;
}

type Job =
  | "watchers"
  | "sweep"
  | "links"
  | { readonly retire: ProjectId }
  | { readonly unlinkThread: ThreadId }
  | { readonly runEnded: ThreadId; readonly status: string; readonly at: string };

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const sources = yield* WorkSourceStore.WorkSourceStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const links = yield* WorkLinkStore.WorkLinkStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
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

  /** Re-reads the linked items and stores what they look like now; a vanished item stays as is. */
  const refreshSnapshots = (rows: ReadonlyArray<WorkLinkStore.StoredWorkLink>) =>
    Effect.gen(function* () {
      let changed = 0;
      const bySource = new Map<WorkSourceId, Array<WorkLinkStore.StoredWorkLink>>();
      for (const link of rows) {
        const group = bySource.get(link.sourceId) ?? [];
        group.push(link);
        bySource.set(link.sourceId, group);
      }
      for (const [sourceId, group] of bySource) {
        const itemIds = [...new Set(group.map((link) => link.itemId))];
        for (let index = 0; index < itemIds.length; index += SNAPSHOT_BATCH) {
          const batch = itemIds.slice(index, index + SNAPSHOT_BATCH);
          const summaries = yield* work.snapshots(sourceId, batch).pipe(
            // A source that is down or rate limited keeps its old snapshots until the next pass.
            Effect.catchCause(logSkipped("work link snapshot refresh skipped")),
            Effect.map((result) => result ?? []),
          );
          const byItem = new Map<WorkItemId, (typeof summaries)[number]>(
            summaries.map((summary) => [summary.ref.itemId, summary]),
          );
          for (const link of group) {
            const summary = byItem.get(link.itemId);
            if (summary === undefined || summary.revision === link.snapshot.revision) continue;
            yield* links.updateSnapshot(link.sourceId, link.itemId, link.threadId, {
              ...link.snapshot,
              key: summary.key,
              title: summary.title,
              status: summary.status,
              url: summary.url,
              revision: summary.revision,
            });
            changed += 1;
          }
        }
      }
      return changed;
    });

  const unlinkThreadOnce = (threadId: ThreadId) =>
    links.unlinkThread(threadId).pipe(
      Effect.flatMap((removed) => (removed > 0 ? work.bumpEpoch : Effect.void)),
      Effect.catchCause(logSkipped("work thread unlink failed")),
    );

  const runEndedOnce = (threadId: ThreadId, status: string, at: string) =>
    Effect.gen(function* () {
      const rows = yield* links.listByThread(threadId);
      if (rows.length === 0) return;
      for (const link of rows) {
        yield* links.updateRun(link.sourceId, link.itemId, link.threadId, { status, at });
      }
      yield* refreshSnapshots(rows);
      yield* work.bumpEpoch;
    }).pipe(Effect.catchCause(logSkipped("work run outcome update failed")));

  const sweepLinksOnce = Effect.gen(function* () {
    const { links: rows } = yield* links.listAll(OPEN_LINKS_MAX);
    const now = yield* Clock.currentTimeMillis;
    const kept: Array<WorkLinkStore.StoredWorkLink> = [];
    let removed = 0;
    for (const link of rows) {
      const shell = yield* projections.getThreadShell(link.threadId);
      if (shell === null || shell.deletedAt !== null || shell.settledAt !== null) {
        // A missing thread younger than a launch may still be starting; its start owns it.
        if (shell === null && now - Date.parse(link.linkedAt) < LAUNCH_GRACE_MS) continue;
        removed += yield* links
          .unlink(link.sourceId, link.itemId, link.threadId)
          .pipe(Effect.map((deleted) => (deleted ? 1 : 0)));
        continue;
      }
      if (shell.archivedAt === null) kept.push(link);
    }
    const updated = yield* refreshSnapshots(kept);
    if (removed > 0 || updated > 0) yield* work.bumpEpoch;
  }).pipe(Effect.catchCause(logSkipped("work link sweep failed")));

  const worker = yield* makeDrainableWorker((job: Job) => {
    if (job === "watchers") return reconcileWatchersOnce;
    if (job === "sweep") return sweepDeletedProjectsOnce;
    if (job === "links") return sweepLinksOnce;
    if ("retire" in job) {
      return work
        .retireProject(job.retire)
        .pipe(Effect.catchCause(logSkipped("work project retirement failed")));
    }
    if ("unlinkThread" in job) return unlinkThreadOnce(job.unlinkThread);
    return runEndedOnce(job.runEnded, job.status, job.at);
  });

  /** Thread lifecycle events Work reacts to; everything else passes by. */
  const onDomainEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.deleted":
      case "thread.settled":
        return worker.enqueue({ unlinkThread: event.payload.id });
      case "run.updated":
        return isTerminalRunStatus(event.payload.status)
          ? worker.enqueue({
              runEnded: event.payload.threadId,
              status: event.payload.status,
              at: DateTime.formatIso(event.occurredAt),
            })
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  // Every epoch bump asks for a reconcile; one queued job serves all of them.
  const reconcileWatchers: Effect.Effect<void> = Effect.suspend(() => {
    if (reconcileQueued) return Effect.void;
    reconcileQueued = true;
    return worker.enqueue("watchers");
  });
  const sweepDeletedProjects = worker.enqueue("sweep");
  const sweepLinks = worker.enqueue("links");

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
    // Live thread lifecycle; the sweep below catches what the tail missed while down.
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onDomainEvent).pipe(
        Effect.catchCause(logSkipped("work thread event stream failed")),
      ),
    );
    yield* forkParked(
      Effect.andThen(sweepLinks, worker.drain).pipe(
        Effect.repeat(Schedule.spaced(LINK_SWEEP_INTERVAL)),
        Effect.asVoid,
      ),
    );
  });

  return WorkSyncReactor.of({
    start,
    drain: worker.drain,
    reconcileWatchers,
    sweepDeletedProjects,
    sweepLinks,
  });
});

export const layer = Layer.effect(WorkSyncReactor, make);
