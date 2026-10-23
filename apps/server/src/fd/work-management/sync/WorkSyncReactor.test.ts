import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

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
): OrchestrationV2DomainEvent =>
  ({ type, threadId, payload: { id: threadId } }) as unknown as OrchestrationV2DomainEvent;
const runEnded = (threadId: ThreadId, status: string): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
    occurredAt: DateTime.makeUnsafe(at),
    payload: { threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;

/** The reactor over the service harness; source changes and project events come from queues. */
const setup = Effect.gen(function* () {
  const changes = yield* Queue.unbounded<void, Cause.Done>();
  const events = yield* Queue.unbounded<ApplicationStoredEvent>();
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
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
    streamDomainEvents: Stream.fromQueue(domainEvents),
  });
  const layer = WorkSyncReactor.layer.pipe(
    Layer.provideMerge(harness.layer),
    Layer.provide(eventStore),
    Layer.provide(threads),
  );
  return { changes, events, domainEvents, watchEnded, markdown, harness, layer };
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
      const { domainEvents, markdown, harness, layer } = yield* setup;
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
        yield* reactor.start;
        yield* reactor.drain;

        // The item moved on while the thread ran; its run outcome refreshes the snapshot.
        yield* work.setStatus(owner, { ref: item.ref, status: "done" });
        const pull = yield* Stream.toPull(work.subscribeRefreshes);
        yield* pull;
        // Non-terminal runs are not outcomes.
        yield* Queue.offer(domainEvents, runEnded(running!, "running"));
        yield* Queue.offer(domainEvents, threadEvent("thread.deleted", deleted!));
        yield* Queue.offer(domainEvents, threadEvent("thread.settled", settled!));
        yield* Queue.offer(domainEvents, runEnded(running!, "failed"));
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
        assert.isAtLeast(markdown.count("snapshots"), 1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("sweeps links whose thread is gone, keeping launches still in flight", () =>
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
        // A link written just now for a thread that does not exist yet is a launch in flight.
        const starting = ThreadId.make("t-starting");
        yield* links.link({
          sourceId: item.ref.sourceId,
          itemId: WorkItemId.make(item.ref.itemId),
          threadId: starting,
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
        harness.threads.set(gone, threadShell(gone, alpha, { deletedAt: DateTime.makeUnsafe(at) }));

        yield* reactor.sweepLinks;
        yield* reactor.drain;

        const remaining = yield* links.listByItem(item.ref.sourceId, item.ref.itemId);
        assert.deepStrictEqual(
          remaining.map((link) => link.threadId).sort(),
          [kept, starting].sort(),
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
