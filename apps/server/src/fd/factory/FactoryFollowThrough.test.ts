import { assert, describe, it } from "@effect/vitest";
import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
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
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  itemStatus,
  linkOf,
  openSingle,
  passingReview,
  reviewPasses,
  syncPullRequest,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

/**
 * Follow-through rounds on the server's real stack: a single item's PR stage watches its pull
 * request on the author thread, and a wake core's watch queues there (dispatched here as core's
 * watch reactor dispatches it) becomes a round of the delivery, which Factory's reactor adopts
 * from the events core commits. The round is settled, verified, reviewed, recorded and published
 * through the fake provider, the project's verify command and the fake PR service. Nothing polls
 * or sleeps: each step drains.
 */

const service = Factory.FactoryService.FactoryService;

/** Waits until the run's provider turn has started, and the effects that started it ran. */
const started = (runId: RunId) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* runReached(runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
  });

/** A wake on the thread whose run has started, once Factory has handled what it committed. */
const wakeStarted = (threadId: ThreadId, number: number, url?: string) =>
  Effect.gen(function* () {
    const runId = yield* wakeThread(threadId, yield* linkOf(threadId, number, url));
    yield* started(runId);
    yield* drainFactory;
    return runId;
  });

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

const commentsSince = (world: World, from: number) =>
  world.commentCalls.slice(from).map(({ input }) => input.body);

describe("Factory follow-through: watching the pull request", () => {
  it.live("watches its pull request on the author thread once, through replays", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, reviewer, state } = yield* openSingle(world);
        const link = yield* linkOf(author, fakePullRequest.number);
        const watch = link.watch ?? assert.fail("The PR stage started no watch.");
        assert.strictEqual(link.url, fakePullRequest.url);
        assert.strictEqual(link.source, "created");
        // Only the author thread watches it.
        const reviewerShell = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.getThreadShell(reviewer),
        ).pipe(Effect.orDie);
        assert.isUndefined(reviewerShell?.pullRequests?.find(({ watch }) => watch !== undefined));

        // The watch's command id derives from the delivery and the PR effect, and the delivery
        // adopts only wakes committed after it.
        const commandId = CommandId.make(`factory-pr-watch:${deliveryId}:${state.effectsIssued}`);
        const receipt = yield* Effect.flatMap(CommandReceiptStore.CommandReceiptStoreV2, (store) =>
          store.getByCommandId(commandId),
        ).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
        assert.strictEqual(receipt.commandType, "thread.pull-request.watch");
        assert.deepStrictEqual(state.followThrough, {
          watchedAfter: receipt.resultSequence,
          runs: [],
        });

        // The PR step taken again changes nothing.
        const worker = yield* Factory.FactoryWorker.FactoryWorker;
        yield* worker
          .step(deliveryId, {
            type: "pr.opened",
            effectId: state.effectsIssued,
            pullRequest: state.pullRequest ?? assert.fail("No pull request."),
            watchedAfter: receipt.resultSequence + 50,
          })
          .pipe(Effect.orDie);
        yield* drainFactory;
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);

        // The effect carried out again replays its watch's receipt: no second watch starts.
        const replayed = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId,
            threadId: author,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: true,
            link: { url: link.url, source: "created" },
          }),
        ).pipe(Effect.orDie);
        assert.strictEqual(replayed.sequence, receipt.resultSequence);
        const after = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.getThreadShell(author),
        ).pipe(Effect.orDie);
        const links = after?.pullRequests?.filter(({ number }) => number === link.number) ?? [];
        assert.strictEqual(links.length, 1);
        assert.deepStrictEqual(links[0]?.watch, watch);
      }),
    ),
  );
});

