import { assert, describe, it } from "@effect/vitest";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  git,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  endWhileDown,
  integratedParent,
  linkOf,
  openParent,
  passingReview,
  runStarted,
  settleThread,
  type WakeReport,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

/**
 * A parent's follow-through on the server's real stack. A parent has no author thread, so its PR
 * stage links its pull request to its last child's author thread and starts core's watch there,
 * and a wake core's watch queues there (dispatched here as core's watch reactor dispatches it)
 * reaches the parent, not the approved child whose launch named that thread. The round settles the
 * parent's branch, verifies it, has a new integrate reviewer judge it, records its approval and
 * pushes it to the same pull request, through the fake provider, the project's verify command and
 * the fake PR service. Nothing polls or sleeps: each step drains.
 */

const service = Factory.FactoryService.FactoryService;

/** The parent's last child, whose author thread its pull request is linked to. */
const lastChild = <A>(parent: { readonly children: ReadonlyArray<A> }) =>
  parent.children.at(-1) ?? assert.fail("The parent has no children.");

/** A wake on the thread whose run has started, once Factory has handled what it committed. */
const wakeStarted = (
  threadId: ThreadId,
  number: number,
  url?: string,
  report: WakeReport = "checks-failed",
) =>
  Effect.gen(function* () {
    const runId = yield* wakeThread(threadId, yield* linkOf(threadId, number, url), report);
    yield* runStarted(runId);
    yield* drainFactory;
    return runId;
  });

/** The receipt of the watch command the delivery's PR effect `effectId` sent, if it sent one. */
const watchCommand = (deliveryId: FactoryDeliveryId, effectId: number) =>
  Effect.flatMap(CommandReceiptStore.CommandReceiptStoreV2, (receipts) =>
    receipts.getByCommandId(CommandId.make(`factory-pr-watch:${deliveryId}:${effectId}`)),
  ).pipe(Effect.orDie);

