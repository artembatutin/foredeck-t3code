import { assert, describe, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { WorkActor } from "./authority.ts";
import { WorkRateLimited, WorkUnauthenticated, type WorkDomainError } from "./errors.ts";
import * as WorkSourceStore from "./persistence/WorkSourceStore.ts";
import type { WorkSourceAdapter } from "./sources/WorkSourceAdapter.ts";
import {
  agent,
  at,
  fakeAdapter,
  jiraConfig,
  makeHarness,
  markdownConfig,
  owner,
  projectRow,
  reader,
  threadShell,
} from "./testkit/fakes.ts";
import * as WorkService from "./WorkService.ts";

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");

/** A harness with project alpha already known to the environment. */
const seeded = (...adapters: ReadonlyArray<WorkSourceAdapter>) => {
  const harness = makeHarness(adapters);
  harness.projects.set(alpha, projectRow(alpha, "/projects/alpha"));
  return harness;
};

const failureOf = <A>(effect: Effect.Effect<A, WorkDomainError>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error._tag === "WorkPermissionDenied" ? `denied:${error.requiredPermission}` : error._tag,
    ),
  );

describe("WorkService sources", () => {
  it.effect("saves, updates, disconnects, restores and revives a source", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const config = markdownConfig(".foredeck/work");

      const saved = yield* work.saveSource(owner, { projectId: alpha, label: "Tasks", config });
      assert.strictEqual(saved.kind, "markdown");
      assert.strictEqual(saved.identity, ".foredeck/work");
      assert.strictEqual(saved.state, "active");
      assert.strictEqual(saved.version, 1);
      assert.deepStrictEqual(saved.credential, { configured: false });
      assert.deepStrictEqual(saved.health, { status: "ok" });
      assert.deepStrictEqual(saved.capabilities, markdown.adapter.capabilities);
      assert.deepStrictEqual(markdown.prepared, [".foredeck/work"]);
      assert.deepStrictEqual(markdown.tested, [{ identity: ".foredeck/work", secret: undefined }]);
      assert.deepStrictEqual(
        yield* work.listSources(owner, { projectId: alpha, includeDisconnected: false }),
        { sources: [saved] },
      );

      assert.strictEqual(
        yield* failureOf(work.saveSource(owner, { projectId: alpha, label: "Again", config })),
        "WorkConflict",
      );

      const renamed = yield* work.saveSource(owner, {
        sourceId: saved.sourceId,
        expectedVersion: 1,
        projectId: alpha,
        label: "Renamed",
        config,
      });
      assert.strictEqual(renamed.label, "Renamed");
      assert.strictEqual(renamed.version, 2);
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            sourceId: saved.sourceId,
            expectedVersion: 1,
            projectId: alpha,
            label: "Stale",
            config,
          }),
        ),
        "WorkSourceStale",
      );

      const disconnected = yield* work.disconnectSource(owner, { sourceId: saved.sourceId });
      assert.strictEqual(disconnected.state, "disconnected");
      assert.deepStrictEqual(
        yield* work.listSources(owner, { projectId: alpha, includeDisconnected: false }),
        { sources: [] },
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            sourceId: saved.sourceId,
            projectId: alpha,
            label: "Edit",
            config,
          }),
        ),
        "WorkInvalid",
      );
      const tombstones = yield* work.listSources(owner, {
        projectId: alpha,
        includeDisconnected: true,
      });
      assert.deepStrictEqual(
        tombstones.sources.map((source) => source.state),
        ["disconnected"],
      );
      assert.strictEqual(
        yield* failureOf(work.listItems(owner, { sourceId: saved.sourceId, limit: 50 })),
        "WorkUnavailable",
      );
      assert.strictEqual(
        yield* failureOf(
          work.listItems(owner, {
            sourceId: WorkSourceId.make("00000000-0000-4000-8000-000000000000"),
            limit: 50,
          }),
        ),
        "WorkSourceNotFound",
      );

      // A source cannot come back to a project that is gone.
      harness.projects.delete(alpha);
      assert.strictEqual(
        yield* failureOf(work.restoreSource(owner, { sourceId: saved.sourceId })),
        "WorkInvalid",
      );
      harness.projects.set(alpha, projectRow(alpha, "/projects/alpha"));
      const restored = yield* work.restoreSource(owner, { sourceId: saved.sourceId });
      assert.strictEqual(restored.state, "active");

      yield* work.disconnectSource(owner, { sourceId: saved.sourceId });
      const revived = yield* work.saveSource(owner, { projectId: alpha, label: "Back", config });
      assert.strictEqual(revived.sourceId, saved.sourceId);
      assert.strictEqual(revived.state, "active");
      assert.strictEqual(revived.label, "Back");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses each call without the grant it needs", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const none: WorkActor = { id: "session:none", grants: [], label: "owner" };
      const settingsOnly: WorkActor = {
        id: "session:settings",
        grants: [AuthSettingsWriteScope],
        label: "owner",
      };
      const sourceId = WorkSourceId.make("11111111-1111-4111-8111-111111111111");
      const ref = { sourceId, itemId: WorkItemId.make("item-1") };

      assert.strictEqual(
        yield* failureOf(work.listSources(none, { includeDisconnected: false })),
        `denied:${AuthWorkReadScope}`,
      );
      assert.strictEqual(
        yield* failureOf(work.listItems(settingsOnly, { sourceId, limit: 50 })),
        `denied:${AuthWorkReadScope}`,
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(reader, {
            projectId: alpha,
            label: "Tasks",
            config: markdownConfig("tasks"),
          }),
        ),
        `denied:${AuthSettingsWriteScope}`,
      );
      assert.strictEqual(
        yield* failureOf(work.disconnectSource(reader, { sourceId })),
        `denied:${AuthSettingsWriteScope}`,
      );
      assert.strictEqual(
        yield* failureOf(
          work.testSource(reader, { projectId: alpha, config: markdownConfig("tasks") }),
        ),
        `denied:${AuthSettingsWriteScope}`,
      );
      assert.strictEqual(
        yield* failureOf(work.createItem(reader, { sourceId, title: "Task" })),
        `denied:${AuthWorkWriteScope}`,
      );
      assert.strictEqual(
        yield* failureOf(work.setStatus(reader, { ref, status: "done" })),
        `denied:${AuthWorkWriteScope}`,
      );
      assert.strictEqual(
        yield* failureOf(
          work.setLink(reader, { ref, threadId: ThreadId.make("thread-1"), action: "link" }),
        ),
        `denied:${AuthWorkWriteScope}`,
      );
      // Asking to look again is a read.
      assert.strictEqual(yield* failureOf(work.refresh(none, {})), `denied:${AuthWorkReadScope}`);
      yield* work.refresh(reader, {});
      assert.deepStrictEqual(yield* work.listLinks(reader, {}), { links: [], truncated: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects source kinds this server lacks, unknown projects and failed tests", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            projectId: alpha,
            label: "Issues",
            config: { kind: "github", host: "github.com", owner: "acme", name: "app" },
          }),
        ),
        "WorkUnsupported",
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            projectId: ProjectId.make("project-elsewhere"),
            label: "Tasks",
            config: markdownConfig("tasks"),
          }),
        ),
        "WorkInvalid",
      );
      assert.deepStrictEqual(
        yield* work.testSource(owner, { projectId: alpha, config: markdownConfig("nope") }),
        { ok: false, message: "That directory cannot hold tasks." },
      );
      assert.deepStrictEqual(
        yield* work.testSource(owner, { projectId: alpha, config: markdownConfig("tasks") }),
        { ok: true, identity: "tasks" },
      );
      markdown.fail = new WorkRateLimited({});
      assert.deepStrictEqual(
        yield* work.testSource(owner, { projectId: alpha, config: markdownConfig("tasks") }),
        { ok: false, message: "The source is rate limiting requests; try again later." },
      );
      markdown.fail = null;
      assert.strictEqual(
        yield* failureOf(
          work.testSource(owner, {
            projectId: alpha,
            sourceId: WorkSourceId.make("00000000-0000-4000-8000-000000000000"),
            config: markdownConfig("tasks"),
          }),
        ),
        "WorkSourceNotFound",
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            projectId: alpha,
            label: "Nope",
            config: markdownConfig("nope"),
          }),
        ),
        "WorkInvalid",
      );
      assert.deepStrictEqual(yield* work.listSources(owner, { includeDisconnected: true }), {
        sources: [],
      });
      assert.deepStrictEqual(markdown.prepared, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "shares one Jira token per site and account and releases it with the last source",
    () => {
      const jira = fakeAdapter("jira");
      const harness = seeded(jira.adapter);
      const name = WorkService.jiraSecretName("https://acme.atlassian.net", "me@acme.test");
      return Effect.gen(function* () {
        const work = yield* WorkService.WorkService;

        const one = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "ONE",
          config: jiraConfig("ONE"),
          apiToken: "token-1",
        });
        assert.deepStrictEqual(one.credential, { configured: true });
        assert.strictEqual(harness.secrets.get(name), "token-1");
        assert.deepStrictEqual(jira.tested.at(-1), {
          identity: "https://acme.atlassian.net/ONE",
          secret: "token-1",
        });

        // A second source on the same site and account reuses the stored token.
        const two = yield* work.saveSource(owner, {
          projectId: alpha,
          label: "TWO",
          config: jiraConfig("TWO"),
        });
        assert.deepStrictEqual(two.credential, { configured: true });
        assert.deepStrictEqual(jira.tested.at(-1), {
          identity: "https://acme.atlassian.net/TWO",
          secret: "token-1",
        });

        // Another account has no token yet.
        const other = jiraConfig("THREE", "other@acme.test");
        assert.strictEqual(
          yield* failureOf(
            work.saveSource(owner, { projectId: alpha, label: "Other", config: other }),
          ),
          "WorkUnauthenticated",
        );
        assert.deepStrictEqual(yield* work.testSource(owner, { projectId: alpha, config: other }), {
          ok: false,
          message: "Jira needs an API token.",
        });
        assert.deepStrictEqual(
          yield* work.testSource(owner, { projectId: alpha, config: other, apiToken: "fresh" }),
          { ok: true, identity: "https://acme.atlassian.net/THREE" },
        );
        assert.strictEqual(
          harness.secrets.has(
            WorkService.jiraSecretName("https://acme.atlassian.net", "other@acme.test"),
          ),
          false,
        );
        // A stored source's token applies to its own test.
        assert.deepStrictEqual(
          yield* work.testSource(owner, {
            projectId: alpha,
            sourceId: two.sourceId,
            config: jiraConfig("TWO"),
          }),
          { ok: true, identity: "https://acme.atlassian.net/TWO" },
        );

        yield* work.disconnectSource(owner, { sourceId: one.sourceId });
        assert.strictEqual(harness.secrets.get(name), "token-1");
        yield* work.disconnectSource(owner, { sourceId: two.sourceId });
        assert.strictEqual(harness.secrets.has(name), false);

        // Restoring after the token went away no longer claims a credential.
        const back = yield* work.restoreSource(owner, { sourceId: one.sourceId });
        assert.deepStrictEqual(back.credential, { configured: false });
        const again = yield* work.saveSource(owner, {
          sourceId: one.sourceId,
          projectId: alpha,
          label: "ONE",
          config: jiraConfig("ONE"),
          apiToken: "token-2",
        });
        assert.deepStrictEqual(again.credential, { configured: true });
        const twoBack = yield* work.restoreSource(owner, { sourceId: two.sourceId });
        assert.deepStrictEqual(twoBack.credential, { configured: true });

        // Clearing drops the shared token for every source that used it, without a test.
        const testsBefore = jira.tested.length;
        const cleared = yield* work.saveSource(owner, {
          sourceId: two.sourceId,
          expectedVersion: twoBack.version,
          projectId: alpha,
          label: "TWO",
          config: jiraConfig("TWO"),
          credential: "clear",
        });
        assert.deepStrictEqual(cleared.credential, { configured: false });
        assert.strictEqual(jira.tested.length, testsBefore);
        assert.strictEqual(harness.secrets.has(name), false);
        const sources = yield* work.listSources(owner, {
          projectId: alpha,
          includeDisconnected: false,
        });
        assert.deepStrictEqual(
          sources.sources.map((source) => source.credential.configured),
          [false, false],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("WorkService source identity", () => {
  it.effect("keeps a source's kind and project across saves", () => {
    const markdown = fakeAdapter("markdown");
    const jira = fakeAdapter("jira");
    const harness = seeded(markdown.adapter, jira.adapter);
    harness.projects.set(beta, projectRow(beta, "/projects/beta"));
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const store = yield* WorkSourceStore.WorkSourceStore;
      const saved = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      const asJira = {
        sourceId: saved.sourceId,
        projectId: alpha,
        label: "Tasks",
        config: jiraConfig("ONE"),
      };
      assert.strictEqual(yield* failureOf(work.saveSource(owner, asJira)), "WorkInvalid");
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            sourceId: saved.sourceId,
            projectId: beta,
            label: "Tasks",
            config: markdownConfig("tasks"),
          }),
        ),
        "WorkInvalid",
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            sourceId: WorkSourceId.make("00000000-0000-4000-8000-000000000000"),
            projectId: alpha,
            label: "Tasks",
            config: markdownConfig("tasks"),
          }),
        ),
        "WorkSourceNotFound",
      );
      // The store refuses a kind change on its own as well.
      const refused = yield* Effect.flip(
        store.update({ sourceId: saved.sourceId, config: jiraConfig("ONE"), identity: "x" }),
      );
      assert.strictEqual(refused._tag, "WorkConflict");
      assert.deepStrictEqual(jira.tested, []);
      assert.deepStrictEqual(markdown.prepared, ["tasks"]);
      const unchanged = yield* work.listSources(owner, {
        projectId: alpha,
        includeDisconnected: false,
      });
      assert.deepStrictEqual(
        unchanged.sources.map((s) => [s.kind, s.projectId, s.version]),
        [["markdown", alpha, 1]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a Markdown directory another source already covers", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const tasks = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("work/tasks"),
      });
      for (const directory of ["Work/Tasks", "work/tasks/done", "work"]) {
        assert.strictEqual(
          yield* failureOf(
            work.saveSource(owner, {
              projectId: alpha,
              label: "Again",
              config: markdownConfig(directory),
            }),
          ),
          "WorkConflict",
        );
      }
      const sibling = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Archive",
        config: markdownConfig("work/tasks-archive"),
      });
      assert.notStrictEqual(sibling.sourceId, tasks.sourceId);
      // A source may keep or move its own directory.
      const moved = yield* work.saveSource(owner, {
        sourceId: tasks.sourceId,
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("work/tasks"),
      });
      assert.strictEqual(moved.version, 2);
      assert.deepStrictEqual(markdown.prepared, ["work/tasks", "work/tasks-archive", "work/tasks"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases a rotated account's token when nothing else uses it", () => {
    const jira = fakeAdapter("jira");
    const harness = seeded(jira.adapter);
    const first = WorkService.jiraSecretName("https://acme.atlassian.net", "me@acme.test");
    const second = WorkService.jiraSecretName("https://acme.atlassian.net", "other@acme.test");
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const one = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "ONE",
        config: jiraConfig("ONE"),
        apiToken: "token-1",
      });
      // A stale or duplicate save is refused before any token moves.
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            sourceId: one.sourceId,
            expectedVersion: 99,
            projectId: alpha,
            label: "ONE",
            config: jiraConfig("ONE"),
            apiToken: "stale-token",
          }),
        ),
        "WorkSourceStale",
      );
      assert.strictEqual(
        yield* failureOf(
          work.saveSource(owner, {
            projectId: alpha,
            label: "Duplicate",
            config: jiraConfig("ONE"),
            apiToken: "duplicate-token",
          }),
        ),
        "WorkConflict",
      );
      assert.strictEqual(harness.secrets.get(first), "token-1");
      const rotated = yield* work.saveSource(owner, {
        sourceId: one.sourceId,
        projectId: alpha,
        label: "ONE",
        config: jiraConfig("ONE", "other@acme.test"),
        apiToken: "token-2",
      });
      assert.deepStrictEqual(rotated.credential, { configured: true });
      assert.strictEqual(harness.secrets.has(first), false);
      assert.strictEqual(harness.secrets.get(second), "token-2");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("WorkService items", () => {
  it.effect("serves reads from the epoch cache until a write or refresh moves it", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const source = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      const query = { sourceId: source.sourceId, limit: 50 };

      const created = yield* work.createItem(owner, {
        sourceId: source.sourceId,
        title: "Write docs",
      });
      assert.strictEqual(created.title, "Write docs");
      assert.strictEqual(markdown.count("create"), 1);

      const first = yield* work.listItems(owner, query);
      assert.deepStrictEqual(
        first.items.map((item) => item.ref.itemId),
        [created.ref.itemId],
      );
      yield* work.listItems(owner, query);
      assert.strictEqual(markdown.count("list"), 1);
      const filtered = yield* work.listItems(owner, { ...query, statuses: ["done"] });
      assert.deepStrictEqual(filtered.items, []);
      assert.strictEqual(markdown.count("list"), 2);

      const pull = yield* Stream.toPull(work.subscribeRefreshes);
      const [initial] = yield* pull;
      const moved = yield* work.setStatus(owner, { ref: created.ref, status: "in_progress" });
      assert.strictEqual(moved.status, "in_progress");
      const bumped = yield* pull;
      assert.isAbove(bumped[bumped.length - 1]!, initial);
      const after = yield* work.listItems(owner, query);
      assert.deepStrictEqual(
        after.items.map((item) => item.status),
        ["in_progress"],
      );
      assert.strictEqual(markdown.count("list"), 3);

      yield* work.refresh(owner, {});
      yield* work.listItems(owner, query);
      assert.strictEqual(markdown.count("list"), 4);

      const detail = yield* work.getItem(owner, { ref: created.ref });
      yield* work.getItem(owner, { ref: created.ref });
      assert.strictEqual(markdown.count(`get:${created.ref.itemId}`), 1);
      assert.strictEqual(detail.status, "in_progress");
      assert.deepStrictEqual(detail.links, []);
      assert.deepStrictEqual(detail.capabilities, markdown.adapter.capabilities);
      assert.strictEqual(
        yield* failureOf(
          work.getItem(owner, {
            ref: { sourceId: source.sourceId, itemId: WorkItemId.make("item-404") },
          }),
        ),
        "WorkItemNotFound",
      );

      const snapshots = yield* work.snapshots(source.sourceId, [
        created.ref.itemId,
        WorkItemId.make("item-404"),
      ]);
      assert.deepStrictEqual(
        snapshots.map((item) => item.ref.itemId),
        [created.ref.itemId],
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("replays retried creates and comments and attributes what agents post", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const source = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      const sourceId = source.sourceId;

      const once = yield* work.createItem(owner, {
        sourceId,
        title: "Once",
        clientRequestId: "req-1",
      });
      const retried = yield* work.createItem(owner, {
        sourceId,
        title: "Once",
        clientRequestId: "req-1",
      });
      assert.deepStrictEqual(retried, once);
      assert.strictEqual(markdown.count("create"), 1);
      // Replays are per caller.
      const byAgent = yield* work.createItem(agent, {
        sourceId,
        title: "Once",
        clientRequestId: "req-1",
      });
      assert.notStrictEqual(byAgent.ref.itemId, once.ref.itemId);
      assert.strictEqual(markdown.count("create"), 2);

      // A retry that lands while the first attempt is still running shares its outcome.
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      markdown.createGate = { entered, release };
      const slow = { sourceId, title: "Slow", clientRequestId: "slow-1" };
      const first = yield* Effect.forkChild(work.createItem(owner, slow));
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(work.createItem(owner, slow));
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(second), yield* Fiber.join(first));
      markdown.createGate = null;
      assert.strictEqual(markdown.count("create"), 3);

      // A cancelled first attempt (the client dropped) does not pin its request id.
      const enteredAgain = yield* Deferred.make<void>();
      const releaseAgain = yield* Deferred.make<void>();
      markdown.createGate = { entered: enteredAgain, release: releaseAgain };
      const dropped = { sourceId, title: "Dropped", clientRequestId: "dropped-1" };
      const cancelled = yield* Effect.forkChild(work.createItem(owner, dropped));
      yield* Deferred.await(enteredAgain);
      yield* Fiber.interrupt(cancelled);
      markdown.createGate = null;
      const afterCancel = yield* work.createItem(owner, dropped);
      assert.strictEqual(afterCancel.title, "Dropped");
      assert.strictEqual(markdown.count("create"), 5);

      assert.deepStrictEqual(yield* work.addComment(owner, { ref: once.ref, body: "Looks good" }), {
        commentId: "comment-1",
      });
      const posted = yield* work.addComment(agent, {
        ref: once.ref,
        body: "Done, @claude please review",
        clientRequestId: "comment-1",
      });
      assert.deepStrictEqual(
        yield* work.addComment(agent, {
          ref: once.ref,
          body: "Done, @claude please review",
          clientRequestId: "comment-1",
        }),
        posted,
      );
      assert.strictEqual(
        yield* failureOf(work.addComment(owner, { ref: once.ref, body: "   " })),
        "WorkInvalid",
      );
      assert.strictEqual(
        yield* failureOf(work.addComment(agent, { ref: once.ref, body: "x".repeat(4_001) })),
        "WorkInvalid",
      );
      yield* work.addComment(owner, { ref: once.ref, body: "y".repeat(4_001) });
      assert.strictEqual(markdown.comments.length, 3);
      assert.deepStrictEqual(markdown.comments[0], {
        itemId: once.ref.itemId,
        body: "Looks good",
        actorId: "session:owner",
      });
      const agentComment = markdown.comments[1]!;
      assert.strictEqual(agentComment.actorId, "thread:thread-1");
      assert.isTrue(
        agentComment.body.endsWith("— posted by Thread 1 via Foredeck (thread thread-1)"),
      );
      assert.isTrue(agentComment.body.includes("`@claude`"));

      assert.strictEqual(
        yield* failureOf(work.updateItem(owner, { ref: once.ref, title: "Renamed" })),
        "WorkInvalid",
      );
      const renamed = yield* work.updateItem(owner, {
        ref: once.ref,
        title: "Renamed",
        expectedRevision: once.revision,
      });
      assert.strictEqual(renamed.title, "Renamed");
      assert.notStrictEqual(renamed.revision, once.revision);
      // Field-only edits need no revision.
      const relabeled = yield* work.updateItem(owner, { ref: once.ref, assignee: null });
      assert.strictEqual(relabeled.title, "Renamed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tracks source health from the latest source call", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const source = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      const query = { sourceId: source.sourceId, limit: 50 };
      const health = work
        .listSources(owner, { projectId: alpha, includeDisconnected: false })
        .pipe(Effect.map((result) => result.sources[0]?.health));

      markdown.fail = new WorkUnauthenticated({ detail: "Token expired." });
      assert.strictEqual(yield* failureOf(work.listItems(owner, query)), "WorkUnauthenticated");
      assert.deepStrictEqual(yield* health, { status: "auth_required", message: "Token expired." });

      markdown.fail = new WorkRateLimited({ retryAt: "2026-10-21T10:00:00.000Z" });
      yield* work.refresh(owner, {});
      assert.strictEqual(yield* failureOf(work.listItems(owner, query)), "WorkRateLimited");
      assert.deepStrictEqual(yield* health, {
        status: "rate_limited",
        message: "The source is rate limiting requests until 2026-10-21T10:00:00.000Z.",
        retryAt: "2026-10-21T10:00:00.000Z",
      });

      markdown.fail = null;
      yield* work.refresh(owner, {});
      yield* work.listItems(owner, query);
      assert.deepStrictEqual(yield* health, { status: "ok" });
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("WorkService links", () => {
  it.effect("links items to live threads and lists only open links by default", () => {
    const markdown = fakeAdapter("markdown");
    const harness = seeded(markdown.adapter);
    const open = ThreadId.make("thread-open");
    const settled = ThreadId.make("thread-settled");
    const archived = ThreadId.make("thread-archived");
    const deleted = ThreadId.make("thread-deleted");
    const when = DateTime.makeUnsafe(at);
    harness.threads.set(open, threadShell(open, alpha));
    harness.threads.set(settled, threadShell(settled, alpha, { settledAt: when }));
    harness.threads.set(archived, threadShell(archived, alpha, { archivedAt: when }));
    harness.threads.set(deleted, threadShell(deleted, alpha, { deletedAt: when }));
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const source = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship it" });
      const ref = item.ref;

      assert.deepStrictEqual(yield* work.setLink(owner, { ref, threadId: open, action: "link" }), {
        linked: true,
      });
      yield* work.setLink(agent, { ref, threadId: settled, action: "link" });
      yield* work.setLink(owner, { ref, threadId: archived, action: "link" });
      // Linking twice changes nothing.
      yield* work.setLink(owner, { ref, threadId: open, action: "link" });
      assert.strictEqual(
        yield* failureOf(work.setLink(owner, { ref, threadId: deleted, action: "link" })),
        "WorkInvalid",
      );
      assert.strictEqual(
        yield* failureOf(
          work.setLink(owner, { ref, threadId: ThreadId.make("thread-none"), action: "link" }),
        ),
        "WorkInvalid",
      );
      assert.strictEqual(
        yield* failureOf(
          work.setLink(owner, {
            ref: { sourceId: source.sourceId, itemId: WorkItemId.make("item-404") },
            threadId: open,
            action: "link",
          }),
        ),
        "WorkItemNotFound",
      );

      const byItem = yield* work.listLinks(owner, { ref });
      assert.deepStrictEqual(byItem.links.map((link) => [link.threadId, link.source]).sort(), [
        [archived, "manual"],
        [open, "manual"],
        [settled, "agent"],
      ]);
      assert.deepStrictEqual(byItem.links[0]?.snapshot, {
        key: item.key,
        title: "Ship it",
        status: "todo",
        url: null,
        revision: item.revision,
        autoStarted: false,
      });
      assert.isNull(byItem.links[0]?.run);

      const everywhere = yield* work.listLinks(owner, {});
      assert.deepStrictEqual(
        everywhere.links.map((link) => link.threadId),
        [open],
      );
      assert.isFalse(everywhere.truncated);
      assert.deepStrictEqual(
        (yield* work.listLinks(owner, { threadId: settled })).links.map((link) => link.threadId),
        [settled],
      );
      assert.strictEqual((yield* work.listLinks(owner, { projectId: alpha })).links.length, 3);
      assert.strictEqual((yield* work.listLinks(owner, { projectId: beta })).links.length, 0);
      assert.strictEqual((yield* work.getItem(owner, { ref })).links.length, 3);

      assert.deepStrictEqual(
        yield* work.setLink(owner, { ref, threadId: open, action: "unlink" }),
        {
          linked: false,
        },
      );
      assert.deepStrictEqual((yield* work.listLinks(owner, { threadId: open })).links, []);
      assert.deepStrictEqual((yield* work.listLinks(owner, {})).links, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("retires a project's sources with their links and token", () => {
    const markdown = fakeAdapter("markdown");
    const jira = fakeAdapter("jira");
    const harness = seeded(markdown.adapter, jira.adapter);
    harness.projects.set(beta, projectRow(beta, "/projects/beta"));
    const thread = ThreadId.make("thread-open");
    harness.threads.set(thread, threadShell(thread, alpha));
    const name = WorkService.jiraSecretName("https://acme.atlassian.net", "me@acme.test");
    return Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const tasks = yield* work.saveSource(owner, {
        projectId: alpha,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      yield* work.saveSource(owner, {
        projectId: alpha,
        label: "ONE",
        config: jiraConfig("ONE"),
        apiToken: "token",
      });
      yield* work.saveSource(owner, { projectId: beta, label: "TWO", config: jiraConfig("TWO") });
      const item = yield* work.createItem(owner, { sourceId: tasks.sourceId, title: "Ship it" });
      yield* work.setLink(owner, { ref: item.ref, threadId: thread, action: "link" });
      // A source disconnected before its project goes still loses its links with it.
      yield* work.disconnectSource(owner, { sourceId: tasks.sourceId });
      assert.strictEqual((yield* work.listLinks(owner, { projectId: alpha })).links.length, 1);

      yield* work.retireProject(alpha);
      const retired = yield* work.listSources(owner, {
        projectId: alpha,
        includeDisconnected: true,
      });
      assert.deepStrictEqual(
        retired.sources.map((source) => source.state),
        ["disconnected", "disconnected"],
      );
      assert.deepStrictEqual(
        yield* work.listSources(owner, { projectId: alpha, includeDisconnected: false }),
        { sources: [] },
      );
      assert.deepStrictEqual((yield* work.listLinks(owner, { projectId: alpha })).links, []);
      // Beta still uses the token.
      assert.strictEqual(harness.secrets.get(name), "token");

      yield* work.retireProject(beta);
      assert.strictEqual(harness.secrets.has(name), false);
      // A project without sources is nothing to retire.
      yield* work.retireProject(ProjectId.make("project-empty"));
    }).pipe(Effect.provide(harness.layer));
  });
});
