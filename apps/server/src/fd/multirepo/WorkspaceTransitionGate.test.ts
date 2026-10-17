import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";

const layer = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const repositories = [
  { id: "primary", name: "Primary", rootPath: "/a" },
  { id: "secondary", name: "Secondary", rootPath: "/b" },
];

it.effect.each(
  (["create", "attach", "prepare"] as const).flatMap((operation) =>
    (["membership-first", "worktree-first"] as const).map((order) => ({ operation, order })),
  ),
)("serializes $operation with a concurrent membership edit ($order)", ({ operation, order }) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const projectEvent = {
      eventId: EventId.make("project-created"),
      aggregateKind: "project" as const,
      aggregateId: projectId,
      occurredAt: iso,
      commandId: CommandId.make("project-create"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created" as const,
      payload: {
        projectId,
        title: "Project",
        workspaceRoot: "/a",
        defaultModelSelection: null,
        scripts: [],
        createdAt: iso,
        updatedAt: iso,
      },
    };
    yield* sink.commitProjectCommand({
      commandId: projectEvent.commandId,
      projectId,
      commandType: "project.create",
      acceptedAt: now,
      event: projectEvent,
    });
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId,
      title: "Conversation",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("test"),
      modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "test" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const commit = (id: string, event: OrchestrationV2DomainEvent) =>
      sink.commitCommand({
        commandId: CommandId.make(id),
        threadId: event.threadId,
        commandType: id,
        acceptedAt: now,
        events: [event],
        effects: [],
      });
    yield* commit("thread-create", {
      id: EventId.make("thread-create"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    });
    const run: OrchestrationV2Run = {
      id: RunId.make("pending"),
      threadId,
      ordinal: 1,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "preparing",
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      workspacePreparation: { type: "worktree", baseRef: "main" },
    };
    const worktreeId = operation === "create" ? ThreadId.make("worktree-thread") : threadId;
    // Both commands were planned against the same earlier membership. Only their transactional commit order differs.
    const worktreeEvent: OrchestrationV2DomainEvent =
      operation === "prepare"
        ? {
            id: EventId.make("pending"),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: run,
          }
        : {
            id: EventId.make("worktree"),
            type: operation === "create" ? "thread.created" : "thread.metadata-updated",
            threadId: worktreeId,
            occurredAt: now,
            payload: {
              ...thread,
              id: worktreeId,
              lineage: { ...thread.lineage, rootThreadId: worktreeId },
              worktreePath: "/worktrees/task",
            },
          };
    const changeMembership = sink.commitProjectCommand({
      commandId: CommandId.make("add-repository"),
      projectId,
      commandType: "project.update",
      acceptedAt: now,
      event: {
        ...projectEvent,
        eventId: EventId.make("added"),
        commandId: CommandId.make("add-repository"),
        type: "project.meta-updated",
        payload: { projectId, repositories, updatedAt: iso },
      },
    });
    if (order === "membership-first") {
      yield* changeMembership;
      const before = yield* sink.latestSequence();
      const failure = yield* commit("worktree-request", worktreeEvent).pipe(Effect.flip);
      assert.include(failure.message, "existing checkouts");
      assert.equal(yield* sink.latestSequence(), before);
      assert.equal((yield* projections.getThread(threadId)).worktreePath, null);
    } else {
      yield* commit("worktree-request", worktreeEvent);
      const before = yield* sink.latestSequence();
      const failure = yield* changeMembership.pipe(Effect.flip);
      assert.include(failure.message, "before adding another repository");
      assert.equal(yield* sink.latestSequence(), before);
      assert.deepEqual(Option.getOrThrow(yield* projects.get(projectId)).repositories, []);
      if (operation === "prepare") {
        yield* commit("cancel", {
          id: EventId.make("cancel"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", completedAt: now },
        });
        yield* changeMembership;
        assert.deepEqual(
          Option.getOrThrow(yield* projects.get(projectId)).repositories,
          repositories,
        );
      }
    }
  }).pipe(Effect.provide(layer)),
);
