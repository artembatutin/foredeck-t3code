import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryPlan, type FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type WorkActor, WorkService, workItemScopeFingerprint } from "../work-management/index.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import { childDeliveryId } from "./FactoryChildren.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { childItemFingerprint } from "./plan/childItem.ts";
import {
  drainFactory,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { editTaskFile } from "./testkit/followThrough.ts";

/**
 * Whether a child's item still says what its frozen task does, judged on real task files in a
 * temporary repository's Markdown source: what Factory wrote for each task, read back through
 * Work, fingerprints as the task row renders it, however Markdown stores its text and whatever
 * comments Work and Factory add under its `## Notes`. A file changed in the source itself, behind
 * Work's back, no longer does, until it says what it said again.
 */

type Opening = FactoryAdmission.FactoryOpening;

const decodePlan = Schema.decodeSync(FactoryPlan);

/**
 * Tasks whose text Markdown stores other than as written, or that reads like the structure Work
 * keeps in a task file: a `## Notes` heading of the task's own, where Work then adds comments.
 */
const plan = decodePlan({
  tasks: [
    {
      id: "export-csv",
      title: "Export the table as CSV — naïve café ✓",
      kind: "feature",
      summary: [
        "Add a CSV export of the visible rows behind the `Export` button.   ",
        "Rows keep their order.\t",
        "",
        "> Keep this note a quote.",
        "",
        "## Notes",
        "",
        "The export runs in the browser.",
      ].join("\n"),
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [
        { criterion: 1, check: "Export two rows and read back the CSV.", paths: ["src/a.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-conflicts",
      title: "Resolve exports that hold a conflict",
      kind: "fix",
      summary: [
        "Resolve exports that still hold a conflict such as:",
        "<<<<<<< HEAD",
        "export const separator = ',';",
        "=======",
        "export const separator = ';';",
        ">>>>>>> topic",
      ].join("\n"),
      acceptance: [
        "No export holds a conflict marker.",
        "A line of\n=======\nalone still exports.",
      ],
      testPlan: [
        { criterion: 1, check: "Export a resolved file.", paths: ["src/b.test.ts"] },
        { criterion: 2, check: "Export the lone line.", paths: [] },
      ],
      likelyPaths: ["src/conflicts.ts"],
      risk: "high",
    },
  ],
  note: "Both tasks change the export module.",
});

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};
const service = Factory.FactoryService.FactoryService;
const proceed: FactoryAdmission.FactoryAdmissionDecision = { type: "proceed" };

/**
 * A manager that manages every root, holds back every child's launch while `held`, and refuses a
 * child's opening exactly when its item no longer says what its task does; every opening it is
 * asked about is recorded in order.
 */
const managingPort = () => {
  const asked: Array<Opening> = [];
  const control = { held: false };
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed("active"),
    enter: (entry) =>
      Effect.succeed(
        control.held && entry.effectType === "launch_thread" && entry.deliveryId !== entry.root
          ? { type: "defer" }
          : proceed,
      ),
    authorizeOpening: (opening) =>
      Effect.sync(() => {
        asked.push(opening);
        return opening.childScopeMatches === false
          ? { type: "refuse", category: "scope_changed" }
          : { type: "allow" };
      }),
  };
  return { asked, control, port };
};

/** Work's read of the item from the source as it is now, past Work's cache. */
const freshRead = (ref: WorkItemRef) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    yield* work.refresh(owner, {});
    return yield* work.getItem(owner, { ref });
  }).pipe(Effect.orDie);

/** Starts a parent with the plan above and approves it at its gate. */
const approvedParent = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan });
    yield* world.endRun(planner.runId, "completed");
    yield* factory.approvePlan(planner.deliveryId);
    yield* drainFactory;
    return planner.deliveryId;
  }).pipe(Effect.orDie);

/** Each frozen task with its child's item, and what Factory wrote for it, fingerprinted. */
const childrenOf = (world: World, parentId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const rows = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
      store.listByDelivery(parentId),
    ).pipe(Effect.orDie);
    return rows.map(({ taskId, plan: task, childItemId }) => ({
      deliveryId: childDeliveryId(parentId, taskId),
      ref: {
        sourceId: world.itemRef.sourceId,
        itemId: childItemId ?? assert.fail(`Task ${taskId} has no child.`),
      },
      written: childItemFingerprint({
        parent: world.itemRef,
        deliveryId: parentId,
        task: task ?? assert.fail(`Task ${taskId} has no plan.`),
      }),
    }));
  });