/** The delivery's row and stage attempts, as the database holds them. */
const rowsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${deliveryId}`,
    };
  }).pipe(Effect.orDie);

/** The rows of each of the parent's children. */
const childRows = (parent: {
  readonly children: ReadonlyArray<{ readonly deliveryId: FactoryDeliveryId }>;
}) => Effect.forEach(parent.children, ({ deliveryId }) => rowsOf(deliveryId));

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.orDie);

/** The approval the parent's record wrote for its whole branch. */
const branchApproval = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem.readFileString(
      path.join(world.evidenceDir(deliveryId), "approval.json"),
    );
    return JSON.parse(text) as { readonly headSha: string };
  }).pipe(Effect.orDie);

describe("Factory follow-through of a parent: watching its pull request", () => {
  it.live("watches it on its last child's author thread, by its derived watch command", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const { deliveryId, state } = parent;
        const [first] = parent.children;
        const last = lastChild(parent);
        // The parent records the thread its pull request is linked to.
        assert.strictEqual(state.pullRequestThread, last.author);
        const link = yield* linkOf(last.author, fakePullRequest.number);
        const watch = link.watch ?? assert.fail("The PR stage started no watch.");
        assert.strictEqual(link.url, fakePullRequest.url);
        assert.strictEqual(link.source, "created");

        // The watch started in the event the parent's derived watch command committed there.
        const commandId = CommandId.make(`factory-pr-watch:${deliveryId}:${state.effectsIssued}`);
        const receipt = Option.getOrThrow(yield* watchCommand(deliveryId, state.effectsIssued));
        assert.strictEqual(receipt.status, "accepted");
        assert.strictEqual(receipt.commandType, "thread.pull-request.watch");
        assert.strictEqual(receipt.threadId, last.author);
        const committed = yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
          sink.readByCommandId({ commandId }).pipe(Stream.runCollect),
        ).pipe(Effect.orDie);
        const synced = Array.from(committed).find(
          ({ event }) => event.type === "thread.pull-request-synced",
        );
        assert.strictEqual(synced?.sequence, receipt.resultSequence);
        assert.strictEqual(synced?.event.threadId, last.author);
        assert.strictEqual(
          DateTime.formatIso(synced?.event.occurredAt ?? assert.fail("No synced event.")),
          watch.startedAt,
        );
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

        // No other thread of the family watches it.
        const others = [first?.author, state.threads.planner, state.threads.reviewer];
        for (const threadId of others) {
          if (threadId === undefined) return assert.fail("A thread is missing.");
          const shell = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.getThreadShell(threadId),
          ).pipe(Effect.orDie);
          assert.isUndefined(shell?.pullRequests?.find(({ watch }) => watch !== undefined));
        }
      }),
    ),
  );

  it.live("follows a watch already on there, starting none, and adopts its wake", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* integratedParent(world);
        const last = lastChild(parent);
        // The owner links and watches the pull request on that thread while the PR stage
        // publishes, before it reads the watch.
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        world.publishHooks.push(
          watchPullRequest(last.author, {
            host: "github.com",
            repository: "acme/alpha",
            ...fakePullRequest,
          }).pipe(Effect.provideService(Orchestrator.OrchestratorV2, orchestrator)),
        );
        yield* world.endRun(parent.integrate.runId, "completed");

        const state = yield* stateOf(parent.deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.pullRequestThread, last.author);
        const owners = (yield* linkOf(last.author, fakePullRequest.number)).watch;
        assert.isDefined(owners);
        assert.isTrue(Option.isNone(yield* watchCommand(parent.deliveryId, state.effectsIssued)));
        // Followed, not held: a cancel would leave it on.
        assert.isNull(state.followThrough?.watchStartedAt);

        const wakeRun = yield* wakeStarted(last.author, fakePullRequest.number);
        const adopted = yield* stateOf(parent.deliveryId);
        assert.strictEqual(adopted.stage, "follow_through");
        assert.deepStrictEqual(adopted.awaiting, {
          type: "run",
          threadId: last.author,
          runId: wakeRun,
        });
      }),
    ),
  );

  it.live("records its pull request and that thread, and blocks, when it cannot watch it", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* integratedParent(world);
        const last = lastChild(parent);
        // The owner settles that thread, which core then refuses to watch from.
        yield* settleThread(last.author);
        yield* world.endRun(parent.integrate.runId, "completed");

        const state = yield* stateOf(parent.deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: state.effectsIssued, type: "open_pr" },
          detail:
            "Factory opened pull request #7 but could not watch it for feedback (OrchestratorDispatchError).",
        });
        assert.deepStrictEqual(state.pullRequest, {
          ...fakePullRequest,
          headBranch: state.branch,
        });
        assert.strictEqual(state.pullRequestThread, last.author);
        assert.isUndefined(state.followThrough);
        assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );

  it.live("starts no watch over an end core committed before its republish, and blocks", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const worker = yield* Factory.FactoryWorker.FactoryWorker;
          const parent = yield* world.boot(openParent(world));
          const { deliveryId } = parent;
          const last = lastChild(parent);
          // One server adopts a round, and its integrate reviewer passes the branch.
          const reviewer = yield* world.boot(
            Effect.gen(function* () {
              const first = yield* wakeStarted(last.author, fakePullRequest.number);
              yield* world.endRun(first, "completed");
              const reviewer = yield* awaitedRun(deliveryId);
              yield* factory.submitReview({
                threadId: reviewer.threadId,
                review: passingReview(2),
              });
              return reviewer;
            }),
          );

          // While no reactor runs, core's watch ends: it could not read the pull request.
          const end = yield* wakeThread(
            last.author,
            yield* linkOf(last.author, fakePullRequest.number),
            "unreadable",
          );
          yield* drainOrchestration;
          assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
          // The worker, handed the reviewer's end, records and pushes; its PR stage reads that
          // end among the wakes the parent has not taken.
          yield* endWhileDown(world, reviewer.runId);
          yield* worker
            .step(deliveryId, {
              type: "run.finished",
              threadId: reviewer.threadId,
              runId: reviewer.runId,
              status: "completed",
            })
            .pipe(Effect.orDie);
          yield* worker.drain;

          const republished = yield* stateOf(deliveryId);
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr", "push"],
          );
          assert.isTrue(Option.isNone(yield* watchCommand(deliveryId, republished.effectsIssued)));
          assert.strictEqual(republished.status, "blocked");
          assert.deepStrictEqual(republished.block, { reason: "watch_ended" });
          assert.include(republished.followThrough?.runs ?? [], end);
          assert.isTrue(republished.followThrough?.watchEnded);
          assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
        }),
      { manualReactor: true },
    ),
  );
});

describe("Factory follow-through of a parent: a round", () => {
  it.live.each([
    { name: "a fix the wake's run commits", commits: true },
    { name: "a HEAD the wake's run left as it was", commits: false },
  ])(
    "verifies, integrates and records $name, then pushes it to the same pull request",
    ({ commits }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const parent = yield* openParent(world);
          const { deliveryId, worktreePath, state } = parent;
          const last = lastChild(parent);
          const children = yield* childRows(parent);
          const watch = (yield* linkOf(last.author, fakePullRequest.number)).watch;

          // The wake core queues on the last child's author thread is the parent's round.
          const wakeRun = yield* wakeStarted(last.author, fakePullRequest.number);
          const adopted = yield* stateOf(deliveryId);
          assert.strictEqual(adopted.status, "running");
          assert.strictEqual(adopted.stage, "follow_through");
          assert.deepStrictEqual(adopted.awaiting, {
            type: "run",
            threadId: last.author,
            runId: wakeRun,
          });
          assert.deepStrictEqual(adopted.followThrough?.runs, [wakeRun]);
          // Its attempt names that thread and run, which is how the run's end reaches the parent.
          const round = (yield* attemptsOf(deliveryId)).at(-1);
          assert.deepStrictEqual(
            [round?.stage, round?.outcome, round?.threadId, round?.runId],
            ["follow_through", null, last.author, wakeRun],
          );

          if (commits) {
            yield* authorCommits(
              worktreePath,
              "fix: address the failed checks",
              "export const x = 2;\n",
            );
          }
          const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);
          assert.strictEqual(head === state.receipts.at(-1)?.headSha, !commits);
          yield* world.endRun(wakeRun, "completed");

          // A new receipt for HEAD, judged by a new integrate reviewer.
          const integrating = yield* stateOf(deliveryId);
          assert.strictEqual(integrating.stage, "integrate");
          assert.strictEqual(integrating.receipts.length, state.receipts.length + 1);
          assert.strictEqual(integrating.receipts.at(-1)?.headSha, head);
          const reviewer = yield* awaitedRun(deliveryId);
          assert.strictEqual(reviewer.threadId, integrating.threads.reviewer);
          assert.notStrictEqual(reviewer.threadId, state.threads.reviewer);
          yield* Effect.flatMap(service, (factory) =>
            factory.submitReview({ threadId: reviewer.threadId, review: passingReview(2) }),
          ).pipe(Effect.orDie);
          yield* world.endRun(reviewer.runId, "completed");

          const reopened = yield* stateOf(deliveryId);
          assert.strictEqual(reopened.status, "pr_open");
          assert.strictEqual(reopened.stage, "pr");
          assert.deepStrictEqual(reopened.pullRequest, state.pullRequest);
          assert.strictEqual(reopened.pullRequestThread, last.author);
          assert.strictEqual((yield* branchApproval(world, deliveryId)).headSha, head);
          // Pushed by its id to the pull request it opened: one create_pr in all.
          assert.deepStrictEqual(
            world.pullRequestCalls.map(({ input }) => input.action),
            ["create_pr", "push"],
          );
          const [, pushed] = world.pullRequestCalls;
          assert.strictEqual(pushed?.input.expectedHeadSha, head);
          assert.strictEqual(pushed?.input.threadId, last.author);
          assert.strictEqual(pushed?.input.cwd, worktreePath);
          assert.strictEqual(yield* git(worktreePath, ["rev-parse", "@{upstream}"]), head);
          // The watch Factory started is still on, so the republish started none.
          assert.isTrue(Option.isNone(yield* watchCommand(deliveryId, reopened.effectsIssued)));
          assert.strictEqual(
            (yield* linkOf(last.author, fakePullRequest.number)).watch?.startedAt,
            watch?.startedAt,
          );
          assert.deepStrictEqual(
            (yield* attemptsOf(deliveryId)).slice(-5).map(({ stage, outcome }) => [stage, outcome]),
            [
              ["follow_through", "passed"],
              ["verify", "passed"],
              ["integrate", "passed"],
              ["record", "passed"],
              ["pr", "passed"],
            ],
          );
          // The approved children are stored as they were, byte for byte.
          assert.deepStrictEqual(yield* childRows(parent), children);
        }),
      ),
  );

  it.live("settles the parent's branch, with a fix-commit turn on that thread", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const { deliveryId, worktreePath, state } = parent;
        const last = lastChild(parent);
        const children = yield* childRows(parent);
        const wakeRun = yield* wakeStarted(last.author, fakePullRequest.number);
        // The wake's run commits a subject the settle check refuses.
        yield* authorCommits(worktreePath, "address the failed checks", "export const x = 2;\n");
        const before = world.provider.started.length;
        yield* world.endRun(wakeRun, "completed");

        const repairing = yield* stateOf(deliveryId);
        assert.strictEqual(repairing.status, "running");
        assert.strictEqual(repairing.fixCommitTurns, 1);
        assert.strictEqual(repairing.receipts.length, state.receipts.length);
        const turn = repairing.awaiting;
        if (turn?.type !== "run") return assert.fail("The parent awaits no fix-commit run.");
        assert.strictEqual(turn.threadId, last.author);
        yield* runStarted(turn.runId);
        assert.deepStrictEqual(
          world.provider.started.slice(before).map(({ threadId, runId }) => [threadId, runId]),
          [[last.author, turn.runId]],
        );

        // Reworded, the branch settles and is verified and integrated.
        yield* git(worktreePath, [
          "-c",
          "user.name=Ada Lovelace",
          "-c",
          "user.email=ada@example.com",
          "commit",
          "--amend",
          "--no-verify",
          "-m",
          "fix: address the failed checks",
        ]);
        const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);
        yield* world.endRun(turn.runId, "completed");
        const integrating = yield* stateOf(deliveryId);
        assert.strictEqual(integrating.stage, "integrate");
        assert.strictEqual(integrating.receipts.at(-1)?.headSha, head);
        assert.deepStrictEqual(yield* childRows(parent), children);
      }),
    ),
  );
});

describe("Factory follow-through of a parent: what starts no round", () => {
  it.live("leaves it open through the owner's own turn on that thread", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const last = lastChild(parent);
        const rows = yield* rowsOf(parent.deliveryId);
        const children = yield* childRows(parent);

        const owner = yield* world.ownerTurn(last.author, "Rename the export button.");
        yield* drainFactory;
        assert.deepStrictEqual(yield* rowsOf(parent.deliveryId), rows);
        assert.strictEqual(yield* world.endRun(owner, "completed"), "completed");
        // Still open, with no new attempt.
        assert.deepStrictEqual(yield* rowsOf(parent.deliveryId), rows);
        assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "pr_open");
        assert.deepStrictEqual(yield* childRows(parent), children);
        assert.strictEqual(world.pullRequestCalls.length, 1);
      }),
    ),
  );

  it.live.each([
    { name: "another number", number: 8, repository: "acme/alpha" },
    { name: "another URL", number: 7, repository: "acme/beta" },
  ])("takes no wake for a pull request of $name there", ({ number, repository }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const last = lastChild(parent);
        const link = yield* linkOf(last.author, fakePullRequest.number);
        const other = {
          host: link.host,
          repository,
          number,
          url: `https://github.com/${repository}/pull/${number}`,
        };
        yield* watchPullRequest(last.author, other);
        const rows = yield* rowsOf(parent.deliveryId);
        const children = yield* childRows(parent);

        const wakeRun = yield* wakeStarted(last.author, other.number, other.url);
        assert.deepStrictEqual(yield* rowsOf(parent.deliveryId), rows);
        yield* world.endRun(wakeRun, "completed");
        assert.deepStrictEqual(yield* rowsOf(parent.deliveryId), rows);
        assert.deepStrictEqual(yield* childRows(parent), children);
      }),
    ),
  );

  it.live("takes no wake of its pull request on its first child's author thread", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const [first] = parent.children;
        if (first === undefined) return assert.fail("The parent has no children.");
        const last = lastChild(parent);
        yield* watchPullRequest(first.author, yield* linkOf(last.author, fakePullRequest.number));
        const rows = yield* rowsOf(parent.deliveryId);
        const children = yield* childRows(parent);

        const wakeRun = yield* wakeStarted(first.author, fakePullRequest.number);
        yield* world.endRun(wakeRun, "completed");
        assert.deepStrictEqual(yield* rowsOf(parent.deliveryId), rows);
        assert.deepStrictEqual(yield* childRows(parent), children);
      }),
    ),
  );
});

