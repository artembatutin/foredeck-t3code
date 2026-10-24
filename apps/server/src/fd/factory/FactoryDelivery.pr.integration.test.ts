import { assert, describe, it } from "@effect/vitest";
import type { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  fakePullRequest,
  git,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

/** What the reviewer first finds wrong with the author's commit. */
const blockingReview = {
  verdict: "changes-required",
  findings: [
    {
      id: "no-header-row",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "The export writes no header row, so spreadsheets read the first record as names.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "failed",
      evidence: "The exported file starts with a data row.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

/** The second round's review of the repaired commit. */
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export now writes its header row first.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

const authorReply = "Fixed no-header-row: the export writes the header row before any record.";

/** The run the delivery awaits, on the thread it names. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    return { threadId: awaiting.threadId, runId: awaiting.runId };
  });

/** Waits until the run's provider turn has started, so the test can answer and end it. */
const turnStarted = (runId: RunId) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* runReached(runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
  });

const submitReview = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
    service.submitReview({ threadId, review }),
  ).pipe(Effect.orDie);

describe("Factory single-item delivery to its pull request", () => {
  it.live("authors, verifies, reviews, repairs, reviews again, records and opens the PR", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const author = yield* world.start;
        const { deliveryId, worktreePath } = author;
        const evidence = world.evidenceDir(deliveryId);
        const turnOf = (runId: RunId) =>
          world.provider.started.find((turn) => turn.runId === runId) ??
          assert.fail(`No provider turn started run ${runId}.`);

        // Author: the first commit settles and passes verify, so a fresh reviewer starts.
        yield* authorCommits(worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const firstReview = yield* stateOf(deliveryId);
        assert.strictEqual(firstReview.status, "running");
        assert.strictEqual(firstReview.stage, "review");
        assert.strictEqual(firstReview.reviewRound, 1);
        assert.strictEqual(firstReview.receipts.at(-1)?.code, 0);
        const reviewer = yield* awaitedRun(deliveryId);
        assert.notStrictEqual(reviewer.threadId, author.threadId);
        assert.strictEqual(firstReview.threads.reviewer, reviewer.threadId);
        yield* turnStarted(reviewer.runId);
        assert.strictEqual(turnOf(reviewer.runId).runtimePolicy.interactionMode, "plan");

        // Review round 1 blocks: the author thread gets a fix-review turn with the finding.
        const blocking = yield* submitReview(reviewer.threadId, blockingReview);
        assert.isTrue(blocking.review.summary.blocking);
        yield* world.endRun(reviewer.runId, "completed");
        const repairing = yield* stateOf(deliveryId);
        assert.strictEqual(repairing.status, "running");
        assert.strictEqual(repairing.stage, "repair");
        assert.deepStrictEqual(repairing.rounds, { fix: 0, review: 1 });
        const repair = yield* awaitedRun(deliveryId);
        assert.strictEqual(repair.threadId, author.threadId);
        yield* turnStarted(repair.runId);
        assert.include(turnOf(repair.runId).message.text, "`no-header-row` (high, required)");

        // The author fixes it and replies; the repaired commit settles and passes verify, and
        // the next round is a follow-up turn on the same reviewer thread.
        yield* world.provider.say(turnOf(repair.runId), authorReply);
        yield* authorCommits(
          worktreePath,
          "fix: write the header row first",
          "export const header = 'id,name';\n",
        );
        yield* world.endRun(repair.runId, "completed");
        const secondReview = yield* stateOf(deliveryId);
        assert.strictEqual(secondReview.status, "running");
        assert.strictEqual(secondReview.stage, "review");
        assert.strictEqual(secondReview.reviewRound, 2);
        assert.strictEqual(secondReview.receipts.length, 2);
        const followUp = yield* awaitedRun(deliveryId);
        assert.strictEqual(followUp.threadId, reviewer.threadId);
        assert.strictEqual(secondReview.threads.reviewer, reviewer.threadId);
        yield* turnStarted(followUp.runId);
        const followUpText = turnOf(followUp.runId).message.text;
        assert.include(followUpText, "Factory review round 2.");
        assert.include(followUpText, "These are claims to check against the code, not evidence:");
        assert.include(followUpText, authorReply);
        assert.deepStrictEqual(
          world.provider.started.map((turn) => turn.threadId),
          [author.threadId, reviewer.threadId, author.threadId, reviewer.threadId],
        );

        // Review round 2 passes: record approves the repaired commit and the PR opens.
        const passing = yield* submitReview(reviewer.threadId, passingReview);
        assert.isFalse(passing.review.summary.blocking);
        yield* world.endRun(followUp.runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.stage, "pr");
        assert.isNull(state.awaiting);
        assert.isNull(state.block);
        assert.deepStrictEqual(state.pullRequest, { ...fakePullRequest, headBranch: state.branch });
        const verified = state.receipts.at(-1);
        assert.strictEqual(verified?.headSha, yield* git(worktreePath, ["rev-parse", "HEAD"]));

        // One stacked action, from the delivery worktree, linked to the author thread.
        assert.strictEqual(world.pullRequestCalls.length, 1);
        const [call] = world.pullRequestCalls;
        assert.strictEqual(call?.input.action, "create_pr");
        assert.strictEqual(call?.input.cwd, worktreePath);
        assert.strictEqual(call?.input.threadId, author.threadId);
        assert.strictEqual(call?.input.prTitle, `${world.itemKey}: ${world.itemTitle}`);
        const body = call?.input.prBody ?? "";
        assert.include(body, `Work item ${world.itemKey}: ${world.itemTitle}`);
        assert.include(body, `   - Verified commit: \`${verified?.headSha}\``);
        assert.include(body, "   - Review: pass in round 2, with 0 high, 0 medium and 0 low");
        assert.strictEqual(call?.branch, state.branch);

        // Opened from the commit the approval covers: verified in round 2 and reviewed.
        const approval = JSON.parse(
          yield* fileSystem.readFileString(path.join(evidence, "approval-item.json")),
        );
        assert.strictEqual(approval.headSha, call?.head);
        assert.strictEqual(approval.headSha, verified?.headSha);
        assert.strictEqual(approval.tree, verified?.tree);
        assert.strictEqual(approval.receiptPath, path.join(evidence, "verify-2.json"));
        assert.strictEqual(approval.reviewPath, path.join(evidence, "review-2.json"));
        // And the branch the pull request merges from holds that commit.
        const published = yield* git(worktreePath, [
          "ls-remote",
          "origin",
          `refs/heads/${state.branch}`,
        ]);
        assert.strictEqual(published.split("\t")[0], approval.headSha);

        // The author thread shows the pull request as one it created.
        const shell = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.getThreadShell(author.threadId),
        );
        assert.deepStrictEqual(
          (shell?.pullRequests ?? []).map(({ number, url, source }) => ({ number, url, source })),
          [{ ...fakePullRequest, source: "created" }],
        );

        const attempts = yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
          runs.listByDelivery(deliveryId),
        );
        assert.deepStrictEqual(
          attempts.map(({ stage, outcome }) => [stage, outcome]),
          [
            ["author", "passed"],
            ["verify", "passed"],
            ["review", "failed"],
            ["repair", "passed"],
            ["verify", "passed"],
            ["review", "passed"],
            ["record", "passed"],
            ["pr", "passed"],
          ],
        );
        assert.strictEqual(
          yield* git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
      }),
    ),
  );
});