/** The text of the item's task file in the project's checkout. */
const taskFileText = (world: World, ref: WorkItemRef) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const detail = yield* freshRead(ref);
    return yield* fileSystem.readFileString(
      path.join(world.root, detail.locator ?? assert.fail(`Item ${ref.itemId} has no file.`)),
    );
  }).pipe(Effect.orDie);

describe("a child's scope on real Markdown task files", () => {
  it.live(
    "matches every unedited child as its frozen task writes it, through Markdown's escapes and every comment Work and Factory add",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const work = yield* WorkService.WorkService;
            const parentId = yield* approvedParent(world);
            const children = yield* childrenOf(world, parentId);
            assert.strictEqual(children.length, 2);
            const [first, second] = children;
            if (first === undefined || second === undefined) return assert.fail("No children.");

            // Markdown stores the second task's conflict lines escaped, not as written.
            const conflicts = yield* taskFileText(world, second.ref);
            for (const line of ["\\<<<<<<< HEAD", "\\=======", "\\>>>>>>> topic"]) {
              assert.include(conflicts.split("\n"), line);
            }
            for (const child of children) {
              assert.strictEqual(
                workItemScopeFingerprint(yield* freshRead(child.ref)),
                child.written,
              );
            }

            // The first child's author asked with the item it renders, which matches.
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: parentId,
              deliveryId: first.deliveryId,
              role: "author",
              fingerprint: first.written,
              status: (yield* freshRead(first.ref)).status,
              childScopeMatches: true,
            });

            // Comments go under each item's `## Notes`, as an agent's and Factory's do.
            for (const child of children) {
              yield* work
                .addComment(owner, { ref: child.ref, body: "Checked the export by hand." })
                .pipe(Effect.orDie);
              const commented = yield* freshRead(child.ref);
              assert.include(commented.body, "## Notes");
              assert.include(commented.body, "Checked the export by hand.");
              assert.strictEqual(workItemScopeFingerprint(commented), child.written);
            }
          }),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "no longer matches a child whose task file changed in the source after approval, and matches it again once the file says what it did",
    () => {
      const manager = managingPort();
      manager.control.held = true;
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const parentId = yield* approvedParent(world);
            const [first] = yield* childrenOf(world, parentId);
            if (first === undefined) return assert.fail("No children.");
            assert.deepStrictEqual((yield* stateOf(first.deliveryId)).admissionWait, {
              effectId: 1,
            });

            // Someone edits the child's criterion in their editor, not through Work.
            const criterion = "1. The export button downloads the visible rows as CSV.";
            const changed = "1. The export button downloads every row as CSV.";
            yield* editTaskFile(world, first.ref, (text) => text.replace(criterion, changed));
            const edited = yield* freshRead(first.ref);
            assert.include(edited.body, changed);
            assert.notStrictEqual(workItemScopeFingerprint(edited), first.written);

            manager.control.held = false;
            assert.strictEqual(yield* factory.redispatch(first.deliveryId, 1), "dispatched");
            yield* drainFactory;
            const refused = yield* stateOf(first.deliveryId);
            assert.strictEqual(refused.status, "blocked");
            assert.deepStrictEqual(
              refused.block?.reason === "effect_failed" ? refused.block.detail : refused.block,
              `Factory did not launch the author thread. ${FactoryAdmission.admissionRefusalText.scope_changed}`,
            );
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: parentId,
              deliveryId: first.deliveryId,
              role: "author",
              fingerprint: workItemScopeFingerprint(edited),
              status: edited.status,
              childScopeMatches: false,
            });

            // Put back as it was, the file keeps the comment Factory posted on the block.
            yield* editTaskFile(world, first.ref, (text) => text.replace(changed, criterion));
            const restored = yield* freshRead(first.ref);
            assert.include(restored.body, "## Notes");
            assert.include(restored.body, "Factory is blocked on this item and needs you.");
            assert.strictEqual(workItemScopeFingerprint(restored), first.written);

            yield* factory.resume(first.deliveryId).pipe(Effect.orDie);
            const author = yield* world.launched(first.deliveryId);
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: parentId,
              deliveryId: first.deliveryId,
              role: "author",
              fingerprint: first.written,
              status: restored.status,
              childScopeMatches: true,
            });
            const stored = yield* Effect.flatMap(
              FactoryDeliveryStore.FactoryDeliveryStore,
              (store) => store.get(first.deliveryId),
            ).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
            assert.strictEqual(stored.state.threads.author, author.threadId);
          }),
        { admission: manager.port },
      );
    },
  );
});
