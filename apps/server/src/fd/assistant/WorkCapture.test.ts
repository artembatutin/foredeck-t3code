import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import type { Caller } from "../../mcp/threadAccess.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as AssistantHandoff from "../assistant-handoff/index.ts";
import { WorkService } from "../work-management/index.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import type { BriefPatch } from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as ProjectAssistant from "./ProjectAssistant.ts";
import * as WorkCapture from "./WorkCapture.ts";
import * as WorkCaptureStore from "./WorkCaptureStore.ts";

type Backend = typeof HandoffBackend.HandoffBackend.Service;

const alpha = ProjectId.make("alpha");
const tasks: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("11111111-1111-4111-8111-111111111111"),
  kind: "markdown",
  label: "Tasks",
};
const plans: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("33333333-3333-4333-8333-333333333333"),
  kind: "markdown",
  label: "Plans",
};
const issues: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("22222222-2222-4222-8222-222222222222"),
  kind: "github",
  label: "Issues",
};
const tickets: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("44444444-4444-4444-8444-444444444444"),
  kind: "jira",
  label: "Tickets",
};

/** A thread's MCP caller, as `readCaller` builds it: only its scope and limits are read here. */
const callerFor = (
  threadId: string,
  options: { readonly plan?: boolean; readonly readOnlyClient?: boolean } = {},
): Caller => ({
  scope: {
    environmentId: EnvironmentId.make("environment"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: options.readOnlyClient
      ? { sessionId: "client", label: "Outside client", access: "read-only" }
      : undefined,
  },
  threads: {} as Caller["threads"],
  caller: undefined,
  limits: { runtimeMode: "full-access", interactionMode: options.plan ? "plan" : "default" },
});
const assistant = callerFor("fd-assistant-owner");

const input = (overrides: Partial<WorkCapture.CaptureInput> = {}): WorkCapture.CaptureInput => ({
  caller: assistant,
  projectId: alpha,
  ideaId: "export",
  kind: "single",
  ...overrides,
});

const agreed: BriefPatch = {
  goal: "Add the export button\nIt belongs in the toolbar.",
  acceptanceCriteria: ["Exports CSV", "Has a test"],
  constraints: ["No new dependencies"],
  decisions: ["Use the toolbar"],
  executionAuthorized: true,
};
const revise = (patch: BriefPatch, ideaId = "export") =>
  Effect.flatMap(PortfolioStore.PortfolioStore, (store) =>
    store.reviseBrief({ projectId: alpha, ideaId, patch }),
  );
const briefOf = (ideaId = "export") =>
  Effect.flatMap(PortfolioStore.PortfolioStore, (store) => store.getBrief(alpha, ideaId)).pipe(
    Effect.map(Option.getOrThrow),
  );
const revisionsOf = (ideaId = "export") =>
  Effect.flatMap(PortfolioStore.PortfolioStore, (store) => store.listRevisions(alpha, ideaId));

interface FakeItem {
  readonly ref: HandoffBackend.HandoffItemRef;
  readonly key: string;
  title: string;
  body: string;
  status: HandoffBackend.HandoffItem["status"];
  revision: number;
}

/**
 * Work as the backend shows it, held in memory. Hooks run inside a create or update, before or
 * after the item changes: a hook that fails after the change models a source that stored the
 * write but answered with an error.
 */
const makeWork = (sources: ReadonlyArray<HandoffBackend.HandoffSource>) => {
  const items: Array<FakeItem> = [];
  const calls = {
    create: 0,
    read: 0,
    update: [] as Array<{ readonly expectedRevision: string }>,
  };
  const state = {
    sources,
    beforeCreate: undefined as Effect.Effect<void, HandoffBackend.HandoffBackendError> | undefined,
    afterCreate: undefined as Effect.Effect<void, HandoffBackend.HandoffBackendError> | undefined,
    beforeUpdate: undefined as Effect.Effect<void, HandoffBackend.HandoffBackendError> | undefined,
    afterUpdate: undefined as Effect.Effect<void, HandoffBackend.HandoffBackendError> | undefined,
    readFails: false,
    findFails: false,
    /** Whether a marker lookup reports that a miss proves absence. */
    complete: true,
    /** Items a marker lookup does not see yet, as a tracker's search index lags. */
    unindexed: new Set<string>(),
  };
  const unavailable = (operation: HandoffBackend.HandoffBackendError["operation"]) =>
    new HandoffBackend.HandoffBackendError({ operation, reason: "unavailable" });
  const view = (item: FakeItem): HandoffBackend.HandoffItem => ({
    ref: item.ref,
    key: item.key,
    url: null,
    title: item.title,
    status: item.status,
    revision: String(item.revision),
    invalid: false,
    body: item.body,
    fingerprint: JSON.stringify([item.title, item.body]),
    notes: "",
  });
  const find = (ref: HandoffBackend.HandoffItemRef) =>
    items.find((item) => item.ref.sourceId === ref.sourceId && item.ref.itemId === ref.itemId);
  const add = (sourceId: WorkSourceId, title: string, body: string) => {
    const itemId = WorkItemId.make(`T-${items.length + 1}`);
    const item: FakeItem = {
      ref: { sourceId, itemId },
      key: itemId,
      title,
      body,
      status: "todo",
      revision: 1,
    };
    items.push(item);
    return item;
  };
  const backend: Backend = {
    sources: () => Effect.sync(() => state.sources),
    read: (ref) =>
      Effect.suspend(() => {
        calls.read += 1;
        if (state.readFails) return Effect.fail(unavailable("read"));
        const item = find(ref);
        return item === undefined
          ? Effect.fail(
              new HandoffBackend.HandoffBackendError({ operation: "read", reason: "not_found" }),
            )
          : Effect.succeed(view(item));
      }),
    findByMarker: ({ sourceId, marker }) =>
      Effect.suspend(() =>
        state.findFails
          ? Effect.fail(unavailable("find"))
          : Effect.succeed({
              items: items
                .filter(
                  (item) =>
                    item.ref.sourceId === sourceId &&
                    item.body.includes(marker) &&
                    !state.unindexed.has(item.ref.itemId),
                )
                .map(view),
              complete: state.complete,
            }),
      ),
    writer: () =>
      Effect.succeed({ id: "thread:fd-assistant-owner", grants: [], label: "the assistant" }),
    create: (_writer, { sourceId, title, body }) =>
      Effect.gen(function* () {
        calls.create += 1;
        if (state.beforeCreate !== undefined) yield* state.beforeCreate;
        const item = add(sourceId, title, body);
        if (state.afterCreate !== undefined) yield* state.afterCreate;
        return { ref: item.ref, key: item.key, url: null };
      }),
    update: (_writer, { ref, expectedRevision, title, body }) =>
      Effect.gen(function* () {
        const item = find(ref);
        if (item === undefined) return yield* unavailable("update");
        if (String(item.revision) !== expectedRevision) {
          return yield* new HandoffBackend.HandoffBackendError({
            operation: "update",
            reason: "stale",
          });
        }
        calls.update.push({ expectedRevision });
        if (state.beforeUpdate !== undefined) yield* state.beforeUpdate;
        item.title = title;
        item.body = body;
        item.revision += 1;
        if (state.afterUpdate !== undefined) yield* state.afterUpdate;
      }),
  };
  return { items, calls, state, backend, add, unavailable };
};

/**
 * Holds a source write until the server's shutdown interrupts its writer, signalling `cut` then.
 * Only the wait itself can be interrupted: the write goes on, as a source that already took the
 * request finishes it.
 */
const untilShutdown = (entered: Deferred.Deferred<void>, cut: Deferred.Deferred<void>) =>
  Deferred.succeed(entered, undefined).pipe(
    Effect.andThen(Effect.exit(Effect.interruptible(Effect.never))),
    Effect.andThen(Deferred.succeed(cut, undefined)),
    Effect.asVoid,
  );

const fakeBackend = (work: ReturnType<typeof makeWork>) =>
  Layer.succeed(HandoffBackend.HandoffBackend, work.backend);

/** The real bridge over a Work service any call of which fails the test. */
const bridgeOverNoWork = AssistantHandoff.layerBackend.pipe(
  Layer.provide(Layer.mock(WorkService.WorkService)({})),
);

/**
 * One instance of the capture service over the test's database, in a scope of its own: closing
 * it is the server stopping, and a new instance is the next process. Each is built with a memo
 * map of its own, as the harness builds a server, so no instance is shared.
 */
const instance = (backend: Layer.Layer<never>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithMemoMap(
      WorkCapture.layer.pipe(Layer.provide(backend)),
      Layer.makeMemoMapUnsafe(),
      scope,
    );
    return {
      service: Context.get(context, WorkCapture.WorkCapture),
      close: Scope.close(scope, Exit.void),
    };
  });

