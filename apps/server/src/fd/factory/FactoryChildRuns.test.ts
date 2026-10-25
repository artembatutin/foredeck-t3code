import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProviderRuntimeRecoveryService from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { continueRestartedRun } from "../../orchestration-v2/RestartContinuation.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import { isTerminalRunStatus } from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

/**
 * An approved parent's children on the server's real stack: Markdown children, real Git in the
 * parent's worktree, the fake provider and the server's verify run. Each child's author works on
 * the parent's worktree and branch, from its task baseline, and the next child starts only once
 * the one before is approved. Nothing sleeps: each step drains.
 */

/** A plan of two tasks, the second building on the first. */
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
};

/** `twoTaskPlan` with a third task after them. */
const threeTaskPlan = {
  tasks: [
    ...twoTaskPlan.tasks,
    {
      id: "export-totals",
      title: "Sum the numeric columns",
      kind: "feature",
      summary: "Add a totals row under the exported rows.",
      acceptance: ["The last row sums each numeric column."],
      testPlan: [{ criterion: 1, check: "Sum two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
};

/** A passing review whose one criterion cites the file each child's author commits. */
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "The export works.", paths: ["export.ts"] },
  ],
  missing_evidence: [],
};

const service = Factory.FactoryService.FactoryService;

const taskRows = (parentId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) => store.listByDelivery(parentId)).pipe(
    Effect.orDie,
  );

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

/** The repository's worktrees with the branch each has checked out, and its local branches. */
const checkouts = (world: World) =>
  Effect.all({
    worktrees: git(world.root, ["worktree", "list", "--porcelain"]).pipe(
      Effect.map((list) =>
        list
          .split("\n")
          .filter((line) => line.startsWith("worktree ") || line.startsWith("branch ")),
      ),
    ),
    branches: git(world.root, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
  }).pipe(Effect.orDie);

/**
 * A parent whose planner's plan (two tasks unless given) its owner approved, once its first child
 * has started; `atGate` runs while it waits at the plan gate. Returns the parent, its first two
 * children in plan order and all of them, and the repository's checkouts and the main branch's
 * commit from before the approval: the parent's branch started there.
 */
const approvedParent = <E = never, R = never>(
  world: World,
  options: {
    readonly plan?: unknown;
    readonly atGate?: (worktreePath: string) => Effect.Effect<unknown, E, R>;
  } = {},
) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan: options.plan ?? twoTaskPlan });
    yield* world.endRun(planner.runId, "completed");
    if (options.atGate !== undefined) yield* options.atGate(planner.worktreePath);
    const before = yield* checkouts(world);
    const branchStart = yield* git(world.root, ["rev-parse", "main"]);
    yield* factory.approvePlan(planner.deliveryId);
    yield* drainFactory;
    const parent = yield* stateOf(planner.deliveryId);
    const [first, second] = parent.children;
    if (first === undefined || second === undefined) return assert.fail("Two children exist.");
    return {
      parentId: planner.deliveryId,
      planner: planner.threadId,
      worktreePath: planner.worktreePath,
      branch: parent.branch,
      children: [first, second] as const,
      all: parent.children,
      before,
      branchStart,
    };
  }).pipe(Effect.orDie);

/** The child's reviewer run, once it has started. */
const reviewerOf = (childId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { stage, awaiting } = yield* stateOf(childId);
    assert.strictEqual(stage, "review");
    if (awaiting?.type !== "run") return assert.fail("The child's reviewer is not running.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);

/** The child's reviewer passes the commit and its run completes; record follows. */
const passReview = (world: World, childId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const reviewer = yield* reviewerOf(childId);
    yield* Effect.flatMap(service, (factory) =>
      factory.submitReview({ threadId: reviewer.threadId, review: passingReview }),
    );
    yield* world.endRun(reviewer.runId, "completed");
    return reviewer;
  }).pipe(Effect.orDie);

/** The child's author commits `text` and its run completes; verify and the reviewer follow. */
const authorDone = (world: World, childId: FactoryDeliveryId, subject: string, text: string) =>
  Effect.gen(function* () {
    const author = yield* world.launched(childId);
    yield* authorCommits(author.worktreePath, subject, text);
    yield* world.endRun(author.runId, "completed");
    return author;
  }).pipe(Effect.orDie);

const head = (worktreePath: string) => git(worktreePath, ["rev-parse", "HEAD"]).pipe(Effect.orDie);

/** The `approval-<taskId>.json` a child's record wrote to its own evidence. */
const approvalEvidence = (world: World, childId: FactoryDeliveryId, taskId: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(world.evidenceDir(childId), `approval-${taskId}.json`);
    return { file, evidence: JSON.parse(yield* fileSystem.readFileString(file)) };
  }).pipe(Effect.orDie);

