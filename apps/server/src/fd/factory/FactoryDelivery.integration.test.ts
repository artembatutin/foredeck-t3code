import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
  withProject,
} from "./testkit/deliveryHarness.ts";

describe("Factory single-item delivery", () => {
  it.live("launches the author on a new worktree, verifies, reviews and approves it", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        const path = yield* Path.Path;

        // The author thread works on the delivery branch in a new worktree under T3 home.
        const before = yield* stateOf(author.deliveryId);
        const thread = (yield* threadProjection(author.threadId)).thread;
        assert.strictEqual(thread.worktreePath, author.worktreePath);
        assert.strictEqual(thread.branch, before.branch);
        assert.isTrue(author.worktreePath.startsWith(path.join(world.t3Home, "worktrees")));
        assert.strictEqual(
          yield* git(author.worktreePath, ["branch", "--show-current"]),
          before.branch,
        );
        assert.strictEqual(before.baseline, yield* git(world.root, ["rev-parse", "HEAD"]));
        const [turn] = world.provider.started;
        assert.strictEqual(world.provider.started.length, 1);
        assert.strictEqual(turn?.runId, author.runId);
        assert.strictEqual(turn?.runtimePolicy.cwd, author.worktreePath);
        assert.include(turn?.message.text ?? "", world.itemTitle);

        yield* authorCommits(author.worktreePath, "feat: add the export button");
        assert.strictEqual(yield* world.endRun(author.runId, "completed"), "completed");

        // Verified, so the review began: a reviewer thread works on the same worktree.
        const state = yield* stateOf(author.deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.isNull(state.block);
        const receipt = state.receipts.at(-1);
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(receipt?.code, 0);
        assert.isFalse(receipt?.timedOut);
        assert.strictEqual(
          receipt?.headSha,
          yield* git(author.worktreePath, ["rev-parse", "HEAD"]),
        );
        assert.strictEqual(
          receipt?.tree,
          yield* git(author.worktreePath, ["rev-parse", "HEAD^{tree}"]),
        );

        // Evidence lives under T3 home; the repository and its worktree are untouched by it.
        const evidence = world.evidenceDir(author.deliveryId);
        assert.strictEqual(receipt?.logPath, path.join(evidence, "verify-1.log"));
        const fileSystem = yield* FileSystem.FileSystem;
        assert.include(
          yield* fileSystem.readFileString(path.join(evidence, "verify-1.log")),
          "checks passed",
        );
        assert.deepStrictEqual(
          JSON.parse(yield* fileSystem.readFileString(path.join(evidence, "verify-1.json"))),
          receipt,
        );
        assert.strictEqual(
          yield* git(world.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
          world.rootStatus,
        );
        assert.strictEqual(world.rootStatus, "");
        assert.strictEqual(
          yield* git(author.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );

        // The reviewer is a separate thread in plan mode, prompted with the verified commit.
        const { awaiting } = state;
        if (awaiting?.type !== "run") return assert.fail("The reviewer launch recorded no run.");
        assert.strictEqual(state.threads.reviewer, awaiting.threadId);
        assert.notStrictEqual(awaiting.threadId, author.threadId);
        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.strictEqual(world.provider.started.length, 2);
        const review = world.provider.started[1];
        assert.strictEqual(review?.threadId, awaiting.threadId);
        assert.strictEqual(review?.runtimePolicy.cwd, author.worktreePath);
        assert.strictEqual(review?.runtimePolicy.interactionMode, "plan");
        assert.include(review?.message.text ?? "", `${state.baseline}..${receipt?.headSha}`);
        assert.include(review?.message.text ?? "", "factory_submit_review");

        // This provider has no t3 tools: its review arrives in the run's last message.
        if (review === undefined) return;
        yield* world.provider.say(
          review,
          `Reviewed.\n\n\`\`\`json\n${JSON.stringify({
            verdict: "pass",
            findings: [],
            acceptance: [
              {
                criterion: 1,
                status: "verified",
                evidence: "The export module is committed.",
                paths: ["export.ts"],
              },
            ],
            missing_evidence: [],
          })}\n\`\`\``,
        );
        assert.strictEqual(yield* world.endRun(awaiting.runId, "completed"), "completed");

        // Accepted from the fallback, then approved: the approval names the task the start stored.
        // FactoryDelivery.pr.integration.test.ts covers the pull request that follows.
        const reviewed = yield* stateOf(author.deliveryId);
        assert.strictEqual(reviewed.stage, "pr");
        assert.strictEqual(reviewed.status, "pr_open");
        assert.isNull(reviewed.block);
        assert.strictEqual(world.pullRequestCalls.length, 1);
        const approval = JSON.parse(
          yield* fileSystem.readFileString(path.join(evidence, "approval-item.json")),
        );
        assert.strictEqual(approval.deliveryId, author.deliveryId);
        assert.strictEqual(approval.taskId, "item");
        assert.strictEqual(approval.headSha, receipt?.headSha);
        assert.strictEqual(approval.tree, receipt?.tree);
        assert.strictEqual(approval.receiptPath, path.join(evidence, "verify-1.json"));
        assert.strictEqual(approval.reviewPath, path.join(evidence, "review-1.json"));
        assert.deepStrictEqual(
          reviewed.reviews.map(({ round, source, summary, evidencePath }) => ({
            round,
            source,
            headSha: summary.headSha,
            blocking: summary.blocking,
            evidencePath,
          })),
          [
            {
              round: 1,
              source: "fallback",
              headSha: receipt?.headSha,
              blocking: false,
              evidencePath: path.join(evidence, "review-1.json"),
            },
          ],
        );
        assert.isTrue(yield* world.exists(path.join(evidence, "review-1.json")));
        assert.strictEqual(
          yield* git(author.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
        assert.strictEqual(world.provider.started.length, 2);
      }),
    ),
  );

  it.live("blocks with the failing receipt and its log when verify fails without fix rounds", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "verify");
          assert.deepStrictEqual(state.block, { reason: "verify_failed" });
          const receipt = state.receipts.at(-1);
          assert.strictEqual(state.receipts.length, 1);
          assert.strictEqual(receipt?.code, 3);
          assert.strictEqual(
            receipt?.headSha,
            yield* git(author.worktreePath, ["rev-parse", "HEAD"]),
          );

          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.strictEqual(receipt?.logPath, path.join(evidence, "verify-1.log"));
          assert.include(
            yield* fileSystem.readFileString(path.join(evidence, "verify-1.log")),
            "one check failed",
          );
          assert.isTrue(yield* world.exists(path.join(evidence, "verify-1.json")));
        }),
      // The project allows no fix round, and the delivery keeps the limit it started with.
      { limits: { maxFixRounds: 0 } },
    ),
  );

  it.live("sends one fix-commit turn on the author thread, then blocks unsettled", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        const noCommit = "No commit was added since the baseline.";

        // The author's turn ends without a commit: the same thread gets one fix-commit turn.
        yield* world.endRun(author.runId, "completed");
        const repairing = yield* stateOf(author.deliveryId);
        assert.strictEqual(repairing.status, "running");
        assert.strictEqual(repairing.stage, "author");
        assert.strictEqual(repairing.fixCommitTurns, 1);
        const { awaiting } = repairing;
        if (awaiting?.type !== "run") return assert.fail("The fix-commit turn started no run.");
        assert.strictEqual(awaiting.threadId, author.threadId);
        assert.notStrictEqual(awaiting.runId, author.runId);

        assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.deepStrictEqual(
          world.provider.started.map((turn) => [turn.threadId, turn.runId]),
          [
            [author.threadId, author.runId],
            [author.threadId, awaiting.runId],
          ],
        );
        const fixCommit = world.provider.started[1]?.message.text ?? "";
        assert.include(fixCommit, `- ${noCommit}`);
        assert.include(fixCommit, repairing.branch);

        // That turn leaves no commit either: the delivery blocks without a second repair turn,
        // and nothing is left queued that could start one.
        yield* world.endRun(awaiting.runId, "completed");
        yield* drainOrchestration;
        yield* drainFactory;
        const state = yield* stateOf(author.deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "author");
        assert.deepStrictEqual(state.block, { reason: "unsettled", problems: [noCommit] });
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.deepStrictEqual(state.receipts, []);

        const projection = yield* threadProjection(author.threadId);
        assert.deepStrictEqual(
          projection.runs.map((run) => [run.id, run.status]),
          [
            [author.runId, "completed"],
            [awaiting.runId, "completed"],
          ],
        );
        assert.strictEqual(world.provider.started.length, 2);
        assert.isFalse(yield* world.exists(world.evidenceDir(author.deliveryId)));
      }),
    ),
  );

  it.live.each(["failed", "cancelled"] as const)(
    "blocks naming the author run when it ends %s, and never verifies",
    (status) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          // A commit is there, so only the run's end can keep verify from running.
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          assert.strictEqual(yield* world.endRun(author.runId, status), status);

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "author");
          assert.deepStrictEqual(state.block, {
            reason: "run_ended",
            threadId: author.threadId,
            runId: author.runId,
            runStatus: status,
          });
          assert.deepStrictEqual(state.receipts, []);
          const path = yield* Path.Path;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.log")));
          assert.strictEqual(world.provider.started.length, 1);
        }),
      ),
  );

  it.live.each([
    { command: "commits", refusal: "head_changed" },
    { command: "dirties", refusal: "tree_dirty" },
  ] as const)(
    "refuses the receipt when the verify command $command the tree",
    ({ command, refusal }) =>
      withProject(verifyCommands[command], (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          const authored = yield* git(author.worktreePath, ["rev-parse", "HEAD"]);
          yield* world.endRun(author.runId, "completed");

          const state = yield* stateOf(author.deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.stage, "verify");
          assert.deepStrictEqual(state.block, { reason: "receipt_refused", refusals: [refusal] });
          assert.deepStrictEqual(state.receipts, []);

          // The command did run: its log stays as evidence, but no receipt was written.
          const path = yield* Path.Path;
          const evidence = world.evidenceDir(author.deliveryId);
          assert.isTrue(yield* world.exists(path.join(evidence, "verify-1.log")));
          assert.isFalse(yield* world.exists(path.join(evidence, "verify-1.json")));
          const head = yield* git(author.worktreePath, ["rev-parse", "HEAD"]);
          assert.strictEqual(head === authored, refusal === "tree_dirty");
        }),
      ),
  );
});
