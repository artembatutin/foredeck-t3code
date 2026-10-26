import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { isTerminalRunStatus } from "./pipeline/state.ts";
import {
  drainFactory,
  fakePullRequest,
  git,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  itemStatus,
  linkOf,
  linkPullRequest,
  closedComment,
  openParent,
  openSingle,
  statusWrites,
  syncPullRequest,
} from "./testkit/followThrough.ts";

/**
 * Follow-through on the server's real stack: a delivery's open pull request merged or closed, as
 * core's sync stores it on the thread the pull request is linked to. Factory's reactor tails the
 * events core commits, the worker closes a merge out through Work's Markdown source and the
 * isolated project's Git, and a close cancels the delivery with one Work comment. Nothing polls or
 * sleeps: each step drains.
 */

const service = Factory.FactoryService.FactoryService;

const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };
const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(
    Effect.orDie,
    Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])),
  );

const closedText = (url: string) => `${closedComment} ${url}`;

const findComment = (ref: WorkItemRef, text: string) =>
  Effect.flatMap(WorkService.WorkService, (work) => work.findComment(reader, { ref, text })).pipe(
    Effect.orDie,
  );

describe("Factory follow-through of a single item's pull request", () => {
  it.live("takes only its own pull request's merge on its author thread, and closes it out", () => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const {
            deliveryId,
            threadId: author,
            reviewer,
            worktreePath,
            state,
          } = yield* openSingle(world);
          const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");
          const link = yield* linkOf(author, fakePullRequest.number);
          assert.strictEqual(link.url, fakePullRequest.url);
          const comments = world.commentCalls.length;

          // The same pull request on the reviewer thread, another one on the author thread, and
          // one of another repository under the same number.
          const other = { ...link, number: 8, url: "https://github.com/acme/alpha/pull/8" };
          const elsewhere = {
            ...link,
            repository: "acme/beta",
            url: "https://github.com/acme/beta/pull/7",
          };
          yield* linkPullRequest(reviewer, link);
          yield* linkPullRequest(author, other);
          yield* linkPullRequest(author, elsewhere);
          for (const [threadId, key, snapshot] of [
            [author, link, "open"],
            [reviewer, link, "merged"],
            [reviewer, link, "closed"],
            [author, other, "merged"],
            [author, other, "closed"],
            [author, elsewhere, "merged"],
            [author, elsewhere, "closed"],
          ] as const) {
            yield* syncPullRequest(threadId, key, snapshot);
            assert.deepStrictEqual(yield* stateOf(deliveryId), state);
          }
          // Each landed on its link: none of them was the delivery's pull request on its thread.
          for (const [threadId, key, snapshot] of [
            [author, link, "open"],
            [reviewer, link, "closed"],
            [author, other, "closed"],
            [author, elsewhere, "closed"],
          ] as const) {
            const synced = yield* linkOf(threadId, key.number, key.url);
            assert.strictEqual(synced.snapshot?.state, snapshot);
          }
          assert.deepStrictEqual(writes.calls, []);
          assert.deepStrictEqual(world.worktreeRemovals, []);

          // Merged: the item is done through Work under Factory's actor, the clean worktree is
          // removed from the project's checkout, and the branch stays at the approved commit.
          yield* syncPullRequest(author, link, "merged");
          const done = yield* stateOf(deliveryId);
          assert.strictEqual(done.status, "done");
          assert.strictEqual(done.stage, "follow_through");
          assert.isNull(done.awaiting);
          assert.deepStrictEqual(done.pullRequest, {
            ...fakePullRequest,
            headBranch: state.branch,
            outcome: "merged",
          });
          assert.deepStrictEqual(
            writes.calls.map(({ actor, input }) => [actor.id, input]),
            [[`factory:${deliveryId}`, { ref: world.itemRef, status: "done" }]],
          );
          assert.strictEqual(yield* itemStatus(world.itemRef), "done");
          assert.deepStrictEqual(world.worktreeRemovals, [{ cwd: world.root, path: worktreePath }]);
          assert.isFalse(yield* world.exists(worktreePath));
          assert.notInclude(yield* git(world.root, ["worktree", "list"]), worktreePath);
          assert.strictEqual(
            yield* git(world.root, ["rev-parse", `refs/heads/${state.branch}`]),
            approved,
          );
          // A merge announces nothing, and the follow-through attempt passed.
          assert.strictEqual(world.commentCalls.length, comments);
          assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-2), [
            ["pr", "passed"],
            ["follow_through", "passed"],
          ]);

          // Synced again, the merge is inert: no second close-out.
          yield* syncPullRequest(author, link, "merged");
          yield* syncPullRequest(author, link, "closed");
          assert.deepStrictEqual(yield* stateOf(deliveryId), done);
          assert.strictEqual(writes.calls.length, 1);
          assert.strictEqual(world.worktreeRemovals.length, 1);
          assert.strictEqual(world.commentCalls.length, comments);
        }),
      { work: writes.work },
    );
  });

  it.live("keeps a worktree with changes, and still ends done", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);
        const notes = path.join(worktreePath, "notes.txt");
        yield* fileSystem.writeFileString(notes, "left for later\n");

        yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), "merged");
        assert.strictEqual((yield* stateOf(deliveryId)).status, "done");
        assert.strictEqual(yield* itemStatus(world.itemRef), "done");
        assert.deepStrictEqual(world.worktreeRemovals, []);
        assert.strictEqual(yield* fileSystem.readFileString(notes), "left for later\n");
      }),
    ),
  );

  it.live("blocks on a close-out whose item write fails, and a resume closes it out", () => {
    const writes = statusWrites();
    writes.fault.fails = () => true;
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);
          const link = yield* linkOf(author, fakePullRequest.number);

          yield* syncPullRequest(author, link, "merged");
          const blocked = yield* stateOf(deliveryId);
          const detail = "Factory could not close out the merged pull request (WorkUnavailable).";
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, {
            reason: "effect_failed",
            effect: { id: blocked.effectsIssued, type: "close_out" },
            detail,
          });
          // Never done with its item unchanged; the worktree waits for the close-out too.
          assert.strictEqual(yield* itemStatus(world.itemRef), "todo");
          assert.isTrue(yield* world.exists(worktreePath));
          assert.deepStrictEqual(world.worktreeRemovals, []);
          assert.include(world.commentCalls.at(-1)?.input.body ?? "", detail);
          // Blocked, it takes the merge no more.
          yield* syncPullRequest(author, link, "merged");
          assert.deepStrictEqual(yield* stateOf(deliveryId), blocked);
          assert.strictEqual(writes.calls.length, 1);

          writes.fault.fails = () => false;
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          const done = yield* stateOf(deliveryId);
          assert.strictEqual(done.status, "done");
          assert.isNull(done.block);
          assert.strictEqual(yield* itemStatus(world.itemRef), "done");
          assert.deepStrictEqual(world.worktreeRemovals, [{ cwd: world.root, path: worktreePath }]);
          assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-2), [
            ["follow_through", "blocked"],
            ["follow_through", "passed"],
          ]);
        }),
      { work: writes.work },
    );
  });

  it.live("cancels on a close without merging, with one comment, keeping its work", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, worktreePath, state } = yield* openSingle(world);
        const link = yield* linkOf(author, fakePullRequest.number);
        const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");
        const before = world.commentCalls.length;

        yield* syncPullRequest(author, link, "closed");
        const cancelled = yield* stateOf(deliveryId);
        assert.strictEqual(cancelled.status, "cancelled");
        assert.strictEqual(cancelled.stage, "follow_through");
        assert.isNull(cancelled.awaiting);
        assert.strictEqual(cancelled.pullRequest?.outcome, "closed");
        // The item is left as it was, and the worktree, branch and commits stay.
        assert.strictEqual(yield* itemStatus(world.itemRef), "todo");
        assert.isTrue(yield* world.exists(worktreePath));
        assert.deepStrictEqual(world.worktreeRemovals, []);
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "HEAD"]), approved);
        assert.strictEqual(
          yield* git(world.root, ["rev-parse", `refs/heads/${state.branch}`]),
          approved,
        );

        // One comment, from the step that stored the cancel, ending with its reference.
        const reference = `Factory delivery ${deliveryId}, update 3.`;
        assert.deepStrictEqual(
          world.commentCalls.slice(before).map(({ actor, input }) => [actor.id, input]),
          [
            [
              `factory:${deliveryId}`,
              {
                ref: world.itemRef,
                body: `${closedText(fakePullRequest.url)} ${reference}`,
                clientRequestId: `factory:${deliveryId}:cancelled:3`,
              },
            ],
          ],
        );
        assert.isTrue(Option.isSome(yield* findComment(world.itemRef, reference)));
        assert.deepStrictEqual((yield* attemptsOf(deliveryId)).slice(-2), [
          ["pr", "passed"],
          ["follow_through", "cancelled"],
        ]);

        // Synced again, the close is inert.
        yield* syncPullRequest(author, link, "closed");
        yield* syncPullRequest(author, link, "merged");
        assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled);
        assert.strictEqual(world.commentCalls.length, before + 1);
      }),
    ),
  );

  it.live("posts nothing when its owner cancels the open pull request's delivery", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const { deliveryId, threadId: author } = yield* openSingle(world);
        const before = world.commentCalls.length;

        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;
        const cancelled = yield* stateOf(deliveryId);
        assert.strictEqual(cancelled.status, "cancelled");
        assert.strictEqual(cancelled.stage, "pr");
        assert.isUndefined(cancelled.pullRequest?.outcome);
        assert.strictEqual(world.commentCalls.length, before);

        // A close reported afterwards finds it ended.
        yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), "closed");
        assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled);
        assert.strictEqual(world.commentCalls.length, before);
      }),
    ),
  );
});

