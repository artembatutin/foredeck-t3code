// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import {
  WorkItemId,
  type WorkListQuery,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { WorkActor } from "../../authority.ts";
import { MAX_TASK_DOCUMENT_BYTES, revisionOf } from "../../documents/taskDocument.ts";
import type { WorkSourceAdapter, WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import * as MarkdownSource from "./MarkdownSource.ts";

const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const actor: WorkActor = { id: "session:test", grants: [], label: "Artem" };
const EPOCH = "1970-01-01T00:00:00.000Z";
const id = (value: string) => WorkItemId.make(value);
const query = (overrides: Partial<WorkListQuery> = {}): WorkListQuery => ({
  sourceId,
  limit: 50,
  ...overrides,
});

const runtimeFor = (rootPath: string, directory: string): WorkSourceRuntime => ({
  sourceId,
  projectId: ProjectId.make("project-1"),
  kind: "markdown",
  identity: directory,
  config: { kind: "markdown", directory, autoStart: true },
  rootPath,
  secret: undefined,
  interactive: true,
});

/** A prepared `work` source in a fresh temp project, with a fixture writer. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "work-markdown-" });
  // Every path the adapter reads or checks for a link, so a test can prove what it opened.
  const reads: Array<string> = [];
  const links: Array<string> = [];
  const adapter = yield* MarkdownSource.make.pipe(
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      readFile: (filePath) => {
        reads.push(filePath);
        return fs.readFile(filePath);
      },
      readLink: (filePath) => {
        links.push(filePath);
        return fs.readLink(filePath);
      },
    }),
  );
  const runtime = runtimeFor(root, "work");
  yield* adapter.prepare(runtime);
  const directory = path.join(root, "work");
  const writeTask = (filename: string, rows: ReadonlyArray<string>, body = "") =>
    fs.writeFileString(path.join(directory, filename), `---\n${rows.join("\n")}\n---\n${body}`);
  const readTask = (filename: string) => fs.readFileString(path.join(directory, filename));
  const listDirectory = Effect.map(fs.readDirectory(directory), (names) => names.toSorted());
  return {
    fs,
    path,
    root,
    directory,
    adapter,
    runtime,
    reads,
    links,
    writeTask,
    readTask,
    listDirectory,
  };
});

const ROWS = ["id: fd-aaaaaa", "title: Alpha", "status: todo"];
const alphaRef = { sourceId, itemId: id("fd-aaaaaa") };

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

const watching = (adapter: WorkSourceAdapter, runtime: WorkSourceRuntime) => {
  if (adapter.watch === undefined)
    return assert.fail("The Markdown adapter watches its directory.");
  return adapter.watch(runtime);
};

describe("MarkdownSource", () => {
  it.effect("validates a directory without creating it and prepares it on save", () =>
    Effect.gen(function* () {
      const { fs, path, root, adapter } = yield* setup;
      const test = (directory: string) =>
        adapter.test({
          config: { kind: "markdown", directory, autoStart: true },
          rootPath: root,
          secret: undefined,
        });
      assert.deepStrictEqual(yield* test("work/tasks"), { identity: "work/tasks" });
      assert.isFalse(yield* fs.exists(path.join(root, "work", "tasks")));

      const rejected = yield* failure(test(".git"));
      assert.strictEqual(rejected._tag, "WorkInvalid");
      assert.strictEqual(rejected.message, "Choose a directory outside Git metadata.");
      const foreign = yield* failure(
        adapter.test({
          config: { kind: "github", host: "github.com", owner: "o", name: "n" },
          rootPath: root,
          secret: undefined,
        }),
      );
      assert.strictEqual(foreign._tag, "WorkInvalid");
      assert.strictEqual(
        adapter.identity({ kind: "markdown", directory: "work", autoStart: true }),
        "work",
      );

      const nested = runtimeFor(root, "work/tasks");
      yield* adapter.prepare(nested);
      assert.isTrue(yield* fs.exists(path.join(root, "work", "tasks")));
      assert.deepStrictEqual(yield* adapter.list(nested, query()), {
        items: [],
        nextCursor: null,
        stale: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates an item atomically and reads it back", () =>
    Effect.gen(function* () {
      const { adapter, runtime, readTask, listDirectory } = yield* setup;
      const created = yield* adapter.create(
        runtime,
        {
          sourceId,
          title: "Add reconnect handling",
          body: "Keep the selected source.\n",
          priority: "high",
          labels: ["work", " sync "],
          assignee: "Jane",
        },
        actor,
      );
      assert.match(created.ref.itemId, /^fd-[0-9a-hjkmnp-tv-z]{6}$/);
      assert.deepStrictEqual(created, {
        ref: { sourceId, itemId: created.ref.itemId },
        kind: "markdown",
        key: created.ref.itemId,
        title: "Add reconnect handling",
        status: "todo",
        nativeStatus: null,
        blocked: false,
        priority: "high",
        labels: ["work", "sync"],
        assignee: { id: "Jane", label: "Jane" },
        parent: null,
        blockedBy: [],
        url: null,
        updatedAt: EPOCH,
        revision: created.revision,
        invalid: null,
      });

      const filename = `${created.ref.itemId}-add-reconnect-handling.md`;
      assert.deepStrictEqual(yield* listDirectory, [filename]);
      assert.strictEqual(
        yield* readTask(filename),
        [
          "---",
          `id: ${created.ref.itemId}`,
          "title: Add reconnect handling",
          "status: todo",
          "priority: high",
          "labels: work, sync",
          "assignee: Jane",
          `created: "${EPOCH}"`,
          `updated: "${EPOCH}"`,
          "---",
          "Keep the selected source.",
          "",
        ].join("\n"),
      );

      const detail = yield* adapter.get(runtime, created.ref.itemId);
      assert.deepStrictEqual(detail, {
        ...created,
        body: "Keep the selected source.\n",
        bodyTruncated: false,
        bodyFidelity: "exact",
        comments: [],
        commentsTruncated: false,
        children: [],
        blocking: [],
        transitions: [],
        locator: `work/${filename}`,
      });
      assert.deepStrictEqual(
        yield* adapter.snapshots(runtime, [created.ref.itemId, id("fd-zzzzzz")]),
        [created],
      );
      const missing = yield* failure(adapter.get(runtime, id("fd-zzzzzz")));
      assert.strictEqual(missing._tag, "WorkItemNotFound");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists, filters, searches, sorts and paginates the directory", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime, writeTask } = yield* setup;
      yield* writeTask(
        "fd-aaaaaa-alpha.md",
        [
          "id: fd-aaaaaa",
          "title: Alpha",
          "status: todo",
          "labels: work, sync",
          "updated: 2026-01-03",
        ],
        "Reconnect logic\n",
      );
      yield* writeTask("fd-bbbbbb.md", [
        "id: fd-bbbbbb",
        "title: Beta",
        "status: in_progress",
        "labels: work",
        "updated: 2026-01-05T10:00:00Z",
      ]);
      yield* writeTask(
        "fd-cccccc.md",
        ["id: fd-cccccc", "title: Gamma", "status: done"],
        "This body mentions SYNC.\n",
      );
      yield* writeTask("fd-dddddd.md", [
        "id: fd-dddddd",
        "title: Delta",
        "status: todo",
        "labels: jira",
        "updated: 2026-01-01",
      ]);
      // Never indexed: dotfiles, editor artefacts, non-Markdown files and subdirectories.
      yield* writeTask(".hidden.md", ["id: fd-eeeeee", "title: Hidden", "status: todo"]);
      yield* writeTask("draft.md.tmp", ["id: fd-ffffff", "title: Temp", "status: todo"]);
      yield* writeTask("notes.txt", ["id: fd-gggggg", "title: Text", "status: todo"]);
      yield* fs.makeDirectory(path.join(directory, "sub"));
      yield* writeTask("sub/fd-hhhhhh.md", ["id: fd-hhhhhh", "title: Nested", "status: todo"]);
      yield* fs.makeDirectory(path.join(directory, "folder.md"));

      const ids = (items: ReadonlyArray<{ readonly ref: { readonly itemId: string } }>) =>
        items.map((item) => item.ref.itemId);
      const all = yield* adapter.list(runtime, query());
      assert.deepStrictEqual(ids(all.items), ["fd-bbbbbb", "fd-aaaaaa", "fd-dddddd", "fd-cccccc"]);
      assert.deepStrictEqual(
        all.items.map((item) => item.updatedAt),
        ["2026-01-05T10:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null],
      );
      assert.isNull(all.nextCursor);
      assert.isFalse(all.stale);

      const todo = yield* adapter.list(runtime, query({ statuses: ["todo"] }));
      assert.deepStrictEqual(ids(todo.items), ["fd-aaaaaa", "fd-dddddd"]);
      const labelled = yield* adapter.list(runtime, query({ labels: ["work", "sync"] }));
      assert.deepStrictEqual(ids(labelled.items), ["fd-aaaaaa"]);
      const searched = yield* adapter.list(runtime, query({ search: "sync" }));
      assert.deepStrictEqual(ids(searched.items), ["fd-aaaaaa", "fd-cccccc"]);
      const titled = yield* adapter.list(runtime, query({ search: "BETA" }));
      assert.deepStrictEqual(ids(titled.items), ["fd-bbbbbb"]);
      const mine = yield* adapter.list(runtime, query({ assignee: "me" }));
      assert.deepStrictEqual(mine.items, []);

      const first = yield* adapter.list(runtime, query({ limit: 2 }));
      assert.deepStrictEqual(ids(first.items), ["fd-bbbbbb", "fd-aaaaaa"]);
      assert.strictEqual(first.nextCursor, "2");
      const second = yield* adapter.list(runtime, query({ limit: 2, cursor: "2" }));
      assert.deepStrictEqual(ids(second.items), ["fd-dddddd", "fd-cccccc"]);
      assert.isNull(second.nextCursor);
      const beyond = yield* adapter.list(runtime, query({ cursor: "9" }));
      assert.deepStrictEqual(beyond.items, []);
      const invalid = yield* failure(adapter.list(runtime, query({ cursor: "two" })));
      assert.strictEqual(invalid._tag, "WorkInvalid");

      // Only `.md` files were indexed, and the listing never touched the directory.
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(directory, "sub")), [
        "fd-hhhhhh.md",
      ]);
      const hidden = yield* failure(adapter.get(runtime, id("fd-eeeeee")));
      assert.strictEqual(hidden._tag, "WorkItemNotFound");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("derives blocked from open blockers and relates parents and children", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask } = yield* setup;
      yield* writeTask("fd-aaaaaa.md", [
        "id: fd-aaaaaa",
        "title: Alpha",
        "status: todo",
        "blocked_by: fd-bbbbbb, fd-cccccc, fd-zzzzzz",
        "parent: fd-dddddd",
      ]);
      yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "title: Beta", "status: in_progress"]);
      yield* writeTask("fd-cccccc.md", ["id: fd-cccccc", "title: Gamma", "status: cancelled"]);
      yield* writeTask("fd-dddddd.md", [
        "id: fd-dddddd",
        "title: Delta",
        "status: todo",
        "blocked_by: fd-zzzzzz",
      ]);

      const alpha = yield* adapter.get(runtime, id("fd-aaaaaa"));
      assert.isTrue(alpha.blocked);
      assert.deepStrictEqual(alpha.blockedBy, [id("fd-bbbbbb"), id("fd-cccccc"), id("fd-zzzzzz")]);
      assert.strictEqual(alpha.parent, "fd-dddddd");
      const delta = yield* adapter.get(runtime, id("fd-dddddd"));
      assert.isFalse(delta.blocked);
      assert.deepStrictEqual(delta.children, [
        { itemId: id("fd-aaaaaa"), key: "fd-aaaaaa", title: "Alpha", status: "todo" },
      ]);
      const beta = yield* adapter.get(runtime, id("fd-bbbbbb"));
      assert.deepStrictEqual(beta.blocking, [id("fd-aaaaaa")]);

      yield* adapter.setStatus(
        runtime,
        { ref: { sourceId, itemId: id("fd-bbbbbb") }, status: "done" },
        actor,
      );
      assert.isFalse((yield* adapter.get(runtime, id("fd-aaaaaa"))).blocked);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists unreadable and duplicated files read-only with the reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask, fs, path, directory } = yield* setup;
      yield* writeTask("alpha-1.md", ["id: fd-aaaaaa", "title: First", "status: todo"]);
      yield* writeTask("alpha-2.md", ["id: fd-aaaaaa", "title: Second", "status: done"]);
      yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "status: todo"]);
      yield* writeTask("fd-cccccc.md", ["id: fd-cccccc", "title: Shipped", "status: shipped"]);
      yield* fs.writeFileString(path.join(directory, "README.md"), "# Work\n");

      const listed = yield* adapter.list(runtime, query());
      const byKey = new Map(listed.items.map((item) => [item.key, item]));
      assert.deepStrictEqual(
        listed.items.map((item) => [item.key, item.title, item.status, item.invalid?.code ?? null]),
        [
          ["README", "README", "unknown", "missing_frontmatter"],
          ["fd-aaaaaa", "First", "todo", "duplicate_id"],
          ["fd-aaaaaa", "Second", "done", "duplicate_id"],
          ["fd-bbbbbb", "fd-bbbbbb", "unknown", "missing_field"],
          ["fd-cccccc", "Shipped", "unknown", "unknown_status"],
        ],
      );
      assert.match(byKey.get("fd-bbbbbb")?.invalid?.message ?? "", /`title` is missing/);

      for (const itemId of ["fd-aaaaaa", "fd-bbbbbb", "fd-cccccc", "README"]) {
        const refusal = yield* failure(
          adapter.update(runtime, { ref: { sourceId, itemId: id(itemId) }, title: "Other" }, actor),
        );
        assert.strictEqual(refusal._tag, "WorkUnsupported", itemId);
        const commented = yield* failure(adapter.comment(runtime, id(itemId), "Hi", actor));
        assert.strictEqual(commented._tag, "WorkUnsupported", itemId);
      }
      assert.strictEqual(
        yield* readTask("alpha-1.md"),
        "---\nid: fd-aaaaaa\ntitle: First\nstatus: todo\n---\n",
      );
      const duplicate = yield* adapter.get(runtime, id("FD-AAAAAA"));
      assert.strictEqual(duplicate.title, "First");
      assert.strictEqual(duplicate.invalid?.code, "duplicate_id");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a stale revision with the current item and leaves the file alone", () =>
    Effect.gen(function* () {
      const { adapter, runtime, readTask } = yield* setup;
      const created = yield* adapter.create(runtime, { sourceId, title: "Alpha" }, actor);
      const filename = `${created.ref.itemId}-alpha.md`;
      const before = yield* readTask(filename);
      const stale = yield* failure(
        adapter.update(
          runtime,
          { ref: created.ref, expectedRevision: "sha256:0", title: "Renamed" },
          actor,
        ),
      );
      assert.strictEqual(stale._tag, "WorkStale");
      if (stale._tag === "WorkStale") assert.deepStrictEqual(stale.current, created);
      assert.strictEqual(yield* readTask(filename), before);

      const renamed = yield* adapter.update(
        runtime,
        { ref: created.ref, expectedRevision: created.revision, title: "Renamed" },
        actor,
      );
      assert.strictEqual(renamed.title, "Renamed");
      assert.notStrictEqual(renamed.revision, created.revision);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("patches fields in place, merges labels and bumps updated on every write", () =>
    Effect.gen(function* () {
      const { adapter, runtime, readTask, listDirectory } = yield* setup;
      const other = yield* adapter.create(runtime, { sourceId, title: "Other" }, actor);
      const created = yield* adapter.create(
        runtime,
        { sourceId, title: "Alpha", labels: ["a", "b"], body: "Body\n" },
        actor,
      );
      const filename = `${created.ref.itemId}-alpha.md`;

      yield* TestClock.adjust("1 minute");
      const updated = yield* adapter.update(
        runtime,
        {
          ref: created.ref,
          title: "Alpha prime",
          priority: "low",
          labels: { add: ["c", "a"], remove: ["a"] },
          assignee: "Sam",
          parent: other.ref.itemId,
          blockedBy: [other.ref.itemId, other.ref.itemId],
        },
        actor,
      );
      assert.deepStrictEqual(updated, {
        ...created,
        title: "Alpha prime",
        priority: "low",
        labels: ["b", "c", "a"],
        assignee: { id: "Sam", label: "Sam" },
        parent: other.ref.itemId,
        blockedBy: [other.ref.itemId],
        blocked: true,
        updatedAt: "1970-01-01T00:01:00.000Z",
        revision: updated.revision,
      });
      assert.strictEqual(
        yield* readTask(filename),
        [
          "---",
          `id: ${created.ref.itemId}`,
          "title: Alpha prime",
          "status: todo",
          "labels: b, c, a",
          `created: "${EPOCH}"`,
          'updated: "1970-01-01T00:01:00.000Z"',
          "priority: low",
          "assignee: Sam",
          `parent: ${other.ref.itemId}`,
          `blocked_by: ${other.ref.itemId}`,
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      yield* TestClock.adjust("1 minute");
      const cleared = yield* adapter.update(
        runtime,
        {
          ref: created.ref,
          priority: null,
          assignee: null,
          parent: null,
          blockedBy: [],
          labels: { add: [], remove: ["b", "c", "a"] },
          body: "Body\n\nMore.\n",
        },
        actor,
      );
      assert.deepStrictEqual(cleared, {
        ...created,
        title: "Alpha prime",
        labels: [],
        updatedAt: "1970-01-01T00:02:00.000Z",
        revision: cleared.revision,
      });
      assert.strictEqual(
        yield* readTask(filename),
        [
          "---",
          `id: ${created.ref.itemId}`,
          "title: Alpha prime",
          "status: todo",
          `created: "${EPOCH}"`,
          'updated: "1970-01-01T00:02:00.000Z"',
          "---",
          "Body",
          "",
          "More.",
          "",
        ].join("\n"),
      );

      yield* TestClock.adjust("1 minute");
      const done = yield* adapter.setStatus(runtime, { ref: created.ref, status: "done" }, actor);
      assert.strictEqual(done.status, "done");
      assert.strictEqual(done.updatedAt, "1970-01-01T00:03:00.000Z");
      const transition = yield* failure(
        adapter.setStatus(runtime, { ref: created.ref, transitionId: "31" }, actor),
      );
      assert.strictEqual(transition._tag, "WorkUnsupported");

      for (const patch of [
        { labels: { add: ["a,b"], remove: [] } },
        { parent: created.ref.itemId },
        { blockedBy: [created.ref.itemId] },
        { parent: id("PROJ-12") },
        { title: "Two\nlines" },
      ]) {
        const refusal = yield* failure(
          adapter.update(runtime, { ref: created.ref, ...patch }, actor),
        );
        assert.strictEqual(refusal._tag, "WorkInvalid", JSON.stringify(patch));
      }
      // Atomic writes leave nothing but the task files behind.
      assert.deepStrictEqual(
        yield* listDirectory,
        [`${other.ref.itemId}-other.md`, filename].toSorted(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("appends comments under a Notes heading and reads them back", () =>
    Effect.gen(function* () {
      const { adapter, runtime, readTask } = yield* setup;
      const created = yield* adapter.create(
        runtime,
        { sourceId, title: "Alpha", body: "Intro\n" },
        actor,
      );
      assert.deepStrictEqual(
        yield* adapter.comment(runtime, created.ref.itemId, "First note", actor),
        {
          commentId: "1",
        },
      );
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(
        yield* adapter.comment(runtime, created.ref.itemId, "Second\nline", {
          ...actor,
          id: "thread:t1",
          label: "Worker",
        }),
        { commentId: "2" },
      );
      const detail = yield* adapter.get(runtime, created.ref.itemId);
      assert.deepStrictEqual(detail.comments, [
        {
          id: "1",
          author: { id: "Artem", label: "Artem" },
          body: "First note",
          createdAt: EPOCH,
          updatedAt: null,
        },
        {
          id: "2",
          author: { id: "Worker", label: "Worker" },
          body: "Second line",
          createdAt: "1970-01-01T00:01:00.000Z",
          updatedAt: null,
        },
      ]);
      assert.strictEqual(detail.updatedAt, "1970-01-01T00:01:00.000Z");
      assert.strictEqual(
        detail.body,
        `Intro\n\n## Notes\n- ${EPOCH} (Artem) First note\n- 1970-01-01T00:01:00.000Z (Worker) Second line\n`,
      );
      assert.isTrue((yield* readTask(`${created.ref.itemId}-alpha.md`)).endsWith(detail.body));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists symbolic links read-only and never reads or writes through them", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime, reads, writeTask } = yield* setup;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "work-outside-" });
      const secret = path.join(outside, "secret.md");
      const secretText = "---\nid: fd-bbbbbb\ntitle: Secret\nstatus: todo\n---\nTOP SECRET\n";
      yield* fs.writeFileString(secret, secretText);
      const link = path.join(directory, "fd-bbbbbb.md");
      yield* fs.symlink(secret, link);
      yield* fs.symlink(path.join(outside, "missing.md"), path.join(directory, "fd-cccccc.md"));
      yield* writeTask("fd-aaaaaa.md", ROWS);

      const listed = yield* adapter.list(runtime, query());
      assert.deepStrictEqual(
        listed.items.map((item) => [item.key, item.title, item.status, item.invalid?.code ?? null]),
        [
          ["fd-aaaaaa", "Alpha", "todo", null],
          ["fd-bbbbbb", "fd-bbbbbb", "unknown", "symlink"],
          ["fd-cccccc", "fd-cccccc", "unknown", "symlink"],
        ],
      );
      const detail = yield* adapter.get(runtime, id("fd-bbbbbb"));
      assert.strictEqual(detail.body, "");
      assert.strictEqual(detail.invalid?.code, "symlink");
      const refusal = yield* failure(
        adapter.update(
          runtime,
          { ref: { sourceId, itemId: id("fd-bbbbbb") }, title: "Leak" },
          actor,
        ),
      );
      assert.strictEqual(refusal._tag, "WorkUnsupported");
      const commented = yield* failure(adapter.comment(runtime, id("fd-bbbbbb"), "Hi", actor));
      assert.strictEqual(commented._tag, "WorkUnsupported");
      assert.strictEqual(yield* fs.readFileString(secret), secretText);
      assert.strictEqual(yield* fs.readLink(link), secret);
      // Paths are recorded resolved, so only the names say which files were opened.
      assert.deepStrictEqual(
        [...new Set(reads.map((filePath) => path.basename(filePath)))],
        ["fd-aaaaaa.md"],
      );

      // A link replaced by a regular file is an ordinary item again.
      yield* fs.remove(link);
      yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "title: Beta", "status: todo"]);
      const beta = yield* adapter.get(runtime, id("fd-bbbbbb"));
      assert.strictEqual(beta.title, "Beta");
      assert.isNull(beta.invalid);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Root reads any file, so permission bits cannot make one unreadable.
  it.effect.skipIf(process.getuid?.() === 0)(
    "lists an unreadable file read-only and keeps the rest of the directory available",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, adapter, runtime, writeTask } = yield* setup;
        yield* writeTask("fd-aaaaaa.md", ROWS);
        yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "title: Beta", "status: todo"]);
        const locked = path.join(directory, "fd-bbbbbb.md");
        yield* fs.chmod(locked, 0o000);

        const listed = yield* adapter.list(runtime, query());
        assert.deepStrictEqual(
          listed.items.map((item) => [item.key, item.title, item.invalid?.code ?? null]),
          [
            ["fd-aaaaaa", "Alpha", null],
            ["fd-bbbbbb", "fd-bbbbbb", "unreadable"],
          ],
        );
        const refusal = yield* failure(
          adapter.update(
            runtime,
            { ref: { sourceId, itemId: id("fd-bbbbbb") }, title: "Other" },
            actor,
          ),
        );
        assert.strictEqual(refusal._tag, "WorkUnsupported");

        // A permission fix leaves size, mtime and inode alone and still shows up at once.
        yield* fs.chmod(locked, 0o644);
        const beta = yield* adapter.get(runtime, id("fd-bbbbbb"));
        assert.strictEqual(beta.title, "Beta");
        assert.isNull(beta.invalid);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps a BOM and CRLF file byte-exact through edits so its revision stays current",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, adapter, runtime } = yield* setup;
        const filePath = path.join(directory, "fd-aaaaaa.md");
        const encoder = new TextEncoder();
        const header = "﻿---\r\nid: fd-aaaaaa\r\n";
        yield* fs.writeFile(
          filePath,
          encoder.encode(`${header}title: Alpha\r\nstatus: todo\r\n---\r\nBody\r\n`),
        );
        const alpha = yield* adapter.get(runtime, alphaRef.itemId);
        assert.strictEqual(alpha.revision, revisionOf(yield* fs.readFile(filePath)));

        const renamed = yield* adapter.update(
          runtime,
          { ref: alphaRef, expectedRevision: alpha.revision, title: "Renamed" },
          actor,
        );
        const onDisk = yield* fs.readFile(filePath);
        assert.deepStrictEqual(
          onDisk,
          encoder.encode(
            `${header}title: Renamed\r\nstatus: todo\r\nupdated: "${EPOCH}"\r\n---\r\nBody\r\n`,
          ),
        );
        assert.strictEqual(renamed.revision, revisionOf(onDisk));

        const again = yield* adapter.update(
          runtime,
          { ref: alphaRef, expectedRevision: renamed.revision, priority: "high" },
          actor,
        );
        assert.strictEqual(again.priority, "high");
        assert.strictEqual(again.revision, revisionOf(yield* fs.readFile(filePath)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps oversized notes on read and refuses a comment that would not fit", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask } = yield* setup;
      const huge = "n".repeat(17_000);
      yield* writeTask("fd-aaaaaa.md", ROWS, `## Notes\n- ${EPOCH} (Artem) ${huge}\n`);
      const detail = yield* adapter.get(runtime, alphaRef.itemId);
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.body),
        ["n".repeat(16_000)],
      );
      const refusal = yield* failure(
        adapter.comment(runtime, alphaRef.itemId, "x".repeat(16_001), actor),
      );
      assert.strictEqual(refusal._tag, "WorkInvalid");
      assert.isTrue((yield* readTask("fd-aaaaaa.md")).endsWith(`${huge}\n`));
      // The cap is on the text alone: a maximal comment is written and read back whole.
      const fitting = "y".repeat(16_000);
      assert.deepStrictEqual(yield* adapter.comment(runtime, alphaRef.itemId, fitting, actor), {
        commentId: "2",
      });
      const after = yield* adapter.get(runtime, alphaRef.itemId);
      assert.strictEqual(after.comments[1]?.body, fitting);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes into blank optional keys instead of refusing the edit", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask } = yield* setup;
      yield* writeTask("fd-aaaaaa.md", [...ROWS, "updated:", "assignee: "]);
      const done = yield* adapter.setStatus(runtime, { ref: alphaRef, status: "done" }, actor);
      assert.strictEqual(done.updatedAt, EPOCH);
      const assigned = yield* adapter.update(runtime, { ref: alphaRef, assignee: "Sam" }, actor);
      assert.deepStrictEqual(assigned.assignee, { id: "Sam", label: "Sam" });
      assert.strictEqual(
        yield* readTask("fd-aaaaaa.md"),
        [
          "---",
          "id: fd-aaaaaa",
          "title: Alpha",
          "status: done",
          `updated: "${EPOCH}"`,
          "assignee: Sam",
          "---",
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists an oversized file read-only without reading it", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime, reads } = yield* setup;
      const filePath = path.join(directory, "fd-aaaaaa.md");
      yield* fs.writeFile(filePath, new Uint8Array(MAX_TASK_DOCUMENT_BYTES + 1));
      const [item] = (yield* adapter.list(runtime, query())).items;
      assert.strictEqual(item?.key, "fd-aaaaaa");
      assert.strictEqual(item?.invalid?.code, "too_large");
      assert.deepStrictEqual(reads, []);
      // Trimmed below the cap, it is read like any other file.
      yield* fs.writeFileString(filePath, `---\n${ROWS.join("\n")}\n---\n`);
      assert.strictEqual((yield* adapter.get(runtime, alphaRef.itemId)).title, "Alpha");
      assert.deepStrictEqual(
        reads.map((read) => path.basename(read)),
        ["fd-aaaaaa.md"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges labels against the file's whole list and refuses more than the cap", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask } = yield* setup;
      const labels = Array.from({ length: 40 }, (_, index) => `l${index}`);
      yield* writeTask("fd-aaaaaa.md", [...ROWS, `labels: ${labels.join(", ")}`]);
      const before = yield* readTask("fd-aaaaaa.md");
      assert.strictEqual((yield* adapter.get(runtime, alphaRef.itemId)).labels.length, 32);

      const refusal = yield* failure(
        adapter.update(runtime, { ref: alphaRef, labels: { add: [], remove: ["l0"] } }, actor),
      );
      assert.strictEqual(refusal._tag, "WorkInvalid");
      assert.match(refusal.message, /at most 32 labels/);
      assert.strictEqual(yield* readTask("fd-aaaaaa.md"), before);

      const trimmed = yield* adapter.update(
        runtime,
        { ref: alphaRef, labels: { add: ["new"], remove: labels.slice(0, 9) } },
        actor,
      );
      const expected = [...labels.slice(9), "new"];
      assert.deepStrictEqual(trimmed.labels, expected);
      assert.include(yield* readTask("fd-aaaaaa.md"), `labels: ${expected.join(", ")}\n`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "serves a body cut at the wire cap on a code point boundary, with its notes intact",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime, writeTask, readTask } = yield* setup;
        const tail = `😀${"b".repeat(5_000)}`;
        const body = `${"a".repeat(65_535)}${tail}\n\n## Notes\n- ${EPOCH} (Artem) Late\n`;
        yield* writeTask("fd-aaaaaa.md", ROWS, body);
        const detail = yield* adapter.get(runtime, alphaRef.itemId);
        assert.strictEqual(detail.body, "a".repeat(65_535));
        assert.isTrue(detail.bodyTruncated);
        assert.deepStrictEqual(
          detail.comments.map((comment) => comment.body),
          ["Late"],
        );
        // A comment appends to the whole file, never to the served body.
        yield* adapter.comment(runtime, alphaRef.itemId, "Later", actor);
        const after = yield* adapter.get(runtime, alphaRef.itemId);
        assert.deepStrictEqual(
          after.comments.map((comment) => comment.body),
          ["Late", "Later"],
        );
        assert.include(yield* readTask("fd-aaaaaa.md"), tail);
        assert.strictEqual(
          (yield* adapter.list(runtime, query({ search: "alpha" }))).items.length,
          1,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists an undecodable file whose name is not an id under a stable hashed id", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime } = yield* setup;
      const filename = "task one.md";
      yield* fs.writeFile(path.join(directory, filename), new Uint8Array([0xff, 0xfe, 0x0a]));
      const [item] = (yield* adapter.list(runtime, query())).items;
      assert.strictEqual(item?.key, filename);
      assert.strictEqual(item?.title, "task one");
      assert.strictEqual(item?.invalid?.code, "invalid_utf8");
      const itemId = item?.ref.itemId ?? id("missing");
      assert.match(itemId, /^file-[0-9a-f]{12}$/);
      const detail = yield* adapter.get(runtime, itemId);
      assert.strictEqual(detail.locator, `work/${filename}`);
      const refusal = yield* failure(
        adapter.update(runtime, { ref: { sourceId, itemId }, title: "Other" }, actor),
      );
      assert.strictEqual(refusal._tag, "WorkUnsupported");
      const [again] = (yield* adapter.list(runtime, query())).items;
      assert.strictEqual(again?.ref.itemId, itemId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a body edit of an item whose body is longer than the served view", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask } = yield* setup;
      const tail = `😀${"b".repeat(5_000)}`;
      yield* writeTask(
        "fd-aaaaaa.md",
        ROWS,
        `${"a".repeat(65_535)}${tail}\n\n## Notes\n- ${EPOCH} (Artem) Late\n`,
      );
      const before = yield* readTask("fd-aaaaaa.md");
      const detail = yield* adapter.get(runtime, alphaRef.itemId);
      assert.isTrue(detail.bodyTruncated);
      const refusal = yield* failure(
        adapter.update(runtime, { ref: alphaRef, body: detail.body }, actor),
      );
      assert.strictEqual(refusal._tag, "WorkUnsupported");
      assert.strictEqual(yield* readTask("fd-aaaaaa.md"), before);
      // Everything but the body stays editable.
      const titled = yield* adapter.update(runtime, { ref: alphaRef, title: "Alpha prime" }, actor);
      assert.strictEqual(titled.title, "Alpha prime");
      assert.include(yield* readTask("fd-aaaaaa.md"), `${tail}\n\n## Notes\n`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("adds comments to a body whose code fence never closes", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask, readTask } = yield* setup;
      yield* writeTask("fd-aaaaaa.md", ROWS, "```\ncode\n");
      assert.deepStrictEqual(yield* adapter.comment(runtime, alphaRef.itemId, "First", actor), {
        commentId: "1",
      });
      assert.deepStrictEqual(yield* adapter.comment(runtime, alphaRef.itemId, "Second", actor), {
        commentId: "2",
      });
      const detail = yield* adapter.get(runtime, alphaRef.itemId);
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.body),
        ["First", "Second"],
      );
      assert.strictEqual(
        yield* readTask("fd-aaaaaa.md"),
        [
          "---",
          ...ROWS,
          `updated: "${EPOCH}"`,
          "---",
          "## Notes",
          `- ${EPOCH} (Artem) First`,
          `- ${EPOCH} (Artem) Second`,
          "",
          "```",
          "code",
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists a file under its stem id in any casing, yielding to a frontmatter id", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime, writeTask } = yield* setup;
      yield* fs.writeFile(path.join(directory, "FD-AAAAAA.md"), new Uint8Array([0xff, 0xfe, 0x0a]));
      const [stem] = (yield* adapter.list(runtime, query())).items;
      assert.strictEqual(stem?.key, "fd-aaaaaa");
      assert.strictEqual(stem?.ref.itemId, "fd-aaaaaa");
      const upper = yield* adapter.get(runtime, id("FD-AAAAAA"));
      assert.strictEqual(upper.invalid?.code, "invalid_utf8");

      // A file whose frontmatter claims the id owns it; the scratch file steps aside.
      yield* writeTask("fd-aaaaaa-real-task.md", ROWS);
      const listed = yield* adapter.list(runtime, query());
      assert.deepStrictEqual(
        listed.items.map((item) => [item.key, item.title, item.invalid?.code ?? null]),
        [
          ["fd-aaaaaa", "Alpha", null],
          ["FD-AAAAAA.md", "FD-AAAAAA", "invalid_utf8"],
        ],
      );
      const scratch = listed.items.find((item) => item.key === "FD-AAAAAA.md");
      assert.match(scratch?.ref.itemId ?? "", /^file-[0-9a-f]{12}$/);
      const healthy = yield* adapter.get(runtime, alphaRef.itemId);
      assert.strictEqual(healthy.locator, "work/fd-aaaaaa-real-task.md");
      assert.isNull(healthy.invalid);
      const renamed = yield* adapter.update(
        runtime,
        { ref: alphaRef, title: "Alpha prime" },
        actor,
      );
      assert.strictEqual(renamed.title, "Alpha prime");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes a note to someone when the actor has no usable label", () =>
    Effect.gen(function* () {
      const { adapter, runtime, writeTask } = yield* setup;
      yield* writeTask("fd-aaaaaa.md", ROWS);
      const nobody: WorkActor = { id: "", grants: [], label: " " };
      assert.deepStrictEqual(yield* adapter.comment(runtime, alphaRef.itemId, "Hi", nobody), {
        commentId: "1",
      });
      const detail = yield* adapter.get(runtime, alphaRef.itemId);
      assert.deepStrictEqual(
        detail.comments.map((comment) => [comment.author?.label, comment.body]),
        [["someone", "Hi"]],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks for links only when a file is first seen, changed or written", () =>
    Effect.gen(function* () {
      const { path, adapter, runtime, links, writeTask } = yield* setup;
      const names = () => links.map((link) => path.basename(link));
      yield* writeTask("fd-aaaaaa.md", ROWS);
      yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "title: Beta", "status: todo"]);
      yield* adapter.list(runtime, query());
      assert.deepStrictEqual(names().toSorted(), ["fd-aaaaaa.md", "fd-bbbbbb.md"]);

      links.length = 0;
      yield* adapter.list(runtime, query());
      yield* adapter.get(runtime, alphaRef.itemId);
      assert.deepStrictEqual(names(), []);

      yield* writeTask("fd-bbbbbb.md", ["id: fd-bbbbbb", "title: Beta prime", "status: todo"]);
      yield* adapter.list(runtime, query());
      assert.deepStrictEqual(names(), ["fd-bbbbbb.md"]);

      // A write looks again under its lock, whatever the index remembers.
      links.length = 0;
      yield* adapter.update(runtime, { ref: alphaRef, title: "Alpha prime" }, actor);
      assert.deepStrictEqual(names(), ["fd-aaaaaa.md"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts a Notes block with the file's line break when the body has none", () =>
    Effect.gen(function* () {
      const { fs, path, directory, adapter, runtime } = yield* setup;
      const filePath = path.join(directory, "fd-aaaaaa.md");
      yield* fs.writeFileString(filePath, `---\r\n${ROWS.join("\r\n")}\r\n---\r\n`);
      yield* adapter.comment(runtime, alphaRef.itemId, "Hi", actor);
      assert.strictEqual(
        yield* fs.readFileString(filePath),
        `---\r\n${ROWS.join("\r\n")}\r\nupdated: "${EPOCH}"\r\n---\r\n## Notes\r\n- ${EPOCH} (Artem) Hi\r\n`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends the watch stream quietly when the directory is missing", () =>
    Effect.gen(function* () {
      const { root, adapter } = yield* setup;
      const events = yield* Stream.runCollect(watching(adapter, runtimeFor(root, "work/missing")));
      assert.deepStrictEqual(events, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// Some sandboxes cannot start FSEvents, which `fs.watch` reports asynchronously as EMFILE
// shortly after attaching. A watcher still silent after the window is attached for real.
const watchSupported = await (async () => {
  const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "work-watch-probe-"));
  const watcher = NodeFS.watch(probe);
  try {
    return await new Promise<boolean>((resolve) => {
      watcher.once("error", () => resolve(false));
      AbortSignal.timeout(200).addEventListener("abort", () => resolve(true));
    });
  } finally {
    watcher.close();
    NodeFS.rmSync(probe, { recursive: true, force: true });
  }
})();

// A real filesystem event through the debounce needs the live clock.
describe("MarkdownSource watching", () => {
  it.live.skipIf(!watchSupported)("emits after the directory changes", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* setup;
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(watching(adapter, runtime), () => Queue.offer(seen, undefined)).pipe(
        Effect.forkScoped,
      );
      yield* adapter.create(runtime, { sourceId, title: "Alpha" }, actor);
      yield* Queue.take(seen).pipe(Effect.timeout("30 seconds"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
