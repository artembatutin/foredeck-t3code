import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

// No other blocking condition: pass verdict, optional finding, verified criterion and no gaps.
const finding = {
  id: "export-newline",
  severity: "medium",
  required: false,
  file: "export.ts",
  line: 1,
  detail: "The export omits the final newline, so appending a second export joins two records.",
} as const;
const review = {
  verdict: "pass",
  findings: [finding],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The committed export module supplies the requested export.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

describe("Factory project blocking severities at review judgment", () => {
  it.live.each([
    {
      name: "records the medium-only review under the default high-only policy",
      before: ["high"],
      after: ["high"],
      blocking: false,
      rounds: 2,
    },
    {
      name: "lists the medium finding in fix-review when enabled after the reviewer starts",
      before: ["high"],
      after: ["high", "medium"],
      blocking: true,
      rounds: 2,
    },
    {
      name: "records when medium is removed after the reviewer starts",
      before: ["high", "medium"],
      after: ["high"],
      blocking: false,
      rounds: 2,
    },
    {
      name: "blocks on the medium finding when enabled and no repair rounds remain",
      before: ["high"],
      after: ["high", "medium"],
      blocking: true,
      rounds: 0,
    },
  ] as const)("$name", (scenario) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const settings = yield* FactorySettings.FactorySettings;
          const original = yield* settings.get(world.projectId);
          assert.deepStrictEqual(original.blockingSeverities, ["high"]);
          if (scenario.before.length > 1) {
            yield* settings.set(world.projectId, {
              ...original,
              blockingSeverities: scenario.before,
            });
          }
          const author = yield* world.start;
          yield* authorCommits(author.worktreePath, "feat: add the export module");
          yield* world.endRun(author.runId, "completed");

          const reviewing = yield* stateOf(author.deliveryId);
          assert.strictEqual(reviewing.stage, "review");
          const reviewer = reviewing.awaiting;
          if (reviewer?.type !== "run") return assert.fail("Expected the reviewer run.");
          assert.strictEqual(yield* runReached(reviewer.runId, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          assert.isTrue(world.provider.started.some(({ runId }) => runId === reviewer.runId));
          // A different client can save while the reviewer works. Judgment must read this value,
          // not a policy captured at delivery start or reviewer launch.
          if (scenario.blocking || scenario.before.length > 1) {
            yield* settings.set(world.projectId, {
              ...original,
              blockingSeverities: scenario.after,
            });
          }
          assert.deepStrictEqual(
            (yield* settings.get(world.projectId)).blockingSeverities,
            scenario.after,
          );

          const service = yield* FactoryService.FactoryService;
          const accepted = yield* service.submitReview({ threadId: reviewer.threadId, review });
          assert.strictEqual(accepted.review.summary.blocking, scenario.blocking);
          assert.deepStrictEqual(accepted.review.summary.findings, {
            high: 0,
            medium: 1,
            low: 0,
          });
          assert.strictEqual(accepted.review.details?.findings[0]?.blocking, scenario.blocking);
          // The accepted review still waits for its run to end; the harness drains both workers.
          assert.strictEqual((yield* stateOf(author.deliveryId)).stage, "review");
          yield* world.endRun(reviewer.runId, "completed");
          const result = yield* stateOf(author.deliveryId);

          if (scenario.blocking && scenario.rounds > 0) {
            assert.strictEqual(result.stage, "repair");
            assert.deepStrictEqual(result.rounds, { fix: 0, review: 1 });
            assert.strictEqual(result.awaiting?.type, "run");
            if (result.awaiting?.type !== "run") return;
            assert.strictEqual(result.awaiting.threadId, author.threadId);
            assert.strictEqual(
              yield* runReached(result.awaiting.runId, ["starting", ...ended]),
              "starting",
            );
            yield* drainOrchestration;
            const repairRun = result.awaiting.runId;
            const repair = world.provider.started.find(({ runId }) => runId === repairRun);
            assert.include(
              repair?.message.text ?? "",
              `Findings to fix:\n- \`${finding.id}\` (medium) at export.ts:1: ${finding.detail}`,
            );
            assert.strictEqual(world.pullRequestCalls.length, 0);
          } else if (scenario.blocking) {
            assert.strictEqual(result.status, "blocked");
            assert.isNotNull(result.block);
            assert.strictEqual(world.provider.started.length, 2);
            assert.strictEqual(world.pullRequestCalls.length, 0);
          } else {
            assert.strictEqual(result.status, "pr_open");
            assert.strictEqual(result.stage, "pr");
            assert.deepStrictEqual(result.rounds, { fix: 0, review: 0 });
            assert.strictEqual(world.provider.started.length, 2);
            const fs = yield* FileSystem.FileSystem;
            const approval = JSON.parse(
              yield* fs.readFileString(
                `${world.evidenceDir(author.deliveryId)}/approval-item.json`,
              ),
            );
            assert.strictEqual(approval.headSha, reviewing.receipts[0]?.headSha);
            assert.strictEqual(world.pullRequestCalls.length, 1);
          }
        }),
      { limits: { maxReviewRounds: scenario.rounds } },
    ),
  );
});
