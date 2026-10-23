import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as WorkLinkStore from "../persistence/WorkLinkStore.ts";
import {
  at,
  fakeAdapter,
  makeHarness,
  markdownConfig,
  owner,
  projectRow,
  threadShell,
} from "../testkit/fakes.ts";
import * as WorkService from "../WorkService.ts";
import * as WorkSyncReactor from "./WorkSyncReactor.ts";

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");

const projectDeleted = (projectId: ProjectId, sequence: number): ApplicationStoredEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.deleted",
  payload: { projectId, deletedAt: at },
});

/** A thread lifecycle event with only the fields the reactor reads. */
const threadEvent = (
  type: "thread.deleted" | "thread.settled",
  threadId: ThreadId,
  when = at,
): OrchestrationV2DomainEvent =>
  ({
    type,
    threadId,
    occurredAt: DateTime.makeUnsafe(when),
    payload: {
      id: threadId,
      settledAt: type === "thread.settled" ? DateTime.makeUnsafe(when) : null,
    },
  }) as unknown as OrchestrationV2DomainEvent;
const runEnded = (threadId: ThreadId, status: string, when = at): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
    occurredAt: DateTime.makeUnsafe(when),
    payload: { threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;

/**
 * The reactor over the service harness; source changes and project events come from queues.
 * Thread events come from a live tail like the orchestrator's: an event published before the
 * reactor subscribes is never delivered. `tailSubscribed` resolves once it has subscribed.
 */
const setup = Effect.gen(function* () {
  const changes = yield* Queue.unbounded<void, Cause.Done>();
  const events = yield* Queue.unbounded<ApplicationStoredEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const tailSubscribed = yield* Deferred.make<void>();
  const watchEnded = yield* Deferred.make<void>();
  const markdown = fakeAdapter("markdown", {
    watch: changes,
    onWatchEnd: Deferred.succeed(watchEnded, undefined),
  });
  const harness = makeHarness([markdown.adapter]);
  harness.projects.set(alpha, projectRow(alpha, "/projects/alpha"));
  const eventStore = Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
    latestApplicationSequence: Effect.succeed(0),
    streamProjectedApplicationEvents: (input) =>
      Stream.fromQueue(events).pipe(Stream.map((event) => input.project(event))),
  });
  const threads = Layer.mock(Orchestrator.OrchestratorV2)({
    streamDomainEvents: Stream.unwrap(
      PubSub.subscribe(domainEvents).pipe(
        Effect.tap(() => Deferred.succeed(tailSubscribed, undefined)),
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    ),
  });
  const layer = WorkSyncReactor.layer.pipe(
    Layer.provideMerge(harness.layer),
    Layer.provide(eventStore),
    Layer.provide(threads),
  );
  return { changes, events, domainEvents, tailSubscribed, watchEnded, markdown, harness, layer };
});