const captureOf = (ideaId = "export") =>
  Effect.flatMap(WorkCaptureStore.WorkCaptureStore, (store) => store.get(alpha, ideaId)).pipe(
    Effect.map(Option.getOrNull),
  );
const eventsOf = (captureId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly event: string; readonly detail: string | null }>`
      SELECT event, detail FROM fd_assistant_capture_events
      WHERE capture_id = ${captureId} ORDER BY sequence
    `,
  ).pipe(Effect.map((rows) => rows.map(({ event }) => event)));
const countOf = (table: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
  ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

/** Everything a dispatch, a claim or a delivery would leave behind. */
const EXECUTION_TABLES = [
  "fd_assistant_assignments",
  "fd_assistant_dispatches",
  "fd_assistant_queue_positions",
  "fd_assistant_factory_links",
  "fd_assistant_managed_roots",
  "fd_assistant_slots",
  "fd_assistant_admissions",
  "fd_assistant_admission_demands",
];

const marker = (captureId: string) => `Captured by the Foredeck project assistant as ${captureId}.`;

const withDatabase = <A, E>(
  body: Effect.Effect<
    A,
    E,
    PortfolioStore.PortfolioStore | WorkCaptureStore.WorkCaptureStore | SqlClient.SqlClient
  >,
) =>
  body.pipe(
    Effect.provide(ProjectAssistant.layerPersistence.pipe(Layer.provideMerge(Sqlite.layerMemory))),
  );

describe("capturing an idea as a Work item", () => {
  it.effect("creates one marker-first item from the brief and clears execution authorization", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise(agreed);
        const authorizedRevision = (yield* briefOf()).revision;

        const result = yield* service.capture(input());
        assert.strictEqual(result.outcome, "created");
        assert.strictEqual(result.kind, "single");
        assert.isTrue(result.verified);
        assert.isFalse(result.executionAuthorized);
        assert.strictEqual(work.calls.create, 1);
        assert.strictEqual(work.items.length, 1);
        const [item] = work.items;
        assert.strictEqual(item?.title, "Add the export button");
        assert.deepStrictEqual(result.item, {
          sourceId: tasks.sourceId,
          itemId: item!.ref.itemId,
          key: item!.key,
          url: null,
        });
        assert.isTrue(result.captureId.startsWith("cap-"));
        assert.strictEqual(
          item?.body,
          [
            marker(result.captureId),
            "## Goal\n\nAdd the export button\nIt belongs in the toolbar.",
            "## Acceptance criteria\n\n1. Exports CSV\n2. Has a test",
            "## Constraints\n\n- No new dependencies",
            "## Decisions\n\n- Use the toolbar",
            "## Open questions\n\n(none recorded)",
          ].join("\n\n"),
        );

        // Nothing runs: no thread, assignment, queue row or delivery.
        for (const table of EXECUTION_TABLES) assert.strictEqual(yield* countOf(table), 0, table);

        // Authorization stays off, cleared with a recorded revision.
        const brief = yield* briefOf();
        assert.isFalse(brief.executionAuthorized);
        assert.strictEqual(brief.revision, authorizedRevision + 1);
        const cleared = (yield* revisionsOf()).at(-1);
        assert.deepStrictEqual(cleared?.changes, [
          { field: "executionAuthorized", previous: true, next: false },
        ]);
        assert.include(cleared?.reason ?? "", item!.key);

        const stored = yield* captureOf();
        assert.strictEqual(stored?.state, "captured");
        assert.strictEqual(stored?.itemId, item?.ref.itemId);
        assert.strictEqual(stored?.itemFingerprint, JSON.stringify([item?.title, item?.body]));
        assert.deepStrictEqual(yield* eventsOf(result.captureId), ["claimed", "created"]);

        // The same brief again writes nothing and leaves authorization alone.
        yield* revise({ executionAuthorized: true });
        const again = yield* service.capture(input());
        assert.strictEqual(again.outcome, "unchanged");
        assert.isTrue(again.executionAuthorized);
        assert.strictEqual(work.calls.create, 1);
        assert.deepStrictEqual(work.calls.update, []);
        assert.isTrue((yield* briefOf()).executionAuthorized);
      }),
    ),
  );

  it.effect("records no revision when the brief was not authorized", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise({ ...agreed, executionAuthorized: false });
        const before = (yield* revisionsOf()).length;
        const result = yield* service.capture(input());
        assert.strictEqual(result.outcome, "created");
        assert.isFalse(result.executionAuthorized);
        assert.strictEqual((yield* revisionsOf()).length, before);
      }),
    ),
  );
});

