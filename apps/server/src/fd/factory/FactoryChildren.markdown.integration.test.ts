import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryPlan,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { childItemInput, childReference } from "./plan/childItem.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  drainFactory,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

/**
 * A parent's plan approval against a real Markdown Work source in a temporary repository: the
 * child task files the approval writes, task text Markdown would otherwise refuse, and a run that
 * goes on after a child it created was never recorded, including one Work cannot read for a while
 * and one near the size of a Work item.
 */

const decodePlan = Schema.decodeSync(FactoryPlan);

const plan = decodePlan({
  tasks: [
    {
      id: "export-csv",
      title: "Export the table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [
        { criterion: 1, check: "Export two rows and read back the CSV.", paths: ["src/a.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names.", "An empty table still exports them."],
      testPlan: [
        { criterion: 1, check: "The first CSV line is the header.", paths: ["src/a.test.ts"] },
        { criterion: 2, check: "Export an empty table.", paths: ["src/b.test.ts", "src/c.ts"] },
      ],
      likelyPaths: ["src/header.ts"],
      risk: "high",
    },
    {
      id: "export-totals",
      title: "Sum the numeric columns",
      kind: "feature",
      summary: "Add a totals row under the exported rows.",
      acceptance: ["The last row sums each numeric column."],
      testPlan: [{ criterion: 1, check: "Sum two rows.", paths: ["src/totals.test.ts"] }],
      likelyPaths: ["src/totals.ts"],
      risk: "normal",
    },
  ],
});
const tasks = plan.tasks as readonly [FactoryPlanTask, FactoryPlanTask, FactoryPlanTask];

const reader: WorkActor = { id: "test:reader", grants: [AuthWorkReadScope], label: "reader" };
const service = Factory.FactoryService.FactoryService;

/** A started parent whose planner submitted `planned` and whose run ended, approved at the gate. */
const approved = (world: World, planned: FactoryPlan = plan) =>
  Effect.gen(function* () {
    const planner = yield* world.startWith({ kind: "parent" });
    const factory = yield* service;
    yield* factory.submitPlan({ threadId: planner.threadId, plan: planned }).pipe(Effect.orDie);
    yield* world.endRun(planner.runId, "completed");
    assert.strictEqual((yield* stateOf(planner.deliveryId)).status, "waiting");
    yield* factory.approvePlan(planner.deliveryId).pipe(Effect.orDie);
    yield* drainFactory;
    return planner.deliveryId;
  });

const childItemIds = (deliveryId: Parameters<typeof stateOf>[0]) =>
  Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
    store.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map(({ childItemId }) => childItemId)),
  );

/** Where a Markdown item's task file is in the project's checkout. */
const taskFilePath = (world: World, itemId: WorkItemId) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const path = yield* Path.Path;
    const detail = yield* work.getItem(reader, { ref: { ...world.itemRef, itemId } });
    return path.join(world.root, detail.locator ?? assert.fail(`Item ${itemId} has no file.`));
  }).pipe(Effect.orDie);

/** How many task files the source's directory holds. */
const taskFileCount = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fileSystem.readDirectory(path.join(world.root, "tasks"));
    return names.filter((name) => name.endsWith(".md")).length;
  }).pipe(Effect.orDie);

/** The task file of a Markdown item, as it is in the project's checkout. */
const taskFile = (world: World, itemId: WorkItemId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(yield* taskFilePath(world, itemId));
    const [, frontmatter = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
    return { lines: frontmatter.split("\n"), body };
  }).pipe(Effect.orDie);

/**
 * Each task's child file: titled as the task, under the parent, blocked by the task before, its
 * body opened by the task's reference and stating its summary, criteria and test plan.
 */
