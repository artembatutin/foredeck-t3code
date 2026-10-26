import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, type RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as FactoryService from "./FactoryService.ts";
import * as Factory from "./index.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { isTerminalRunStatus } from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  instanceId,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

/**
 * Cancelling a parent whose integrate review blocked on its reviewer's invalid submissions while
 * that reviewer's turn went on, after a resume launched a new reviewer beside it: on the server's
 * real stack, with a Markdown child, real Git, the fake provider and the server's verify runs.
 * The fake provider's turns run until the test ends them, so an interrupt is seen as the provider
 * being asked to stop a turn. Nothing sleeps: each step drains.
 */

const oneTaskPlan = {
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
  ],
};

/** The child's passing review: its one criterion, citing the file its author commits. */
const childReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "The export works.", paths: ["export.ts"] },
  ],
  missing_evidence: [],
};

const service = Factory.FactoryService.FactoryService;
const isReviewInvalid = Schema.is(FactoryService.FactoryReviewInvalidError);
const isCancelRefused = Schema.is(FactoryService.FactoryCancelRefusedError);

const head = (worktreePath: string) => git(worktreePath, ["rev-parse", "HEAD"]).pipe(Effect.orDie);

const taskRows = (parentId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) => store.listByDelivery(parentId)).pipe(
    Effect.orDie,
  );

interface Run {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

/**
 * The run, once it has started and its provider turn is recorded running: until then core ends
 * an interrupted run itself, without asking the provider.
 */
const started = (world: World, run: Run) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* runReached(run.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    const turn = world.provider.started.find((candidate) => candidate.runId === run.runId);
    if (turn === undefined) return assert.fail(`No provider turn started run ${run.runId}.`);
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.stream({ threadId: run.threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-turn.updated" &&
            event.payload.runAttemptId === turn.attemptId &&
            event.payload.status === "running",
        ),
        Stream.runHead,
      ),
    );
    yield* drainFactory;
    return run;
  });

/** The run the delivery awaits, once it has started. */
const awaitedRun = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    return yield* started(world, { threadId: awaiting.threadId, runId: awaiting.runId });
  }).pipe(Effect.orDie);

const runStatus = ({ threadId, runId }: Run) =>
  threadProjection(threadId).pipe(
    Effect.map(({ runs }) => runs.find((run) => run.id === runId)?.status),
    Effect.orDie,
  );

/** The provider's id of the turn that started the run, as an interrupt of it names it. */
const providerTurnOf = (world: World, { runId }: Run) => {
  const turn = world.provider.started.find((candidate) => candidate.runId === runId);
  return turn === undefined
    ? assert.fail(`No provider turn started run ${runId}.`)
    : `provider-turn:${turn.attemptId}`;
};

/** Every turn the provider was asked to interrupt, in a stable order. */
const interruptedTurns = (world: World) =>
  world.provider.interrupted.map(({ providerTurnId }) => providerTurnId).toSorted();

/** The ids of the interrupt commands a Factory cancel sent the thread, from its event log. */
const cancelCommands = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const latest = yield* sink.latestSequence({ threadId });
    const events = yield* sink.stream({ threadId }).pipe(
      Stream.takeUntil(({ sequence }) => sequence >= latest),
      Stream.runCollect,
    );
    return [
      ...new Set(
        events.flatMap(({ commandId }) =>
          commandId?.startsWith("factory-cancel:") === true ? [commandId] : [],
        ),
      ),
    ];
  }).pipe(Effect.orDie);

/**
 * A parent whose one child is approved and whose fresh integrate reviewer, A, blocked it with two
 * invalid submissions, while A's turn goes on: the block interrupts nothing.
 */
