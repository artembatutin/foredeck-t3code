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
  closedComment,
  itemStatus,
  linkOf,
  openSingle,
  passingReview,
  reviewPasses,
  settleThread,
  syncPullRequest,
  unsettleThread,
  type WakeReport,
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
const wakeStarted = (
  threadId: ThreadId,
  number: number,
  url?: string,
  report: WakeReport = "checks-failed",
) =>
  Effect.gen(function* () {
    const runId = yield* wakeThread(threadId, yield* linkOf(threadId, number, url), report);
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
          armedAt: receipt.resultSequence,
          // Its own command started the watch, so the watch is Factory's.
          watchStartedAt: watch.startedAt,
          heldUntil: null,
          runs: [],
          pending: [],
          watchEnded: false,
        });

        // The PR step taken again changes nothing.
        const worker = yield* Factory.FactoryWorker.FactoryWorker;
        yield* worker
          .step(deliveryId, {
            type: "pr.opened",
            effectId: state.effectsIssued,
            pullRequest: state.pullRequest ?? assert.fail("No pull request."),
            watch: {
              firstAt: receipt.resultSequence,
              at: receipt.resultSequence + 50,
              armed: true,
              held: watch.startedAt,
            },
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

        // A wake that comes while the round runs is the delivery's, and waits: no second round.
        const during = yield* wakeThread(author, yield* linkOf(author, link.number));
        yield* drainOrchestration;
        yield* drainFactory;
        const kept = yield* stateOf(deliveryId);
        assert.deepStrictEqual(kept.awaiting, adopted.awaiting);
        assert.deepStrictEqual(kept.followThrough?.runs, [wakeRun, during]);
        assert.deepStrictEqual(kept.followThrough?.pending, [during]);
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
        // The republish's watch command is later; wakes still count from the first.
        assert.strictEqual(reopened.followThrough?.watchedAfter, state.followThrough?.watchedAfter);
        assert.isAbove(
          reopened.followThrough?.armedAt ?? 0,
          state.followThrough?.armedAt ?? Number.POSITIVE_INFINITY,
        );
        assert.strictEqual(reopened.followThrough?.watchStartedAt, watch?.startedAt);
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

describe("Factory follow-through: wakes that come during a round", () => {
  it.live("runs a wake queued behind the round's run before it verifies the branch", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, worktreePath, state } = yield* openSingle(world);
        const first = yield* wakeStarted(author, fakePullRequest.number);
        const second = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* drainOrchestration;
        yield* drainFactory;
        assert.deepStrictEqual((yield* stateOf(deliveryId)).followThrough?.pending, [second]);

        // The first answer commits a fix; the second wake's run starts after it, and the round
        // waits for it rather than judging the branch under it.
        yield* authorCommits(worktreePath, "fix: make the checks pass", "export const x = 2;\n");
        yield* world.endRun(first, "completed");
        yield* started(second);
        yield* drainFactory;
        const waiting = yield* stateOf(deliveryId);
        assert.deepStrictEqual(waiting.awaiting, { type: "run", threadId: author, runId: second });
        assert.strictEqual(waiting.stage, "follow_through");
        assert.strictEqual(waiting.receipts.length, state.receipts.length);
        assert.deepStrictEqual(waiting.followThrough?.pending, []);

        // One verify and review cover both answers.
        yield* world.endRun(second, "completed");
        assert.strictEqual((yield* stateOf(deliveryId)).receipts.length, state.receipts.length + 1);
        yield* reviewPasses(world, deliveryId);
        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.deepStrictEqual(reopened.followThrough?.runs, [first, second]);
        assert.deepStrictEqual(reopened.followThrough?.pending, []);
        assert.strictEqual(world.pullRequestCalls.length, 2);
      }),
    ),
  );

  it.live("takes a wake that came during review as the next round once the PR is open again", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, state } = yield* openSingle(world);
        const first = yield* wakeStarted(author, fakePullRequest.number);
        yield* world.endRun(first, "completed");
        const reviewer = yield* awaitedRun(deliveryId);

        // The next wake starts at once on the idle author thread, while the review runs.
        const second = yield* wakeStarted(author, fakePullRequest.number);
        const kept = yield* stateOf(deliveryId);
        assert.deepStrictEqual(kept.awaiting, reviewer);
        assert.deepStrictEqual(kept.followThrough?.runs, [first, second]);
        assert.deepStrictEqual(kept.followThrough?.pending, [second]);
        // Its run ends before the round does, with nothing to hand it to yet.
        yield* world.endRun(second, "completed");
        assert.deepStrictEqual((yield* stateOf(deliveryId)).awaiting, reviewer);

        yield* Effect.flatMap(service, (factory) =>
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
        );
        yield* world.endRun(reviewer.runId, "completed");
        // Published, then the wake that waited is the next round: its run has ended, so the
        // branch is settled and verified again at once, and reviewed on a fresh thread.
        const next = yield* stateOf(deliveryId);
        assert.strictEqual(world.pullRequestCalls.length, 2);
        assert.strictEqual(next.stage, "review");
        assert.strictEqual(next.receipts.length, state.receipts.length + 2);
        assert.notStrictEqual(next.threads.reviewer, reviewer.threadId);
        assert.deepStrictEqual(next.followThrough?.pending, []);
        yield* reviewPasses(world, deliveryId);

        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.deepStrictEqual(reopened.followThrough?.runs, [first, second]);
        assert.strictEqual(world.pullRequestCalls.length, 3);
        assert.deepStrictEqual(
          world.pullRequestCalls.map(({ input }) => input.action),
          ["create_pr", "push", "push"],
        );
        const rounds = (yield* attemptsOf(deliveryId)).filter(
          ([stage]) => stage === "follow_through",
        );
        assert.deepStrictEqual(rounds, [
          ["follow_through", "passed"],
          ["follow_through", "passed"],
        ]);
      }),
    ),
  );
});