const assertTaskFiles = (
  world: World,
  deliveryId: Parameters<typeof stateOf>[0],
  itemIds: ReadonlyArray<WorkItemId>,
  planned: ReadonlyArray<FactoryPlanTask> = tasks,
) =>
  Effect.gen(function* () {
    for (const [index, task] of planned.entries()) {
      const itemId = itemIds[index] ?? assert.fail(`Task ${task.id} has no child.`);
      const { lines, body } = yield* taskFile(world, itemId);
      assert.include(lines, `title: ${task.title}`);
      assert.include(lines, `parent: ${world.itemRef.itemId}`);
      const blockedBy = lines.filter((line) => line.startsWith("blocked_by:"));
      assert.deepStrictEqual(blockedBy, index === 0 ? [] : [`blocked_by: ${itemIds[index - 1]}`]);
      assert.isTrue(body.startsWith(childReference(deliveryId, task.id)));
      assert.include(body, task.summary);
      for (const [number, criterion] of task.acceptance.entries()) {
        assert.include(body, `${number + 1}. ${criterion}`);
      }
      for (const { criterion, check, paths } of task.testPlan) {
        assert.include(body, `- Criterion ${criterion}: ${check}`);
        for (const path of paths) assert.include(body, `\`${path}\``);
      }
    }
  });

/** The parent item's children as Work lists them, by id. */
const childrenInWork = (world: World) =>
  Effect.flatMap(WorkService.WorkService, (work) =>
    work.getItem(reader, { ref: world.itemRef }),
  ).pipe(
    Effect.orDie,
    Effect.map(({ children }) => children.map(({ itemId }) => itemId).toSorted()),
  );

// Work's own errors are private to Work; this carries the same tag.
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

/**
 * Work whose dependency writes fail while `fault.failing` is set: a child after the first is
 * written, and its run fails before recording it.
 */
const failingDependencies = () => {
  const fault = { failing: true };
  return {
    fault,
    options: {
      work: (work: WorkService.WorkService["Service"]): WorkService.WorkService["Service"] => ({
        ...work,
        updateItem: (actor, patch) =>
          patch.blockedBy !== undefined && fault.failing
            ? Effect.fail(
                new FakeWorkUnavailable({
                  detail: "The task file could not be written.",
                }) as unknown as WorkDomainError,
              )
            : work.updateItem(actor, patch),
      }),
    },
  };
};

const lookupFailed = "Factory could not create the child items (FactoryChildLookupError).";

/** A task quoting a merge conflict, which Markdown would read as one if written as it is. */
const conflicted: FactoryPlanTask = {
  ...tasks[1],
  summary: [
    "Resolve exports that still hold a conflict such as:",
    "<<<<<<< HEAD",
    "export const separator = ',';",
    "=======",
    "export const separator = ';';",
    ">>>>>>> topic",
    "> Keep this note a quote.",
  ].join("\n"),
  acceptance: ["No export holds a conflict marker.", "A line of\n=======\nalone still exports."],
};
const conflictedPlan = decodePlan({ tasks: [tasks[0], conflicted, tasks[2]] });

/** The near-limit task's last check, which falls past what its source indexes for search. */
const nearLimitTail = "Tail check zq9 past the search index.";

/**
 * A task with `summary` under a title as long as Work allows, whose child body nears what a Work
 * item holds: the source's search index starts with the title, so it reaches the end only of
 * shorter bodies.
 */
const nearLimitWith = (summary: string): FactoryPlanTask => ({
  ...tasks[1],
  title: `Export every column ${"z".repeat(492)}`,
  summary,
  acceptance: Array.from(
    { length: 30 },
    (_, index) => `Criterion ${index + 1} holds near the bound: ${"y".repeat(1880)}`,
  ),
  testPlan: Array.from({ length: 30 }, (_, index) =>
    index === 29
      ? { criterion: 30, check: nearLimitTail, paths: [] }
      : { criterion: index + 1, check: `Check ${index + 1}.`, paths: ["src/near.test.ts"] },
  ),
});

/** The near-limit child body's length, which its summary pads the body to. */
const NEAR_LIMIT_BODY_LENGTH = 65_400;