const blockedIntegrate = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan: oneTaskPlan });
    yield* world.endRun(planner.runId, "completed");
    yield* factory.approvePlan(planner.deliveryId);
    yield* drainFactory;
    const [childId] = (yield* stateOf(planner.deliveryId)).children;
    if (childId === undefined) return assert.fail("The child exists.");
    const author = yield* world.launched(childId);
    yield* authorCommits(author.worktreePath, "feat: export the table as CSV");
    yield* world.endRun(author.runId, "completed");
    const childReviewer = yield* awaitedRun(world, childId);
    yield* factory.submitReview({ threadId: childReviewer.threadId, review: childReview });
    yield* world.endRun(childReviewer.runId, "completed");
    assert.strictEqual((yield* stateOf(childId)).status, "approved");

    const reviewerA = yield* awaitedRun(world, planner.deliveryId);
    assert.strictEqual((yield* stateOf(planner.deliveryId)).stage, "integrate");
    for (const blocks of [false, true]) {
      const invalid = yield* Effect.flip(
        factory.submitReview({ threadId: reviewerA.threadId, review: { verdict: "maybe" } }),
      );
      if (!isReviewInvalid(invalid)) return assert.fail(`Got ${invalid._tag}.`);
      assert.strictEqual(invalid.blocked, blocks);
    }
    const blocked = yield* stateOf(planner.deliveryId);
    assert.strictEqual(blocked.status, "blocked");
    assert.strictEqual(blocked.block?.reason, "invalid_submission");
    assert.isNull(blocked.awaiting);
    assert.strictEqual(yield* runStatus(reviewerA), "running");
    return {
      parentId: planner.deliveryId,
      childId,
      worktreePath: planner.worktreePath,
      branch: blocked.branch,
      reviewerA,
    };
  }).pipe(Effect.orDie);

/**
 * Resumes the blocked parent: it verifies its branch afresh and launches reviewer B, a new
 * thread the parent now records as its reviewer, whose run it awaits.
 */
const resumeToReviewerB = (world: World, parentId: FactoryDeliveryId, reviewerA: Run) =>
  Effect.gen(function* () {
    yield* Effect.flatMap(service, (factory) => factory.resume(parentId));
    yield* drainFactory;
    const reviewerB = yield* awaitedRun(world, parentId);
    const resumed = yield* stateOf(parentId);
    assert.strictEqual(resumed.stage, "integrate");
    assert.strictEqual(resumed.receipts.length, 2);
    assert.notStrictEqual(reviewerB.threadId, reviewerA.threadId);
    assert.strictEqual(resumed.threads.reviewer, reviewerB.threadId);
    return reviewerB;
  }).pipe(Effect.orDie);

/** A thread of the owner's own in the project, its first turn running. */
const ownerThread = (world: World) =>
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const messageId = MessageId.make("owner-thread-message");
    const launched = yield* launches.launch({
      commandId: CommandId.make("owner-thread"),
      threadId: ThreadId.make("owner-thread"),
      projectId: world.projectId,
      title: "Notes on the export",
      modelSelection: { instanceId, model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "existing_worktree", worktreePath: world.root },
      initialMessage: { messageId, text: "List the export's open questions.", attachments: [] },
      createdBy: "user",
      creationSource: "web",
    });
    const run = launched.projection.runs.find(({ userMessageId }) => userMessageId === messageId);
    if (run === undefined) return assert.fail("The owner's launch started no run.");
    return yield* started(world, { threadId: launched.threadId, runId: run.id });
  }).pipe(Effect.orDie);

