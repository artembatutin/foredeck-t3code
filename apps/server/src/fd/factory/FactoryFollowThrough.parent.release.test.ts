import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  type FactoryDispatch,
  fakePullRequest,
  git,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  cancelledRuns,
  interruptedTurns,
  linkOf,
  openParent,
  ownerQueues,
  providerTurnOf,
  runStarted,
  runStatus,
  syncPullRequest,
  wakeThread,
  watchPullRequest,
} from "./testkit/followThrough.ts";

/**
 * A parent's follow-through cancelled or closed out on the server's real stack. Its pull request
 * is linked to its last child's author thread, whose id names that approved child, so a cancel of
 * the parent, or of a child, which cancels its parent, must end the parent's watch there and stop
 * the wake runs that watch set off as the parent's, never the owner's turns, and leave its branch,
 * worktree and approved children as they are. A merged parent's close-out ends that watch before
 * it judges whether a thread still works in the shared worktree. Nothing polls or sleeps: each
 * step drains.
 */

const service = Factory.FactoryService.FactoryService;

/** The parent's last child, whose author thread its pull request is linked to. */
const lastChild = <A>(parent: { readonly children: ReadonlyArray<A> }) =>
  parent.children.at(-1) ?? assert.fail("The parent has no children.");

/** The delivery's row, stage attempts and tasks; a parent's tasks hold its children's approvals. */
const rowsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      delivery: yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`,
      attempts: yield* sql`SELECT * FROM fd_factory_stage_runs WHERE delivery_id = ${deliveryId}`,
      tasks: yield* sql`SELECT * FROM fd_factory_tasks WHERE delivery_id = ${deliveryId}`,
    };
  }).pipe(Effect.orDie);

/** Cancels the delivery as its owner does. */
const cancel = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(service, (factory) => factory.cancel(deliveryId)).pipe(Effect.orDie);

/** Every watch release Factory sends from now on, recorded before it runs. */
const recordReleases = (world: World) => {
  const sent: Array<FactoryDispatch> = [];
  world.factoryDispatch.before = (command) => {
    if (command.commandId.startsWith("factory-pr-unwatch:")) sent.push(command);
    return Effect.void;
  };
  return sent;
};

/** A parent run to its open pull request, with what a cancel must leave as it is. */
const openedParent = (world: World) =>
  Effect.gen(function* () {
    const parent = yield* openParent(world);
    const [first] = parent.children;
    const last = lastChild(parent);
    if (first === undefined) return assert.fail("The parent has no children.");
    return {
      ...parent,
      first,
      last,
      link: yield* linkOf(last.author, fakePullRequest.number),
      head: yield* git(parent.worktreePath, ["rev-parse", "HEAD"]),
      parentRows: yield* rowsOf(parent.deliveryId),
      childRows: yield* Effect.forEach(parent.children, ({ deliveryId }) => rowsOf(deliveryId)),
      lastState: yield* stateOf(last.deliveryId),
    };
  });

/** Which delivery the owner cancels: the parent, or its last child, which cancels the parent. */
const targets = [
  { cancelled: "the parent", child: false },
  { cancelled: "its last child", child: true },
] as const;

/** The delivery a target names. */
const targetOf = (
  parent: {
    readonly deliveryId: FactoryDeliveryId;
    readonly last: { readonly deliveryId: FactoryDeliveryId };
  },
  child: boolean,
) => (child ? parent.last.deliveryId : parent.deliveryId);

/**
 * The parent's work stays after a cancel: its worktree at the same HEAD, its branch, its tasks'
 * approvals, and its approved children as they were. A child its owner cancelled ends cancelled
 * with everything else it recorded, its receipts and reviews included.
 */
const assertWorkKept = (
  world: World,
  parent: Effect.Success<ReturnType<typeof openedParent>>,
  child: boolean,
) =>
  Effect.gen(function* () {
    assert.isTrue(yield* world.exists(parent.worktreePath));
    assert.deepStrictEqual(world.worktreeRemovals, []);
    assert.strictEqual(yield* git(parent.worktreePath, ["rev-parse", "HEAD"]), parent.head);
    assert.strictEqual(
      yield* git(world.root, ["rev-parse", `refs/heads/${parent.state.branch}`]),
      parent.head,
    );
    assert.deepStrictEqual((yield* rowsOf(parent.deliveryId)).tasks, parent.parentRows.tasks);
    const [first, last] = parent.childRows;
    assert.deepStrictEqual(yield* rowsOf(parent.first.deliveryId), first);
    if (child) {
      assert.deepStrictEqual(yield* stateOf(parent.last.deliveryId), {
        ...parent.lastState,
        status: "cancelled",
      });
    } else {
      assert.deepStrictEqual(yield* rowsOf(parent.last.deliveryId), last);
    }
  });

describe("Factory follow-through of a parent cancelled after its PR stage", () => {
  it.live.each([
    ...targets.map((target) => ({
      ...target,
      action: "ends the watch Factory started",
      owners: false,
    })),
    ...targets.map((target) => ({
      ...target,
      action: "keeps a watch the owner put in its place",
      owners: true,
    })),
  ])(
    "$action on the last child's author thread when $cancelled is cancelled",
    ({ child, owners }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const parent = yield* openedParent(world);
          const { deliveryId, last, link } = parent;
          const started = link.watch ?? assert.fail("The PR stage started no watch.");
          if (owners) {
            // The owner stops Factory's watch and starts one of their own.
            yield* watchPullRequest(last.author, link, false);
            yield* watchPullRequest(last.author, link);
          }
          const before = (yield* linkOf(last.author, fakePullRequest.number)).watch;
          assert.isDefined(before);
          const sent = recordReleases(world);

          yield* cancel(targetOf(parent, child));
          yield* drainFactory;
          yield* drainOrchestration;

          const cancelled = yield* stateOf(deliveryId);
          assert.strictEqual(cancelled.status, "cancelled");
          assert.isUndefined(cancelled.releaseWatch);
          // Where the watch Factory started ended: by the release, or by the owner before it.
          assert.strictEqual(cancelled.followThrough?.watchStartedAt, started.startedAt);
          assert.isAbove(
            cancelled.followThrough?.heldUntil ?? 0,
            parent.state.followThrough?.armedAt ?? 0,
          );
          const after = (yield* linkOf(last.author, fakePullRequest.number)).watch;
          if (owners) {
            // Factory's watch was no longer on, so it sent nothing, and the owner's stays.
            assert.deepStrictEqual(after, before);
            assert.deepStrictEqual(sent, []);
          } else {
            // Ended by core's conditional sync naming Factory's start, carrying no wake.
            assert.isUndefined(after);
            assert.strictEqual(sent.length, 1);
            const [release] = sent;
            assert.deepInclude(release, {
              type: "thread.pull-request-watch.sync",
              threadId: last.author,
              number: link.number,
              startedAt: started.startedAt,
              watch: null,
            });
            assert.notProperty(release, "wake");
            const receipt = yield* Effect.flatMap(
              CommandReceiptStore.CommandReceiptStoreV2,
              (store) =>
                store.getByCommandId(release?.commandId ?? assert.fail("Nothing was released.")),
            ).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
            assert.strictEqual(receipt.status, "accepted");
          }
          yield* assertWorkKept(world, parent, child);
        }),
      ),
  );

  it.live.each(targets)(
    "stops the wake running there when $cancelled is cancelled, never the owner's turn queued behind it",
    ({ child }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const parent = yield* openedParent(world);
          const { deliveryId, last } = parent;
          const wake = yield* wakeThread(last.author, parent.link);
          yield* runStarted(wake);
          // Its provider turn runs, so a stop reaches the provider.
          assert.strictEqual(yield* runReached(wake, ["running", ...ended]), "running");
          yield* drainFactory;
          assert.deepStrictEqual((yield* stateOf(deliveryId)).awaiting, {
            type: "run",
            threadId: last.author,
            runId: wake,
          });
          const ownerRun = yield* ownerQueues(last.author, "Summarize the review comments.");
          assert.strictEqual(yield* runStatus(last.author, ownerRun), "queued");

          yield* cancel(targetOf(parent, child));
          yield* drainFactory;
          yield* drainOrchestration;
          assert.strictEqual((yield* stateOf(deliveryId)).status, "cancelled");
          // The parent stops it as its own; the child, whose id the thread carries, stops nothing.
          assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [wake]);
          assert.deepStrictEqual(yield* cancelledRuns(last.author, last.deliveryId), []);
          assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wake)]);

          // The wake's turn stops; the owner's turn then runs, and is left alone.
          yield* world.endRun(wake, "cancelled");
          yield* runStarted(ownerRun);
          yield* drainFactory;
          yield* drainOrchestration;
          assert.deepStrictEqual(interruptedTurns(world), [providerTurnOf(world, wake)]);
          assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [wake]);
          assert.strictEqual(yield* runStatus(last.author, ownerRun), "running");
          assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");
          yield* assertWorkKept(world, parent, child);
        }),
      ),
  );

  it.live.each(targets)(
    "stops a wake queued behind the owner's turn once it starts when $cancelled is cancelled, never that turn",
    ({ child }) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const parent = yield* openedParent(world);
          const { deliveryId, last } = parent;
          const ownerRun = yield* world.ownerTurn(last.author, "Rename the export button.");
          const wake = yield* wakeThread(last.author, parent.link);
          yield* drainOrchestration;
          yield* drainFactory;
          assert.strictEqual(yield* runStatus(last.author, wake), "queued");
          assert.deepStrictEqual((yield* stateOf(deliveryId)).awaiting, {
            type: "run",
            threadId: last.author,
            runId: wake,
          });

          // Cancelled while the owner's turn runs: that turn goes on, and the wake, queued behind
          // it, cannot be stopped before it starts.
          yield* cancel(targetOf(parent, child));
          yield* drainFactory;
          yield* drainOrchestration;
          assert.deepStrictEqual(interruptedTurns(world), []);
          assert.strictEqual(yield* runStatus(last.author, wake), "queued");
          assert.strictEqual(yield* world.endRun(ownerRun, "completed"), "completed");

          // The wake goes live after it, on the approved child's thread, as the parent's turn,
          // and is stopped then.
          yield* drainFactory;
          yield* drainOrchestration;
          assert.deepStrictEqual(yield* cancelledRuns(last.author, deliveryId), [wake]);
          assert.notInclude(interruptedTurns(world), providerTurnOf(world, ownerRun));
          const stopped = yield* runStatus(last.author, wake);
          assert.isTrue(
            stopped === "interrupted" ||
              interruptedTurns(world).includes(providerTurnOf(world, wake)),
            `The queued wake went on as ${stopped}.`,
          );
          yield* assertWorkKept(world, parent, child);
        }),
      ),
  );
});

describe("Factory follow-through of a parent: a release whose command fails", () => {
  it.live.each(targets)(
    "keeps the release marked when $cancelled is cancelled, and a fresh boot sweep ends the watch",
    ({ child }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const worker = yield* Factory.FactoryWorker.FactoryWorker;
            const parent = yield* world.boot(openedParent(world));
            const { deliveryId, last } = parent;
            const started = parent.link.watch ?? assert.fail("The PR stage started no watch.");
            // The release's command fails before core runs it; the watch stays on.
            world.factoryDispatch.before = (command) => {
              if (!command.commandId.startsWith("factory-pr-unwatch:")) return Effect.void;
              world.factoryDispatch.before = undefined;
              return Effect.die("The database is locked.");
            };

            yield* cancel(targetOf(parent, child));
            yield* worker.drain;
            const cancelled = yield* stateOf(deliveryId);
            assert.strictEqual(cancelled.status, "cancelled");
            assert.isTrue(cancelled.releaseWatch);
            assert.deepStrictEqual(
              (yield* linkOf(last.author, fakePullRequest.number)).watch,
              started,
            );

            // The next server's boot sweep releases it, once.
            yield* world.boot(Effect.void);
            const released = yield* stateOf(deliveryId);
            assert.strictEqual(released.status, "cancelled");
            assert.isUndefined(released.releaseWatch);
            assert.strictEqual(released.followThrough?.watchStartedAt, started.startedAt);
            assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
            yield* world.boot(Effect.void);
            assert.deepStrictEqual(yield* stateOf(deliveryId), released);
            yield* assertWorkKept(world, parent, child);
          }),
        { manualReactor: true },
      ),
  );
});

describe("Factory follow-through of a merged parent's close-out", () => {
  it.live(
    "ends Factory's watch on the last child's author thread, then removes the clean worktree",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const parent = yield* openedParent(world);
          const { last, link } = parent;
          const started = link.watch ?? assert.fail("The PR stage started no watch.");
          // Each watch Factory ends, with the worktree removals asked for by then.
          const sent: Array<{
            readonly threadId: ThreadId;
            readonly startedAt: string;
            readonly removals: number;
          }> = [];
          world.factoryDispatch.before = (command) => {
            if (command.type === "thread.pull-request-watch.sync") {
              const { threadId, startedAt } = command;
              sent.push({ threadId, startedAt, removals: world.worktreeRemovals.length });
            }
            return Effect.void;
          };

          yield* syncPullRequest(last.author, link, "merged");
          assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "done");
          // The watch ended first, so it kept nothing; then the clean worktree went.
          assert.deepStrictEqual(sent, [
            { threadId: last.author, startedAt: started.startedAt, removals: 0 },
          ]);
          assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
          assert.deepStrictEqual(world.worktreeRemovals, [
            { cwd: world.root, path: parent.worktreePath },
          ]);
          assert.isFalse(yield* world.exists(parent.worktreePath));
          // The one branch stays at the approved commit.
          assert.strictEqual(
            yield* git(world.root, ["rev-parse", `refs/heads/${parent.state.branch}`]),
            parent.head,
          );
        }),
      ),
  );

  it.live("keeps the worktree while another watch is on that thread", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openedParent(world);
        const { last, link } = parent;
        // The owner watches another pull request on the last child's author thread.
        const other = { ...link, number: 8, url: "https://github.com/acme/alpha/pull/8" };
        yield* watchPullRequest(last.author, other);
        const owners = (yield* linkOf(last.author, other.number, other.url)).watch;
        assert.isDefined(owners);

        yield* syncPullRequest(last.author, link, "merged");
        assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "done");
        // Factory's watch ended; the owner's still counts as that thread's work there.
        assert.isUndefined((yield* linkOf(last.author, fakePullRequest.number)).watch);
        assert.deepStrictEqual((yield* linkOf(last.author, other.number, other.url)).watch, owners);
        assert.deepStrictEqual(world.worktreeRemovals, []);
        assert.isTrue(yield* world.exists(parent.worktreePath));
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${parent.state.branch}`]),
          parent.head,
        );
      }),
    ),
  );
});
