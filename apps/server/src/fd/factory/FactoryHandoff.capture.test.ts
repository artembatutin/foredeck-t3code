import { assert, describe, it } from "@effect/vitest";
import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  type WorkItemDetail,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { Caller } from "../../mcp/threadAccess.ts";
import { ProjectAssistant, WorkCapture } from "../assistant/index.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import { verifyCommands, withProject, type World } from "./testkit/deliveryHarness.ts";

/**
 * The project assistant capturing an idea as a Work item on the server's real stack: Work with
 * its real Markdown source in a Git project, and Factory beside it, which a capture never calls.
 */

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

/** The assistant thread's MCP caller, as `readCaller` builds it; only its scope and limits count. */
const assistant: Caller = {
  scope: {
    environmentId: EnvironmentId.make("environment"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: ThreadId.make("fd-assistant-owner"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  threads: {} as Caller["threads"],
  caller: undefined,
  limits: { runtimeMode: "full-access", interactionMode: "default" },
};

const marker = (captureId: string) => `Captured by the Foredeck project assistant as ${captureId}.`;

/** The description a capture of `agreed` writes. */
const capturedBody = (captureId: string) =>
  [
    marker(captureId),
    "## Goal\n\nAdd a CSV export\nThe toolbar gets an Export button.",
    "## Acceptance criteria\n\n1. Exports the visible rows as CSV\n2. Has a test",
    "## Constraints\n\n- No new dependencies",
    "## Decisions\n\n- Use the existing toolbar",
    "## Open questions\n\n(none recorded)",
  ].join("\n\n");

const revise = (
  world: World,
  patch: Parameters<ProjectAssistant.ProjectAssistant["Service"]["revise"]>[0]["patch"],
) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistantService) =>
    assistantService.revise({ projectId: world.projectId, ideaId: "export", patch }),
  ).pipe(Effect.orDie);

const agreed = {
  goal: "Add a CSV export\nThe toolbar gets an Export button.",
  acceptanceCriteria: ["Exports the visible rows as CSV", "Has a test"],
  constraints: ["No new dependencies"],
  decisions: ["Use the existing toolbar"],
  executionAuthorized: true,
};

const capture = (world: World, overrides: Partial<WorkCapture.CaptureInput> = {}) =>
  Effect.flatMap(WorkCapture.WorkCapture, (captures) =>
    captures.capture({
      caller: assistant,
      projectId: world.projectId,
      ideaId: "export",
      kind: "single",
      ...overrides,
    }),
  );

const refOf = (result: WorkCapture.CaptureResult): WorkItemRef => ({
  sourceId: result.item.sourceId,
  itemId: result.item.itemId,
});

const read = (ref: WorkItemRef) =>
  Effect.flatMap(WorkService.WorkService, (work) => work.getItem(owner, { ref })).pipe(
    Effect.orDie,
  );

/** Every item of the world's source whose description opens with the capture's marker. */
const markedItems = (world: World, captureId: string) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    yield* work.refresh(owner, {});
    const { items } = yield* work.listItems(owner, {
      sourceId: world.itemRef.sourceId,
      limit: 100,
    });
    const details: Array<WorkItemDetail> = [];
    for (const { ref } of items) details.push(yield* work.getItem(owner, { ref }));
    return details.filter(({ body }) => body.startsWith(marker(captureId)));
  }).pipe(Effect.orDie);

const executionAuthorized = (world: World) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistantService) =>
    assistantService.inspect(world.projectId, "export"),
  ).pipe(
    Effect.orDie,
    Effect.map(({ briefs }) => briefs[0]?.executionAuthorized),
  );