describe("refusals before any write", () => {
  /** Fails the capture and checks nothing was written anywhere. */
  const refusedWith = <A>(
    reason: WorkCapture.WorkCaptureRefused["reason"],
    work: ReturnType<typeof makeWork>,
    attempt: Effect.Effect<A, WorkCapture.WorkCaptureError>,
  ) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(attempt);
      assert.strictEqual(error._tag, "WorkCaptureRefused");
      assert.strictEqual(error._tag === "WorkCaptureRefused" ? error.reason : undefined, reason);
      assert.strictEqual(work.calls.create, 0);
      assert.deepStrictEqual(work.calls.update, []);
      assert.isNull(yield* captureOf());
      assert.strictEqual(yield* countOf("fd_assistant_capture_events"), 0);
      return error;
    });

  it.effect("refuses callers that are not the assistant or may only read", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        yield* revise(agreed);
        const fake = yield* instance(fakeBackend(work));
        yield* refusedWith(
          "not_assistant",
          work,
          fake.service.capture(input({ caller: callerFor("thread-ordinary") })),
        );
        yield* refusedWith(
          "not_assistant",
          work,
          fake.service.abandon({
            caller: callerFor("thread-ordinary"),
            projectId: alpha,
            ideaId: "export",
          }),
        );
        // The real bridge decides who may write, as Work does for every agent.
        const bridged = yield* instance(bridgeOverNoWork);
        yield* refusedWith(
          "read_only",
          work,
          bridged.service.capture(
            input({ caller: callerFor("fd-assistant-owner", { plan: true }) }),
          ),
        );
        yield* refusedWith(
          "read_only",
          work,
          bridged.service.capture(
            input({ caller: callerFor("fd-assistant-owner", { readOnlyClient: true }) }),
          ),
        );
      }),
    ),
  );

  it.effect("refuses a brief without a goal or acceptance criteria", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* refusedWith("incomplete_brief", work, service.capture(input()));
        yield* revise({ acceptanceCriteria: ["Exports CSV"] }, "no-goal");
        yield* refusedWith("incomplete_brief", work, service.capture(input({ ideaId: "no-goal" })));
        yield* revise({ goal: "Add the export button" }, "no-criteria");
        yield* refusedWith(
          "incomplete_brief",
          work,
          service.capture(input({ ideaId: "no-criteria" })),
        );
      }),
    ),
  );

  it.effect("names the prerequisite or the sources instead of choosing one", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* revise(agreed);
        const none = makeWork([]);
        const empty = yield* instance(fakeBackend(none));
        const prerequisite = yield* refusedWith("no_sources", none, empty.service.capture(input()));
        assert.include(prerequisite.message, "Project settings → Work sources");

        const several = makeWork([tasks, issues]);
        const many = yield* instance(fakeBackend(several));
        const listed = yield* refusedWith(
          "several_sources",
          several,
          many.service.capture(input()),
        );
        assert.include(listed.message, `${tasks.sourceId} (markdown, Tasks)`);
        assert.include(listed.message, `${issues.sourceId} (github, Issues)`);
        yield* refusedWith(
          "unknown_source",
          several,
          many.service.capture(input({ sourceId: plans.sourceId })),
        );
      }),
    ),
  );

  it.effect("refuses a GitHub or Jira parent and names the supported paths", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* revise(agreed);
        const mixed = makeWork([issues, tasks, plans]);
        const withMarkdown = yield* instance(fakeBackend(mixed));
        const github = yield* refusedWith(
          "tracker_parent",
          mixed,
          withMarkdown.service.capture(input({ kind: "parent", sourceId: issues.sourceId })),
        );
        assert.include(github.message, "Capture it as single");
        assert.include(github.message, `${tasks.sourceId} (markdown, Tasks)`);
        assert.include(github.message, `${plans.sourceId} (markdown, Plans)`);
        assert.notInclude(github.message, issues.sourceId);

        const onlyJira = makeWork([tickets]);
        const trackerOnly = yield* instance(fakeBackend(onlyJira));
        const jira = yield* refusedWith(
          "tracker_parent",
          onlyJira,
          trackerOnly.service.capture(input({ kind: "parent" })),
        );
        assert.include(jira.message, "Capture it as single");
        assert.include(jira.message, "add a Markdown source in Project settings → Work sources");
      }),
    ),
  );
});

