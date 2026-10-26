import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import {
  drainFactory,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  closedComment,
  linkOf,
  openSingle,
  statusWrites,
  syncPullRequest,
} from "./testkit/followThrough.ts";

/**
 * Follow-through across restarts, on the server's real stack. Factory's reactor runs only while a
 * server boots it (`manualReactor`), so a pull request core's sync stores merged or closed between
 * two boots reaches Factory only through the next boot sweep, which reads the link from the
 * projection. Nothing sleeps or polls: each boot drains.
 */

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

const itemOf = (ref: WorkItemRef) =>
  Effect.flatMap(WorkService.WorkService, (work) => work.getItem(owner, { ref })).pipe(
    Effect.orDie,
  );

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

describe("Factory's boot sweep of open pull requests", () => {
  it.live("steps a merge stored while Factory was down as the tail would, and only once", () => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          // Server 1 opens the pull request, then stops.
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author, worktreePath } = opened;
          const link = yield* linkOf(author, fakePullRequest.number);
          const comments = world.commentCalls.length;

          // While no server runs Factory, core's sync stores the merge.
          yield* syncPullRequest(author, link, "merged", { drain: false });
          assert.deepStrictEqual(yield* stateOf(deliveryId), opened.state);

          // Server 2's boot sweep reads it from the link and closes the delivery out.
          yield* world.boot(Effect.void);
          const done = yield* stateOf(deliveryId);
          assert.deepStrictEqual(
            done,
            advance(
              advance(opened.state, { type: "pr.merged", number: link.number, url: link.url })
                .delivery,
              {
                type: "closed_out",
                effectId: opened.state.effectsIssued + 1,
              },
            ).delivery,
          );
          assert.strictEqual(done.status, "done");
          const item = yield* itemOf(world.itemRef);
          assert.strictEqual(item.status, "done");
          assert.strictEqual(writes.calls.length, 1);
          assert.deepStrictEqual(world.worktreeRemovals, [{ cwd: world.root, path: worktreePath }]);
          assert.strictEqual(world.commentCalls.length, comments);

          // Server 3 finds nothing to do: no second close-out, comment or item write.
          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), done);
          assert.deepStrictEqual(yield* itemOf(world.itemRef), item);
          assert.strictEqual(writes.calls.length, 1);
          assert.strictEqual(world.worktreeRemovals.length, 1);
          assert.strictEqual(world.commentCalls.length, comments);
        }),
      { manualReactor: true, work: writes.work },
    );
  });

  it.live("steps a close stored while Factory was down, posting its one comment once", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* world.boot(openSingle(world));
          const { deliveryId, threadId: author, worktreePath } = opened;
          const link = yield* linkOf(author, fakePullRequest.number);
          const comments = world.commentCalls.length;
          yield* syncPullRequest(author, link, "closed", { drain: false });

          yield* world.boot(Effect.void);
          const cancelled = yield* stateOf(deliveryId);
          assert.deepStrictEqual(
            cancelled,
            advance(opened.state, { type: "pr.closed", number: link.number, url: link.url })
              .delivery,
          );
          assert.strictEqual(cancelled.status, "cancelled");
          assert.deepStrictEqual(
            world.commentCalls.slice(comments).map(({ input }) => input.body),
            [`${closedComment} ${fakePullRequest.url} Factory delivery ${deliveryId}, update 3.`],
          );
          const item = yield* itemOf(world.itemRef);
          assert.strictEqual(item.status, "todo");
          assert.isTrue(yield* world.exists(worktreePath));

          yield* world.boot(Effect.void);
          assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled);
          assert.strictEqual(world.commentCalls.length, comments + 1);
          assert.deepStrictEqual(yield* itemOf(world.itemRef), item);
          assert.deepStrictEqual(world.worktreeRemovals, []);
        }),
      { manualReactor: true },
    ),
  );

  it.live.each([
    { when: "before its item write", written: false },
    { when: "after its item write", written: true },
  ])("blocks a close-out a restart lost $when, and a resume closes it out once", ({ written }) => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const work = yield* WorkService.WorkService;
          const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const opened = yield* world.boot(openSingle(world));

          // A delivery of another item that took its merge in a server that stopped before
          // running the close-out: stored awaiting it, with its follow-through attempt open.
          const other = yield* work
            .createItem(owner, { sourceId: world.itemRef.sourceId, title: "Add the import button" })
            .pipe(Effect.orDie);
          // The stopped process may have set the item done before it stopped.
          if (written) {
            yield* work.setStatus(owner, { ref: other.ref, status: "done" }).pipe(Effect.orDie);
          }
          const before = writes.written.length;
          const merged = advance(
            { ...opened.state, worktreePath: null },
            { type: "pr.merged", number: fakePullRequest.number, url: fakePullRequest.url },
          );
          assert.deepStrictEqual(merged.effects, [
            { id: opened.state.effectsIssued + 1, type: "close_out" },
          ]);
          const deliveryId = FactoryDeliveryId.make("delivery-lost-close-out");
          yield* deliveries
            .insert({
              deliveryId,
              projectId: world.projectId,
              itemRef: other.ref,
              state: merged.delivery,
            })
            .pipe(Effect.orDie);
          yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
            runs.append({ deliveryId, stage: "follow_through" }),
          ).pipe(Effect.orDie);

          // The next boot finds it awaiting an effect no process runs: it blocks, never done
          // with its item unchanged.
          yield* world.boot(Effect.void);
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, {
            reason: "effect_failed",
            effect: merged.effects[0] ?? assert.fail("No close-out."),
            detail:
              "Factory could not close out the merged pull request: a server restart interrupted it.",
          });
          assert.strictEqual(writes.written.length, before);
          assert.strictEqual((yield* itemOf(other.ref)).status, written ? "done" : "todo");

          // A resume closes it out.
          yield* world.boot(
            Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
              factory.resume(deliveryId),
            ).pipe(Effect.orDie, Effect.andThen(drainFactory)),
          );
          assert.strictEqual((yield* stateOf(deliveryId)).status, "done");
          // Set once, by whichever process got to it; a done item is never set done again.
          assert.deepStrictEqual(
            writes.written.map(({ ref }) => ref),
            [other.ref],
          );
          assert.strictEqual((yield* itemOf(other.ref)).status, "done");
          assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
            ["follow_through", "blocked"],
            ["follow_through", "passed"],
          ]);
          // The first delivery's pull request is still open, and it is untouched.
          assert.deepStrictEqual(yield* stateOf(opened.deliveryId), opened.state);
        }),
      { manualReactor: true, work: writes.work },
    );
  });
});