describe("Factory follow-through: a stop with a wake pending", () => {
  it.live("keeps the owner's stop through a wake queued behind the round's run", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, state } = yield* openSingle(world);
        const first = yield* wakeStarted(author, fakePullRequest.number);
        const second = yield* wakeThread(author, yield* linkOf(author, fakePullRequest.number));
        yield* drainOrchestration;
        yield* drainFactory;
        yield* Effect.flatMap(service, (factory) => factory.stop(deliveryId)).pipe(Effect.orDie);
        assert.strictEqual((yield* stateOf(deliveryId)).status, "stopping");

        // The round waits for the queued wake, still stopping.
        yield* world.endRun(first, "completed");
        yield* started(second);
        yield* drainFactory;
        const waiting = yield* stateOf(deliveryId);
        assert.strictEqual(waiting.status, "stopping");
        assert.deepStrictEqual(waiting.awaiting, { type: "run", threadId: author, runId: second });

        // Its end has the branch settled, and the delivery stops where verify would begin.
        yield* world.endRun(second, "completed");
        const stopped = yield* stateOf(deliveryId);
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(stopped.checkpoint, "verify");
        assert.isNull(stopped.awaiting);
        assert.deepStrictEqual(stopped.receipts, state.receipts);
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );
});

describe("Factory follow-through: what a wake reports", () => {
  it.live("takes new comments as a round, and passing checks as nothing to repair", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, state } = yield* openSingle(world);
        const passed = yield* wakeStarted(
          author,
          fakePullRequest.number,
          undefined,
          "checks-passed",
        );
        // Its run is the delivery's to cancel, and nothing else changes.
        const noticed = yield* stateOf(deliveryId);
        assert.deepStrictEqual(noticed, {
          ...state,
          followThrough: {
            ...(state.followThrough ?? assert.fail("Not watched.")),
            runs: [passed],
          },
        });
        yield* world.endRun(passed, "completed");
        assert.deepStrictEqual(yield* stateOf(deliveryId), noticed);

        const remarks = yield* wakeStarted(author, fakePullRequest.number, undefined, "remarks");
        const adopted = yield* stateOf(deliveryId);
        assert.strictEqual(adopted.status, "running");
        assert.deepStrictEqual(adopted.awaiting, { type: "run", threadId: author, runId: remarks });
        assert.deepStrictEqual(adopted.followThrough?.runs, [passed, remarks]);
      }),
    ),
  );

  it.live(
    "blocks when core stops watching an unreadable pull request; a resume watches again",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const { deliveryId, threadId: author, state } = yield* openSingle(world);
          const before = (yield* linkOf(author, fakePullRequest.number)).watch;
          const comments = world.commentCalls.length;

          const notice = yield* wakeStarted(
            author,
            fakePullRequest.number,
            undefined,
            "unreadable",
          );
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, { reason: "watch_ended" });
          // The notice's run is the delivery's to cancel; core's watch is gone with it, at the
          // sync that queued it.
          assert.deepStrictEqual(blocked.followThrough?.runs, [notice]);
          assert.deepStrictEqual(blocked.followThrough?.pending, []);
          assert.strictEqual(blocked.followThrough?.watchStartedAt, before?.startedAt);
          assert.isAbove(blocked.followThrough?.heldUntil ?? 0, state.followThrough?.armedAt ?? 0);
          assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
          assert.deepStrictEqual(commentsSince(world, comments), [
            `Factory is blocked on this item and needs you. The pull request's watch ended, so Factory no longer follows its feedback. Resume or cancel the delivery in Foredeck. Factory delivery ${deliveryId}, update 3.`,
          ]);
          yield* world.endRun(notice, "completed");
          assert.deepStrictEqual(yield* stateOf(deliveryId), blocked);
          assert.strictEqual(world.pullRequestCalls.length, 1);

          // The owner's resume publishes the same commit again and starts a new watch.
          yield* Effect.flatMap(service, (factory) => factory.resume(deliveryId)).pipe(
            Effect.orDie,
          );
          yield* drainFactory;
          const reopened = yield* stateOf(deliveryId);
          assert.strictEqual(reopened.status, "pr_open");
          assert.isFalse(reopened.followThrough?.watchEnded);
          assert.deepStrictEqual(reopened.pullRequest, state.pullRequest);
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr", "push"],
          );
          const watch = (yield* linkOf(author, fakePullRequest.number)).watch;
          assert.isDefined(watch);
          assert.notStrictEqual(watch?.startedAt, before?.startedAt);
          assert.strictEqual(reopened.followThrough?.watchStartedAt, watch?.startedAt);
        }),
      ),
  );

  it.live("finishes a round when core stops watching during it, then blocks unwatched", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const first = yield* wakeStarted(author, fakePullRequest.number);
        yield* world.endRun(first, "completed");
        const reviewer = yield* awaitedRun(deliveryId);

        // Core stops after too many comment-only updates while the round's review runs.
        const last = yield* wakeStarted(author, fakePullRequest.number, undefined, "exhausted");
        const flagged = yield* stateOf(deliveryId);
        assert.strictEqual(flagged.status, "running");
        assert.isTrue(flagged.followThrough?.watchEnded);
        assert.deepStrictEqual(flagged.followThrough?.runs, [first, last]);
        assert.deepStrictEqual(flagged.followThrough?.pending, []);
        yield* world.endRun(last, "completed");

        yield* Effect.flatMap(service, (factory) =>
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
        );
        yield* world.endRun(reviewer.runId, "completed");
        // The round's commit is published, but core's ended watch is not started again.
        const blocked = yield* stateOf(deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, { reason: "watch_ended" });
        assert.deepStrictEqual(
          world.pullRequestCalls.map(({ input }) => input.action),
          ["create_pr", "push"],
        );
        assert.isUndefined((yield* linkOf(author, fakePullRequest.number)).watch);
      }),
    ),
  );
});