const countOf = (table: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

/**
 * Work's `createItem`, held or failed by the test. `hold` runs after the real create, inside the
 * source write; `refuse` makes Work refuse the create before anything is written.
 */
const createControl = () => {
  const control: {
    hold: Effect.Effect<void> | undefined;
    refuse: boolean;
  } = { hold: undefined, refuse: false };
  const missing = WorkSourceId.make("99999999-9999-4999-8999-999999999999");
  const wrap = (
    service: WorkService.WorkService["Service"],
  ): WorkService.WorkService["Service"] => ({
    ...service,
    createItem: (actor, input) =>
      control.refuse
        ? // A real refusal: Work writes nothing for a source it does not have.
          Effect.suspend(() => control.hold ?? Effect.void).pipe(
            Effect.andThen(service.createItem(actor, { ...input, sourceId: missing })),
          )
        : service
            .createItem(actor, input)
            .pipe(Effect.tap(() => Effect.suspend(() => control.hold ?? Effect.void))),
  });
  return { control, wrap };
};

/** Holds the source write until the server's shutdown interrupts its writer; see `cut`. */
const untilShutdown = (entered: Deferred.Deferred<void>, cut: Deferred.Deferred<void>) =>
  Deferred.succeed(entered, undefined).pipe(
    Effect.andThen(Effect.exit(Effect.interruptible(Effect.never))),
    Effect.andThen(Deferred.succeed(cut, undefined)),
    Effect.asVoid,
  );

describe("capturing an idea in a real Markdown source", () => {
  it.live("creates one marker-first task file and starts nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const factory = yield* Factory.FactoryService.FactoryService;
        yield* revise(world, agreed);

        const result = yield* capture(world);
        assert.strictEqual(result.outcome, "created");
        assert.isTrue(result.verified);
        assert.isFalse(result.executionAuthorized);
        const ref = refOf(result);
        assert.strictEqual(ref.sourceId, world.itemRef.sourceId);
        const item = yield* read(ref);
        assert.strictEqual(item.title, "Add a CSV export");
        assert.strictEqual(item.status, "todo");
        assert.strictEqual(item.body.trimEnd(), capturedBody(result.captureId));
        assert.isTrue(yield* fileSystem.exists(path.join(world.root, item.locator!)));
        assert.lengthOf(yield* markedItems(world, result.captureId), 1);

        // Nothing runs: no thread, Work link, assignment, queue row or delivery.
        assert.strictEqual(world.provider.started.length, 0);
        assert.deepStrictEqual(item.links, []);
        assert.deepStrictEqual((yield* factory.listByItem(ref).pipe(Effect.orDie)).deliveries, []);
        for (const table of [
          "fd_assistant_assignments",
          "fd_assistant_dispatches",
          "fd_assistant_queue_positions",
          "fd_assistant_factory_links",
          "fd_assistant_managed_roots",
          "fd_assistant_slots",
          "fd_assistant_admissions",
        ]) {
          assert.strictEqual(yield* countOf(table), 0, table);
        }
        // Execution is authorized again only once the owner has reviewed the item.
        assert.isFalse(yield* executionAuthorized(world));
        const sql = yield* SqlClient.SqlClient;
        const [latest] = yield* sql<{ readonly changes: string }>`
          SELECT changes_json AS changes FROM fd_assistant_brief_revisions
          WHERE project_id = ${world.projectId} AND idea_id = 'export'
          ORDER BY revision DESC LIMIT 1
        `.pipe(Effect.orDie);
        assert.deepStrictEqual(JSON.parse(latest!.changes), [
          { field: "executionAuthorized", previous: true, next: false },
        ]);
      }).pipe(Effect.orDie),
    ),
  );

  it.live(
    "keeps the item's Notes, which never change its fingerprint, and refuses an owner edit",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const work = yield* WorkService.WorkService;
          yield* revise(world, agreed);
          const created = yield* capture(world);
          const ref = refOf(created);
          yield* work.addComment(owner, { ref, body: "Looks right to me." });
          const noted = yield* read(ref);
          assert.include(noted.body, "## Notes");
          assert.lengthOf(noted.comments, 1);

          // The comment changed the file, not what the item says.
          yield* revise(world, { executionAuthorized: true });
          const same = yield* capture(world);
          assert.strictEqual(same.outcome, "unchanged");
          assert.isTrue(same.executionAuthorized);

          yield* revise(world, {
            acceptanceCriteria: [...agreed.acceptanceCriteria, "Works with an empty table"],
          });
          const updated = yield* capture(world);
          assert.strictEqual(updated.outcome, "updated");
          assert.strictEqual(updated.item.itemId, created.item.itemId);
          const rewritten = yield* read(ref);
          assert.isTrue(rewritten.body.startsWith(marker(created.captureId)));
          assert.include(rewritten.body, "3. Works with an empty table");
          assert.lengthOf(rewritten.comments, 1);
          assert.strictEqual(rewritten.comments[0]?.body.includes("Looks right to me."), true);
          assert.lengthOf(yield* markedItems(world, created.captureId), 1);

          // Another comment, then the same brief: still nothing to write.
          yield* work.addComment(owner, { ref, body: "Ship it." });
          assert.strictEqual((yield* capture(world)).outcome, "unchanged");

          // An owner's edit in Work is theirs: the brief does not replace it uninvited.
          const current = yield* read(ref);
          yield* work.updateItem(owner, {
            ref,
            expectedRevision: current.revision,
            body: current.body.replace("Has a test", "Has a test and a screenshot"),
          });
          yield* revise(world, { constraints: ["No new dependencies", "Keep it small"] });
          const refused = yield* Effect.flip(capture(world));
          assert.strictEqual(refused._tag, "WorkCaptureRefused");
          assert.strictEqual(
            refused._tag === "WorkCaptureRefused" ? refused.reason : undefined,
            "external_edit",
          );
          assert.include((yield* read(ref)).body, "Has a test and a screenshot");
        }).pipe(Effect.orDie),
      ),
  );
});

