import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import type { FactoryDeliveryWithRuns } from "./FactoryService.ts";
import {
  type FactoryBlock,
  type FactoryDeliveryState,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import { toFactoryDelivery } from "./snapshot.ts";

const deliveryId = FactoryDeliveryId.make("delivery-1");
const projectId = ProjectId.make("project-alpha");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const headSha = "a".repeat(40);
const tree = "b".repeat(40);
const evidence = "/home/owner/.t3/userdata/fd-factory/delivery-1";

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha,
  tree,
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "secret-verify-tool", args: ["--token", "hunter2"] },
  settingsHash: "settings-hash-0123",
  platform: "darwin-arm64",
  logPath: `${evidence}/verify-1.log`,
  outputHash: "output-hash-4567",
};

const reviewSummary: FactoryReviewSummary = {
  headSha,
  verdict: "pass",
  blocking: false,
  findings: { high: 0, medium: 1, low: 2 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
};

const base = queuedDeliveryState({ branch: "work/fd-aaaaaa-add-export", baseRef: "HEAD" });

const running: FactoryDeliveryState = {
  ...base,
  status: "running",
  stage: "author",
  worktreePath: "/worktrees/fd-aaaaaa",
  baseline: "c".repeat(40),
  threads: { author },
  awaiting: { type: "run", threadId: author, runId: RunId.make("run-1") },
  effectsIssued: 1,
};

const stored = (state: FactoryDeliveryState): FactoryDeliveryWithRuns => ({
  deliveryId,
  projectId,
  itemRef,
  parentId: null,
  state,
  stageRuns: [],
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T10:06:00.000Z",
});

const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const roundTrip = (snapshot: FactoryDelivery) => decodeDelivery(encodeDelivery(snapshot));

describe("toFactoryDelivery", () => {
  it("projects a running delivery, which needs nothing from its owner", () => {
    const snapshot = toFactoryDelivery(stored(running));
    expect(snapshot).toStrictEqual({
      deliveryId,
      projectId,
      itemRef,
      childIds: [],
      status: "running",
      stage: { name: "author", kind: "agent" },
      rounds: { fix: 0, review: 0 },
      branch: "work/fd-aaaaaa-add-export",
      worktreePath: "/worktrees/fd-aaaaaa",
      threads: { author },
      receipts: [],
      reviews: [],
      stageRuns: [],
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T10:06:00.000Z",
    });
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);
  });

  it("leaves out the stage and worktree before the delivery starts", () => {
    const snapshot = toFactoryDelivery(stored(base));
    expect(snapshot).not.toHaveProperty("stage");
    expect(snapshot).not.toHaveProperty("worktreePath");
    expect(snapshot.status).toBe("queued");
  });

  it("projects a repair round as an agent stage", () => {
    const snapshot = toFactoryDelivery(
      stored({ ...running, stage: "repair", rounds: { fix: 1, review: 0 } }),
    );
    expect(snapshot.stage).toEqual({ name: "repair", kind: "agent" });
    expect(snapshot.rounds).toEqual({ fix: 1, review: 0 });
  });

  it("projects an open pull request's delivery with summaries and no evidence", () => {
    const state: FactoryDeliveryState = {
      ...running,
      status: "pr_open",
      stage: "pr",
      threads: { author, reviewer },
      awaiting: null,
      receipts: [{ ...receipt, code: 1 }, receipt],
      reviewRound: 1,
      reviews: [
        {
          round: 1,
          source: "mcp",
          summary: reviewSummary,
          evidencePath: `${evidence}/review-1.json`,
        },
      ],
      rounds: { fix: 1, review: 0 },
      pullRequest: { number: 42, url: "https://example.test/pr/42", headBranch: base.branch },
    };
    const snapshot = toFactoryDelivery(stored(state));
    const summary = {
      headSha,
      tree,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      code: 0,
      timedOut: false,
      durationMs: 60_000,
    };
    expect(snapshot).toMatchObject({
      status: "pr_open",
      stage: { name: "pr", kind: "pr" },
      rounds: { fix: 1, review: 0 },
      threads: { author, reviewer },
      receipts: [{ ...summary, code: 1 }, summary],
      reviews: [reviewSummary],
    });
    expect(snapshot).not.toHaveProperty("needsYou");
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);

    const wire = JSON.stringify(encodeDelivery(snapshot));
    for (const secret of [
      "fd-factory",
      "verify-1.log",
      "review-1.json",
      "secret-verify-tool",
      "hunter2",
      "settings-hash-0123",
      "output-hash-4567",
      "logPath",
      "evidencePath",
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it.each([
    "queued",
    "running",
    "stopping",
    "stopped",
    "approved",
    "pr_open",
    "done",
    "cancelled",
  ] as const)("sets no needsYou while %s", (status) => {
    expect(toFactoryDelivery(stored({ ...running, status }))).not.toHaveProperty("needsYou");
  });

  const blockCases: ReadonlyArray<{ readonly block: FactoryBlock; readonly needsYou: string }> = [
    {
      block: { reason: "run_ended", threadId: author, runId: RunId.make("r"), runStatus: "failed" },
      needsYou: "The author thread's run failed.",
    },
    {
      block: {
        reason: "run_ended",
        threadId: reviewer,
        runId: RunId.make("r"),
        runStatus: "interrupted",
      },
      needsYou: "The reviewer thread's run was interrupted.",
    },
    {
      block: { reason: "thread_deleted", threadId: ThreadId.make("thread-gone") },
      needsYou: "A delivery thread was deleted.",
    },
    {
      block: {
        reason: "effect_failed",
        effect: { id: 3, type: "run_command", stage: "verify" },
        detail: "Factory could not run the verify command (FactoryVerifyTimeout).",
      },
      needsYou: "Factory could not run the verify command (FactoryVerifyTimeout).",
    },
    {
      block: {
        reason: "unsettled",
        problems: [
          "Worktree has uncommitted or untracked changes.",
          "No commit was added since the baseline.",
        ],
      },
      needsYou:
        "The branch does not settle: Worktree has uncommitted or untracked changes, and 1 more.",
    },
    { block: { reason: "verify_failed" }, needsYou: "Verify failed with no fix round left." },
    {
      block: { reason: "repeated_failure", stage: "verify" },
      needsYou: "Verify failed the same way after a repair, so Factory stopped repairing.",
    },
    {
      block: { reason: "repeated_failure", stage: "review" },
      needsYou:
        "The review blocked on the same findings after a repair, so Factory stopped repairing.",
    },
    {
      block: { reason: "receipt_refused", refusals: ["head_changed", "tree_dirty"] },
      needsYou:
        "Factory refused the verify result: HEAD moved and the worktree has uncommitted changes.",
    },
    {
      block: { reason: "unsupported_stage", stage: "integrate" },
      needsYou: "This server cannot run the integrate stage.",
    },
    {
      block: {
        reason: "review_changes_required",
        summary: {
          ...reviewSummary,
          verdict: "changes-required",
          blocking: true,
          findings: { high: 1, medium: 2, low: 0 },
        },
      },
      needsYou: "The review requires changes with no review round left (1 high, 2 medium, 0 low).",
    },
    {
      block: { reason: "code_changed", changes: ["tree_dirty"] },
      needsYou: "The code changed during review: the worktree has uncommitted changes.",
    },
    {
      block: { reason: "invalid_submission", problems: ["Criterion 2 has no acceptance check."] },
      needsYou: "The reviewer's submission was invalid again: Criterion 2 has no acceptance check.",
    },
    {
      block: {
        reason: "record_mismatch",
        expected: { headSha, tree },
        actual: { headSha: "d".repeat(40), tree, clean: false },
        differences: ["head_changed", "not_reviewed", "tree_dirty"],
      },
      needsYou:
        "The worktree no longer holds the verified, reviewed commit: HEAD is not the verified commit, HEAD is not the reviewed commit and the worktree has uncommitted changes.",
    },
  ];

  it.each(blockCases)("tells the owner why it blocked: $block.reason", ({ block, needsYou }) => {
    const snapshot = toFactoryDelivery(
      stored({ ...running, threads: { author, reviewer }, status: "blocked", block }),
    );
    expect(snapshot.needsYou).toBe(needsYou);
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);
  });

  it("bounds a block reason however long its detail", () => {
    const snapshot = toFactoryDelivery(
      stored({
        ...running,
        status: "blocked",
        block: {
          reason: "effect_failed",
          effect: { id: 2, type: "open_pr" },
          detail: `Factory could not open the pull request (${"x".repeat(1000)}).`,
        },
      }),
    );
    expect(snapshot.needsYou).toHaveLength(280);
    expect(snapshot.needsYou?.endsWith("…")).toBe(true);
  });

  it("says a blocked delivery without a recorded block still needs its owner", () => {
    const snapshot = toFactoryDelivery(stored({ ...running, status: "blocked", block: null }));
    expect(snapshot.needsYou).toBe("Factory blocked this delivery.");
  });

  it("reads a status and stage from a newer server as unknown", () => {
    const encoded = encodeDelivery(toFactoryDelivery(stored(running)));
    const decoded = decodeDelivery({
      ...encoded,
      status: "merging",
      stage: { name: "deploy", kind: "release" },
      mergeQueue: { position: 3 },
    });
    expect(decoded.status).toBe("unknown");
    expect(decoded.stage).toEqual({ name: "unknown", kind: "unknown" });
    expect(decoded).not.toHaveProperty("mergeQueue");
    expect(decoded.threads).toEqual({ author });
  });
});