describe("Factory follow-through: adopting a wake", () => {
  it.live("adopts only a wake of its own pull request on its author thread", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, reviewer, state } = yield* openSingle(world);
        const link = yield* linkOf(author, fakePullRequest.number);

        // The owner's own turn on the author thread is theirs.
        const owner = yield* world.ownerTurn(author, "Rename the export button.");
        yield* drainFactory;
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);
        assert.strictEqual(yield* world.endRun(owner, "completed"), "completed");
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);

        // A wake about another pull request on the author thread, and one about its pull request
        // on another thread.
        const other = { ...link, number: 8, url: "https://github.com/acme/alpha/pull/8" };
        yield* watchPullRequest(author, other);
        const otherWake = yield* wakeStarted(author, other.number, other.url);
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);
        yield* world.endRun(otherWake, "completed");
        yield* watchPullRequest(reviewer, link);
        const reviewerWake = yield* wakeStarted(reviewer, link.number, link.url);
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);
        yield* world.endRun(reviewerWake, "completed");
        assert.deepStrictEqual(yield* stateOf(deliveryId), state);

        // Its own pull request's wake on its author thread is a follow-through round.
        const wakeRun = yield* wakeStarted(author, link.number, link.url);
        const adopted = yield* stateOf(deliveryId);
        assert.strictEqual(adopted.status, "running");
        assert.strictEqual(adopted.stage, "follow_through");
        assert.deepStrictEqual(adopted.awaiting, { type: "run", threadId: author, runId: wakeRun });
        assert.deepStrictEqual(adopted.followThrough?.runs, [wakeRun]);
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).at(-1), ["follow_through", null]);

        // A wake that comes while the round runs is no second round.
        const during = yield* wakeThread(author, yield* linkOf(author, link.number));
        yield* drainOrchestration;
        yield* drainFactory;
        assert.deepStrictEqual(yield* stateOf(deliveryId), adopted);
        assert.notStrictEqual(during, wakeRun);
      }),
    ),
  );
});

describe("Factory follow-through: a round after its run", () => {
  it.live("verifies, reviews and records an unchanged HEAD afresh, then republishes it", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const opened = yield* openSingle(world);
        const { deliveryId, threadId: author, worktreePath, state } = opened;
        const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");
        const watch = (yield* linkOf(author, fakePullRequest.number)).watch;
        const comments = world.commentCalls.length;

        const wakeRun = yield* wakeStarted(author, fakePullRequest.number);
        const woke = (yield* linkOf(author, fakePullRequest.number)).watch;
        assert.strictEqual(woke?.startedAt, watch?.startedAt);
        // The author answers the wake without committing anything.
        yield* world.endRun(wakeRun, "completed");
        const reviewing = yield* stateOf(deliveryId);
        assert.strictEqual(reviewing.stage, "review");
        assert.strictEqual(reviewing.receipts.length, 2);
        assert.strictEqual(reviewing.receipts[1]?.headSha, approved);
        // The round's review starts on a fresh reviewer thread.
        assert.notStrictEqual(reviewing.threads.reviewer, opened.reviewer);
        yield* reviewPasses(world, deliveryId);

        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.strictEqual(reopened.stage, "pr");
        assert.isNull(reopened.awaiting);
        assert.deepStrictEqual(reopened.pullRequest, state.pullRequest);
        assert.strictEqual(reopened.reviews.length, 2);
        assert.deepStrictEqual(reopened.followThrough?.runs, [wakeRun]);
        assert.isAbove(
          reopened.followThrough?.watchedAfter ?? 0,
          state.followThrough?.watchedAfter ?? Number.POSITIVE_INFINITY,
        );
        // Published again by its id: a push to the pull request it opened, never a second one.
        assert.strictEqual(world.pullRequestCalls.length, 2);
        const [, republished] = world.pullRequestCalls;
        assert.strictEqual(republished?.input.action, "push");
        assert.strictEqual(republished?.input.expectedHeadSha, approved);
        assert.strictEqual(republished?.input.cwd, worktreePath);
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "@{upstream}"]), approved);
        // The watch it started goes on as the wake left it: the republish restarted none.
        assert.deepStrictEqual((yield* linkOf(author, fakePullRequest.number)).watch, woke);
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-5), [
          ["follow_through", "passed"],
          ["verify", "passed"],
          ["review", "passed"],
          ["record", "passed"],
          ["pr", "passed"],
        ]);
        assert.deepStrictEqual(commentsSince(world, comments), [
          `Factory approved commit ${approved} for this item after verify and review, and is updating its pull request. Factory delivery ${deliveryId}, update 3.`,
          `Factory updated pull request #7 for this item. ${fakePullRequest.url} Factory delivery ${deliveryId}, update 4.`,
        ]);
      }),
    ),
  );

  it.live("settles, verifies, reviews and records a fix, and publishes only that commit", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, worktreePath, state } = yield* openSingle(world);
        const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");

        const wakeRun = yield* wakeStarted(author, fakePullRequest.number);
        yield* authorCommits(worktreePath, "fix: write the header row", "export const x = 2;\n");
        const fixed = yield* git(worktreePath, ["rev-parse", "HEAD"]);
        assert.notStrictEqual(fixed, approved);
        yield* world.endRun(wakeRun, "completed");
        assert.strictEqual((yield* stateOf(deliveryId)).receipts.at(-1)?.headSha, fixed);
        yield* reviewPasses(world, deliveryId);

        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.deepStrictEqual(reopened.pullRequest, state.pullRequest);
        const [task] = yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
          tasks.listByDelivery(deliveryId),
        ).pipe(Effect.orDie);
        assert.strictEqual(task?.lastReviewedSha, fixed);
        const [, republished] = world.pullRequestCalls;
        assert.strictEqual(world.pullRequestCalls.length, 2);
        assert.strictEqual(republished?.input.action, "push");
        assert.strictEqual(republished?.input.expectedHeadSha, fixed);
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "@{upstream}"]), fixed);
      }),
    ),
  );

  it.live("blocks on a wake run that fails, publishing nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, state } = yield* openSingle(world);
        const wakeRun = yield* wakeStarted(author, fakePullRequest.number);
        yield* world.endRun(wakeRun, "failed");

        const blocked = yield* stateOf(deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, {
          reason: "run_ended",
          threadId: author,
          runId: wakeRun,
          runStatus: "failed",
        });
        assert.deepStrictEqual(blocked.receipts, state.receipts);
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );
});