describe("recovering a capture after a restart, on real Markdown", () => {
  it.live(
    "a capture cut during its write adopts the one item with its marker after rebuild",
    () => {
      const { control, wrap } = createControl();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* revise(world, agreed);
            const entered = yield* Deferred.make<void>();
            const shutdown = yield* Deferred.make<void>();
            control.hold = untilShutdown(entered, shutdown);
            const cut = yield* capture(world).pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(entered);

            const { result, authorized } = yield* world.rebuild(
              Effect.gen(function* () {
                control.hold = undefined;
                const result = yield* capture(world);
                return { result, authorized: yield* executionAuthorized(world) };
              }),
            );
            assert.isTrue(yield* Deferred.isDone(shutdown));
            assert.isTrue(Exit.isFailure(yield* Fiber.join(cut)));
            assert.strictEqual(result.outcome, "recovered");
            // Read back from the task file, the item says exactly what the claim wrote.
            assert.isTrue(result.verified);
            const marked = yield* markedItems(world, result.captureId);
            assert.lengthOf(marked, 1);
            assert.strictEqual(marked[0]?.ref.itemId, result.item.itemId);
            assert.isFalse(authorized);
          }).pipe(Effect.orDie),
        { work: wrap },
      );
    },
  );

  it.live(
    "a capture cut before its write creates once, with the same marker, after rebuild",
    () => {
      const { control, wrap } = createControl();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* revise(world, agreed);
            const entered = yield* Deferred.make<void>();
            const shutdown = yield* Deferred.make<void>();
            control.refuse = true;
            control.hold = untilShutdown(entered, shutdown);
            yield* capture(world).pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(entered);

            const result = yield* world.rebuild(
              Effect.gen(function* () {
                control.refuse = false;
                control.hold = undefined;
                return yield* capture(world);
              }),
            );
            assert.isTrue(yield* Deferred.isDone(shutdown));
            assert.strictEqual(result.outcome, "created");
            assert.lengthOf(yield* markedItems(world, result.captureId), 1);
            // Built again, the server finds it recorded and creates nothing more.
            const again = yield* world.rebuild(capture(world));
            assert.strictEqual(again.outcome, "unchanged");
            assert.strictEqual(again.captureId, result.captureId);
            assert.lengthOf(yield* markedItems(world, result.captureId), 1);
          }).pipe(Effect.orDie),
        { work: wrap },
      );
    },
  );

  it.live("one match is adopted only once a whole read shows it is the only one", () => {
    const { control, wrap } = createControl();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* revise(world, agreed);
          control.refuse = true;
          const failed = yield* Effect.flip(capture(world));
          control.refuse = false;
          assert.strictEqual(failed._tag, "WorkCaptureUncertain");
          const captureId = failed._tag === "WorkCaptureUncertain" ? failed.captureId : "";
          const uncertainty = (error: WorkCapture.WorkCaptureError) =>
            error._tag === "WorkCaptureUncertain" ? error.uncertainty : error._tag;

          // The one item the listing shows with the marker, beside a task file that does not read
          // as an item and could be another copy: nothing is taken.
          const work = yield* WorkService.WorkService;
          const own = yield* work.createItem(owner, {
            sourceId: world.itemRef.sourceId,
            title: "Add a CSV export",
            body: capturedBody(captureId),
          });
          const broken = path.join(world.root, "tasks", "fd-broken-export.md");
          yield* fileSystem.writeFileString(
            broken,
            "---\nid: fd-brk001\nstatus: todo\n---\n\nHalf a task.\n",
          );
          const unreadable = yield* world.rebuild(Effect.flip(capture(world)));
          assert.strictEqual(uncertainty(unreadable), "incomplete");
          assert.lengthOf(yield* markedItems(world, captureId), 1);

          // Two items open with the marker: neither is taken.
          yield* fileSystem.remove(broken);
          const copy = yield* work.createItem(owner, {
            sourceId: world.itemRef.sourceId,
            title: "Add a CSV export",
            body: `${marker(captureId)}\n\nAnother copy.`,
          });
          const ambiguous = yield* world.rebuild(Effect.flip(capture(world)));
          assert.strictEqual(uncertainty(ambiguous), "ambiguous");
          assert.lengthOf(yield* markedItems(world, captureId), 2);

          // Read whole with the copy gone, the one left is adopted, and a read of its task file
          // confirms it says what the capture writes.
          const extra = yield* read(copy.ref);
          yield* fileSystem.remove(path.join(world.root, extra.locator!));
          const adopted = yield* world.rebuild(capture(world));
          assert.strictEqual(adopted.outcome, "recovered");
          assert.isTrue(adopted.verified);
          assert.strictEqual(adopted.captureId, captureId);
          assert.strictEqual(adopted.item.itemId, own.ref.itemId);
          assert.lengthOf(yield* markedItems(world, captureId), 1);
        }).pipe(Effect.orDie),
      { work: wrap },
    );
  });
});
