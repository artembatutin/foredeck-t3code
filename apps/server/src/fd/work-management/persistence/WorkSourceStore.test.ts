import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as WorkLinkStore from "./WorkLinkStore.ts";
import * as WorkMigrations from "./WorkMigrations.ts";
import * as WorkSourceStore from "./WorkSourceStore.ts";

const persistence = Layer.mergeAll(WorkSourceStore.layer, WorkLinkStore.layer).pipe(
  Layer.provide(WorkMigrations.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const tasksId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const notesId = WorkSourceId.make("0b1c2d3e-4f50-4617-8899-aabbccddeeff");
const otherId = WorkSourceId.make("9f8e7d6c-5b4a-4392-8171-605f4e3d2c1b");

const markdown = (directory: string) => ({
  kind: "markdown" as const,
  directory,
  autoStart: true,
});

const tasks = {
  sourceId: tasksId,
  projectId: alpha,
  kind: "markdown" as const,
  identity: "work/tasks",
  label: "Tasks",
  config: markdown("work/tasks"),
  secretName: null,
};

const github = (sourceId: WorkSourceId, projectId: ProjectId, secretName: string | null) => ({
  sourceId,
  projectId,
  kind: "github" as const,
  identity: "github.com/acme/app",
  label: "Issues",
  config: { kind: "github" as const, host: "github.com", owner: "acme", name: "app" },
  secretName,
});

describe("WorkSourceStore", () => {
  it.effect("inserts a source and reads it back", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const created = yield* store.insertOrRevive(tasks);
      assert.strictEqual(created.sourceId, tasksId);
      assert.strictEqual(created.state, "active");
      assert.strictEqual(created.version, 1);
      assert.isNull(created.disconnectedAt);
      assert.strictEqual(created.createdAt, created.updatedAt);

      assert.deepStrictEqual(yield* store.get(tasksId), Option.some(created));
      assert.deepStrictEqual(yield* store.get(otherId), Option.none());
      assert.deepStrictEqual(yield* store.list(), [created]);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("lists active sources by project and tombstones on request", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const first = yield* store.insertOrRevive(tasks);
      yield* TestClock.adjust("1 second");
      const second = yield* store.insertOrRevive(github(notesId, alpha, "token-a"));
      const elsewhere = yield* store.insertOrRevive(github(otherId, beta, "token-a"));

      assert.deepStrictEqual(yield* store.list(), [first, second, elsewhere]);
      assert.deepStrictEqual(yield* store.list({ projectId: alpha }), [first, second]);

      const disconnected = yield* store.disconnect(notesId);
      assert.deepStrictEqual(yield* store.list({ projectId: alpha }), [first]);
      assert.deepStrictEqual(yield* store.list({ projectId: alpha, includeDisconnected: true }), [
        first,
        disconnected,
      ]);
      assert.deepStrictEqual(yield* store.listProjectIds(), [alpha, beta]);
      assert.strictEqual(yield* store.countActiveBySecret("token-a"), 1);
      assert.strictEqual(yield* store.countActiveBySecret("token-b"), 0);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("updates on the expected version and refuses a stale one", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const created = yield* store.insertOrRevive(tasks);
      yield* TestClock.adjust("1 minute");

      const updated = yield* store.update({
        sourceId: tasksId,
        expectedVersion: 1,
        label: "Backlog",
        config: markdown("work/backlog"),
        identity: "work/backlog",
      });
      assert.strictEqual(updated.version, 2);
      assert.strictEqual(updated.label, "Backlog");
      assert.strictEqual(updated.identity, "work/backlog");
      assert.deepStrictEqual(updated.config, markdown("work/backlog"));
      assert.strictEqual(updated.createdAt, created.createdAt);
      assert.notStrictEqual(updated.updatedAt, created.updatedAt);
      assert.deepStrictEqual(yield* store.get(tasksId), Option.some(updated));

      const stale = yield* store
        .update({ sourceId: tasksId, expectedVersion: 1, label: "Old" })
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "WorkSourceStale");
      assert.deepStrictEqual(yield* store.get(tasksId), Option.some(updated));

      const missing = yield* store.update({ sourceId: otherId, label: "Nope" }).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "WorkSourceNotFound");

      // No expected version skips the check; a null secret clears it.
      const withSecret = yield* store.update({ sourceId: tasksId, secretName: "token-a" });
      assert.strictEqual(withSecret.secretName, "token-a");
      assert.strictEqual(withSecret.version, 3);
      const cleared = yield* store.update({ sourceId: tasksId, secretName: null });
      assert.isNull(cleared.secretName);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses an identity another live source already uses", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      yield* store.insertOrRevive(tasks);
      const notes = yield* store.insertOrRevive({
        ...tasks,
        sourceId: notesId,
        identity: "work/notes",
        config: markdown("work/notes"),
      });

      const conflict = yield* store
        .update({ sourceId: notesId, identity: "work/tasks" })
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "WorkConflict");
      assert.deepStrictEqual(yield* store.get(notesId), Option.some(notes));

      // The same identity in another project is fine.
      const elsewhere = yield* store.insertOrRevive({
        ...tasks,
        sourceId: otherId,
        projectId: beta,
      });
      assert.strictEqual(elsewhere.identity, "work/tasks");
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("disconnects once and restores", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      yield* store.insertOrRevive(tasks);
      yield* TestClock.adjust("1 minute");

      const stale = yield* store.disconnect(tasksId, 7).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "WorkSourceStale");

      const disconnected = yield* store.disconnect(tasksId, 1);
      assert.strictEqual(disconnected.state, "disconnected");
      assert.strictEqual(disconnected.version, 2);
      assert.strictEqual(disconnected.disconnectedAt, disconnected.updatedAt);

      // A repeated disconnect returns the tombstone unchanged, whatever version it carries.
      assert.deepStrictEqual(yield* store.disconnect(tasksId), disconnected);
      assert.deepStrictEqual(yield* store.disconnect(tasksId, 1), disconnected);
      assert.deepStrictEqual(yield* store.list(), []);

      yield* TestClock.adjust("1 minute");
      const restored = yield* store.restore(tasksId, 2);
      assert.strictEqual(restored.state, "active");
      assert.strictEqual(restored.version, 3);
      assert.isNull(restored.disconnectedAt);
      assert.notStrictEqual(restored.updatedAt, disconnected.updatedAt);
      assert.deepStrictEqual(yield* store.restore(tasksId), restored);
      assert.deepStrictEqual(yield* store.list(), [restored]);

      const missing = yield* store.disconnect(otherId).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "WorkSourceNotFound");
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("revives a tombstone under its own id with its links intact", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const created = yield* store.insertOrRevive(tasks);
      const { link } = yield* links.link({
        sourceId: tasksId,
        itemId: WorkItemId.make("fd-7k3qa2"),
        threadId: ThreadId.make("thread-1"),
        source: "started",
        snapshot: {
          key: "fd-7k3qa2",
          title: "Fix",
          status: "todo",
          url: null,
          revision: "r1",
          autoStarted: true,
        },
      });
      yield* store.disconnect(tasksId);
      yield* TestClock.adjust("1 minute");

      const revived = yield* store.insertOrRevive({
        ...tasks,
        sourceId: otherId,
        label: "Tasks again",
        config: markdown("work/tasks"),
        secretName: "token-a",
      });
      assert.strictEqual(revived.sourceId, tasksId);
      assert.strictEqual(revived.state, "active");
      assert.strictEqual(revived.version, 3);
      assert.strictEqual(revived.label, "Tasks again");
      assert.strictEqual(revived.secretName, "token-a");
      assert.strictEqual(revived.createdAt, created.createdAt);
      assert.isNull(revived.disconnectedAt);
      assert.deepStrictEqual(yield* store.list({ includeDisconnected: true }), [revived]);
      assert.deepStrictEqual(yield* store.get(otherId), Option.none());
      assert.deepStrictEqual(yield* links.listByThread(ThreadId.make("thread-1")), [link]);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses a second live source for one identity", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const created = yield* store.insertOrRevive(tasks);

      const conflict = yield* store
        .insertOrRevive({ ...tasks, sourceId: otherId, label: "Duplicate" })
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "WorkConflict");
      assert.deepStrictEqual(yield* store.list({ includeDisconnected: true }), [created]);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses to restore a tombstone whose identity went live elsewhere", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const notes = yield* store.insertOrRevive({
        ...tasks,
        sourceId: notesId,
        identity: "work/notes",
        config: markdown("work/notes"),
      });
      const tombstone = yield* store.disconnect(notesId);
      // With the old identity free, another source may take it over.
      yield* store.insertOrRevive(tasks);
      const squatter = yield* store.update({ sourceId: tasksId, identity: "work/notes" });
      assert.strictEqual(squatter.identity, notes.identity);

      const conflict = yield* store.restore(notesId).pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "WorkConflict");
      assert.include(conflict.message, tasksId);
      assert.deepStrictEqual(yield* store.get(notesId), Option.some(tombstone));
    }).pipe(Effect.provide(persistence)),
  );
});

describe("WorkSourceStore kind", () => {
  it.effect("refuses a config of another kind and leaves the row unchanged", () =>
    Effect.gen(function* () {
      const store = yield* WorkSourceStore.WorkSourceStore;
      const created = yield* store.insertOrRevive(tasks);
      const refused = yield* Effect.flip(
        store.update({
          sourceId: created.sourceId,
          config: github(otherId, alpha, null).config,
          identity: "github.com/acme/app",
        }),
      );
      assert.strictEqual(refused._tag, "WorkConflict");
      assert.deepStrictEqual(yield* store.get(created.sourceId), Option.some(created));
    }).pipe(Effect.provide(persistence)),
  );
});
