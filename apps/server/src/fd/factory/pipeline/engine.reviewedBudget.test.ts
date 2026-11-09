import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryReviewedExecution } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type { FactoryDeliveryState, FactoryEffect, FactoryResumeCheck } from "./state.ts";

const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const head = "a".repeat(40);
const tree = "c".repeat(40);

const reviewed = (
  limits: Partial<FactoryReviewedExecution["limits"]> = {},
): FactoryReviewedExecution =>
  ({
    receiptId: "receipt-1",
    reviewVersion: 1,
    limits: {
      maxFixRounds: 1,
      maxReviewRounds: 1,
      maxFixCommitTurns: 1,
      verifyTimeoutMinutes: 30,
      ...limits,
    },
  }) as FactoryReviewedExecution;

/** A running delivery whose author has launched. */
const running = (execution?: FactoryReviewedExecution): FactoryDeliveryState => ({
  ...queuedDeliveryState({
    branch: "fd/item-7",
    baseRef: "HEAD",
    limits: { maxFixRounds: 1, maxReviewRounds: 1 },
    ...(execution === undefined ? {} : { reviewedExecution: execution }),
  }),
  status: "running",
  stage: "author",
  worktreePath: "/worktrees/item-7",
  baseline: "b".repeat(40),
  threads: { author },
  awaiting: { type: "run", threadId: author, runId: authorRun },
  effectsIssued: 1,
});

const checked = (
  settle: NonNullable<FactoryResumeCheck["worktree"]>["settle"],
): FactoryResumeCheck => ({
  deletedThreads: [],
  unrecordedAuthorRunEnded: false,
  worktree: { settle, commit: { headSha: head, tree }, approvedSha: null },
});

const failedVerify = (effectId: number) =>
  ({
    type: "command.finished",
    effectId,
    outcome: {
      type: "receipt",
      receipt: {
        version: 1,
        headSha: head,
        tree,
        startedAt: "2026-10-24T10:00:00.000Z",
        finishedAt: "2026-10-24T10:01:00.000Z",
        code: 1,
        timedOut: false,
        durationMs: 60_000,
        command: { executable: "vp", args: ["test", "run"] },
        settingsHash: "settings-1",
        platform: "darwin-arm64",
        logPath: "/t3/verify-1.log",
        outputHash: "output-1",
      },
      fingerprint: `fingerprint-${effectId}`,
    },
  }) as const;

const problems = ["Worktree has uncommitted or untracked changes."];

/** One failed verify's repair round, on the way to `stopped` where it would verify again. */
const spentFixRound = (state: FactoryDeliveryState) => {
  const verifying = {
    ...state,
    stage: "verify" as const,
    effectsIssued: 2,
    awaiting: {
      type: "effect" as const,
      effect: { id: 2, type: "run_command" as const, stage: "verify" as const },
    },
  };
  return advance(verifying, failedVerify(2)).delivery;
};