describe("one writer per idea", () => {
  it.effect("two callers behind a held create cause one create and get the same item", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise(agreed);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        work.state.afterCreate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );

        const first = yield* service.capture(input()).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* service
          .capture(input({ caller: callerFor("fd-assistant-second") }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);

        const [one, two] = [yield* Fiber.join(first), yield* Fiber.join(second)];
        // The second joined the first's writer: it reports that writer's create.
        assert.deepStrictEqual(two, one);
        assert.strictEqual(one.outcome, "created");
        assert.strictEqual(work.calls.create, 1);
        assert.strictEqual(work.items.length, 1);
      }),
    ),
  );

  it.effect("an interrupted caller leaves the writer running, and a later caller joins it", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise(agreed);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        work.state.afterCreate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );

        const gone = yield* service.capture(input()).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(gone);
        assert.strictEqual((yield* captureOf())?.state, "pending");

        const later = yield* service
          .capture(input())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(later);
        assert.strictEqual(result.outcome, "created");
        assert.strictEqual(work.calls.create, 1);
        assert.strictEqual((yield* captureOf())?.state, "captured");
      }),
    ),
  );
});

describe("recovery", () => {
  it.effect("records an item whose record failed, without creating a second", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise(agreed);
        yield* sql`CREATE TRIGGER refuse_created BEFORE INSERT ON fd_assistant_capture_events
          WHEN NEW.event = 'created' BEGIN SELECT RAISE(ABORT, 'injected'); END`;
        const failed = yield* Effect.flip(service.capture(input()));
        assert.strictEqual(failed._tag, "WorkCaptureFailed");
        assert.strictEqual(
          failed._tag === "WorkCaptureFailed" ? failed.stage : undefined,
          "record",
        );
        assert.strictEqual(work.items.length, 1);
        // Nothing of the record committed: still claimed, still authorized.
        assert.strictEqual((yield* captureOf())?.state, "pending");
        assert.isTrue((yield* briefOf()).executionAuthorized);
        yield* sql`DROP TRIGGER refuse_created`;

        const retried = yield* service.capture(input());
        assert.strictEqual(retried.outcome, "created");
        assert.strictEqual(retried.item.itemId, work.items[0]?.ref.itemId);
        assert.strictEqual(work.calls.create, 1);
        assert.isFalse((yield* briefOf()).executionAuthorized);
      }),
    ),
  );

  it.effect(
    "after a mid-capture close, the next instance adopts the one item with the marker",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const work = makeWork([tasks]);
          yield* revise(agreed);
          const first = yield* instance(fakeBackend(work));
          const entered = yield* Deferred.make<void>();
          const shutdown = yield* Deferred.make<void>();
          work.state.afterCreate = untilShutdown(entered, shutdown);
          const caller = yield* first.service.capture(input()).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          const readsBefore = work.calls.read;

          // The shutdown arrives during the source write: the write and its read-back finish, and
          // only then is the writer cut, before it records anything.
          yield* first.close;
          assert.isTrue(yield* Deferred.isDone(shutdown));
          assert.strictEqual(work.calls.read, readsBefore + 1);
          const exit = yield* Fiber.join(caller);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.include(String(exit.cause), "WorkCaptureFailed");
          const claimed = yield* captureOf();
          assert.strictEqual(claimed?.state, "pending");
          assert.strictEqual(work.items.length, 1);
          work.state.afterCreate = undefined;

          const next = yield* instance(fakeBackend(work));
          const result = yield* next.service.capture(input());
          assert.strictEqual(result.outcome, "recovered");
          assert.strictEqual(result.captureId, claimed?.captureId);
          assert.strictEqual(result.item.itemId, work.items[0]?.ref.itemId);
          assert.strictEqual(work.calls.create, 1);
          assert.deepStrictEqual(yield* eventsOf(result.captureId), ["claimed", "recovered"]);
          assert.isFalse((yield* briefOf()).executionAuthorized);
        }),
      ),
  );

  it.effect(
    "after a close with no item, a complete Markdown listing creates once with the marker",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const work = makeWork([tasks]);
          yield* revise(agreed);
          const first = yield* instance(fakeBackend(work));
          const entered = yield* Deferred.make<void>();
          const shutdown = yield* Deferred.make<void>();
          // The shutdown arrives before the source took the write, which then never lands.
          work.state.beforeCreate = untilShutdown(entered, shutdown).pipe(
            Effect.andThen(Effect.fail(work.unavailable("create"))),
          );
          yield* first.service.capture(input()).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* first.close;
          assert.isTrue(yield* Deferred.isDone(shutdown));
          const claimed = yield* captureOf();
          assert.strictEqual(claimed?.state, "pending");
          assert.strictEqual(work.items.length, 0);
          work.state.beforeCreate = undefined;

          const next = yield* instance(fakeBackend(work));
          const result = yield* next.service.capture(input());
          assert.strictEqual(result.outcome, "created");
          assert.strictEqual(result.captureId, claimed?.captureId);
          assert.strictEqual(work.items.length, 1);
          assert.isTrue(work.items[0]!.body.startsWith(marker(claimed!.captureId)));
          assert.deepStrictEqual(yield* eventsOf(result.captureId), [
            "claimed",
            "claimed",
            "created",
          ]);

          // A later instance finds it recorded and creates nothing.
          const third = yield* instance(fakeBackend(work));
          assert.strictEqual((yield* third.service.capture(input())).outcome, "unchanged");
          assert.strictEqual(work.items.length, 1);
        }),
      ),
  );

  it.effect(
    "an incomplete or stale listing, a failed lookup or two matches leave it uncertain",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const work = makeWork([tasks]);
          yield* revise(agreed);
          const { service } = yield* instance(fakeBackend(work));
          work.state.beforeCreate = Effect.fail(work.unavailable("create"));
          const unconfirmed = yield* Effect.flip(service.capture(input()));
          assert.strictEqual(unconfirmed._tag, "WorkCaptureUncertain");
          const stored = yield* captureOf();
          assert.strictEqual(stored?.state, "uncertain");
          const captureId = stored!.captureId;
          work.state.beforeCreate = undefined;

          const expectUncertain = (uncertainty: WorkCapture.WorkCaptureUncertain["uncertainty"]) =>
            Effect.gen(function* () {
              const error = yield* Effect.flip(service.capture(input()));
              assert.strictEqual(error._tag, "WorkCaptureUncertain");
              if (error._tag === "WorkCaptureUncertain") {
                assert.strictEqual(error.uncertainty, uncertainty);
                assert.isFalse(error.tracker);
              }
              assert.strictEqual((yield* captureOf())?.state, "uncertain");
            });

          // A listing that is stale or lists a file Work cannot read proves nothing absent.
          work.state.complete = false;
          yield* expectUncertain("incomplete");
          work.state.complete = true;
          work.state.findFails = true;
          yield* expectUncertain("incomplete");
          work.state.findFails = false;
          assert.strictEqual(work.calls.create, 1);

          // Two items carry the marker: neither is taken.
          work.add(tasks.sourceId, "Export", `${marker(captureId)}\n\nOne copy.`);
          work.add(tasks.sourceId, "Export", `${marker(captureId)}\n\nAnother copy.`);
          yield* expectUncertain("ambiguous");
          assert.strictEqual(work.calls.create, 1);
          assert.strictEqual(work.items.length, 2);
          // An item that only mentions the marker is not the capture's: a complete listing without
          // its own item creates it, once.
          work.items.pop();
          work.items[0]!.body = `See ${marker(captureId)}`;
          const created = yield* service.capture(input());
          assert.strictEqual(created.outcome, "created");
          assert.strictEqual(created.captureId, captureId);
          assert.strictEqual(work.calls.create, 2);
          assert.isTrue(work.items[1]!.body.startsWith(marker(captureId)));
        }),
      ),
  );
});