// Delivery ids are UUIDs, so any one of their length gives the body's length; the parent item
// does not change it.
const nearLimitBodyLength = (task: FactoryPlanTask) =>
  childItemInput({
    parent: {
      sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
      itemId: WorkItemId.make("fd-aaaaaa"),
    },
    deliveryId: FactoryDeliveryId.make("00000000-0000-4000-8000-000000000000"),
    task,
  }).body?.length ?? 0;
const nearLimitTask = nearLimitWith(
  "s".repeat(1 + NEAR_LIMIT_BODY_LENGTH - nearLimitBodyLength(nearLimitWith("s"))),
);
const nearLimitPlan = decodePlan({ tasks: [tasks[0], nearLimitTask, tasks[2]] });

describe("approving a parent's plan in a Markdown source", () => {
  it.live("writes one child task file per task, chained in plan order", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const deliveryId = yield* approved(world);
        const itemIds = (yield* childItemIds(deliveryId)).map(
          (itemId) => itemId ?? assert.fail("A task has no child."),
        );
        yield* assertTaskFiles(world, deliveryId, itemIds);
        assert.deepStrictEqual(yield* childrenInWork(world), itemIds.toSorted());

        // Their queued deliveries are the parent's children, in plan order.
        const factory = yield* service;
        const snapshot = toFactoryDelivery(Option.getOrThrow(yield* factory.get(deliveryId)));
        assert.strictEqual(snapshot.childIds.length, 3);
        for (const [index, childId] of snapshot.childIds.entries()) {
          const child = Option.getOrThrow(yield* factory.get(childId));
          assert.deepStrictEqual(child.itemRef, { ...world.itemRef, itemId: itemIds[index] });
          assert.strictEqual(child.parentId, deliveryId);
          assert.strictEqual(child.state.status, "queued");
        }
        // Only the planner ran.
        assert.strictEqual(world.provider.started.length, 1);
      }),
    ),
  );

  it.live("takes the child a run created and never recorded, once Work can read it again", () => {
    const { fault, options } = failingDependencies();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const deliveryId = yield* approved(world);
          assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
          const [first] = yield* childItemIds(deliveryId);
          assert.deepStrictEqual(yield* childItemIds(deliveryId), [first, null, null]);
          const written = yield* childrenInWork(world);
          assert.strictEqual(written.length, 2);
          const unrecorded = written.find((itemId) => itemId !== first);
          if (unrecorded === undefined) return assert.fail("The second child was not written.");
          // The parent and its two children.
          assert.strictEqual(yield* taskFileCount(world), 3);

          // The unrecorded child's file cannot be read for now (a new modification time makes
          // Work read it again): no search finds its reference, and nothing is created for it.
          fault.failing = false;
          const factory = yield* service;
          const file = yield* taskFilePath(world, unrecorded);
          const touch = (at: string) => {
            const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe(at));
            return fileSystem.utimes(file, modifiedAt, modifiedAt);
          };
          yield* fileSystem
            .chmod(file, 0o000)
            .pipe(Effect.andThen(touch("2001-01-01T00:00:00.000Z")), Effect.orDie);
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const unread = yield* stateOf(deliveryId);
          assert.strictEqual(
            unread.block?.reason === "effect_failed" && unread.block.detail,
            lookupFailed,
          );
          assert.deepStrictEqual(yield* childItemIds(deliveryId), [first, null, null]);
          assert.strictEqual(yield* taskFileCount(world), 3);

          yield* fileSystem
            .chmod(file, 0o644)
            .pipe(Effect.andThen(touch("2002-01-01T00:00:00.000Z")), Effect.orDie);
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const itemIds = (yield* childItemIds(deliveryId)).map(
            (itemId) => itemId ?? assert.fail("A task has no child."),
          );
          // Still three children: the second is the one written before, under its own id.
          assert.deepStrictEqual(itemIds.slice(0, 2), [first, unrecorded]);
          assert.deepStrictEqual(yield* childrenInWork(world), itemIds.toSorted());
          assert.strictEqual(yield* taskFileCount(world), 4);
          yield* assertTaskFiles(world, deliveryId, itemIds);
          const snapshot = toFactoryDelivery(Option.getOrThrow(yield* factory.get(deliveryId)));
          assert.strictEqual(snapshot.childIds.length, 3);
        }),
      options,
    );
  });

  it.live("writes a task that quotes conflict markers as Markdown its source keeps", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const deliveryId = yield* approved(world, conflictedPlan);
        const itemIds = (yield* childItemIds(deliveryId)).map(
          (itemId) => itemId ?? assert.fail("A task has no child."),
        );
        assert.strictEqual(itemIds.length, 3);

        const child = itemIds[1]!;
        const { body } = yield* taskFile(world, child);
        const expected = childItemInput({ parent: world.itemRef, deliveryId, task: conflicted });
        assert.strictEqual(body, expected.body);
        for (const line of ["\\<<<<<<< HEAD", "\\=======", "\\>>>>>>> topic"]) {
          assert.include(body.split("\n"), line);
        }
        assert.include(body.split("\n"), "> Keep this note a quote.");
        // Markdown renders each escape as the character it precedes: nothing of the task is lost.
        assert.include(body.replaceAll(/^\\(?=[<=>])/gm, ""), conflicted.summary);
        const work = yield* WorkService.WorkService;
        const detail = yield* work
          .getItem(reader, { ref: { ...world.itemRef, itemId: child } })
          .pipe(Effect.orDie);
        assert.isNull(detail.invalid);
        assert.strictEqual(detail.body, expected.body);
      }),
    ),
  );

  it.live("finds a near-limit child by its reference, whole, under its own id", () => {
    const { fault, options } = failingDependencies();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const deliveryId = yield* approved(world, nearLimitPlan);
          const expected = childItemInput({
            parent: world.itemRef,
            deliveryId,
            task: nearLimitTask,
          }).body;
          if (expected === undefined) return assert.fail("A child has a body.");
          assert.strictEqual(expected.length, NEAR_LIMIT_BODY_LENGTH);

          const [first] = yield* childItemIds(deliveryId);
          const unrecorded = (yield* childrenInWork(world)).find((itemId) => itemId !== first);
          if (unrecorded === undefined) return assert.fail("The second child was not written.");
          // Its reference opens the body, so a search finds it; the body's end lies past what the
          // source indexes for search.
          const work = yield* WorkService.WorkService;
          const search = (text: string) =>
            work
              .listItems(reader, { sourceId: world.itemRef.sourceId, search: text, limit: 100 })
              .pipe(
                Effect.orDie,
                Effect.map(({ items }) => items.map(({ ref }) => ref.itemId)),
              );
          assert.deepStrictEqual(yield* search(childReference(deliveryId, nearLimitTask.id)), [
            unrecorded,
          ]);
          assert.deepStrictEqual(yield* search(nearLimitTail), []);

          fault.failing = false;
          const factory = yield* service;
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const itemIds = (yield* childItemIds(deliveryId)).map(
            (itemId) => itemId ?? assert.fail("A task has no child."),
          );
          assert.deepStrictEqual(itemIds.slice(0, 2), [first, unrecorded]);
          assert.strictEqual(yield* taskFileCount(world), 4);
          yield* assertTaskFiles(world, deliveryId, itemIds, nearLimitPlan.tasks);
          // Whole, as Work serves it and as its file holds it.
          const detail = yield* work
            .getItem(reader, { ref: { ...world.itemRef, itemId: unrecorded } })
            .pipe(Effect.orDie);
          assert.isFalse(detail.bodyTruncated);
          assert.strictEqual(detail.body, expected);
          assert.strictEqual((yield* taskFile(world, unrecorded)).body, expected);
        }),
      options,
    );
  });
});