describe("a reviewed delivery's cumulative allowances", () => {
  it("keeps rounds and fix-commit turns across a resume, and forgets only fingerprints", () => {
    const repaired = spentFixRound(running(reviewed()));
    expect(repaired.rounds).toEqual({ fix: 1, review: 0 });
    expect(repaired.fingerprints).toEqual(["fingerprint-2"]);
    const stopped: FactoryDeliveryState = {
      ...repaired,
      status: "stopped",
      awaiting: null,
      checkpoint: "verify",
      fixCommitTurns: 1,
    };

    const { delivery } = advance(stopped, {
      type: "resume",
      check: checked({ status: "settled" }),
    });

    expect(delivery.status).toBe("running");
    expect(delivery.rounds).toEqual({ fix: 1, review: 0 });
    expect(delivery.fixCommitTurns).toBe(1);
    expect(delivery.fingerprints).toEqual([]);
  });

  it("blocks with what it used of what was approved once a kind of round is spent", () => {
    const spent = { ...running(reviewed()), rounds: { fix: 1, review: 0 } };
    const verifying = {
      ...spent,
      stage: "verify" as const,
      effectsIssued: 3,
      awaiting: {
        type: "effect" as const,
        effect: { id: 3, type: "run_command" as const, stage: "verify" as const },
      },
    };

    const { delivery, effects } = advance(verifying, failedVerify(3));

    expect(effects).toEqual([]);
    expect(delivery.status).toBe("blocked");
    expect(delivery.block).toEqual({
      reason: "allowance_exhausted",
      allowance: "fix",
      used: 1,
      approved: 1,
      problems: [],
    });
  });

  it("blocks a blocking review with no review round left the same way", () => {
    const summary = {
      headSha: head,
      verdict: "changes-required",
      blocking: true,
      findings: { high: 1, medium: 0, low: 0 },
      reviewedAt: "2026-10-24T10:05:00.000Z",
    } as const;
    const reviewing: FactoryDeliveryState = {
      ...running(reviewed()),
      stage: "review",
      rounds: { fix: 0, review: 1 },
      reviewRound: 2,
      threads: { author, reviewer: ThreadId.make("thread-reviewer") },
      effectsIssued: 3,
      awaiting: {
        type: "effect",
        effect: {
          id: 3,
          type: "read_fallback_review",
          threadId: ThreadId.make("thread-reviewer"),
          runId: RunId.make("run-review"),
        },
      },
    };

    const { delivery, effects } = advance(reviewing, {
      type: "review.read",
      effectId: 3,
      judgment: {
        type: "accepted",
        review: {
          source: "fallback",
          summary,
          evidencePath: "/t3/review-2.json",
          fingerprint: "r",
        },
      },
    });

    expect(effects).toEqual([]);
    expect(delivery.block).toEqual({
      reason: "allowance_exhausted",
      allowance: "review",
      used: 1,
      approved: 1,
      problems: [],
    });
  });

  it("gives a resume no fix-commit turn once its allowance is spent, however often it asks", () => {
    let state: FactoryDeliveryState = {
      ...running(reviewed()),
      status: "blocked",
      awaiting: null,
      fixCommitTurns: 1,
      block: { reason: "unsettled", problems },
    };
    for (let resume = 0; resume < 3; resume += 1) {
      const next = advance(state, {
        type: "resume",
        check: checked({ status: "repairable", problems }),
      });
      expect(next.effects).toEqual([]);
      expect(next.delivery.status).toBe("blocked");
      expect(next.delivery.block).toEqual({
        reason: "allowance_exhausted",
        allowance: "fix_commit",
        used: 1,
        approved: 1,
        problems,
      });
      expect(next.delivery.fixCommitTurns).toBe(1);
      state = next.delivery;
    }
  });

  it("counts a settle check's turn against the reviewed allowance, then blocks saying so", () => {
    const checking = (fixCommitTurns: number): FactoryDeliveryState => ({
      ...running(reviewed({ maxFixCommitTurns: 2 })),
      fixCommitTurns,
      effectsIssued: 2,
      awaiting: {
        type: "effect",
        effect: { id: 2, type: "check_settle", threadId: author, runId: authorRun },
      },
    });
    const settle = {
      type: "settle.checked",
      effectId: 2,
      result: { status: "repairable", problems },
    } as const;

    const second = advance(checking(1), settle);
    expect(second.effects.map(({ type }) => type)).toEqual(["send_fix_commit_turn"]);
    expect(second.delivery.fixCommitTurns).toBe(2);

    const spent = advance(checking(2), settle);
    expect(spent.effects).toEqual([]);
    expect(spent.delivery.block).toEqual({
      reason: "allowance_exhausted",
      allowance: "fix_commit",
      used: 2,
      approved: 2,
      problems,
    });
  });
});