/** The owner's own turn on `threadId`, running. */
const ownerTurn = (world: World, threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sent = yield* threads.sendToThread({
      projectId: world.projectId,
      commandId: CommandId.make("owner-turn"),
      threadId,
      messageId: MessageId.make("owner-turn-message"),
      text: "Summarize what you found.",
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    return yield* started(world, { threadId, runId: sent.run.id });
  }).pipe(Effect.orDie);

describe("cancelling a parent after a resume replaced its blocked integrate reviewer", () => {
  it.live("interrupts both reviewers' runs once each and keeps the branch and the approval", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const factory = yield* service;
        const worker = yield* Factory.FactoryWorker.FactoryWorker;
        const { parentId, childId, worktreePath, branch, reviewerA } =
          yield* blockedIntegrate(world);
        const reviewerB = yield* resumeToReviewerB(world, parentId, reviewerA);
        // The parent no longer records reviewer A, whose turn still runs beside B's.
        assert.strictEqual(yield* runStatus(reviewerA), "running");
        const committed = yield* head(worktreePath);
        const approvedChild = yield* stateOf(childId);
        const tasks = yield* taskRows(parentId);
        assert.strictEqual(tasks[0]?.lastReviewedSha, committed);

        const cancelled = yield* factory.cancel(parentId);
        assert.strictEqual(cancelled.state.status, "cancelled");
        yield* drainFactory;
        yield* drainOrchestration;

        // Both reviewers' turns were asked to stop, each by one interrupt command of its thread.
        const interrupted = [providerTurnOf(world, reviewerA), providerTurnOf(world, reviewerB)];
        const commands = {
          a: [`factory-cancel:${parentId}:${reviewerA.runId}`],
          b: [`factory-cancel:${parentId}:${reviewerB.runId}`],
        };
        const sent = Effect.all({
          a: cancelCommands(reviewerA.threadId),
          b: cancelCommands(reviewerB.threadId),
        });
        assert.deepStrictEqual(interruptedTurns(world), interrupted.toSorted());
        assert.deepStrictEqual(yield* sent, commands);

        // A second cancel is refused, and the boot sweep's pass over the live runs of Factory's
        // threads, both reviewers' still among them, sends no second interrupt either.
        const again = yield* Effect.flip(factory.cancel(parentId));
        assert.isTrue(isCancelRefused(again));
        yield* worker.stopCancelledRuns;
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(interruptedTurns(world), interrupted.toSorted());
        assert.deepStrictEqual(yield* sent, commands);

        // Their providers stop the turns, so neither run is still active, and neither end, nor a
        // completion reported late, changes the parent or its approved child.
        for (const reviewer of [reviewerA, reviewerB]) {
          assert.isTrue(isTerminalRunStatus(yield* world.endRun(reviewer.runId, "cancelled")));
          assert.isTrue(isTerminalRunStatus(yield* runStatus(reviewer)));
          yield* worker.stepThread({ type: "run.finished", ...reviewer, status: "completed" });
        }
        yield* drainFactory;
        assert.deepStrictEqual(yield* stateOf(parentId), cancelled.state);
        assert.deepStrictEqual(yield* stateOf(childId), approvedChild);
        assert.strictEqual(approvedChild.status, "approved");
        assert.deepStrictEqual(yield* taskRows(parentId), tasks);

        // The worktree, the parent's branch and every commit stay.
        assert.isTrue(yield* fileSystem.exists(worktreePath));
        assert.strictEqual(yield* head(worktreePath), committed);
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${branch}`]).pipe(Effect.orDie),
          committed,
        );
        assert.deepStrictEqual(world.pullRequestCalls, []);
      }),
    ).pipe(Effect.orDie),
  );

  it.live.each([
    { case: "on a project thread of their own", onReviewerA: false },
    { case: "on reviewer A's thread once its Factory run ended", onReviewerA: true },
  ] as const)("leaves the owner's own turn $case running", ({ onReviewerA }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const { parentId, reviewerA } = yield* blockedIntegrate(world);
        // Ended while the parent is blocked, A's run hands the parent nothing.
        if (onReviewerA) {
          yield* world.endRun(reviewerA.runId, "completed");
          assert.strictEqual((yield* stateOf(parentId)).status, "blocked");
        }
        const own = onReviewerA
          ? yield* ownerTurn(world, reviewerA.threadId)
          : yield* ownerThread(world);
        const reviewerB = yield* resumeToReviewerB(world, parentId, reviewerA);

        yield* factory.cancel(parentId);
        yield* drainFactory;
        yield* drainOrchestration;

        // Only the turns Factory sent were asked to stop: B's, and A's while it still ran.
        const factoryRuns = onReviewerA ? [reviewerB] : [reviewerA, reviewerB];
        assert.deepStrictEqual(
          interruptedTurns(world),
          factoryRuns.map((run) => providerTurnOf(world, run)).toSorted(),
        );
        assert.deepStrictEqual(yield* cancelCommands(own.threadId), []);
        assert.strictEqual(yield* runStatus(own), "running");
        assert.strictEqual((yield* stateOf(parentId)).status, "cancelled");
      }),
    ).pipe(Effect.orDie),
  );
});
