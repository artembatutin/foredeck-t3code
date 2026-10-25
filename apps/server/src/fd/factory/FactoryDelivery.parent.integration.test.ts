import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, type RunId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemSummary, WorkListResult } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import { childDeliveryId } from "./FactoryChildren.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  git,
  runReached,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

/**
 * A parent delivery end to end on the server's real stack: a Git project whose Markdown source
 * holds the parent item, the fake provider, the server's verify runs and an isolated bare
 * `origin` the fake PR service pushes to. It plans, waits at the plan gate for its owner, creates
 * its children in the source on approval, runs them in plan order on its one branch, integrates
 * and opens one pull request. Nothing sleeps: each step drains.
 */

/** Two tasks; the owner runs the second first. */
const twoTaskPlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names."],
      testPlan: [{ criterion: 1, check: "Read the first line.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "Both tasks change the export module.",
};
/** What each task's child commits, so the branch's history shows the order the children ran. */
const subjects: Readonly<Record<string, string>> = {
  "export-csv": "feat: export the table as CSV",
  "export-header": "fix: write the header row first",
};

const passingReview = (criteria: number) => ({
  verdict: "pass",
  findings: [],
  acceptance: Array.from({ length: criteria }, (_, index) => ({
    criterion: index + 1,
    status: "verified",
    evidence: "The export does what the criterion says.",
    paths: ["export.ts"],
  })),
  missing_evidence: [],
});

/** Reads the parent's Markdown source as its owner does. */
const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };

const service = Factory.FactoryService.FactoryService;

/** Every item of the project's Markdown source. */
const sourceItems = (world: World) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const items: Array<WorkItemSummary> = [];
    let cursor: string | null = null;
    do {
      const page: WorkListResult = yield* work.listItems(reader, {
        sourceId: world.itemRef.sourceId,
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return items;
  }).pipe(Effect.orDie);

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

/** The run the delivery awaits, once its provider turn has started. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);

const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((turn) => turn.runId === runId) ??
  assert.fail(`No provider turn started run ${runId}.`);

/** Starts the parent and waits at the plan gate with its planner's `plan`. */
const planned = (world: World, plan: unknown) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan });
    yield* world.endRun(planner.runId, "completed");
    const state = yield* stateOf(planner.deliveryId);
    assert.strictEqual(state.status, "waiting");
    assert.strictEqual(state.stage, "approve_plan");
    return planner;
  }).pipe(Effect.orDie);

