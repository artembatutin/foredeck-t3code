import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

// No Factory persistence or runtime: selection provenance is retained for ordinary threads too.
const layer = ProjectionMaintenance.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  ),
);

it.effect("retains every model and provider choice through public compaction and rebuild", () =>
  Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    for (const deleted of [false, true]) {
      const threadId = ThreadId.make(`ordinary-thread:${deleted}`);
      const instanceId = ProviderInstanceId.make("first-provider");
      const initial: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("ordinary-project"),
        createdBy: "user",
        creationSource: "web",
        title: "Owner work",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "first-model" },
        runtimeMode: "full-access",
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
      let state = initial;
      let ordinal = 0;
      const append = (
        type:
          | "thread.created"
          | "thread.model-selection-updated"
          | "thread.provider-switched"
          | "thread.metadata-updated"
          | "thread.deleted",
        updates: Partial<OrchestrationV2AppThread> = {},
      ) => {
        state = { ...state, ...updates };
        return events.append({
          commandId: CommandId.make(`owner:${threadId}:${++ordinal}`),
          events: [
            {
              id: EventId.make(`event:${threadId}:${ordinal}`),
              type,
              threadId,
              occurredAt: now,
              payload: state,
            },
          ],
        });
      };
      yield* append("thread.created");
      const choices = [];
      for (const effort of ["high", "medium", "low"]) {
        choices.push(
          ...(yield* append("thread.model-selection-updated", {
            modelSelection: {
              ...initial.modelSelection,
              options: [{ id: "effort", value: effort }],
            },
          })),
        );
      }
      for (const instanceId of ["second-provider", "first-provider"]) {
        const modelSelection: ModelSelection = {
          instanceId: ProviderInstanceId.make(instanceId),
          model: "owner-model",
        };
        choices.push(
          ...(yield* append("thread.provider-switched", {
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
          })),
        );
      }
      for (const title of ["Superseded title", "Current title"]) {
        yield* append("thread.metadata-updated", { title });
      }
      if (deleted) {
        yield* append("thread.deleted", { deletedAt: now });
      }
      assert.isTrue((yield* maintenance.rebuild).valid);
      const before = yield* projections.getThreadProjection(threadId);
      const compacted = yield* maintenance.compactEventStore;
      assert.strictEqual(compacted.deletedEventCount, deleted ? 2 : 1);
      const retained = yield* events.read({ threadId }).pipe(Stream.runCollect);
      assert.deepStrictEqual(
        retained.filter(
          ({ event }) =>
            event.type === "thread.model-selection-updated" ||
            event.type === "thread.provider-switched",
        ),
        choices,
      );
      assert.strictEqual(
        retained.at(-1)?.event.type,
        deleted ? "thread.deleted" : "thread.metadata-updated",
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepStrictEqual(yield* projections.getThreadProjection(threadId), before);
      assert.strictEqual(
        (yield* projections.getThreadRecords(threadId, [])).thread.deletedAt !== null,
        deleted,
      );
      assert.strictEqual((yield* maintenance.compactEventStore).deletedEventCount, 0);
    }
  }).pipe(Effect.provide(layer)),
);
