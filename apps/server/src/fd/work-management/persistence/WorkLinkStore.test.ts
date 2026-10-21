import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
const issuesId = WorkSourceId.make("0b1c2d3e-4f50-4617-8899-aabbccddeeff");
const unknownId = WorkSourceId.make("9f8e7d6c-5b4a-4392-8171-605f4e3d2c1b");
const itemA = WorkItemId.make("fd-aaaaaa");
const itemB = WorkItemId.make("fd-bbbbbb");
const issue7 = WorkItemId.make("7");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");
const thread3 = ThreadId.make("thread-3");

const snapshot = (key: string) => ({
  key,
  title: `Item ${key}`,
  status: "todo" as const,
  url: null,
  revision: "r1",
  autoStarted: false,
});

/** Two sources in different projects, so project-scoped listing has something to exclude. */
const seedSources = Effect.gen(function* () {
  const store = yield* WorkSourceStore.WorkSourceStore;
  yield* store.insertOrRevive({
    sourceId: tasksId,
    projectId: alpha,
    kind: "markdown",
    identity: "work/tasks",
    label: "Tasks",
    config: { kind: "markdown", directory: "work/tasks", autoStart: true },
    secretName: null,
  });
  yield* store.insertOrRevive({
    sourceId: issuesId,
    projectId: beta,
    kind: "github",
    identity: "github.com/acme/app",
    label: "Issues",
    config: { kind: "github", host: "github.com", owner: "acme", name: "app" },
    secretName: "token-a",
  });
});

