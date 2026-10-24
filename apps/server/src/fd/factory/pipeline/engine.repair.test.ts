import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryProjectSettings,
  type FactoryReviewSummary,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryReviewJudgment,
  FactoryRoundLimits,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const worktreePath = "/worktrees/item-7";
const baseline = "b".repeat(40);
const head = "a".repeat(40);

const receipt = (overrides: Partial<FactoryVerifyReceipt> = {}): FactoryVerifyReceipt => ({
  version: 1,
  headSha: head,
  tree: "c".repeat(40),
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
  ...overrides,
});
const passing = receipt();
const failing = receipt({ code: 1 });

const verified = (effectId: number, passed = passing): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: { type: "receipt", receipt: passed },
});
const verifyFailed = (effectId: number, fingerprint: string, failed = failing): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: { type: "receipt", receipt: failed, fingerprint },
});
const turnStarted = (effectId: number, runId: RunId): FactoryEvent => ({
  type: "turn.started",
  effectId,
  runId,
});
const finished = (
  threadId: ThreadId,
  runId: RunId,
  status: Extract<FactoryEvent, { readonly type: "run.finished" }>["status"] = "completed",
): FactoryEvent => ({ type: "run.finished", threadId, runId, status });
const settled = (effectId: number): FactoryEvent => ({
  type: "settle.checked",
  effectId,
  result: { status: "settled" },
});

const summary = (blocking: boolean): FactoryReviewSummary => ({
  headSha: head,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
});
const blockingReview = (fingerprint: string): FactoryReviewJudgment => ({
  type: "accepted",
  review: {
    source: "mcp",
    summary: summary(true),
    evidencePath: "/t3/userdata/fd-factory/delivery-1/review-1.json",
    fingerprint,
  },
});
const passingReview: FactoryReviewJudgment = {
  type: "accepted",
  review: {
    source: "mcp",
    summary: summary(false),
    evidencePath: "/t3/userdata/fd-factory/delivery-1/review-2.json",
  },
};
const submitted = (judgment: FactoryReviewJudgment, round: number, runId: RunId): FactoryEvent => ({
  type: "review.submitted",
  round,
  threadId: reviewer,
  runId,
  judgment,
});

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

const issued = (delivery: FactoryDeliveryState, effect: FactoryEffect): FactoryAdvance => ({
  delivery: { ...delivery, effectsIssued: effect.id, awaiting: { type: "effect", effect } },
  effects: [effect],
});
const blockedState = (
  delivery: FactoryDeliveryState,
  block: FactoryDeliveryState["block"],
): FactoryAdvance => ({
  delivery: { ...delivery, status: "blocked", awaiting: null, block },
  effects: [],
});

/** The effect the delivery awaits. */
const awaited = (delivery: FactoryDeliveryState): FactoryEffect => {
  if (delivery.awaiting?.type !== "effect") throw new Error("The delivery awaits no effect.");
  return delivery.awaiting.effect;
};
/** The run the delivery awaits. */
const awaitedRun = (delivery: FactoryDeliveryState) => {
  if (delivery.awaiting?.type !== "run") throw new Error("The delivery awaits no run.");
  return delivery.awaiting;
};

const limits = (maxFixRounds: number, maxReviewRounds: number): FactoryRoundLimits => ({
  maxFixRounds,
  maxReviewRounds,
});

// Effect ids, issued in order: the author launch (1), its settle check (2) and verify (3).
const VERIFY = 3;

/** A delivery whose author run settled, awaiting its first verify. */
const verifying = (roundLimits: FactoryRoundLimits) =>
  run(
    queuedDeliveryState({ branch: "fd/item-7", baseRef: "main", limits: roundLimits }),
    { type: "start" },
    {
      type: "thread.launched",
      effectId: 1,
      threadId: author,
      runId: authorRun,
      worktreePath,
      baseline,
    },
    finished(author, authorRun),
    settled(2),
  ).delivery;

/** A delivery whose first verify passed, awaiting its first reviewer's run. */
const reviewing = (roundLimits: FactoryRoundLimits) =>
  run(verifying(roundLimits), verified(VERIFY), {
    type: "thread.launched",
    effectId: VERIFY + 1,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath,
    baseline: head,
  }).delivery;

let runs = 0;
const nextRun = () => RunId.make(`run-${(runs += 1)}`);

/**
 * Runs the awaited repair turn on the author thread: its run starts and completes, and the
 * branch settles. Returns the delivery awaiting the next verify.
 */