describe("GitHub and Jira captures", () => {
  it.effect("a failed create stays uncertain and a missing match never creates again", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([issues]);
        yield* revise(agreed);
        const { service } = yield* instance(fakeBackend(work));
        // The issue is stored, but the reply is lost.
        work.state.afterCreate = Effect.fail(work.unavailable("create"));
        const error = yield* Effect.flip(service.capture(input()));
        assert.strictEqual(error._tag, "WorkCaptureUncertain");
        if (error._tag === "WorkCaptureUncertain") {
          assert.strictEqual(error.uncertainty, "unconfirmed");
          assert.isTrue(error.tracker);
          assert.include(error.message, "recoverItem");
        }
        const stored = yield* captureOf();
        assert.strictEqual(stored?.state, "uncertain");
        assert.strictEqual(work.items.length, 1);
        work.state.afterCreate = undefined;

        // The search has not indexed it yet; even a lookup that calls itself complete is no proof.
        const [issue] = work.items;
        work.state.unindexed.add(issue!.ref.itemId);
        for (const caller of [assistant, callerFor("fd-assistant-second")]) {
          const missing = yield* Effect.flip(service.capture(input({ caller })));
          assert.strictEqual(missing._tag, "WorkCaptureUncertain");
          if (missing._tag === "WorkCaptureUncertain") {
            assert.strictEqual(missing.uncertainty, "not_found");
          }
        }
        // A rebuilt instance does not create it again either.
        const next = yield* instance(fakeBackend(work));
        assert.strictEqual(
          (yield* Effect.flip(next.service.capture(input())))._tag,
          "WorkCaptureUncertain",
        );
        assert.strictEqual(work.calls.create, 1);

        // recoverItem takes only an item whose description opens with the marker.
        const other = work.add(issues.sourceId, "Something else", "Unrelated.");
        const mismatch = yield* Effect.flip(
          next.service.capture(input({ recoverItem: other.ref.itemId })),
        );
        assert.strictEqual(mismatch._tag, "WorkCaptureRefused");
        assert.strictEqual(
          mismatch._tag === "WorkCaptureRefused" ? mismatch.reason : undefined,
          "recover_mismatch",
        );
        const quoted = work.add(issues.sourceId, "Quote", `As said: ${marker(stored!.captureId)}`);
        assert.strictEqual(
          (yield* Effect.flip(next.service.capture(input({ recoverItem: quoted.ref.itemId }))))
            ._tag,
          "WorkCaptureRefused",
        );
        const recovered = yield* next.service.capture(input({ recoverItem: issue!.ref.itemId }));
        assert.strictEqual(recovered.outcome, "recovered");
        assert.strictEqual(recovered.item.itemId, issue!.ref.itemId);
        assert.strictEqual(work.calls.create, 1);
        assert.strictEqual((yield* captureOf())?.state, "captured");
        // Once recorded, recoverItem has nothing left to do.
        const unneeded = yield* Effect.flip(
          next.service.capture(input({ recoverItem: issue!.ref.itemId })),
        );
        assert.strictEqual(
          unneeded._tag === "WorkCaptureRefused" ? unneeded.reason : undefined,
          "recover_unneeded",
        );
      }),
    ),
  );

  it.effect("a match the search finds is adopted", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tickets]);
        yield* revise(agreed);
        const { service } = yield* instance(fakeBackend(work));
        work.state.afterCreate = Effect.fail(work.unavailable("create"));
        yield* Effect.flip(service.capture(input()));
        work.state.afterCreate = undefined;
        const result = yield* service.capture(input());
        assert.strictEqual(result.outcome, "recovered");
        assert.strictEqual(work.calls.create, 1);
      }),
    ),
  );
});