describe("Factory follow-through: a pull request whose watch could not start", () => {
  /** A single item whose PR stage published while its author thread was settled. */
  const unwatched = (world: World) =>
    Effect.gen(function* () {
      const author = yield* world.start;
      yield* authorCommits(author.worktreePath, "feat: add the export button");
      yield* world.endRun(author.runId, "completed");
      const reviewer = yield* awaitedRun(author.deliveryId);
      yield* Effect.flatMap(service, (factory) =>
        factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
      );
      // The owner settles the author thread, which core then refuses to watch from.
      yield* settleThread(author.threadId);
      yield* world.endRun(reviewer.runId, "completed");
      const state = yield* stateOf(author.deliveryId);
      return { ...author, state };
    }).pipe(Effect.orDie);

  it.live("records the published pull request and blocks", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { state } = yield* unwatched(world);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.pullRequest, {
          ...fakePullRequest,
          headBranch: state.branch,
        });
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: state.effectsIssued, type: "open_pr" },
          detail:
            "Factory opened pull request #7 but could not watch it for feedback (OrchestratorDispatchError).",
        });
        assert.isUndefined(state.followThrough);
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );

  it.live.each([
    { change: "closed", status: "cancelled" },
    { change: "merged", status: "done" },
  ] as const)(
    "takes that pull request $change on the host, blocked as it is",
    ({ change, status }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const { deliveryId, threadId: author } = yield* unwatched(world);
          const comments = world.commentCalls.length;
          yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), change);

          const after = yield* stateOf(deliveryId);
          assert.strictEqual(after.status, status);
          assert.strictEqual(after.pullRequest?.outcome, change);
          assert.strictEqual(world.pullRequestCalls.length, 1);
          if (change === "closed") {
            assert.deepStrictEqual(commentsSince(world, comments), [
              `${closedComment} ${fakePullRequest.url} Factory delivery ${deliveryId}, update 3.`,
            ]);
            // Ended: no resume can publish it again.
            const refused = yield* Effect.flatMap(service, (factory) =>
              factory.resume(deliveryId),
            ).pipe(Effect.flip);
            assert.strictEqual(refused._tag, "FactoryResumeRefusedError");
          } else {
            assert.strictEqual(yield* itemStatus(world.itemRef), "done");
          }
        }),
      ),
  );

  it.live("resumes into a push to the same pull request, never a second one", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, state } = yield* unwatched(world);
        yield* unsettleThread(author);
        yield* Effect.flatMap(service, (factory) => factory.resume(deliveryId)).pipe(Effect.orDie);
        yield* drainFactory;

        const reopened = yield* stateOf(deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        assert.deepStrictEqual(reopened.pullRequest, state.pullRequest);
        assert.deepStrictEqual(
          world.pullRequestCalls.map(({ input }) => input.action),
          ["create_pr", "push"],
        );
        assert.isDefined((yield* linkOf(author, fakePullRequest.number)).watch);
        assert.isFalse(reopened.followThrough?.watchEnded);
      }),
    ),
  );
});