const repairSettles = (delivery: FactoryDeliveryState, runId = nextRun()) => {
  const started = run(delivery, turnStarted(awaited(delivery).id, runId)).delivery;
  const ended = run(started, finished(author, runId)).delivery;
  return run(ended, settled(awaited(ended).id)).delivery;
};

/** Makes the awaited reviewer run accept a blocking review and complete. */
const reviewBlocks = (delivery: FactoryDeliveryState, fingerprint: string) => {
  const { runId } = awaitedRun(delivery);
  return run(
    delivery,
    submitted(blockingReview(fingerprint), delivery.reviewRound, runId),
    finished(reviewer, runId),
  );
};

describe("fix-verify rounds", () => {
  it("sends a fix-verify turn on the author thread for a failed receipt", () => {
    const delivery = verifying(limits(2, 2));
    expect(advance(delivery, verifyFailed(VERIFY, "fp-1"))).toEqual(
      issued(
        {
          ...delivery,
          stage: "repair",
          receipts: [failing],
          rounds: { fix: 1, review: 0 },
          fingerprints: ["fp-1"],
        },
        {
          id: VERIFY + 1,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 1,
        },
      ),
    );
  });

  it("sends one for a timed-out receipt too", () => {
    const timedOut = receipt({ code: null, timedOut: true });
    const step = advance(verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1", timedOut));
    expect(step.effects).toEqual([
      { id: VERIFY + 1, type: "send_repair_turn", kind: "fix-verify", threadId: author, round: 1 },
    ]);
  });

  it("settles the branch after the repair run, then verifies again", () => {
    const fixRun = RunId.make("run-fix");
    const awaitingTurn = run(verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1")).delivery;
    const repairing = run(awaitingTurn, turnStarted(VERIFY + 1, fixRun)).delivery;
    expect(repairing.awaiting).toEqual({ type: "run", threadId: author, runId: fixRun });
    expect(repairing.stage).toBe("repair");

    expect(advance(repairing, finished(author, fixRun))).toEqual(
      issued(repairing, { id: VERIFY + 2, type: "check_settle", threadId: author, runId: fixRun }),
    );
    const settling = run(repairing, finished(author, fixRun)).delivery;
    expect(advance(settling, settled(VERIFY + 2))).toEqual(
      issued(
        { ...settling, stage: "verify" },
        { id: VERIFY + 3, type: "run_command", stage: "verify" },
      ),
    );
  });

  it("keeps the fix-commit rule for a repair run whose branch does not settle", () => {
    const fixRun = RunId.make("run-fix");
    const settling = run(
      verifying(limits(2, 2)),
      verifyFailed(VERIFY, "fp-1"),
      turnStarted(VERIFY + 1, fixRun),
      finished(author, fixRun),
    ).delivery;
    const problems = ["The worktree has uncommitted changes."];
    expect(
      advance(settling, {
        type: "settle.checked",
        effectId: VERIFY + 2,
        result: { status: "repairable", problems },
      }),
    ).toEqual(
      issued(
        { ...settling, fixCommitTurns: 1 },
        { id: VERIFY + 3, type: "send_fix_commit_turn", threadId: author, problems },
      ),
    );
  });

  it.each([0, 1, 2])(
    "spends maxFixRounds %i on fix-verify turns, then blocks verify_failed",
    (maxFixRounds) => {
      let delivery = verifying(limits(maxFixRounds, 2));
      const repairTurns: Array<FactoryEffect> = [];
      for (let failure = 1; delivery.status === "running"; failure += 1) {
        const step = advance(delivery, verifyFailed(awaited(delivery).id, `fp-${failure}`));
        delivery = step.delivery;
        if (delivery.status !== "running") break;
        repairTurns.push(...step.effects);
        delivery = repairSettles(delivery);
        expect(awaited(delivery)).toMatchObject({ type: "run_command", stage: "verify" });
      }

      expect(repairTurns).toEqual(
        Array.from({ length: maxFixRounds }, (_, index) =>
          expect.objectContaining({
            type: "send_repair_turn",
            kind: "fix-verify",
            threadId: author,
            round: index + 1,
          }),
        ),
      );
      expect(delivery.block).toEqual({ reason: "verify_failed" });
      expect(delivery.stage).toBe("verify");
      expect(delivery.rounds).toEqual({ fix: maxFixRounds, review: 0 });
      expect(delivery.receipts).toHaveLength(maxFixRounds + 1);
    },
  );

  it("moves on to review once a repaired commit passes", () => {
    const repaired = repairSettles(
      run(verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1")).delivery,
    );
    const step = advance(repaired, verified(awaited(repaired).id));
    expect(step.delivery.stage).toBe("review");
    expect(step.delivery.reviewRound).toBe(1);
    // No fix-review was spent, so the first review launches a fresh reviewer.
    expect(step.effects).toEqual([
      expect.objectContaining({ type: "launch_thread", role: "reviewer" }),
    ]);
    expect(step.delivery.rounds).toEqual({ fix: 1, review: 0 });
  });

  it("blocks when a repair run does not complete", () => {
    const fixRun = RunId.make("run-fix");
    const repairing = run(
      verifying(limits(2, 2)),
      verifyFailed(VERIFY, "fp-1"),
      turnStarted(VERIFY + 1, fixRun),
    ).delivery;
    expect(advance(repairing, finished(author, fixRun, "interrupted"))).toEqual(
      blockedState(repairing, {
        reason: "run_ended",
        threadId: author,
        runId: fixRun,
        runStatus: "interrupted",
      }),
    );
  });
});

describe("fix-review rounds", () => {
  it("sends a fix-review turn on the author thread once a blocking review's run completes", () => {
    const accepting = run(
      reviewing(limits(2, 2)),
      submitted(blockingReview("rv-1"), 1, reviewRun),
    ).delivery;
    expect(advance(accepting, finished(reviewer, reviewRun))).toEqual(
      issued(
        {
          ...accepting,
          stage: "repair",
          rounds: { fix: 0, review: 1 },
          fingerprints: ["rv-1"],
        },
        {
          id: VERIFY + 2,
          type: "send_repair_turn",
          kind: "fix-review",
          threadId: author,
          round: 1,
        },
      ),
    );
  });

  it("records the fix-review run as the author's reply", () => {
    const replyRun = RunId.make("run-reply");
    const replying = run(
      reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery,
      turnStarted(VERIFY + 2, replyRun),
    ).delivery;
    expect(replying.reviewResponse).toEqual({ threadId: author, runId: replyRun });
    expect(replying.awaiting).toEqual({ type: "run", threadId: author, runId: replyRun });
  });

  it("follows up on the reviewer thread after settle and a passing verify", () => {
    const replyRun = RunId.make("run-reply");
    const awaitingVerify = run(
      reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery,
      turnStarted(VERIFY + 2, replyRun),
      finished(author, replyRun),
      settled(VERIFY + 3),
    ).delivery;
    expect(awaited(awaitingVerify)).toEqual({
      id: VERIFY + 4,
      type: "run_command",
      stage: "verify",
    });
    const repaired = receipt({ headSha: "d".repeat(40), tree: "e".repeat(40) });

    expect(advance(awaitingVerify, verified(VERIFY + 4, repaired))).toEqual(
      issued(
        {
          ...awaitingVerify,
          stage: "review",
          reviewRound: 2,
          invalidSubmissions: 0,
          receipts: [passing, repaired],
        },
        { id: VERIFY + 5, type: "send_review_follow_up_turn", threadId: reviewer, round: 2 },
      ),
    );
  });

  it("takes the follow-up's review from the same reviewer thread and moves to record", () => {
    const followUpRun = RunId.make("run-follow-up");
    const repaired = repairSettles(reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery);
    const followingUp = run(repaired, verified(awaited(repaired).id)).delivery;
    const reviewingAgain = run(
      followingUp,
      turnStarted(awaited(followingUp).id, followUpRun),
    ).delivery;
    expect(reviewingAgain.awaiting).toEqual({
      type: "run",
      threadId: reviewer,
      runId: followUpRun,
    });
    expect(reviewingAgain.threads).toEqual({ author, reviewer });

    // A run without a submission has its fenced review read from the reviewer thread.
    expect(advance(reviewingAgain, finished(reviewer, followUpRun)).effects).toEqual([
      expect.objectContaining({
        type: "read_fallback_review",
        threadId: reviewer,
        runId: followUpRun,
      }),
    ]);
    const accepted = run(
      reviewingAgain,
      submitted(passingReview, 2, followUpRun),
      finished(reviewer, followUpRun),
    ).delivery;
    expect(accepted.reviews.map(({ round }) => round)).toEqual([1, 2]);
    // Record is not built yet: the delivery blocks there, past the review.
    expect(accepted.stage).toBe("record");
    expect(accepted.block).toEqual({ reason: "unsupported_stage", stage: "record" });
  });

  it("gives a follow-up round a fresh retry budget", () => {
    const invalidFirst = run(
      reviewing(limits(2, 2)),
      submitted({ type: "invalid", problems: ["Duplicate id."] }, 1, reviewRun),
    ).delivery;
    expect(invalidFirst.invalidSubmissions).toBe(1);
    const followingUp = repairSettles(reviewBlocks(invalidFirst, "rv-1").delivery);
    const step = advance(followingUp, verified(awaited(followingUp).id));
    expect(step.delivery.invalidSubmissions).toBe(0);
  });

  it.each([0, 1, 2])(
    "spends maxReviewRounds %i on fix-review turns, then blocks with the review",
    (maxReviewRounds) => {
      let delivery = reviewing(limits(2, maxReviewRounds));
      const repairTurns: Array<FactoryEffect> = [];
      const reviewTurns: Array<FactoryEffect> = [];
      for (let review = 1; delivery.status === "running"; review += 1) {
        const step = reviewBlocks(delivery, `rv-${review}`);
        delivery = step.delivery;
        if (delivery.status !== "running") break;
        repairTurns.push(...step.effects);
        const repaired = repairSettles(delivery);
        const next = advance(repaired, verified(awaited(repaired).id));
        reviewTurns.push(...next.effects);
        delivery = run(next.delivery, turnStarted(awaited(next.delivery).id, nextRun())).delivery;
      }

      expect(repairTurns).toEqual(
        Array.from({ length: maxReviewRounds }, (_, index) =>
          expect.objectContaining({ kind: "fix-review", threadId: author, round: index + 1 }),
        ),
      );
      // Every later round follows up on the one reviewer thread; none launches another.
      expect(reviewTurns).toEqual(
        Array.from({ length: maxReviewRounds }, (_, index) =>
          expect.objectContaining({
            type: "send_review_follow_up_turn",
            threadId: reviewer,
            round: index + 2,
          }),
        ),
      );
      expect(delivery.block).toEqual({ reason: "review_changes_required", summary: summary(true) });
      expect(delivery.stage).toBe("review");
      expect(delivery.reviewRound).toBe(maxReviewRounds + 1);
      expect(delivery.rounds).toEqual({ fix: 0, review: maxReviewRounds });
    },
  );

  it("counts fix-verify and fix-review rounds apart", () => {
    // Review 1 blocks; the fix-review's commit fails verify once, then passes.
    const replyRun = RunId.make("run-reply");
    const awaitingVerify = repairSettles(
      reviewBlocks(reviewing(limits(1, 1)), "rv-1").delivery,
      replyRun,
    );
    const failed = advance(awaitingVerify, verifyFailed(awaited(awaitingVerify).id, "fp-1"));
    expect(failed.effects).toEqual([
      expect.objectContaining({ kind: "fix-verify", threadId: author, round: 1 }),
    ]);
    const fixed = repairSettles(failed.delivery);
    const step = advance(fixed, verified(awaited(fixed).id));

    expect(step.delivery.rounds).toEqual({ fix: 1, review: 1 });
    // The reply the next round checks is still the fix-review's, not the fix-verify's.
    expect(step.delivery.reviewResponse).toEqual({ threadId: author, runId: replyRun });
    expect(step.effects).toEqual([
      expect.objectContaining({ type: "send_review_follow_up_turn", threadId: reviewer, round: 2 }),
    ]);
  });
});

describe("fingerprint stops", () => {
  it("blocks a verify failure seen before on the task, with rounds left", () => {
    const repaired = repairSettles(
      run(verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1")).delivery,
    );
    const id = awaited(repaired).id;
    expect(advance(repaired, verifyFailed(id, "fp-1"))).toEqual(
      blockedState(
        { ...repaired, receipts: [failing, failing] },
        { reason: "repeated_failure", stage: "verify" },
      ),
    );
  });

  it("blocks a blocking review seen before on the task, with rounds left", () => {
    let delivery = reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery;
    const repaired = repairSettles(delivery);
    const next = advance(repaired, verified(awaited(repaired).id)).delivery;
    delivery = run(next, turnStarted(awaited(next).id, nextRun())).delivery;
    const step = reviewBlocks(delivery, "rv-1");

    expect(step.effects).toEqual([]);
    expect(step.delivery.status).toBe("blocked");
    expect(step.delivery.block).toEqual({ reason: "repeated_failure", stage: "review" });
    expect(step.delivery.rounds).toEqual({ fix: 0, review: 1 });
    expect(step.delivery.fingerprints).toEqual(["rv-1"]);
  });

  it("starts another round for a new fingerprint and records it", () => {
    const repaired = repairSettles(
      run(verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1")).delivery,
    );
    const step = advance(repaired, verifyFailed(awaited(repaired).id, "fp-2"));
    expect(step.delivery.fingerprints).toEqual(["fp-1", "fp-2"]);
    expect(step.effects).toEqual([expect.objectContaining({ kind: "fix-verify", round: 2 })]);
  });

  it("never matches a failure without a fingerprint", () => {
    const failedOnce = run(verifying(limits(2, 2)), {
      type: "command.finished",
      effectId: VERIFY,
      outcome: { type: "receipt", receipt: failing },
    }).delivery;
    expect(failedOnce.fingerprints).toEqual([]);
    const repaired = repairSettles(failedOnce);
    const step = advance(repaired, {
      type: "command.finished",
      effectId: awaited(repaired).id,
      outcome: { type: "receipt", receipt: failing },
    });
    expect(step.effects).toEqual([expect.objectContaining({ kind: "fix-verify", round: 2 })]);
  });
});

describe("late events of an earlier round", () => {
  const firstFix = RunId.make("run-fix-1");
  const secondFix = RunId.make("run-fix-2");
  const firstRepair = run(
    verifying(limits(2, 2)),
    verifyFailed(VERIFY, "fp-1"),
    turnStarted(VERIFY + 1, firstFix),
    finished(author, firstFix),
    settled(VERIFY + 2),
  ).delivery;
  const awaitingSecondTurn = run(firstRepair, verifyFailed(VERIFY + 3, "fp-2")).delivery;
  const secondRepairing = run(awaitingSecondTurn, turnStarted(VERIFY + 4, secondFix)).delivery;
  const followUpRun = RunId.make("run-follow-up");
  const followingUp = (() => {
    const repaired = repairSettles(reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery);
    const next = run(repaired, verified(awaited(repaired).id)).delivery;
    return run(next, turnStarted(awaited(next).id, followUpRun)).delivery;
  })();

  it.each([
    [
      "the first repair turn's result while the second is awaited",
      awaitingSecondTurn,
      turnStarted(VERIFY + 1, secondFix),
    ],
    [
      "the first repair turn's result once the second runs",
      secondRepairing,
      turnStarted(VERIFY + 1, firstFix),
    ],
    [
      "the second repair turn's result once its run is awaited",
      secondRepairing,
      turnStarted(VERIFY + 4, firstFix),
    ],
    ["the first repair run's end during the second", secondRepairing, finished(author, firstFix)],
    ["the first settle result during the second repair", secondRepairing, settled(VERIFY + 2)],
    [
      "the first verify result during the second repair",
      secondRepairing,
      verifyFailed(VERIFY, "fp-3"),
    ],
    [
      "the first reviewer run's end during the follow-up",
      followingUp,
      finished(reviewer, reviewRun),
    ],
    [
      "a submission for the first round during the follow-up",
      followingUp,
      submitted(passingReview, 1, followUpRun),
    ],
    [
      "a submission from the first reviewer run during the follow-up",
      followingUp,
      submitted(passingReview, 2, reviewRun),
    ],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const step = advance(delivery, event);
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});

describe("repair steps", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const replying = reviewBlocks(reviewing(limits(2, 2)), "rv-1").delivery;
  const repaired = repairSettles(replying);

  it.each([
    ["a failed verify", verifying(limits(2, 2)), verifyFailed(VERIFY, "fp-1")],
    [
      "a blocking review's run end",
      run(reviewing(limits(2, 2)), submitted(blockingReview("rv-1"), 1, reviewRun)).delivery,
      finished(reviewer, reviewRun),
    ],
    [
      "the fix-review turn's result",
      replying,
      turnStarted(awaited(replying).id, RunId.make("run-x")),
    ],
    ["the repaired commit's passing verify", repaired, verified(awaited(repaired).id)],
  ] as const)("never mutate their input: %s", (_, delivery, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(delivery));
    const first = advance(input, deepFreeze(structuredClone(event)));
    expect(advance(structuredClone(delivery), structuredClone(event))).toEqual(first);
    expect(input).toEqual(delivery);
  });
});

const decodeSettings = Schema.decodeSync(FactoryProjectSettings);

describe("round limits", () => {
  it("default to the project settings' defaults", () => {
    const { limits: settings } = decodeSettings({});
    expect(queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" }).limits).toEqual({
      maxFixRounds: settings.maxFixRounds,
      maxReviewRounds: settings.maxReviewRounds,
    });
  });
});