describe("WorkSyncReactor", () => {
  it.effect("retires sources whose project vanished while the server was down", () =>
    Effect.gen(function* () {
      const { harness, layer } = yield* setup;
      harness.projects.set(beta, projectRow(beta, "/projects/beta"));
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const kept = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const lost = yield* work.saveSource(owner, {
          projectId: beta,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        harness.projects.delete(beta);

        yield* reactor.start;
        yield* reactor.drain;

        const sources = (yield* work.listSources(owner, { includeDisconnected: true })).sources;
        const stateOf = (sourceId: typeof kept.sourceId) =>
          sources.find((source) => source.sourceId === sourceId)?.state;
        assert.strictEqual(stateOf(kept.sourceId), "active");
        assert.strictEqual(stateOf(lost.sourceId), "disconnected");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("watches sources that report changes and follows their moves", () =>
    Effect.gen(function* () {
      const { changes, markdown, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        yield* reactor.start;
        yield* reactor.drain;
        assert.deepStrictEqual(markdown.watchers, { started: 1, stopped: 0 });

        // A change report moves the epoch, so cached reads are dropped.
        const pull = yield* Stream.toPull(work.subscribeRefreshes);
        const [before] = yield* pull;
        yield* Queue.offer(changes, undefined);
        const moved = yield* pull;
        assert.isAbove(moved[moved.length - 1]!, before);

        // A moved directory is a different watch.
        yield* work.saveSource(owner, {
          sourceId: source.sourceId,
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks-v2"),
        });
        yield* reactor.reconcileWatchers;
        yield* reactor.drain;
        assert.deepStrictEqual(markdown.watchers, { started: 2, stopped: 1 });

        // A disconnected source is no longer watched.
        yield* work.disconnectSource(owner, { sourceId: source.sourceId });
        yield* reactor.reconcileWatchers;
        yield* reactor.drain;
        assert.deepStrictEqual(markdown.watchers, { started: 2, stopped: 2 });
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("starts a watcher again after its stream ended", () =>
    Effect.gen(function* () {
      const { changes, watchEnded, markdown, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        yield* reactor.start;
        yield* reactor.drain;
        assert.strictEqual(markdown.watchers.started, 1);

        // The directory vanished: the source's stream ends on its own.
        yield* Queue.end(changes);
        yield* Deferred.await(watchEnded);
        yield* Effect.yieldNow;
        yield* reactor.reconcileWatchers;
        yield* reactor.drain;
        assert.strictEqual(markdown.watchers.started, 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("retires a project's sources when its deletion event arrives", () =>
    Effect.gen(function* () {
      const { events, markdown, harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        yield* reactor.start;
        yield* reactor.drain;

        const pull = yield* Stream.toPull(work.subscribeRefreshes);
        yield* pull;
        // Other projects' deletions are not this project's business.
        yield* Queue.offer(events, projectDeleted(beta, 1));
        harness.projects.delete(alpha);
        yield* Queue.offer(events, projectDeleted(alpha, 2));
        yield* pull;

        const sources = (yield* work.listSources(owner, { includeDisconnected: true })).sources;
        assert.deepStrictEqual(
          sources.map((entry) => [entry.sourceId, entry.state]),
          [[source.sourceId, "disconnected"]],
        );
        yield* reactor.reconcileWatchers;
        yield* reactor.drain;
        assert.deepStrictEqual(markdown.watchers, { started: 1, stopped: 1 });
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("drops the links of deleted and settled threads and records run outcomes", () =>
    Effect.gen(function* () {
      const { domainEvents, tailSubscribed, markdown, harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship" });
        const [running, deleted, settled] = ["t-running", "t-deleted", "t-settled"].map((id) =>
          ThreadId.make(id),
        );
        for (const threadId of [running!, deleted!, settled!]) {
          harness.threads.set(threadId, threadShell(threadId, alpha));
          yield* work.setLink(owner, { ref: item.ref, threadId, action: "link" });
        }
        const baseline = (yield* links.listByThread(running!))[0]!.snapshot.revision;
        yield* reactor.start;
        yield* Deferred.await(tailSubscribed);

        // The item moved on while the thread ran; its run outcome refreshes the snapshot.
        yield* work.setStatus(owner, { ref: item.ref, status: "done" });
        const pull = yield* Stream.toPull(work.subscribeRefreshes);
        yield* pull;
        // Non-terminal runs are not outcomes.
        yield* PubSub.publish(domainEvents, runEnded(running!, "running"));
        yield* PubSub.publish(domainEvents, threadEvent("thread.deleted", deleted!));
        yield* PubSub.publish(domainEvents, threadEvent("thread.settled", settled!));
        yield* PubSub.publish(domainEvents, runEnded(running!, "failed"));
        // Every handled event moves the epoch; wait for the last one's effect.
        const current = links.listByItem(item.ref.sourceId, item.ref.itemId);
        while ((yield* current).some((link) => link.run === null || link.threadId !== running)) {
          yield* pull;
        }
        yield* reactor.drain;

        const remaining = yield* current;
        assert.deepStrictEqual(
          remaining.map((link) => link.threadId),
          [running],
        );
        assert.deepStrictEqual(remaining[0]!.run, { status: "failed", at });
        assert.strictEqual(remaining[0]!.snapshot.status, "done");
        // The displayed fields follow the item; the revision stays the one the thread started
        // from, so "Changed since the thread started" still shows.
        assert.strictEqual(remaining[0]!.snapshot.revision, baseline);
        assert.isAtLeast(markdown.count("snapshots"), 1);

        // Repeating the deletion and settlement changes nothing.
        yield* PubSub.publish(domainEvents, threadEvent("thread.deleted", deleted!));
        yield* PubSub.publish(domainEvents, threadEvent("thread.settled", settled!));
        yield* PubSub.publish(
          domainEvents,
          runEnded(running!, "completed", "2026-10-21T08:00:00.000Z"),
        );
        yield* reactor.sweepLinks;
        yield* reactor.drain;
        const again = yield* current;
        assert.deepStrictEqual(
          again.map((link) => [link.threadId, link.run]),
          [[running!, { status: "failed", at }]],
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps a link made on purpose after its thread settled", () =>
    Effect.gen(function* () {
      const { domainEvents, tailSubscribed, harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship" });
        const thread = ThreadId.make("t-settled-earlier");
        // Settled long before the owner linked it (links are written at the test clock's now).
        const settledAt = "1969-12-31T00:00:00.000Z";
        harness.threads.set(
          thread,
          threadShell(thread, alpha, { settledAt: DateTime.makeUnsafe(settledAt) }),
        );
        yield* work.setLink(owner, { ref: item.ref, threadId: thread, action: "link" });
        yield* reactor.start;
        yield* Deferred.await(tailSubscribed);

        yield* PubSub.publish(domainEvents, threadEvent("thread.settled", thread, settledAt));
        yield* reactor.sweepLinks;
        yield* reactor.drain;
        assert.deepStrictEqual(
          (yield* links.listByThread(thread)).map((link) => link.threadId),
          [thread],
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("recovers a run outcome that ended while the reactor was not listening", () =>
    Effect.gen(function* () {
      const { domainEvents, harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship" });
        const thread = ThreadId.make("t-before-restart");
        const earlier = ThreadId.make("t-earlier-run");
        const runId = RunId.make("run-1");
        harness.threads.set(thread, threadShell(thread, alpha));
        harness.threads.set(earlier, threadShell(earlier, alpha));
        yield* work.setLink(owner, { ref: item.ref, threadId: thread, action: "link" });
        yield* work.setLink(owner, { ref: item.ref, threadId: earlier, action: "link" });

        // The run completed and its event committed before this reactor started: the live
        // tail is not subscribed yet, so the event is never delivered.
        harness.threads.set(
          thread,
          threadShell(thread, alpha, { activeRunId: null, latestRunId: runId }),
        );
        harness.runs.set(thread, [
          { id: runId, status: "completed", completedAt: DateTime.makeUnsafe(at) },
        ]);
        yield* PubSub.publish(domainEvents, runEnded(thread, "completed"));
        // A run that ended before its thread was linked is not this link's outcome.
        const oldRun = RunId.make("run-old");
        harness.threads.set(
          earlier,
          threadShell(earlier, alpha, { activeRunId: null, latestRunId: oldRun }),
        );
        harness.runs.set(earlier, [
          {
            id: oldRun,
            status: "failed",
            completedAt: DateTime.makeUnsafe("1969-12-31T00:00:00.000Z"),
          },
        ]);

        const pull = yield* Stream.toPull(work.subscribeRefreshes);
        yield* pull;
        yield* reactor.start;
        // The boot sweep moves the epoch once it recorded the outcome.
        while ((yield* links.listByThread(thread))[0]?.run === null) yield* pull;
        yield* reactor.drain;

        assert.deepStrictEqual((yield* links.listByThread(thread))[0]?.run, {
          status: "completed",
          at,
        });
        assert.isNull((yield* links.listByThread(earlier))[0]?.run);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("never sweeps a reserved launch, however long it runs", () =>
    Effect.gen(function* () {
      const { harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship" });
        const kept = ThreadId.make("t-kept");
        const gone = ThreadId.make("t-gone");
        harness.threads.set(kept, threadShell(kept, alpha));
        harness.threads.set(gone, threadShell(gone, alpha));
        for (const threadId of [kept, gone]) {
          yield* work.setLink(owner, { ref: item.ref, threadId, action: "link" });
        }
        const linkFor = (threadId: ThreadId) =>
          links.link({
            sourceId: item.ref.sourceId,
            itemId: WorkItemId.make(item.ref.itemId),
            threadId,
            source: "started",
            snapshot: {
              key: "k",
              title: "t",
              status: "todo",
              url: null,
              revision: "r",
              autoStarted: false,
            },
          });
        // A launch still running holds its reservation; one that died with the process does not.
        const starting = ThreadId.make("t-starting");
        const crashed = ThreadId.make("t-crashed");
        const launch = yield* Scope.make();
        yield* work.reserveLaunch(starting).pipe(Scope.provide(launch));
        yield* linkFor(starting);
        yield* linkFor(crashed);
        harness.threads.set(gone, threadShell(gone, alpha, { deletedAt: DateTime.makeUnsafe(at) }));
        // Long past any grace period.
        yield* TestClock.adjust("10 minutes");

        yield* reactor.sweepLinks;
        yield* reactor.drain;
        const remaining = () =>
          links
            .listByItem(item.ref.sourceId, item.ref.itemId)
            .pipe(Effect.map((rows) => rows.map((link) => link.threadId).sort()));
        assert.deepStrictEqual(yield* remaining(), [kept, starting].sort());

        // Once the launch ended without its thread, the link is a dead reservation.
        yield* Scope.close(launch, Exit.void);
        yield* reactor.sweepLinks;
        yield* reactor.drain;
        assert.deepStrictEqual(yield* remaining(), [kept]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("refreshes displayed fields without undoing a concurrent automatic start", () =>
    Effect.gen(function* () {
      const { markdown, harness, layer } = yield* setup;
      yield* Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const source = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "Tasks",
          config: markdownConfig("tasks"),
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship" });
        const thread = ThreadId.make("t-auto");
        harness.threads.set(thread, threadShell(thread, alpha));
        yield* work.setLink(owner, { ref: item.ref, threadId: thread, action: "link" });
        // The item's title changes, so the sweep has a display refresh to write.
        yield* work.updateItem(owner, {
          ref: item.ref,
          title: "Ship it",
          expectedRevision: item.revision,
        });

        markdown.snapshotsGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const sweep = yield* Effect.forkChild(Effect.andThen(reactor.sweepLinks, reactor.drain));
        yield* Deferred.await(markdown.snapshotsGate.entered);
        // Between the sweep's read and its write, the automatic start stores its revision and
        // mark on the link.
        const [before] = yield* links.listByThread(thread);
        yield* links.updateSnapshot(item.ref.sourceId, item.ref.itemId, thread, {
          ...before!.snapshot,
          revision: "auto-revision",
          status: "in_progress",
          autoStarted: true,
        });
        yield* Deferred.succeed(markdown.snapshotsGate.release, undefined);
        yield* Fiber.join(sweep);

        const [after] = yield* links.listByThread(thread);
        assert.strictEqual(after?.snapshot.title, "Ship it");
        assert.strictEqual(after?.snapshot.revision, "auto-revision");
        assert.isTrue(after?.snapshot.autoStarted);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