describe("Factory follow-through of a parent: what blocks it", () => {
  it.live("blocks on a wake run that fails, publishing nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const last = lastChild(parent);
        const children = yield* childRows(parent);
        const wakeRun = yield* wakeStarted(last.author, fakePullRequest.number);
        yield* world.endRun(wakeRun, "failed");

        const blocked = yield* stateOf(parent.deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, {
          reason: "run_ended",
          threadId: last.author,
          runId: wakeRun,
          runStatus: "failed",
        });
        assert.deepStrictEqual(blocked.receipts, parent.state.receipts);
        assert.strictEqual(world.pullRequestCalls.length, 1);
        assert.deepStrictEqual(yield* childRows(parent), children);
      }),
    ),
  );

  it.live("blocks when its last child's author thread is deleted during a round's review", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const last = lastChild(parent);
        const children = yield* childRows(parent);
        const wakeRun = yield* wakeStarted(last.author, fakePullRequest.number);
        yield* world.endRun(wakeRun, "completed");
        const reviewer = yield* awaitedRun(parent.deliveryId);
        yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-the-last-child-author"),
            threadId: last.author,
          }),
        ).pipe(Effect.orDie);
        yield* drainOrchestration;
        yield* drainFactory;

        const blocked = yield* stateOf(parent.deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.deepStrictEqual(blocked.block, { reason: "thread_deleted", threadId: last.author });
        // The reviewer's end comes too late to record anything.
        yield* world.endRun(reviewer.runId, "completed");
        assert.deepStrictEqual(yield* stateOf(parent.deliveryId), blocked);
        assert.strictEqual(world.pullRequestCalls.length, 1);
        assert.deepStrictEqual(yield* childRows(parent), children);
      }),
    ),
  );
});
