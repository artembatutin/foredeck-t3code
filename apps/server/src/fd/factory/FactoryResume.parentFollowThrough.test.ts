import { assert, describe, it } from "@effect/vitest";
import { CommandId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  git,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import { openParent } from "./testkit/followThrough.ts";

/**
 * A parent's resume once its pull request is linked to its last child's author thread, on the
 * server's real stack: the resume reads the parent's branch as it reads an author's, so a
 * follow-through round's commits are settled before the branch is verified and integrated again.
 * Each test stores the parent its PR stage left, blocked on a follow-through round's run there
 * that failed, and resumes from there.
 */

const service = Factory.FactoryService.FactoryService;
const wakeRun = RunId.make("run-wake");

/** A parent of two children with its pull request open, blocked on a failed round's run. */
const blockedRound = (world: World) =>
  Effect.gen(function* () {
    const parent = yield* openParent(world);
    const [, last] = parent.children;
    if (last === undefined) return assert.fail("The parent has no last child.");
    // The PR stage recorded the thread it linked the pull request to.
    assert.strictEqual(parent.state.pullRequestThread, last.author);
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.update(parent.deliveryId, {
      ...parent.state,
      status: "blocked",
      stage: "follow_through",
      block: { reason: "run_ended", threadId: last.author, runId: wakeRun, runStatus: "failed" },
    });
    return { ...parent, last, child: yield* stateOf(last.deliveryId) };
  });

describe("resuming a parent whose pull request is linked to its last child's author thread", () => {
  it.live("sends its fix-commit turn there for a commit the round left unsettled", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, worktreePath, last, child } = yield* blockedRound(world);
        const before = world.provider.started.length;
        yield* authorCommits(worktreePath, "address the review", "export const y = 2;\n");

        yield* (yield* service).resume(deliveryId);
        yield* drainFactory;
        yield* drainOrchestration;

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "repair");
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.strictEqual(state.awaiting?.type, "run");
        if (state.awaiting?.type !== "run") return;
        assert.strictEqual(state.awaiting.threadId, last.author);
        const turns = world.provider.started.slice(before);
        assert.deepStrictEqual(
          turns.map((turn) => [turn.threadId, turn.runId]),
          [[last.author, state.awaiting.runId]],
        );
        // The approved child is left as it was.
        assert.deepStrictEqual(yield* stateOf(last.deliveryId), child);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("verifies and integrates a settled branch afresh, with a new reviewer", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, worktreePath, last, child, state: opened } = yield* blockedRound(world);
        yield* authorCommits(worktreePath, "fix: address the review", "export const y = 2;\n");
        const head = yield* git(worktreePath, ["rev-parse", "HEAD"]);

        yield* (yield* service).resume(deliveryId);
        yield* drainFactory;
        yield* drainOrchestration;

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "integrate");
        assert.strictEqual(state.receipts.length, opened.receipts.length + 1);
        assert.strictEqual(state.receipts.at(-1)?.headSha, head);
        assert.strictEqual(state.reviewRound, opened.reviewRound + 1);
        assert.strictEqual(state.awaiting?.type, "run");
        if (state.awaiting?.type !== "run") return;
        assert.notStrictEqual(state.awaiting.threadId, opened.threads.reviewer);
        assert.strictEqual(state.threads.reviewer, state.awaiting.threadId);
        assert.deepStrictEqual(yield* stateOf(last.deliveryId), child);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("blocks again, sending nothing, when that thread was deleted", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, last } = yield* blockedRound(world);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-the-last-child-author"),
          threadId: last.author,
        });
        yield* drainOrchestration;
        yield* drainFactory;
        const before = world.provider.started.length;

        const resumed = yield* (yield* service).resume(deliveryId);
        yield* drainFactory;

        assert.strictEqual(resumed.state.status, "blocked");
        assert.deepStrictEqual(resumed.state.block, {
          reason: "thread_deleted",
          threadId: last.author,
        });
        assert.strictEqual(world.provider.started.length, before);
      }),
    ).pipe(Effect.orDie),
  );
});