describe("Factory parent delivery end to end", () => {
  it.live(
    "plans, takes the owner's reordering edit, runs the children in that order and opens one PR",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const work = yield* WorkService.WorkService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const planner = yield* planned(world, twoTaskPlan);
          const { deliveryId: parentId, worktreePath } = planner;
          const branchStart = yield* git(world.root, ["rev-parse", "main"]);

          // The owner runs the header task first, then approves.
          const edited = { ...twoTaskPlan, tasks: twoTaskPlan.tasks.toReversed() };
          const order = edited.tasks.map((task) => task.id);
          yield* factory.updatePlan({ deliveryId: parentId, plan: edited });
          assert.deepStrictEqual(
            (yield* stateOf(parentId)).plan?.tasks.map((task) => task.id),
            order,
          );
          yield* factory.approvePlan(parentId);
          yield* drainFactory;

          // One child item per task in the parent's Markdown source, under the parent, in the
          // edited order, each blocked by the one before; one child delivery each.
          const parent = yield* stateOf(parentId);
          const tasks = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
            store.listByDelivery(parentId),
          );
          assert.deepStrictEqual(
            tasks.map(({ taskId }) => taskId),
            order,
          );
          assert.deepStrictEqual(
            parent.children,
            tasks.map(({ taskId }) => childDeliveryId(parentId, taskId)),
          );
          const childItems = yield* Effect.forEach(tasks, ({ childItemId }) =>
            childItemId === null
              ? Effect.die("A child item is not recorded.")
              : work.getItem(reader, {
                  ref: { sourceId: world.itemRef.sourceId, itemId: childItemId },
                }),
          ).pipe(Effect.orDie);
          assert.deepStrictEqual(
            childItems.map(({ title, parent: itemParent }) => ({ title, parent: itemParent })),
            edited.tasks.map(({ title }) => ({ title, parent: world.itemRef.itemId })),
          );
          assert.deepStrictEqual(
            childItems.map(({ blockedBy }) => blockedBy),
            [[], ...childItems.slice(0, -1).map(({ ref }) => [ref.itemId])],
          );
          assert.deepStrictEqual(
            (yield* sourceItems(world)).map(({ ref }) => ref.itemId).toSorted(),
            [world.itemRef.itemId, ...childItems.map(({ ref }) => ref.itemId)].toSorted(),
          );

          // Each child in turn: its own author commits on the shared worktree, its reviewer
          // passes it, and the next starts only once it is approved.
          const authors = [];
          for (const [index, childId] of parent.children.entries()) {
            const later = parent.children.slice(index + 1);
            for (const next of later) assert.strictEqual((yield* stateOf(next)).status, "queued");
            const author = yield* world.launched(childId);
            assert.strictEqual(author.worktreePath, worktreePath);
            const taskId = order[index] ?? assert.fail("No task.");
            yield* authorCommits(worktreePath, subjects[taskId] ?? "", `${taskId}\n`);
            yield* world.endRun(author.runId, "completed");
            const reviewer = yield* awaitedRun(childId);
            yield* factory.submitReview({ threadId: reviewer.threadId, review: passingReview(1) });
            yield* world.endRun(reviewer.runId, "completed");
            const child = yield* stateOf(childId);
            assert.strictEqual(child.status, "approved");
            assert.isNull(child.pullRequest);
            authors.push(author.threadId);
          }
          // No child opened a pull request.
          assert.deepStrictEqual(world.pullRequestCalls, []);

          // Integrate: a fresh verify of the whole branch, then a new reviewer of both criteria.
          const integrating = yield* stateOf(parentId);
          assert.strictEqual(integrating.stage, "integrate");
          const integrateReviewer = yield* awaitedRun(parentId);
          assert.notInclude([planner.threadId, ...authors], integrateReviewer.threadId);
          yield* factory.submitReview({
            threadId: integrateReviewer.threadId,
            review: passingReview(2),
          });
          yield* world.endRun(integrateReviewer.runId, "completed");

          // The branch's commits are the children's, in the edited order.
          const history = yield* git(worktreePath, [
            "log",
            "--reverse",
            "--format=%s",
            `${branchStart}..HEAD`,
          ]);
          assert.deepStrictEqual(
            history.split("\n"),
            order.map((taskId) => subjects[taskId]),
          );

          // Record approved the branch, and exactly one pull request was opened for it, from the
          // parent's worktree, linked to the last child's author thread.
          const done = yield* stateOf(parentId);
          assert.strictEqual(done.status, "pr_open");
          assert.strictEqual(done.stage, "pr");
          assert.deepStrictEqual(done.pullRequest, { ...fakePullRequest, headBranch: done.branch });
          const approval = JSON.parse(
            yield* fileSystem.readFileString(
              path.join(world.evidenceDir(parentId), "approval.json"),
            ),
          );
          const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);
          assert.strictEqual(approval.headSha, head);
          assert.strictEqual(done.receipts.at(-1)?.headSha, head);
          assert.strictEqual(world.pullRequestCalls.length, 1);
          const [call] = world.pullRequestCalls;
          assert.strictEqual(call?.input.action, "create_pr");
          assert.strictEqual(call?.input.cwd, worktreePath);
          assert.strictEqual(call?.input.threadId, authors.at(-1));
          assert.strictEqual(call?.input.expectedHeadSha, approval.headSha);
          assert.strictEqual(call?.input.prTitle, `${world.itemKey}: ${world.itemTitle}`);
          const body = call?.input.prBody ?? "";
          const listed = childItems.map(
            ({ key, title }, index) => `${index + 1}. ${key}: ${title}`,
          );
          const positions = listed.map((line) => body.indexOf(line));
          assert.isTrue(positions.every((position) => position >= 0));
          assert.isTrue((positions[0] ?? 0) < (positions[1] ?? 0));
          // The isolated remote's branch head is the commit the parent's approval covers.
          const published = yield* git(worktreePath, [
            "ls-remote",
            "origin",
            `refs/heads/${done.branch}`,
          ]);
          assert.strictEqual(published.split("\t")[0], approval.headSha);

          // Every child stays approved without a pull request of its own.
          for (const childId of parent.children) {
            const child = yield* stateOf(childId);
            assert.strictEqual(child.status, "approved");
            assert.isNull(child.pullRequest);
          }
          assert.deepStrictEqual((yield* attemptsOf(parentId)).slice(-4), [
            ["verify", "passed"],
            ["integrate", "passed"],
            ["record", "passed"],
            ["pr", "passed"],
          ]);
          assert.strictEqual(
            yield* git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
            "",
          );
        }),
      ),
  );

  it.live("cancels the parent on a rejected plan, creating no child item", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const planner = yield* planned(world, twoTaskPlan);
        const before = yield* sourceItems(world);
        assert.deepStrictEqual(
          before.map(({ ref }) => ref.itemId),
          [world.itemRef.itemId],
        );

        yield* factory.rejectPlan(planner.deliveryId);
        yield* drainFactory;
        yield* drainOrchestration;

        const state = yield* stateOf(planner.deliveryId);
        assert.strictEqual(state.status, "cancelled");
        assert.isFalse(state.planApproved);
        assert.deepStrictEqual(state.children, []);
        assert.isNull(state.awaiting);
        // The source lists no new item, and no task, child delivery or thread turn followed.
        assert.deepStrictEqual(yield* sourceItems(world), before);
        assert.deepStrictEqual(
          yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
            store.listByDelivery(planner.deliveryId),
          ),
          [],
        );
        assert.deepStrictEqual(
          world.provider.started.map(({ threadId }) => threadId),
          [planner.threadId],
        );
        assert.deepStrictEqual(world.pullRequestCalls, []);
        assert.deepStrictEqual(yield* attemptsOf(planner.deliveryId), [
          ["plan", "passed"],
          ["approve_plan", "cancelled"],
        ]);
      }),
    ),
  );

  it.live("sends a replan's note to the planner once, and waits at the gate on its new plan", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const planner = yield* planned(world, twoTaskPlan);
        const { deliveryId } = planner;
        const note = "Keep it to one task.\nThe header belongs with the export.";

        yield* factory.replan({ deliveryId, note });
        yield* drainFactory;

        // One turn on the planner thread, carrying the owner's note, in a new plan round.
        const replanning = yield* stateOf(deliveryId);
        assert.strictEqual(replanning.status, "running");
        assert.strictEqual(replanning.stage, "plan");
        assert.strictEqual(replanning.planRound, 2);
        const replan = yield* awaitedRun(deliveryId);
        assert.strictEqual(replan.threadId, planner.threadId);
        assert.notStrictEqual(replan.runId, planner.runId);
        assert.deepStrictEqual(
          world.provider.started.map(({ threadId }) => threadId),
          [planner.threadId, planner.threadId],
        );
        const text = turnOf(world, replan.runId).message.text;
        assert.include(text, "The owner sent your plan back from Factory's plan gate");
        assert.include(text, "> Keep it to one task.\n> The header belongs with the export.");

        // The plan it submits next replaces the old one at the gate.
        const onePlan = { tasks: [twoTaskPlan.tasks[0]], note: "One task covers both." };
        yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
        yield* world.endRun(replan.runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.strictEqual(state.plan?.round, 2);
        assert.deepStrictEqual(
          state.plan?.tasks.map((task) => task.id),
          ["export-csv"],
        );
        assert.strictEqual(state.plan?.note, onePlan.note);
        const snapshot = Option.getOrThrow(yield* factory.get(deliveryId));
        assert.strictEqual(
          toFactoryDelivery(snapshot).needsYou,
          "A plan of 1 task awaits your approval.",
        );
        assert.strictEqual(world.provider.started.length, 2);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", "failed"],
          ["plan", "passed"],
          ["approve_plan", null],
        ]);
      }),
    ),
  );
});