describe("abandoning a capture", () => {
  const abandonOf = (service: WorkCapture.WorkCapture["Service"]) =>
    service.abandon({ caller: assistant, projectId: alpha, ideaId: "export" });
  const reasonOf = (error: WorkCapture.WorkCaptureError) =>
    error._tag === "WorkCaptureRefused" ? error.reason : error._tag;

  it.effect("is refused while a writer runs or an unended Factory assignment uses it", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* PortfolioStore.PortfolioStore;
        const work = makeWork([tasks]);
        yield* revise(agreed);
        const { service } = yield* instance(fakeBackend(work));
        assert.strictEqual(reasonOf(yield* Effect.flip(abandonOf(service))), "no_capture");

        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        work.state.afterCreate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const writing = yield* service.capture(input()).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.strictEqual(reasonOf(yield* Effect.flip(abandonOf(service))), "in_flight");
        yield* Deferred.succeed(release, undefined);
        const created = yield* Fiber.join(writing);
        work.state.afterCreate = undefined;

        yield* store.createAssignment({
          assignmentId: "assignment-1",
          projectId: alpha,
          ideaId: "export",
          executor: "foredeck",
        });
        yield* sql`INSERT INTO fd_assistant_factory_links (
            assignment_id, capture_id, source_id, item_id, kind, scope_hash, item_fingerprint,
            runtime_mode, delivery_id, control, created_at, updated_at
          ) VALUES (
            'assignment-1', ${created.captureId}, ${tasks.sourceId}, ${created.item.itemId},
            'single', 'scope', 'fingerprint', 'full-access', NULL, 'none', 'now', 'now'
          )`;
        assert.strictEqual(reasonOf(yield* Effect.flip(abandonOf(service))), "in_use");
        assert.strictEqual((yield* captureOf())?.captureId, created.captureId);

        // Once the assignment has ended, the capture can go.
        yield* store.transitionAssignment({
          assignmentId: "assignment-1",
          event: { type: "cancel" },
        });
        const abandoned = yield* abandonOf(service);
        assert.strictEqual(abandoned.captureId, created.captureId);
        assert.deepStrictEqual(abandoned.item, created.item);
        assert.isNull(yield* captureOf());
        // Its history stays, and so does its item.
        assert.deepStrictEqual(yield* eventsOf(created.captureId), [
          "claimed",
          "created",
          "abandoned",
        ]);
        assert.strictEqual(work.items.length, 1);

        // The next capture mints a new id and creates a new item.
        const fresh = yield* service.capture(input());
        assert.strictEqual(fresh.outcome, "created");
        assert.notStrictEqual(fresh.captureId, created.captureId);
        assert.notStrictEqual(fresh.item.itemId, created.item.itemId);
        assert.isTrue(work.items[1]!.body.startsWith(marker(fresh.captureId)));
        assert.strictEqual(work.calls.create, 2);
      }),
    ),
  );

  it.effect("drops an uncertain tracker capture so the next one creates anew", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([issues]);
        yield* revise(agreed);
        const { service } = yield* instance(fakeBackend(work));
        work.state.beforeCreate = Effect.fail(work.unavailable("create"));
        yield* Effect.flip(service.capture(input()));
        const uncertain = yield* captureOf();
        work.state.beforeCreate = undefined;
        const abandoned = yield* abandonOf(service);
        assert.strictEqual(abandoned.captureId, uncertain?.captureId);
        assert.isNull(abandoned.item);
        const fresh = yield* service.capture(input());
        assert.strictEqual(fresh.outcome, "created");
        assert.notStrictEqual(fresh.captureId, uncertain?.captureId);
        assert.deepStrictEqual(yield* eventsOf(uncertain!.captureId), [
          "claimed",
          "create_uncertain",
          "abandoned",
        ]);
      }),
    ),
  );
});