describe("Factory follow-through of a parent's pull request", () => {
  it.live("closes a merge on the last child's author thread out with every child item", () => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const parent = yield* openParent(world);
          const [first, last] = parent.children;
          if (first === undefined || last === undefined) return assert.fail("Two children.");
          const link = yield* linkOf(last.author, fakePullRequest.number);
          const comments = world.commentCalls.length;
          const approvedChildren = yield* Effect.forEach(parent.children, ({ deliveryId }) =>
            stateOf(deliveryId),
          );

          // The pull request is the last child's author's: the first child's link to it is not.
          yield* linkPullRequest(first.author, link);
          yield* syncPullRequest(first.author, link, "merged");
          assert.deepStrictEqual(yield* stateOf(parent.deliveryId), parent.state);
          assert.deepStrictEqual(writes.calls, []);

          yield* syncPullRequest(last.author, link, "merged");
          assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "done");
          // Each child item in plan order, then the parent's, all done in the Markdown source.
          const items = [...parent.children.map(({ itemRef }) => itemRef), world.itemRef];
          assert.deepStrictEqual(
            writes.calls.map(({ input }) => input),
            items.map((ref) => ({ ref, status: "done" as const })),
          );
          for (const ref of items) assert.strictEqual(yield* itemStatus(ref), "done");
          // The approved children are done with their parent.
          for (const [index, { deliveryId }] of parent.children.entries()) {
            assert.deepStrictEqual(yield* stateOf(deliveryId), {
              ...approvedChildren[index],
              status: "done",
            });
          }
          // The shared worktree is removed; the one branch stays.
          assert.deepStrictEqual(world.worktreeRemovals, [
            { cwd: world.root, path: parent.worktreePath },
          ]);
          assert.strictEqual(
            yield* git(world.root, ["rev-parse", `refs/heads/${parent.state.branch}`]),
            parent.state.receipts.at(-1)?.headSha,
          );
          assert.strictEqual(world.commentCalls.length, comments);
        }),
      { work: writes.work },
    );
  });

  it.live("cancels a closed parent alone, leaving its approved children approved", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const parent = yield* openParent(world);
        const last = parent.children.at(-1) ?? assert.fail("Two children.");
        const approvedChildren = yield* Effect.forEach(parent.children, ({ deliveryId }) =>
          stateOf(deliveryId),
        );
        const before = world.commentCalls.length;

        yield* syncPullRequest(
          last.author,
          yield* linkOf(last.author, fakePullRequest.number),
          "closed",
        );
        assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "cancelled");
        for (const [index, { deliveryId }] of parent.children.entries()) {
          assert.deepStrictEqual(yield* stateOf(deliveryId), approvedChildren[index]);
        }
        for (const { itemRef } of parent.children) {
          assert.strictEqual(yield* itemStatus(itemRef), "todo");
        }
        // One comment, on the parent's item.
        assert.deepStrictEqual(
          world.commentCalls.slice(before).map(({ input }) => [input.ref, input.body]),
          [
            [
              world.itemRef,
              `${closedText(fakePullRequest.url)} Factory delivery ${parent.deliveryId}, update 4.`,
            ],
          ],
        );
        assert.isTrue(yield* world.exists(parent.worktreePath));
        assert.deepStrictEqual(world.worktreeRemovals, []);
      }),
    ),
  );
});