describe("Factory follow-through: what a round refuses", () => {
  it.live("blocks on a commit made during the round's review", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);
        const wakeRun = yield* wakeStarted(author, fakePullRequest.number);
        yield* world.endRun(wakeRun, "completed");
        const reviewer = yield* awaitedRun(deliveryId);

        // A commit lands in the worktree while the reviewer reads it.
        yield* authorCommits(worktreePath, "fix: a late change", "export const x = 3;\n");
        yield* Effect.flatMap(service, (factory) =>
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
        ).pipe(Effect.exit);
        yield* world.endRun(reviewer.runId, "completed");

        const blocked = yield* stateOf(deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, {
          reason: "code_changed",
          changes: ["head_changed"],
        });
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );

  it.live.each([
    { during: "the wake's run", reviewing: false },
    { during: "the round's review", reviewing: true },
  ])(
    "closes out a merge that lands during $during, opening no second pull request",
    ({ reviewing }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);
          const link = yield* linkOf(author, fakePullRequest.number);
          const wakeRun = yield* wakeStarted(author, fakePullRequest.number);
          if (reviewing) yield* world.endRun(wakeRun, "completed");
          // The run still working in the worktree when the merge lands.
          const live = reviewing ? (yield* awaitedRun(deliveryId)).runId : wakeRun;

          yield* syncPullRequest(author, link, "merged");
          const done = yield* stateOf(deliveryId);
          assert.strictEqual(done.status, "done");
          assert.strictEqual(done.pullRequest?.outcome, "merged");
          assert.strictEqual(yield* itemStatus(world.itemRef), "done");
          // That run keeps the worktree; the watch Factory started ended with the merge.
          assert.isTrue(yield* world.exists(worktreePath));
          assert.deepStrictEqual(world.worktreeRemovals, []);
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
          // A review the merge cut short did not pass.
          assert.deepStrictEqual(
            (yield* attemptsOf(deliveryId)).slice(-2),
            reviewing
              ? [
                  ["review", "cancelled"],
                  ["follow_through", "passed"],
                ]
              : [
                  ["pr", "passed"],
                  ["follow_through", "passed"],
                ],
          );

          // The run ends later, and nothing comes of it.
          yield* world.endRun(live, "completed");
          assert.deepStrictEqual(yield* stateOf(deliveryId), done);
          assert.strictEqual(world.pullRequestCalls.length, 1);
        }),
      ),
  );
});
