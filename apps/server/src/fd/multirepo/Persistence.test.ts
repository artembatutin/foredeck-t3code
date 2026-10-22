import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ApplicationProjectEvent, EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ApplicationProjectEvent as ProjectEvent } from "@t3tools/contracts";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";

const decodeProjectEvent = Schema.decodeUnknownEffect(ProjectEvent);

it.effect(
  "retains ordered membership through restart, removal and replay while old events still decode",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fd-multirepo-persistence-" });
      const projectId = ProjectId.make("membership");
      const at = "2026-10-16T00:00:00.000Z";
      const base = {
        sequence: 1,
        eventId: EventId.make("create"),
        aggregateKind: "project" as const,
        aggregateId: projectId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      };
      const legacy: ApplicationProjectEvent = yield* decodeProjectEvent({
        ...base,
        type: "project.created",
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      });
      const repositories = [
        { id: "a", name: "App", rootPath: "/a" },
        { id: "b", name: "Service", rootPath: "/b" },
      ];
      const added: ApplicationProjectEvent = {
        ...base,
        sequence: 2,
        eventId: EventId.make("add"),
        type: "project.meta-updated",
        payload: { projectId, repositories, updatedAt: at },
      };
      const database = () =>
        ProjectStore.layer.pipe(
          Layer.provideMerge(Sqlite.layerFromPath(directory + "/statev2.sqlite")),
        );
      yield* Effect.gen(function* () {
        const store = yield* ProjectStore.ProjectStoreV2;
        yield* store.apply(legacy);
        assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)).repositories, []);
        yield* store.apply(added);
      }).pipe(Effect.provide(database()), Effect.scoped);
      yield* Effect.gen(function* () {
        const store = yield* ProjectStore.ProjectStoreV2;
        assert.deepEqual(
          Option.getOrThrow(yield* store.getShell(projectId)).repositories,
          repositories,
        );
        const removed: ApplicationProjectEvent = {
          ...base,
          sequence: 3,
          eventId: EventId.make("remove"),
          type: "project.meta-updated",
          payload: { projectId, repositories: [repositories[0]!], updatedAt: at },
        };
        yield* store.apply(removed);
        const before = Option.getOrThrow(yield* store.get(projectId));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
        for (const event of [legacy, added, removed]) yield* store.apply(event);
        assert.deepEqual(Option.getOrThrow(yield* store.get(projectId)), before);
        assert.deepEqual(before.repositories, [repositories[0]!]);
      }).pipe(Effect.provide(database()), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
);