describe("a turn a review charged, when it fails", () => {
  const failing = (effect: FactoryEffect): FactoryDeliveryState => ({
    ...running(reviewed()),
    stage: "repair",
    rounds: { fix: 1, review: 1 },
    fixCommitTurns: 1,
    effectsIssued: effect.id,
    awaiting: { type: "effect", effect },
  });
  const failed = (effect: FactoryEffect, unsent?: true) =>
    ({
      type: "effect.failed",
      effectId: effect.id,
      detail: "Refused.",
      ...(unsent === undefined ? {} : { unsent }),
    }) as const;
  const fixCommit: FactoryEffect = {
    id: 5,
    type: "send_fix_commit_turn",
    threadId: author,
    problems,
  };
  const repairTurn = (kind: "fix-verify" | "fix-review"): FactoryEffect => ({
    id: 5,
    type: "send_repair_turn",
    kind,
    threadId: author,
    round: 1,
  });

  it.each([
    { name: "fix-commit", effect: fixCommit, fixCommitTurns: 0, rounds: { fix: 1, review: 1 } },
    {
      name: "fix-verify",
      effect: repairTurn("fix-verify"),
      fixCommitTurns: 1,
      rounds: { fix: 0, review: 1 },
    },
    {
      name: "fix-review",
      effect: repairTurn("fix-review"),
      fixCommitTurns: 1,
      rounds: { fix: 1, review: 0 },
    },
  ])("gives back the $name count of a turn that never started", ({ effect, ...counts }) => {
    const { delivery } = advance(failing(effect), failed(effect, true));
    expect(delivery.status).toBe("blocked");
    expect(delivery.fixCommitTurns).toBe(counts.fixCommitTurns);
    expect(delivery.rounds).toEqual(counts.rounds);
  });

  it("keeps the count when the turn may have started", () => {
    const effect = repairTurn("fix-verify");
    const { delivery } = advance(failing(effect), failed(effect));
    expect(delivery.status).toBe("blocked");
    expect(delivery.rounds).toEqual({ fix: 1, review: 1 });
  });

  it("charges nothing back to a delivery without a review, or for any other effect", () => {
    const effect = repairTurn("fix-verify");
    const legacy: FactoryDeliveryState = {
      ...failing(effect),
      reviewedExecution: undefined,
    } as never;
    const { reviewedExecution: _, ...unreviewed } = legacy;
    expect(advance(unreviewed, failed(effect, true)).delivery.rounds).toEqual({
      fix: 1,
      review: 1,
    });

    const launch: FactoryEffect = {
      id: 5,
      type: "run_command",
      stage: "verify",
    };
    expect(advance(failing(launch), failed(launch, true)).delivery.fixCommitTurns).toBe(1);
  });

  it("lets a resume spend the count it gave back, and no more", () => {
    const effect = fixCommit;
    const refused = advance(
      { ...failing(effect), rounds: { fix: 0, review: 0 } },
      failed(effect, true),
    ).delivery;
    const again = advance(refused, {
      type: "resume",
      check: checked({ status: "repairable", problems }),
    });
    expect(again.effects.map(({ type }) => type)).toEqual(["send_fix_commit_turn"]);
    expect(again.delivery.fixCommitTurns).toBe(1);
  });
});

