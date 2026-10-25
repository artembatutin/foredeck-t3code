import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope } from "@t3tools/contracts";
import { FactoryPlan, type FactoryPlanTask } from "@t3tools/contracts/fd/factory";
import type { WorkItemId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { childReference } from "./plan/childItem.ts";
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
 * child task files the approval writes, and a run that goes on after a child it created was never
 * recorded.
 */

const plan = Schema.decodeSync(FactoryPlan)({
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

/** A started parent whose planner submitted `plan` and whose run ended, approved at the gate. */
const approved = (world: World) =>
  Effect.gen(function* () {
    const planner = yield* world.startWith({ kind: "parent" });
    const factory = yield* service;
    yield* factory.submitPlan({ threadId: planner.threadId, plan }).pipe(Effect.orDie);
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

/** The task file of a Markdown item, as it is in the project's checkout. */
const taskFile = (world: World, itemId: WorkItemId) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const detail = yield* work.getItem(reader, { ref: { ...world.itemRef, itemId } });
    const locator = detail.locator ?? assert.fail(`Item ${itemId} has no file.`);
    const text = yield* fileSystem.readFileString(path.join(world.root, locator));
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
) =>
  Effect.gen(function* () {
    for (const [index, task] of tasks.entries()) {
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

  it.live("takes the child a run created and never recorded instead of writing another", () => {
    // The second child's dependency write fails once: its file is written, never recorded.
    let failBlockedBy = true;
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const deliveryId = yield* approved(world);
          assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
          const [first] = yield* childItemIds(deliveryId);
          assert.deepStrictEqual(yield* childItemIds(deliveryId), [first, null, null]);
          const written = yield* childrenInWork(world);
          assert.strictEqual(written.length, 2);
          const unrecorded = written.find((itemId) => itemId !== first);

          failBlockedBy = false;
          const factory = yield* service;
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const itemIds = (yield* childItemIds(deliveryId)).map(
            (itemId) => itemId ?? assert.fail("A task has no child."),
          );
          // Still three items: the second is the one written before, under its own id.
          assert.deepStrictEqual(itemIds.slice(0, 2), [first, unrecorded]);
          assert.deepStrictEqual(yield* childrenInWork(world), itemIds.toSorted());
          yield* assertTaskFiles(world, deliveryId, itemIds);
          const snapshot = toFactoryDelivery(Option.getOrThrow(yield* factory.get(deliveryId)));
          assert.strictEqual(snapshot.childIds.length, 3);
        }),
      {
        work: (work) => ({
          ...work,
          updateItem: (actor, patch) =>
            patch.blockedBy !== undefined && failBlockedBy
              ? Effect.fail(
                  new FakeWorkUnavailable({
                    detail: "The task file could not be written.",
                  }) as unknown as WorkDomainError,
                )
              : work.updateItem(actor, patch),
        }),
      },
    );
  });
});