/** The thread's turns the provider was asked to start. */
const turnsOf = (world: World, threadId: ThreadId) =>
  world.provider.started.filter((turn) => turn.threadId === threadId);

describe("an approved parent's children", () => {
  it.live("run one at a time, each with its own author on the parent's worktree and branch", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* approvedParent(world);
        const [first, second] = parent.children;

        // The parent waits for its first child, whose author works on the parent's checkout:
        // no worktree or branch was added for it.
        const waiting = yield* stateOf(parent.parentId);
        assert.strictEqual(waiting.status, "running");
        assert.deepStrictEqual(waiting.awaiting, { type: "child", deliveryId: first });
        const firstAuthor = yield* world.launched(first);
        assert.strictEqual(firstAuthor.worktreePath, parent.worktreePath);
        const firstChild = yield* stateOf(first);
        assert.deepStrictEqual(firstChild.authorLaunch?.workspace, {
          type: "existing_worktree",
          worktreePath: parent.worktreePath,
        });
        const { thread } = yield* threadProjection(firstAuthor.threadId);
        assert.strictEqual(thread.worktreePath, parent.worktreePath);
        assert.strictEqual(
          yield* git(parent.worktreePath, ["branch", "--show-current"]).pipe(Effect.orDie),
          parent.branch,
        );
        assert.deepStrictEqual(yield* checkouts(world), parent.before);
        // Its baseline is where the parent's branch started.
        assert.strictEqual(firstChild.baseline, parent.branchStart);
        assert.strictEqual(waiting.baseline, parent.branchStart);
        // The second child waits its turn, launching nothing.
        assert.strictEqual((yield* stateOf(second)).status, "queued");
        assert.deepStrictEqual(
          world.provider.started.map((turn) => turn.threadId),
          [parent.planner, firstAuthor.threadId],
        );

        yield* authorCommits(parent.worktreePath, "feat: export the table as CSV", "csv\n");
        yield* world.endRun(firstAuthor.runId, "completed");
        // Verified and under review, the first child is not approved yet: no second launch.
        const reviewer = yield* reviewerOf(first);
        assert.strictEqual((yield* stateOf(second)).status, "queued");
        yield* Effect.flatMap(service, (factory) =>
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview }),
        ).pipe(Effect.orDie);
        yield* world.endRun(reviewer.runId, "completed");

        // The record approved the parent's first task for the reviewed commit.
        const approved = yield* head(parent.worktreePath);
        assert.strictEqual((yield* stateOf(first)).status, "approved");
        const [firstTask, secondTask] = yield* taskRows(parent.parentId);
        assert.strictEqual(firstTask?.lastReviewedSha, approved);
        assert.isNull(secondTask?.lastReviewedSha);
        const { file, evidence } = yield* approvalEvidence(world, first, "export-csv");
        assert.deepInclude(evidence, {
          deliveryId: first,
          taskId: "export-csv",
          headSha: approved,
        });
        assert.isFalse(file.startsWith(parent.worktreePath));
        assert.deepStrictEqual((yield* attemptsOf(first)).at(-1), ["record", "passed"]);

        // Then, and only then, the second child's author: a fresh thread on the same checkout,
        // from the commit the first task was approved for.
        const handedOn = yield* stateOf(parent.parentId);
        assert.deepStrictEqual(handedOn.approvedChildren, [first]);
        assert.deepStrictEqual(handedOn.awaiting, { type: "child", deliveryId: second });
        const secondAuthor = yield* world.launched(second);
        assert.notStrictEqual(secondAuthor.threadId, firstAuthor.threadId);
        assert.notStrictEqual(secondAuthor.threadId, reviewer.threadId);
        assert.strictEqual(secondAuthor.worktreePath, parent.worktreePath);
        assert.strictEqual(turnsOf(world, secondAuthor.threadId).length, 1);
        assert.strictEqual((yield* stateOf(second)).baseline, approved);
        assert.deepStrictEqual(yield* checkouts(world), parent.before);

        // The second child runs through the same way; the parent then leaves its children.
        yield* authorCommits(parent.worktreePath, "fix: write a header row first", "h\ncsv\n");
        yield* world.endRun(secondAuthor.runId, "completed");
        yield* passReview(world, second);
        assert.strictEqual((yield* stateOf(second)).status, "approved");
        const [, secondApproved] = yield* taskRows(parent.parentId);
        assert.strictEqual(secondApproved?.lastReviewedSha, yield* head(parent.worktreePath));
        const done = yield* stateOf(parent.parentId);
        assert.deepStrictEqual(done.approvedChildren, [first, second]);
        assert.notStrictEqual(done.awaiting?.type, "child");
        assert.strictEqual(done.stage, "integrate");
        // No child opened a pull request of its own.
        assert.deepStrictEqual(world.pullRequestCalls, []);
      }),
    ),
  );

  it.live("judge each child's branch only by the commits after its task baseline", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        // A commit lands on the parent's branch while its plan waits at the gate.
        const parent = yield* approvedParent(world, {
          atGate: (worktreePath) =>
            authorCommits(worktreePath, "docs: note the CSV format", "format\n"),
        });
        const [first, second] = parent.children;

        // The first child starts where the parent's branch started, not at the HEAD it found,
        // so its review covers that commit too.
        const firstAuthor = yield* world.launched(first);
        const landed = yield* head(parent.worktreePath);
        assert.notStrictEqual(landed, parent.branchStart);
        assert.strictEqual((yield* stateOf(first)).baseline, parent.branchStart);
        yield* authorCommits(parent.worktreePath, "feat: export the table as CSV", "csv\n");
        yield* world.endRun(firstAuthor.runId, "completed");
        const reviewer = yield* passReview(world, first);
        const [reviewTurn] = turnsOf(world, reviewer.threadId);
        const [firstTask] = yield* taskRows(parent.parentId);
        const approved = firstTask?.lastReviewedSha;
        assert.strictEqual(approved, yield* head(parent.worktreePath));
        assert.include(reviewTurn?.message.text, `${parent.branchStart}..${approved}`);

        // The second child's baseline is that approval, so no commit before it is the second's.
        const author = yield* world.launched(second);
        assert.strictEqual((yield* stateOf(second)).baseline, approved);
        yield* world.endRun(author.runId, "completed");
        // Its one fix-commit turn adds nothing either, and the branch does not settle.
        const fixing = yield* stateOf(second);
        if (fixing.awaiting?.type !== "run") return assert.fail("No fix-commit turn runs.");
        assert.strictEqual(fixing.awaiting.threadId, author.threadId);
        assert.strictEqual(
          yield* runReached(fixing.awaiting.runId, ["starting", ...ended]),
          "starting",
        );
        yield* drainOrchestration;
        yield* world.endRun(fixing.awaiting.runId, "completed");

        const blocked = yield* stateOf(second);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, {
          reason: "unsettled",
          problems: ["No commit was added since the baseline."],
        });
        assert.deepStrictEqual(blocked.receipts, []);
        // Only that child blocks; the parent waits for it.
        const waiting = yield* stateOf(parent.parentId);
        assert.strictEqual(waiting.status, "running");
        assert.deepStrictEqual(waiting.awaiting, { type: "child", deliveryId: second });
      }),
    ),
  );

  it.live("block only a child whose worktree moved before record; its resume goes on", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const parent = yield* approvedParent(world);
        const [first, second] = parent.children;
        yield* authorDone(world, first, "feat: export the table as CSV", "csv\n");
        const reviewed = yield* head(parent.worktreePath);
        const reviewer = yield* reviewerOf(first);
        yield* factory
          .submitReview({ threadId: reviewer.threadId, review: passingReview })
          .pipe(Effect.orDie);
        const parentBefore = yield* stateOf(parent.parentId);

        // A commit lands while the reviewer's run goes on: HEAD is no longer the reviewed one.
        yield* authorCommits(parent.worktreePath, "fix: quote the CSV fields", "quoted\n");
        const moved = yield* head(parent.worktreePath);
        yield* world.endRun(reviewer.runId, "completed");

        const blocked = yield* stateOf(first);
        assert.strictEqual(blocked.status, "blocked");
        assert.strictEqual(blocked.block?.reason, "record_mismatch");
        if (blocked.block?.reason === "record_mismatch") {
          assert.strictEqual(blocked.block.expected.headSha, reviewed);
          assert.strictEqual(blocked.block.actual.headSha, moved);
          assert.deepStrictEqual(blocked.block.differences, [
            "head_changed",
            "tree_changed",
            "not_reviewed",
          ]);
        }
        // Nothing was approved, and the parent still waits for that child; the next one waits.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.isFalse(
          yield* fileSystem.exists(path.join(world.evidenceDir(first), "approval-export-csv.json")),
        );
        assert.isNull((yield* taskRows(parent.parentId))[0]?.lastReviewedSha);
        assert.deepStrictEqual(yield* stateOf(parent.parentId), parentBefore);
        assert.strictEqual((yield* stateOf(second)).status, "queued");

        // Resumed, the child verifies and reviews the moved commit, records it, and the parent
        // starts its second child from it.
        yield* factory.resume(first).pipe(Effect.orDie);
        yield* drainFactory;
        const again = yield* passReview(world, first);
        assert.notStrictEqual(again.threadId, reviewer.threadId);
        assert.strictEqual((yield* stateOf(first)).status, "approved");
        assert.strictEqual((yield* taskRows(parent.parentId))[0]?.lastReviewedSha, moved);
        const { evidence } = yield* approvalEvidence(world, first, "export-csv");
        assert.strictEqual(evidence.headSha, moved);
        const handedOn = yield* stateOf(parent.parentId);
        assert.deepStrictEqual(handedOn.approvedChildren, [first]);
        assert.deepStrictEqual(handedOn.awaiting, { type: "child", deliveryId: second });
        yield* world.launched(second);
        assert.strictEqual((yield* stateOf(second)).baseline, moved);
      }),
    ),
  );

  it.live("are cancelled with their parent, and the running one's author is interrupted", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const factory = yield* service;
        const parent = yield* approvedParent(world);
        const [first, second] = parent.children;
        const author = yield* world.launched(first);
        yield* authorCommits(parent.worktreePath, "feat: export the table as CSV", "csv\n");
        const committed = yield* head(parent.worktreePath);

        const cancelled = yield* factory.cancel(parent.parentId).pipe(Effect.orDie);
        assert.strictEqual(cancelled.state.status, "cancelled");
        yield* drainFactory;
        yield* drainOrchestration;
        const firstCancelled = yield* stateOf(first);
        const secondCancelled = yield* stateOf(second);
        assert.strictEqual(firstCancelled.status, "cancelled");
        assert.isNull(firstCancelled.awaiting);
        // The child it never started goes with it, so its item can be delivered again.
        assert.strictEqual(secondCancelled.status, "cancelled");
        // The running author's turn was asked to stop, through the thread's own interrupt.
        const turn = world.provider.started.find(({ runId }) => runId === author.runId);
        assert.deepStrictEqual(
          world.provider.interrupted.map(({ providerTurnId }) => providerTurnId),
          [`provider-turn:${turn?.attemptId}`],
        );
        assert.deepStrictEqual((yield* attemptsOf(first)).at(-1), ["author", "cancelled"]);

        // Its run then completes anyway: neither delivery takes it.
        yield* world.endRun(author.runId, "completed");
        assert.deepStrictEqual(yield* stateOf(parent.parentId), cancelled.state);
        assert.deepStrictEqual(yield* stateOf(first), firstCancelled);
        assert.deepStrictEqual(yield* stateOf(second), secondCancelled);
        assert.strictEqual(turnsOf(world, author.threadId).length, 1);

        // The worktree, its branch and the child's commit stay.
        assert.isTrue(yield* fileSystem.exists(parent.worktreePath));
        assert.strictEqual(yield* head(parent.worktreePath), committed);
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${parent.branch}`]),
          committed,
        );
      }),
    ),
  );

  it.live("are cancelled with a parent cancelled while the first's launch is pending", () =>
    Effect.gen(function* () {
      // The first child's author launch waits here, before anything is dispatched for it.
      const launching = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hold = { armed: true };
      return yield* withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const factory = yield* service;
            const planner = yield* world.startWith({ kind: "parent" });
            yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTaskPlan });
            yield* world.endRun(planner.runId, "completed");
            yield* factory.approvePlan(planner.deliveryId);
            yield* Deferred.await(launching);
            const [first, second] = (yield* stateOf(planner.deliveryId)).children;
            if (first === undefined || second === undefined) return assert.fail("No children.");
            assert.strictEqual((yield* stateOf(first)).status, "running");
            const committed = yield* head(planner.worktreePath);

            const cancelled = yield* factory.cancel(planner.deliveryId);
            assert.strictEqual(cancelled.state.status, "cancelled");
            const firstCancelled = yield* stateOf(first);
            assert.strictEqual(firstCancelled.status, "cancelled");
            assert.strictEqual((yield* stateOf(second)).status, "cancelled");

            // The launch goes through after the cancel: neither delivery takes it, and its run is
            // interrupted, so no agent works on in the shared worktree.
            yield* Deferred.succeed(release, undefined);
            yield* drainFactory;
            yield* drainOrchestration;
            const { runs } = yield* threadProjection(ThreadId.make(`factory-thread:${first}:1`));
            assert.deepStrictEqual(
              runs.map(({ status }) => status),
              ["interrupted"],
            );
            assert.deepStrictEqual(yield* stateOf(first), firstCancelled);
            assert.deepStrictEqual(yield* stateOf(planner.deliveryId), cancelled.state);
            assert.strictEqual((yield* stateOf(second)).status, "cancelled");
            // The provider never started a turn for it.
            assert.deepStrictEqual(turnsOf(world, ThreadId.make(`factory-thread:${first}:1`)), []);

            // The worktree and its branch stay.
            assert.isTrue(yield* fileSystem.exists(planner.worktreePath));
            assert.strictEqual(yield* head(planner.worktreePath), committed);
          }).pipe(Effect.orDie),
        {
          work: (work) => ({
            ...work,
            linkLaunch: (input, launch) =>
              hold.armed && input.threadId.startsWith("factory-thread:child-")
                ? Effect.gen(function* () {
                    hold.armed = false;
                    yield* Deferred.succeed(launching, undefined);
                    yield* Deferred.await(release);
                    return yield* work.linkLaunch(input, launch);
                  })
                : work.linkLaunch(input, launch),
          }),
        },
      );
    }),
  );

  it.live("are cancelled with their parent when the owner cancels one, keeping approvals", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const factory = yield* service;
        const parent = yield* approvedParent(world, { plan: threeTaskPlan });
        const [first, second] = parent.children;
        const third = parent.all[2] ?? assert.fail("Three children exist.");
        yield* authorDone(world, first, "feat: export the table as CSV", "csv\n");
        yield* passReview(world, first);
        const approved = yield* head(parent.worktreePath);
        const author = yield* world.launched(second);
        yield* authorCommits(parent.worktreePath, "fix: write a header row first", "h\ncsv\n");
        const committed = yield* head(parent.worktreePath);

        // Owner decision: cancelling a child cancels its parent and its unfinished siblings.
        const cancelled = yield* factory.cancel(second).pipe(Effect.orDie);
        assert.strictEqual(cancelled.state.status, "cancelled");
        yield* drainFactory;
        yield* drainOrchestration;
        const ended = {
          parent: yield* stateOf(parent.parentId),
          first: yield* stateOf(first),
          second: yield* stateOf(second),
          third: yield* stateOf(third),
        };
        assert.strictEqual(ended.parent.status, "cancelled");
        assert.isNull(ended.parent.awaiting);
        assert.strictEqual(ended.second.status, "cancelled");
        assert.strictEqual(ended.third.status, "cancelled");
        // The approved child keeps its approval, as the parent's task does.
        assert.strictEqual(ended.first.status, "approved");
        assert.strictEqual((yield* taskRows(parent.parentId))[0]?.lastReviewedSha, approved);
        const { evidence } = yield* approvalEvidence(world, first, "export-csv");
        assert.strictEqual(evidence.headSha, approved);
        // The cancelled child's author was asked to stop its run, through the thread's interrupt.
        const turn = world.provider.started.find(({ runId }) => runId === author.runId);
        assert.deepStrictEqual(
          world.provider.interrupted.map(({ providerTurnId }) => providerTurnId),
          [`provider-turn:${turn?.attemptId}`],
        );

        // It cannot resume, and its run's late end changes no delivery.
        const refused = yield* Effect.flip(factory.resume(second));
        assert.strictEqual(refused._tag, "FactoryResumeRefusedError");
        yield* world.endRun(author.runId, "completed");
        assert.deepStrictEqual(
          {
            parent: yield* stateOf(parent.parentId),
            first: yield* stateOf(first),
            second: yield* stateOf(second),
            third: yield* stateOf(third),
          },
          ended,
        );
        assert.strictEqual(turnsOf(world, author.threadId).length, 1);

        // The worktree, its branch and every commit stay.
        assert.isTrue(yield* fileSystem.exists(parent.worktreePath));
        assert.strictEqual(yield* head(parent.worktreePath), committed);
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${parent.branch}`]),
          committed,
        );
      }),
    ),
  );

  it.live.each([
    { shape: "with its parent", parentCancelled: true },
    { shape: "on its own", parentCancelled: false },
  ])(
    "stop the turn a restart carries on for a child cancelled $shape before its interrupt",
    ({ parentCancelled }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const worker = yield* Factory.FactoryWorker.FactoryWorker;
          const parent = yield* approvedParent(world);
          const [first, second] = parent.children;
          const author = yield* world.launched(first);
          // Its provider is working on the turn, as core recovery reads it.
          yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
            sink.stream().pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "provider-turn.updated" &&
                  event.threadId === author.threadId &&
                  event.payload.status === "running",
              ),
              Stream.runHead,
            ),
          );
          yield* authorCommits(parent.worktreePath, "feat: export the table as CSV", "csv\n");
          const committed = yield* head(parent.worktreePath);

          // The cancels were stored, and the server stopped before it sent any interrupt.
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const cut = parentCancelled ? [parent.parentId, first, second] : [first];
          for (const deliveryId of cut) {
            const state = yield* stateOf(deliveryId);
            yield* store.update(deliveryId, advance(state, { type: "cancel" }).delivery);
          }

          // The restart: core recovery cuts the turn, Factory's sweep completes the cancellation,
          // and core's restart continuation (as its effect worker runs it) carries the turn on.
          const recovery = yield* Effect.service(
            ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService,
          ).pipe(
            Effect.provide(
              ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(EffectOutbox.layer)),
            ),
          );
          yield* recovery.reconcile("startup");
          yield* drainOrchestration;
          yield* worker.finishCancellation(parent.parentId);
          yield* continueRestartedRun({ threadId: author.threadId, sourceRunId: author.runId });
          yield* drainFactory;
          yield* drainOrchestration;
          yield* drainFactory;

          // Factory interrupted the continuation; once its provider stops, no run of the cancelled
          // child's thread is live.
          const continued = (yield* threadProjection(author.threadId)).runs.find(
            (run) => run.restartContinuationOfRunId === author.runId,
          );
          if (continued === undefined) return assert.fail("Core did not continue the turn.");
          const turn = world.provider.started.find(({ runId }) => runId === continued.id);
          if (turn !== undefined) {
            assert.deepStrictEqual(
              world.provider.interrupted.map(({ providerTurnId }) => providerTurnId),
              [`provider-turn:${turn.attemptId}`],
            );
            yield* world.endRun(continued.id, "cancelled");
          }
          const { runs } = yield* threadProjection(author.threadId);
          assert.isTrue(runs.every(({ status }) => isTerminalRunStatus(status)));
          for (const deliveryId of [parent.parentId, first, second]) {
            assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
          }

          // The owner's own turn on that thread afterwards is theirs, and runs on.
          const ownTurn = yield* Effect.flatMap(
            ThreadManagement.ThreadManagementService,
            (threads) =>
              threads.sendToThread({
                projectId: world.projectId,
                commandId: CommandId.make("owner-turn"),
                threadId: author.threadId,
                messageId: MessageId.make("owner-turn-message"),
                text: "Summarize what you changed.",
                attachments: [],
                mode: "queue",
                createdBy: "user",
                creationSource: "web",
              }),
          );
          yield* drainOrchestration;
          yield* drainFactory;
          const owned = (yield* threadProjection(author.threadId)).runs.find(
            ({ id }) => id === ownTurn.run.id,
          );
          assert.isFalse(owned === undefined || isTerminalRunStatus(owned.status));
          assert.isFalse(
            world.provider.interrupted.some(
              ({ providerTurnId }) =>
                providerTurnId ===
                `provider-turn:${world.provider.started.find(({ runId }) => runId === ownTurn.run.id)?.attemptId}`,
            ),
          );

          // The worktree, its branch and the commit stay.
          assert.isTrue(yield* fileSystem.exists(parent.worktreePath));
          assert.strictEqual(yield* head(parent.worktreePath), committed);
          assert.strictEqual(
            yield* git(world.root, ["rev-parse", `refs/heads/${parent.branch}`]),
            committed,
          );
        }),
      ).pipe(Effect.orDie),
  );
});