describe("a fresh review's rebinding of a delivery", () => {
  const rebound = (receiptId: string, owesResume = true) =>
    ({
      type: "reviewed.rebound",
      execution: { ...reviewed({ maxFixRounds: 5 }), receiptId, reviewVersion: 2 },
      owesResume,
    }) as const;
  const blockedAt: FactoryDeliveryState = {
    ...running(reviewed()),
    status: "blocked",
    awaiting: null,
    block: { reason: "unsettled", problems: [] },
    checkpoint: "verify",
    rounds: { fix: 1, review: 1 },
    fixCommitTurns: 1,
  };
  const settled = { type: "resume", check: checked({ status: "settled" }) } as const;

  it("runs on the new review, owing one resume, with every used count kept", () => {
    const { delivery } = advance(blockedAt, rebound("receipt-2"));
    expect(delivery.reviewedExecution?.receiptId).toBe("receipt-2");
    expect(delivery.limits.maxFixRounds).toBe(5);
    expect(delivery.supersededReceipts).toEqual(["receipt-1"]);
    expect(delivery.reviewResumeOwed).toBe("receipt-2");
    expect(delivery.rounds).toEqual({ fix: 1, review: 1 });
    expect(delivery.fixCommitTurns).toBe(1);
  });

  it("takes that resume once, whatever the resume then finds", () => {
    const owing = advance(blockedAt, rebound("receipt-2")).delivery;
    const { delivery } = advance(owing, settled);
    expect(delivery.reviewResumeOwed).toBeUndefined();
    expect(delivery.reviewedExecution?.receiptId).toBe("receipt-2");
    // Rebinding again under that receipt owes nothing more.
    expect(advance(delivery, rebound("receipt-2")).delivery).toBe(delivery);
  });

  it("owes nothing of a family member the resume is not for", () => {
    const { delivery } = advance(blockedAt, rebound("receipt-2", false));
    expect(delivery.reviewResumeOwed).toBeUndefined();
    expect(delivery.reviewedExecution?.receiptId).toBe("receipt-2");
  });

  it("takes no receipt an earlier review stood under", () => {
    const later = advance(advance(blockedAt, rebound("receipt-2")).delivery, settled).delivery;
    expect(advance(later, rebound("receipt-1")).delivery).toBe(later);
  });
});

describe("a fresh review's amendment of a delivery's allowances", () => {
  const amended = {
    type: "reviewed.amended",
    receiptId: "receipt-2",
    reviewVersion: 2,
    allowances: { maxFixRounds: 3, maxReviewRounds: 1, maxFixCommitTurns: 2 },
  } as const;

  it("raises what was approved under the new receipt and keeps every used count", () => {
    const state: FactoryDeliveryState = {
      ...running(reviewed()),
      rounds: { fix: 1, review: 1 },
      fixCommitTurns: 1,
    };

    const { delivery, effects } = advance(state, amended);

    expect(effects).toEqual([]);
    expect(delivery.limits).toEqual({ maxFixRounds: 3, maxReviewRounds: 1 });
    expect(delivery.reviewedExecution?.receiptId).toBe("receipt-2");
    expect(delivery.reviewedExecution?.reviewVersion).toBe(2);
    expect(delivery.reviewedExecution?.limits).toEqual({
      maxFixRounds: 3,
      maxReviewRounds: 1,
      maxFixCommitTurns: 2,
      verifyTimeoutMinutes: 30,
    });
    expect(delivery.rounds).toEqual({ fix: 1, review: 1 });
    expect(delivery.fixCommitTurns).toBe(1);
  });

  it("keeps the receipt it replaced, which can never stand again", () => {
    const state = advance(running(reviewed()), amended).delivery;
    expect(state.supersededReceipts).toEqual(["receipt-1"]);
    const third = advance(state, { ...amended, receiptId: "receipt-3", reviewVersion: 3 }).delivery;
    expect(third.supersededReceipts).toEqual(["receipt-1", "receipt-2"]);

    const reused = advance(third, { ...amended, receiptId: "receipt-1", reviewVersion: 4 });
    expect(reused.delivery).toBe(third);
  });

  it("changes nothing for the receipt it already stands under, or without a review", () => {
    const state = running(reviewed());
    expect(advance(state, { ...amended, receiptId: "receipt-1", reviewVersion: 1 }).delivery).toBe(
      state,
    );
    const legacy = running();
    expect(advance(legacy, amended).delivery).toBe(legacy);
  });
});

describe("an automatic turn a review refused", () => {
  const refused = { type: "reviewed.refused", detail: "The review no longer holds." } as const;

  it("blocks a delivery waiting on its pull request, saying why", () => {
    const open: FactoryDeliveryState = {
      ...running(reviewed()),
      status: "pr_open",
      awaiting: null,
    };
    const { delivery } = advance(open, refused);
    expect(delivery.status).toBe("blocked");
    expect(delivery.block).toEqual({ reason: "reviewed_refused", detail: refused.detail });
  });

  it("changes nothing while it runs a stage, whose next effect is refused by itself", () => {
    const state = running(reviewed());
    expect(advance(state, refused).delivery).toBe(state);
  });
});