describe("Factory's close-out keeps what it must and is safe to run again", () => {
  it.live("keeps the worktree of a delivery its owner cancels while its item is set done", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writes = statusWrites();
      return yield* withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { deliveryId, threadId: author, worktreePath, state } = yield* openSingle(world);
            const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");

            // The merge's close-out waits in its item write.
            yield* syncPullRequest(
              author,
              yield* linkOf(author, fakePullRequest.number),
              "merged",
              {
                drain: false,
              },
            );
            yield* Deferred.await(writing);
            const closing = yield* stateOf(deliveryId);
            assert.strictEqual(closing.status, "pr_open");
            assert.strictEqual(closing.awaiting?.type, "effect");

            // The owner's cancel is accepted meanwhile, then the write finishes.
            const cancelled = yield* factory.cancel(deliveryId).pipe(Effect.orDie);
            assert.strictEqual(cancelled.state.status, "cancelled");
            yield* Deferred.succeed(release, undefined);
            yield* drainFactory;

            // The cancel keeps the checkout, and the close-out's result changes nothing.
            assert.deepStrictEqual(yield* stateOf(deliveryId), cancelled.state);
            assert.isTrue(yield* world.exists(worktreePath));
            assert.deepStrictEqual(world.worktreeRemovals, []);
            assert.strictEqual(yield* git(worktreePath, ["rev-parse", "HEAD"]), approved);
            assert.strictEqual(
              yield* git(world.root, ["rev-parse", `refs/heads/${state.branch}`]),
              approved,
            );
            // The write under way when the cancel came landed, as other effects' writes do.
            assert.deepStrictEqual(writes.written, [{ ref: world.itemRef, status: "done" }]);
          }),
        {
          work: (work) => {
            const recorded = writes.work(work);
            return {
              ...recorded,
              setStatus: (actor, input) =>
                Deferred.succeed(writing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(recorded.setStatus(actor, input)),
                ),
            };
          },
        },
      );
    }),
  );

  it.live("keeps a clean worktree a thread is working in, and leaves that run alone", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);

        // The owner asks the author thread for more before the pull request merges; its turn
        // runs in the delivery's worktree and has written nothing yet.
        const own = yield* world.ownerTurn(author, "Rename the export button to Download.");
        assert.isTrue(world.provider.started.some(({ runId }) => runId === own));
        assert.strictEqual(
          yield* git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );

        yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), "merged");
        const done = yield* stateOf(deliveryId);
        assert.strictEqual(done.status, "done");
        assert.strictEqual(yield* itemStatus(world.itemRef), "done");
        // The worktree stays under the owner's turn, which runs on uninterrupted.
        assert.deepStrictEqual(world.worktreeRemovals, []);
        assert.isTrue(yield* world.exists(worktreePath));
        assert.deepStrictEqual(world.provider.interrupted, []);
        const running = (yield* threadProjection(author)).runs.find(({ id }) => id === own);
        assert.isFalse(running === undefined || isTerminalRunStatus(running.status));

        // The turn ends as its owner's: the worktree and the delivery stay as they are.
        assert.strictEqual(yield* world.endRun(own, "completed"), "completed");
        assert.isTrue(yield* world.exists(worktreePath));
        assert.deepStrictEqual(yield* stateOf(deliveryId), done);
      }),
    ),
  );

  it.live("leaves an item already done as it is, where setting it done again is refused", () => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId, threadId: author, worktreePath } = yield* openSingle(world);
          // Someone finished the item before the pull request merged.
          yield* Effect.flatMap(WorkService.WorkService, (work) =>
            work.setStatus(owner, { ref: world.itemRef, status: "done" }),
          ).pipe(Effect.orDie);
          const before = writes.calls.length;

          yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), "merged");
          assert.strictEqual((yield* stateOf(deliveryId)).status, "done");
          assert.strictEqual(writes.calls.length, before);
          assert.deepStrictEqual(world.worktreeRemovals, [{ cwd: world.root, path: worktreePath }]);
        }),
      { work: writes.work },
    );
  });

  it.live(
    "resumes a close-out whose removal failed after its item was set, writing it once",
    () => {
      const writes = statusWrites();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { deliveryId, threadId: author, worktreePath, state } = yield* openSingle(world);
            const approved = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");
            // Git refuses to remove a locked worktree.
            yield* git(world.root, [
              "worktree",
              "lock",
              "--reason",
              "kept by a test",
              worktreePath,
            ]);

            yield* syncPullRequest(author, yield* linkOf(author, fakePullRequest.number), "merged");
            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.status, "blocked");
            assert.deepStrictEqual(blocked.block, {
              reason: "effect_failed",
              effect: { id: blocked.effectsIssued, type: "close_out" },
              detail: "Factory could not close out the merged pull request (GitCommandError).",
            });
            // The item was set; the worktree, branch and approval stay.
            assert.deepStrictEqual(writes.written, [{ ref: world.itemRef, status: "done" }]);
            assert.strictEqual(world.worktreeRemovals.length, 1);
            assert.isTrue(yield* world.exists(worktreePath));
            assert.strictEqual(
              yield* git(world.root, ["rev-parse", `refs/heads/${state.branch}`]),
              approved,
            );
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            assert.isTrue(
              yield* fileSystem.exists(
                path.join(world.evidenceDir(deliveryId), "approval-item.json"),
              ),
            );

            // Unlocked, a resume removes the worktree and sets nothing again.
            yield* git(world.root, ["worktree", "unlock", worktreePath]);
            yield* factory.resume(deliveryId).pipe(Effect.orDie);
            yield* drainFactory;
            assert.strictEqual((yield* stateOf(deliveryId)).status, "done");
            assert.strictEqual(writes.calls.length, 1);
            assert.strictEqual(world.worktreeRemovals.length, 2);
            assert.isFalse(yield* world.exists(worktreePath));
          }),
        { work: writes.work },
      );
    },
  );

  it.live("resumes a parent's close-out that failed partway, setting each item done once", () => {
    const writes = statusWrites();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parent = yield* openParent(world);
          const [first, last] = parent.children;
          if (first === undefined || last === undefined) return assert.fail("Two children.");
          const approvedChildren = yield* Effect.forEach(parent.children, ({ deliveryId }) =>
            stateOf(deliveryId),
          );
          // The last child's item cannot be written the first time.
          writes.fault.fails = (input) => input.ref.itemId === last.itemRef.itemId;

          yield* syncPullRequest(
            last.author,
            yield* linkOf(last.author, fakePullRequest.number),
            "merged",
          );
          const blocked = yield* stateOf(parent.deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.strictEqual(blocked.block?.reason, "effect_failed");
          assert.strictEqual(yield* itemStatus(first.itemRef), "done");
          assert.strictEqual(yield* itemStatus(last.itemRef), "todo");
          assert.strictEqual(yield* itemStatus(world.itemRef), "todo");
          // Its children stay approved, and its worktree, branch and approval stay.
          for (const [index, { deliveryId }] of parent.children.entries()) {
            assert.deepStrictEqual(yield* stateOf(deliveryId), approvedChildren[index]);
          }
          assert.isTrue(yield* world.exists(parent.worktreePath));
          assert.deepStrictEqual(world.worktreeRemovals, []);
          assert.isTrue(
            yield* fileSystem.exists(
              path.join(world.evidenceDir(parent.deliveryId), "approval.json"),
            ),
          );

          writes.fault.fails = () => false;
          yield* factory.resume(parent.deliveryId).pipe(Effect.orDie);
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(parent.deliveryId)).status, "done");
          // The first child's item is read done and left; the others are set once each.
          assert.deepStrictEqual(
            writes.calls.map(({ input }) => input.ref),
            [first.itemRef, last.itemRef, last.itemRef, world.itemRef],
          );
          assert.deepStrictEqual(
            writes.written.map(({ ref }) => ref),
            [first.itemRef, last.itemRef, world.itemRef],
          );
          for (const { deliveryId } of parent.children) {
            assert.strictEqual((yield* stateOf(deliveryId)).status, "done");
          }
          assert.deepStrictEqual(world.worktreeRemovals, [
            { cwd: world.root, path: parent.worktreePath },
          ]);
        }),
      { work: writes.work },
    );
  });
});