describe("updating a captured item", () => {
  /** A captured idea whose brief the owner authorized again after reviewing the item. */
  const captured = (
    work: ReturnType<typeof makeWork>,
    service: WorkCapture.WorkCapture["Service"],
  ) =>
    Effect.gen(function* () {
      yield* revise(agreed);
      const created = yield* service.capture(input());
      yield* revise({ executionAuthorized: true });
      return created;
    });
  const reasonOf = (error: WorkCapture.WorkCaptureError) =>
    error._tag === "WorkCaptureRefused" ? error.reason : error._tag;

  it.effect("rewrites an unchanged item at its revision and records its new fingerprint", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        const created = yield* captured(work, service);
        const before = yield* captureOf();
        yield* revise({ acceptanceCriteria: ["Exports CSV", "Has a test", "Works offline"] });
        yield* revise({ executionAuthorized: true });

        const updated = yield* service.capture(input());
        assert.strictEqual(updated.outcome, "updated");
        assert.strictEqual(updated.captureId, created.captureId);
        assert.deepStrictEqual(work.calls.update, [{ expectedRevision: "1" }]);
        const [item] = work.items;
        assert.include(item!.body, "3. Works offline");
        assert.isTrue(item!.body.startsWith(marker(created.captureId)));
        const after = yield* captureOf();
        assert.notStrictEqual(after?.itemFingerprint, before?.itemFingerprint);
        assert.strictEqual(after?.itemFingerprint, JSON.stringify([item!.title, item!.body]));
        assert.isFalse(updated.executionAuthorized);
        assert.isFalse((yield* briefOf()).executionAuthorized);
        assert.deepStrictEqual(yield* eventsOf(created.captureId), [
          "claimed",
          "created",
          "updated",
        ]);
        assert.strictEqual(work.calls.create, 1);
      }),
    ),
  );

  it.effect("only records a change that leaves the item's content as it is", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        const created = yield* captured(work, service);
        yield* revise({ priority: { rank: 1, reason: "Customers ask for it" } });
        const same = yield* service.capture(input());
        assert.strictEqual(same.outcome, "unchanged");
        assert.isTrue(same.executionAuthorized);
        // Delivering it as a parent instead is recorded, and needs authorizing again.
        const parent = yield* service.capture(input({ kind: "parent" }));
        assert.strictEqual(parent.outcome, "updated");
        assert.strictEqual(parent.kind, "parent");
        assert.isFalse(parent.executionAuthorized);
        assert.deepStrictEqual(work.calls.update, []);
        assert.strictEqual(work.items[0]!.revision, 1);
        assert.deepStrictEqual(yield* eventsOf(created.captureId), [
          "claimed",
          "created",
          "updated",
        ]);
      }),
    ),
  );

  it.effect("refuses an item edited elsewhere unless told to overwrite it", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* captured(work, service);
        const [item] = work.items;
        item!.body = `${item!.body}

The owner's own note.`;
        item!.revision += 1;
        yield* revise({ constraints: ["No new dependencies", "Keep it small"] });

        assert.strictEqual(reasonOf(yield* Effect.flip(service.capture(input()))), "external_edit");
        assert.deepStrictEqual(work.calls.update, []);
        assert.include(item!.body, "The owner's own note.");

        const overwritten = yield* service.capture(input({ overwrite: true }));
        assert.strictEqual(overwritten.outcome, "updated");
        assert.deepStrictEqual(work.calls.update, [{ expectedRevision: "2" }]);
        assert.notInclude(item!.body, "The owner's own note.");
        assert.include(item!.body, "- Keep it small");
      }),
    ),
  );

  it.effect("refuses a done or cancelled item", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* captured(work, service);
        yield* revise({ decisions: ["Use the menu"] });
        for (const status of ["done", "cancelled"] as const) {
          work.items[0]!.status = status;
          assert.strictEqual(reasonOf(yield* Effect.flip(service.capture(input()))), "item_closed");
          assert.strictEqual(
            reasonOf(yield* Effect.flip(service.capture(input({ overwrite: true })))),
            "item_closed",
          );
        }
        assert.deepStrictEqual(work.calls.update, []);
      }),
    ),
  );

  it.effect("re-reads after a failed update: unchanged fails, anything else is uncertain", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        const created = yield* captured(work, service);
        const recorded = (yield* captureOf())?.itemFingerprint;
        yield* revise({ decisions: ["Use the menu"] });
        yield* revise({ executionAuthorized: true });

        work.state.beforeUpdate = Effect.fail(work.unavailable("update"));
        const refusedUpdate = yield* Effect.flip(service.capture(input()));
        assert.strictEqual(refusedUpdate._tag, "WorkCaptureFailed");
        assert.strictEqual((yield* captureOf())?.itemFingerprint, recorded);
        assert.isTrue((yield* briefOf()).executionAuthorized);

        // Stored, but the reply is lost: the item no longer matches what was verified.
        work.state.beforeUpdate = undefined;
        work.state.afterUpdate = Effect.fail(work.unavailable("update"));
        const lost = yield* Effect.flip(service.capture(input()));
        assert.strictEqual(lost._tag, "WorkCaptureUncertain");
        assert.isNull((yield* captureOf())?.itemFingerprint);
        assert.isFalse((yield* briefOf()).executionAuthorized);
        assert.deepStrictEqual(yield* eventsOf(created.captureId), [
          "claimed",
          "created",
          "update_uncertain",
        ]);
        work.state.afterUpdate = undefined;
        // Unverified now: only an explicit overwrite writes it again.
        assert.strictEqual(reasonOf(yield* Effect.flip(service.capture(input()))), "external_edit");
        assert.strictEqual((yield* service.capture(input({ overwrite: true }))).outcome, "updated");
        assert.isNotNull((yield* captureOf())?.itemFingerprint);
      }),
    ),
  );

  it.effect("verifies an item whose read-back failed once a read shows what was written", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* revise(agreed);
        work.state.readFails = true;
        const created = yield* service.capture(input());
        assert.strictEqual(created.outcome, "created");
        assert.isFalse(created.verified);
        assert.isNull((yield* captureOf())?.itemFingerprint);
        work.state.readFails = false;
        yield* revise({ executionAuthorized: true });

        const verified = yield* service.capture(input());
        assert.strictEqual(verified.outcome, "verified");
        assert.isTrue(verified.verified);
        // Verifying sets the baseline execution is checked against, so it is authorized again.
        assert.isFalse(verified.executionAuthorized);
        assert.deepStrictEqual(work.calls.update, []);
        assert.strictEqual(work.calls.create, 1);
      }),
    ),
  );

  it.effect("refuses an item that no longer exists", () =>
    withDatabase(
      Effect.gen(function* () {
        const work = makeWork([tasks]);
        const { service } = yield* instance(fakeBackend(work));
        yield* captured(work, service);
        work.items.pop();
        assert.strictEqual(reasonOf(yield* Effect.flip(service.capture(input()))), "item_missing");
        assert.strictEqual(work.calls.create, 1);
      }),
    ),
  );
});