describe("Factory follow-through: a watch the owner started first", () => {
  it.live("keeps the owner's watch Factory found on, through a resume and a cancel", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        // Published while its author thread was settled, so Factory started no watch.
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const reviewer = yield* awaitedRun(author.deliveryId);
        yield* Effect.flatMap(service, (factory) =>
          factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
        );
        yield* settleThread(author.threadId);
        yield* world.endRun(reviewer.runId, "completed");
        assert.strictEqual((yield* stateOf(author.deliveryId)).status, "blocked");

        // The owner unsettles the thread and watches the pull request before resuming.
        yield* unsettleThread(author.threadId);
        const link = yield* linkOf(author.threadId, fakePullRequest.number);
        yield* watchPullRequest(author.threadId, link);
        const owners = (yield* linkOf(author.threadId, fakePullRequest.number)).watch;
        assert.isDefined(owners);
        yield* Effect.flatMap(service, (factory) => factory.resume(author.deliveryId)).pipe(
          Effect.orDie,
        );
        yield* drainFactory;
        const reopened = yield* stateOf(author.deliveryId);
        assert.strictEqual(reopened.status, "pr_open");
        // Core kept the owner's watch, which Factory follows but does not hold.
        assert.deepStrictEqual(
          (yield* linkOf(author.threadId, fakePullRequest.number)).watch,
          owners,
        );
        assert.isNull(reopened.followThrough?.watchStartedAt);

        yield* Effect.flatMap(service, (factory) => factory.cancel(author.deliveryId)).pipe(
          Effect.orDie,
        );
        yield* drainFactory;
        assert.deepStrictEqual(
          (yield* linkOf(author.threadId, fakePullRequest.number)).watch,
          owners,
        );
      }),
    ),
  );
});