describe("WorkLinkStore", () => {
  it.effect("links once per key and returns the stored link on a repeat", () =>
    Effect.gen(function* () {
      yield* seedSources;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const input = {
        sourceId: tasksId,
        itemId: itemA,
        threadId: thread1,
        source: "started" as const,
        snapshot: { ...snapshot("fd-aaaaaa"), mode: "implement" as const, autoStarted: true },
      };

      const first = yield* links.link(input);
      assert.isTrue(first.inserted);
      assert.deepStrictEqual(first.link, {
        sourceId: tasksId,
        itemId: itemA,
        threadId: thread1,
        source: "started",
        snapshot: input.snapshot,
        run: null,
        linkedAt: first.link.linkedAt,
      });

      yield* TestClock.adjust("1 minute");
      const repeat = yield* links.link({
        ...input,
        source: "manual",
        snapshot: snapshot("changed"),
      });
      assert.isFalse(repeat.inserted);
      assert.deepStrictEqual(repeat.link, first.link);
      assert.deepStrictEqual(yield* links.listByThread(thread1), [first.link]);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("refuses a link for a source that does not exist", () =>
    Effect.gen(function* () {
      yield* seedSources;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const error = yield* links
        .link({
          sourceId: unknownId,
          itemId: itemA,
          threadId: thread1,
          source: "agent",
          snapshot: snapshot("fd-aaaaaa"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkStoreError");
      assert.strictEqual(error.operation, "link");
      assert.deepStrictEqual(yield* links.listByThread(thread1), []);
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("lists by thread, item and project, newest first", () =>
    Effect.gen(function* () {
      yield* seedSources;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const { link: a1 } = yield* links.link({
        sourceId: tasksId,
        itemId: itemA,
        threadId: thread1,
        source: "started",
        snapshot: snapshot("fd-aaaaaa"),
      });
      yield* TestClock.adjust("1 minute");
      const { link: b1 } = yield* links.link({
        sourceId: tasksId,
        itemId: itemB,
        threadId: thread1,
        source: "manual",
        snapshot: snapshot("fd-bbbbbb"),
      });
      yield* TestClock.adjust("1 minute");
      const { link: a2 } = yield* links.link({
        sourceId: tasksId,
        itemId: itemA,
        threadId: thread2,
        source: "agent",
        snapshot: snapshot("fd-aaaaaa"),
      });
      yield* TestClock.adjust("1 minute");
      const { link: i7 } = yield* links.link({
        sourceId: issuesId,
        itemId: issue7,
        threadId: thread3,
        source: "started",
        snapshot: snapshot("#7"),
      });

      assert.deepStrictEqual(yield* links.listByThread(thread1), [b1, a1]);
      assert.deepStrictEqual(yield* links.listByThread(thread3), [i7]);
      assert.deepStrictEqual(yield* links.listByItem(tasksId, itemA), [a2, a1]);
      assert.deepStrictEqual(yield* links.listByItem(issuesId, itemA), []);
      assert.deepStrictEqual(yield* links.listByProject(alpha), [a2, b1, a1]);
      assert.deepStrictEqual(yield* links.listByProject(beta), [i7]);

      assert.deepStrictEqual(yield* links.listAll(10), {
        links: [i7, a2, b1, a1],
        truncated: false,
      });
      assert.deepStrictEqual(yield* links.listAll(4), {
        links: [i7, a2, b1, a1],
        truncated: false,
      });
      assert.deepStrictEqual(yield* links.listAll(2), { links: [i7, a2], truncated: true });
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("unlinks one key, a whole thread, or a whole source", () =>
    Effect.gen(function* () {
      yield* seedSources;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const base = { sourceId: tasksId, source: "manual" as const };
      yield* links.link({ ...base, itemId: itemA, threadId: thread1, snapshot: snapshot("a") });
      yield* links.link({ ...base, itemId: itemB, threadId: thread1, snapshot: snapshot("b") });
      yield* links.link({ ...base, itemId: itemA, threadId: thread2, snapshot: snapshot("a") });
      const issueLink = {
        sourceId: issuesId,
        itemId: issue7,
        threadId: thread1,
        source: "started" as const,
        snapshot: snapshot("#7"),
      };
      yield* links.link(issueLink);

      assert.isTrue(yield* links.unlink(tasksId, itemA, thread1));
      assert.isFalse(yield* links.unlink(tasksId, itemA, thread1));
      assert.lengthOf(yield* links.listByThread(thread1), 2);

      // The thread's links across both sources go; thread2's stay.
      assert.strictEqual(yield* links.unlinkThread(thread1), 2);
      assert.strictEqual(yield* links.unlinkThread(thread1), 0);
      assert.deepStrictEqual(yield* links.listByThread(thread1), []);
      assert.lengthOf(yield* links.listByThread(thread2), 1);

      const { link: relinked } = yield* links.link(issueLink);
      assert.strictEqual(yield* links.deleteBySource(tasksId), 1);
      assert.strictEqual(yield* links.deleteBySource(tasksId), 0);
      assert.deepStrictEqual(yield* links.listAll(10), { links: [relinked], truncated: false });
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("round-trips snapshot and run updates", () =>
    Effect.gen(function* () {
      yield* seedSources;
      const links = yield* WorkLinkStore.WorkLinkStore;
      const { link } = yield* links.link({
        sourceId: tasksId,
        itemId: itemA,
        threadId: thread1,
        source: "started",
        snapshot: snapshot("fd-aaaaaa"),
      });

      const moved = {
        ...snapshot("fd-aaaaaa"),
        status: "in_progress" as const,
        url: "https://example.test/fd-aaaaaa",
        revision: "r2",
        mode: "plan" as const,
        autoStarted: true,
      };
      yield* links.updateSnapshot(tasksId, itemA, thread1, moved);
      const run = { status: "failed", at: "2026-10-21T10:00:00.000Z" };
      yield* links.updateRun(tasksId, itemA, thread1, run);
      assert.deepStrictEqual(yield* links.listByItem(tasksId, itemA), [
        { ...link, snapshot: moved, run },
      ]);

      yield* links.updateRun(tasksId, itemA, thread1, null);
      assert.deepStrictEqual(yield* links.listByItem(tasksId, itemA), [
        { ...link, snapshot: moved, run: null },
      ]);

      // An unknown key changes nothing.
      yield* links.updateRun(tasksId, itemB, thread1, run);
      assert.deepStrictEqual(yield* links.listByThread(thread1), [
        { ...link, snapshot: moved, run: null },
      ]);
    }).pipe(Effect.provide(persistence)),
  );
});
