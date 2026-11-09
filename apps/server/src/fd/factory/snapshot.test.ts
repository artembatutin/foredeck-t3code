import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewedExecution,
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

/** Only its limits matter here: the snapshot reads no other part of a review. */
const reviewedExecutionFixture = {} as FactoryReviewedExecution;

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
  stageAttempts: {},
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
      allowance: {
        counted: "since_resume",
        verificationFixes: { used: 0, limit: 2, remaining: 2 },
        reviewFollowUps: { used: 0, limit: 2, remaining: 2 },
        fixCommitTurns: { used: 0, limit: 1, remaining: 1 },
        attempts: { verify: 0, review: 0 },
      },
      proceeding: true,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T10:06:00.000Z",
    });
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);
  });

  describe("its allowance", () => {
    const oneRepairTwoReviews = { author: 1, verify: 2, review: 2, repair: 1 };
    const spent = { ...running, rounds: { fix: 0, review: 1 } };

    it("counts one repair and two review attempts apart, for a delivery with no review", () => {
      const { allowance } = toFactoryDelivery({
        ...stored(spent),
        stageAttempts: oneRepairTwoReviews,
      });
      expect(allowance).toEqual({
        counted: "since_resume",
        verificationFixes: { used: 0, limit: 2, remaining: 2 },
        reviewFollowUps: { used: 1, limit: 2, remaining: 1 },
        fixCommitTurns: { used: 0, limit: 1, remaining: 1 },
        attempts: { verify: 2, review: 2 },
      });
    });

    it("counts what a review approved for the whole delivery, whatever its limits say", () => {
      const reviewed = {
        ...spent,
        fixCommitTurns: 1,
        limits: { maxFixRounds: 9, maxReviewRounds: 9 },
        reviewedExecution: {
          ...reviewedExecutionFixture,
          limits: {
            maxFixRounds: 3,
            maxReviewRounds: 1,
            maxFixCommitTurns: 2,
            verifyTimeoutMinutes: 30,
          },
        },
      };
      const { allowance } = toFactoryDelivery({
        ...stored(reviewed),
        stageAttempts: oneRepairTwoReviews,
      });
      expect(allowance).toEqual({
        counted: "whole_delivery",
        verificationFixes: { used: 0, limit: 3, remaining: 3 },
        reviewFollowUps: { used: 1, limit: 1, remaining: 0 },
        fixCommitTurns: { used: 1, limit: 2, remaining: 1 },
        attempts: { verify: 2, review: 2 },
      });
    });

    it("never reads a limit lowered below what was spent as a negative", () => {
      const { allowance } = toFactoryDelivery(
        stored({
          ...running,
          rounds: { fix: 3, review: 0 },
          limits: { maxFixRounds: 1, maxReviewRounds: 1 },
        }),
      );
      expect(allowance?.verificationFixes).toEqual({ used: 3, limit: 1, remaining: 0 });
    });

    it("reads the totals of the whole history, not of the attempts the timeline's window holds", () => {
      const snapshot = toFactoryDelivery({
        ...stored(running),
        stageRuns: [],
        stageAttempts: { verify: 25, review: 1, repair: 25 },
      });
      expect(snapshot.stageRuns).toEqual([]);
      expect(snapshot.allowance?.attempts).toEqual({ verify: 25, review: 1 });
    });

    it("counts a parent's integrate attempts as its reviews, submitted or not", () => {
      const { allowance } = toFactoryDelivery({
        // No review accepted: the reviewer's run failed, or is still going.
        ...stored({ ...running, kind: "parent", receipts: [receipt], reviews: [] }),
        stageAttempts: { plan: 1, verify: 1, integrate: 1 },
      });
      expect(allowance).toMatchObject({
        verificationFixes: null,
        reviewFollowUps: null,
        attempts: { verify: 1, review: 1 },
      });
    });
  });

  describe("whether anything of it is under way", () => {
    const opening = {
      type: "effect",
      effect: { id: 6, type: "open_pr" },
    } as FactoryDeliveryState["awaiting"];
    const closing = {
      type: "effect",
      effect: { id: 9, type: "close_out" },
    } as FactoryDeliveryState["awaiting"];

    it.each<[string, Partial<FactoryDeliveryState>, boolean]>([
      ["running, awaiting a run", {}, true],
      ["stopping, awaiting a run", { status: "stopping" }, true],
      ["approved, opening its pull request", { status: "approved", awaiting: opening }, true],
      // As `FactoryDeliveryStore.pr.test.ts` stores one: nothing will open its pull request.
      [
        "approved before the PR stage existed",
        { status: "approved", stage: "record", awaiting: null },
        false,
      ],
      ["an approved child", { status: "approved", kind: "child", awaiting: null }, false],
      ["resting on its open pull request", { status: "pr_open", awaiting: null }, false],
      ["closing out its merge", { status: "pr_open", awaiting: closing }, true],
      ["blocked", { status: "blocked", awaiting: null }, false],
      ["stopped", { status: "stopped", awaiting: null }, false],
      ["waiting at the plan gate", { status: "waiting", awaiting: null }, false],
      ["queued", { status: "queued", awaiting: null }, false],
      ["done", { status: "done", awaiting: null }, false],
    ])("reads a delivery %s", (_name, state, proceeding) => {
      expect(toFactoryDelivery(stored({ ...running, ...state })).proceeding).toBe(proceeding);
    });
  });

  describe("its pull request", () => {
    const pullRequest = {
      number: 7,
      url: "https://github.com/acme/alpha/pull/7",
      headBranch: "feature/fd-aaaaaa",
    };

    it("is absent until one opens", () => {
      expect(toFactoryDelivery(stored(running))).not.toHaveProperty("pullRequest");
    });

    it("names the author's thread for a single item, and rests with nothing awaited", () => {
      const snapshot = toFactoryDelivery(
        stored({ ...running, status: "pr_open", awaiting: null, pullRequest }),
      );
      expect(snapshot.pullRequest).toEqual({
        number: 7,
        url: pullRequest.url,
        threadId: author,
      });
      expect(snapshot.proceeding).toBe(false);
      expect(roundTrip(snapshot)).toStrictEqual(snapshot);
    });

    it("names the thread a parent's pull request is linked to", () => {
      const linked = ThreadId.make("thread-last-child-author");
      expect(
        toFactoryDelivery(
          stored({
            ...base,
            kind: "parent",
            status: "pr_open",
            pullRequest,
            pullRequestThread: linked,
          }),
        ).pullRequest?.threadId,
      ).toBe(linked);
    });

    it("says a merge is closing out rather than resting on its owner", () => {
      const snapshot = toFactoryDelivery(
        stored({
          ...running,
          status: "pr_open",
          pullRequest: { ...pullRequest, outcome: "merged" },
          awaiting: {
            type: "effect",
            effect: { id: 9, type: "close_out" },
          },
        }),
      );
      expect(snapshot.pullRequest?.outcome).toBe("merged");
      expect(snapshot.proceeding).toBe(true);
    });

    it("is still followed up while a round runs on it", () => {
      const snapshot = toFactoryDelivery(
        stored({ ...running, stage: "follow_through", pullRequest }),
      );
      expect(snapshot.status).toBe("running");
      expect(snapshot.pullRequest?.url).toBe(pullRequest.url);
      expect(snapshot.proceeding).toBe(true);
    });
  });

  describe("what a listing reads beside it", () => {
    it("is carried when present, and absent otherwise", () => {
      const source = {
        key: "fd-aaaaaa",
        title: "Add export",
        status: "todo" as const,
        statusName: null,
        assignee: null,
      };
      const snapshot = toFactoryDelivery({ ...stored(running), source, queuePriority: null });
      expect(snapshot.source).toEqual(source);
      expect(snapshot.queuePriority).toBeNull();
      expect(roundTrip(snapshot)).toStrictEqual(snapshot);
      const plain = toFactoryDelivery(stored(running));
      expect(plain).not.toHaveProperty("source");
      expect(plain).not.toHaveProperty("queuePriority");
    });
  });

  describe("capacityWait", () => {
    const awaitingEffect: FactoryDeliveryState = {
      ...running,
      stage: "verify",
      awaiting: { type: "effect", effect: { id: 4, type: "close_out" } },
    };

    it("is set while the effect the delivery awaits is marked", () => {
      const snapshot = toFactoryDelivery(
        stored({ ...awaitingEffect, admissionWait: { effectId: 4 } }),
      );
      expect(snapshot.capacityWait).toBe(true);
      expect(snapshot).not.toHaveProperty("needsYou");
      expect(roundTrip(snapshot)).toStrictEqual(snapshot);
    });

    it.each<[string, FactoryDeliveryState]>([
      ["awaiting an effect that is not marked", awaitingEffect],
      [
        "marked for another effect than it awaits",
        { ...awaitingEffect, admissionWait: { effectId: 3 } },
      ],
      ["awaiting a run, with a mark left over", { ...running, admissionWait: { effectId: 4 } }],
      ["awaiting nothing, with a mark left over", { ...base, admissionWait: { effectId: 4 } }],
    ])("is absent %s", (_label, state) => {
      expect(toFactoryDelivery(stored(state))).not.toHaveProperty("capacityWait");
    });
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
