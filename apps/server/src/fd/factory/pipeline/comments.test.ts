import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryStatus,
  type FactoryReviewSummary,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { carriesAiAttribution, namesAiTool } from "../git/publishedText.ts";
import { transitionComment } from "./comments.ts";
import { queuedDeliveryState } from "./state.ts";
import type { FactoryBlock, FactoryDeliveryState } from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const headSha = "a".repeat(40);
const tree = "c".repeat(40);

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha,
  tree,
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};

const summary: FactoryReviewSummary = {
  headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 2 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
};

const pullRequest = {
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  headBranch: "work/fd-aaaaaa-add-export",
};

/** A delivery that has verified its commit, with its author and reviewer threads. */
const delivery: FactoryDeliveryState = {
  ...queuedDeliveryState({ branch: "work/fd-aaaaaa-add-export", baseRef: "HEAD" }),
  stage: "review",
  worktreePath: "/worktrees/fd-aaaaaa",
  baseline: "b".repeat(40),
  threads: { author, reviewer },
  receipts: [receipt],
};

const verifyFailed: FactoryBlock = { reason: "verify_failed" };

/** The delivery in `status`, with what that status records. */
const inStatus = (
  status: FactoryDeliveryStatus,
  block: FactoryBlock = verifyFailed,
): FactoryDeliveryState => ({
  ...delivery,
  status,
  block: status === "blocked" ? block : null,
  pullRequest: status === "pr_open" ? pullRequest : null,
});

const COMMENTED: ReadonlySet<FactoryDeliveryStatus> = new Set([
  "blocked",
  "waiting",
  "approved",
  "pr_open",
]);

/** One block of every reason, with facts that are safe to publish. */
const everyBlock = {
  run_ended: {
    reason: "run_ended",
    threadId: author,
    runId: RunId.make("run-1"),
    runStatus: "failed",
  },
  thread_deleted: { reason: "thread_deleted", threadId: reviewer },
  effect_failed: {
    reason: "effect_failed",
    effect: { id: 3, type: "run_command", stage: "verify" },
    detail: "Factory could not run the verify command (FactoryVerifyRunError).",
  },
  unsettled: {
    reason: "unsettled",
    problems: [
      "Worktree has uncommitted or untracked changes.",
      "No commit was added since the baseline.",
    ],
  },
  verify_failed: verifyFailed,
  repeated_failure: { reason: "repeated_failure", stage: "review" },
  receipt_refused: { reason: "receipt_refused", refusals: ["head_changed", "tree_dirty"] },
  unsupported_stage: { reason: "unsupported_stage", stage: "integrate" },
  review_changes_required: { reason: "review_changes_required", summary },
  code_changed: { reason: "code_changed", changes: ["head_changed"] },
  invalid_submission: {
    reason: "invalid_submission",
    problems: ["acceptance[0].paths[0] does not exist in the worktree."],
  },
  record_mismatch: {
    reason: "record_mismatch",
    expected: { headSha, tree },
    actual: { headSha: "d".repeat(40), tree, clean: false },
    differences: ["head_changed", "not_reviewed", "tree_dirty"],
  },
} satisfies {
  readonly [Reason in FactoryBlock["reason"]]: Extract<FactoryBlock, { reason: Reason }>;
};

const blockedText = (reason: string) =>
  `Factory is blocked on this item and needs you. ${reason} Resume or cancel the delivery in Foredeck.`;

describe("transitionComment", () => {
  it("comments on entering blocked, waiting, approved or pr_open from any other status, and on nothing else", () => {
    for (const from of FactoryDeliveryStatus.literals) {
      for (const to of FactoryDeliveryStatus.literals) {
        const comment = transitionComment(inStatus(from), inStatus(to));
        if (from !== to && COMMENTED.has(to)) {
          expect(comment?.status, `${from} -> ${to}`).toBe(to);
        } else {
          expect(comment, `${from} -> ${to}`).toBeUndefined();
        }
      }
    }
  });

  it("does not comment when a blocked delivery blocks again for another reason", () => {
    const deleted = inStatus("blocked", everyBlock.thread_deleted);
    expect(transitionComment(inStatus("blocked"), deleted)).toBeUndefined();
  });

  it("renders each comment from its fixed template", () => {
    expect(transitionComment(inStatus("running"), inStatus("blocked"))).toEqual({
      status: "blocked",
      body: blockedText("Verify failed with no fix round left."),
    });
    expect(
      transitionComment(inStatus("running"), inStatus("blocked", everyBlock.thread_deleted)),
    ).toEqual({ status: "blocked", body: blockedText("The reviewer thread was deleted.") });
    expect(transitionComment(inStatus("running"), inStatus("waiting"))).toEqual({
      status: "waiting",
      body: "Factory is waiting for your decision on this item in Foredeck.",
    });
    expect(transitionComment(inStatus("running"), inStatus("approved"))).toEqual({
      status: "approved",
      body: `Factory approved commit ${headSha} for this item after verify and review, and is opening its pull request.`,
    });
    expect(transitionComment(inStatus("approved"), inStatus("pr_open"))).toEqual({
      status: "pr_open",
      body: "Factory opened pull request #7 for this item. https://github.com/acme/alpha/pull/7",
    });
  });

  it("names no AI agent, model or provider and carries no attribution in any rendered text", () => {
    const rendered = [
      ...Object.values(everyBlock).map(
        (block) => transitionComment(inStatus("running"), inStatus("blocked", block))?.body,
      ),
      ...(["waiting", "approved", "pr_open"] as const).map(
        (status) => transitionComment(inStatus("running"), inStatus(status))?.body,
      ),
      // What a delivery stored without a receipt or pull request would render.
      transitionComment(inStatus("running"), { ...inStatus("approved"), receipts: [] })?.body,
      transitionComment(inStatus("approved"), { ...inStatus("pr_open"), pullRequest: null })?.body,
    ];
    for (const body of rendered) {
      expect(body).toBeDefined();
      expect(namesAiTool(body ?? ""), body).toBe(false);
      expect(carriesAiAttribution(body ?? ""), body).toBe(false);
    }
  });

  it("drops facts that would name an AI tool, carry attribution or mention someone", () => {
    const fixedBlock =
      "Factory is blocked on this item and needs you. Resume or cancel the delivery in Foredeck.";
    const quoting = (problem: string) =>
      transitionComment(
        inStatus("running"),
        inStatus("blocked", { reason: "unsettled", problems: [problem] }),
      )?.body;
    for (const problem of [
      'Commit 0123456789ab subject is not a Conventional Commit: "Update readme with Claude".',
      'Commit 0123456789ab subject is not a Conventional Commit: "Add export Generated-by: bot".',
      'Worktree is on branch "copilot/fix"; expected "work/fd-aaaaaa".',
      'Commit 0123456789ab subject is not a Conventional Commit: "Thanks @octocat".',
    ]) {
      expect(quoting(problem), problem).toBe(fixedBlock);
    }
    // An address is not a mention.
    expect(quoting('Worktree is on branch "ada@home"; expected "main".')).toBe(
      blockedText('The branch does not settle: Worktree is on branch "ada@home"; expected "main".'),
    );

    const repository = { ...pullRequest, url: "https://github.com/acme/claude-tools/pull/7" };
    expect(
      transitionComment(inStatus("approved"), { ...inStatus("pr_open"), pullRequest: repository }),
    ).toEqual({ status: "pr_open", body: "Factory opened pull request #7 for this item." });
  });
});
