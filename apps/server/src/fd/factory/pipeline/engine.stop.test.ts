import { RunId, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDeliveryStatus,
  FactoryReviewSummary,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryReviewJudgment,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const fixRun = RunId.make("run-fix");
const reviewRun = RunId.make("run-review");
const retryRun = RunId.make("run-retry");
const repairRun = RunId.make("run-repair");
const worktreePath = "/worktrees/item-7";
const baseline = "b".repeat(40);
const head = "a".repeat(40);

const receipt = (code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha: head,
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
});
const passing = receipt(0);
const failing = receipt(1);

const summary = (blocking: boolean): FactoryReviewSummary => ({
  headSha: head,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
});
const accepted = (blocking: boolean): FactoryReviewJudgment => ({
  type: "accepted",
  review: {
    source: "mcp",
    summary: summary(blocking),
    evidencePath: "/t3/review-1.json",
    ...(blocking ? { fingerprint: "rv-1" } : {}),
  },
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
const verified = (effectId: number, result = passing, fingerprint?: string): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: {
    type: "receipt",
    receipt: result,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  },
});
const submitted = (judgment: FactoryReviewJudgment, runId = reviewRun): FactoryEvent => ({
  type: "review.submitted",
  round: 1,
  threadId: reviewer,
  runId,
  judgment,
});
const stop: FactoryEvent = { type: "stop" };
const cancel: FactoryEvent = { type: "cancel" };

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });
const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  run(delivery, ...events).delivery;

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), then record or the fallback read (5) and the PR or a retry turn (6).
const queued = queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" });
const authoring = fold(
  queued,
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath,
    baseline,
  },
);
const settling = fold(authoring, finished(author, authorRun));
const verifying = fold(settling, settled(2));
const reviewing = fold(verifying, verified(3), {
  type: "thread.launched",
  effectId: 4,
  threadId: reviewer,
  runId: reviewRun,
  worktreePath,
  baseline: head,
});
const recording = fold(reviewing, submitted(accepted(false)), finished(reviewer, reviewRun));

/** The state the owner's stop leaves: stopping, awaiting what it awaited. */
const stopping = (delivery: FactoryDeliveryState): FactoryDeliveryState => {
  const step = advance(delivery, stop);
  expect(step).toEqual({ delivery: { ...delivery, status: "stopping" }, effects: [] });
  return step.delivery;
};

/** Stopped where `checkpoint` would begin: awaiting nothing, no effect issued. */
const stoppedAt = (
  delivery: FactoryDeliveryState,
  checkpoint: FactoryDeliveryState["checkpoint"],
): FactoryAdvance => ({
  delivery: { ...delivery, status: "stopped", awaiting: null, checkpoint },
  effects: [],
});

describe("stop after the current step", () => {
  it("stops a running delivery without touching what it awaits", () => {
    const step = advance(authoring, stop);
    expect(step.delivery.status).toBe("stopping");
    expect(step.delivery.awaiting).toEqual({ type: "run", threadId: author, runId: authorRun });
    expect(step.effects).toEqual([]);
  });

  it("finishes the author's step and stops at verify once the branch settles", () => {
    const stopped = stopping(authoring);
    // The run's end still gets its settle check: that is the author stage's own work.
    const checking = advance(stopped, finished(author, authorRun));
    expect(checking.effects).toEqual([
      { id: 2, type: "check_settle", threadId: author, runId: authorRun },
    ]);
    expect(checking.delivery.status).toBe("stopping");

    const step = advance(checking.delivery, settled(2));
    expect(step).toEqual(stoppedAt(checking.delivery, "verify"));
    expect(step.delivery.stage).toBe("author");
  });

  it("still sends the fix-commit turn and stops at verify after it", () => {
    const stopped = stopping(settling);
    const repairing = advance(stopped, {
      type: "settle.checked",
      effectId: 2,
      result: { status: "repairable", problems: ["The worktree has uncommitted changes."] },
    });
    expect(repairing.effects).toEqual([
      {
        id: 3,
        type: "send_fix_commit_turn",
        threadId: author,
        problems: ["The worktree has uncommitted changes."],
      },
    ]);
    const fixed = fold(
      repairing.delivery,
      { type: "turn.started", effectId: 3, runId: fixRun },
      finished(author, fixRun),
    );
    expect(fixed.status).toBe("stopping");
    expect(advance(fixed, settled(4))).toEqual(stoppedAt(fixed, "verify"));
  });

  it("records a passing receipt and stops before the review round", () => {
    const stopped = stopping(verifying);
    const step = advance(stopped, verified(3));
    expect(step).toEqual(stoppedAt({ ...stopped, receipts: [passing] }, "review"));
    expect(step.delivery.reviewRound).toBe(0);
  });

  it("records a failed receipt's fingerprint and stops before the repair round", () => {
    const stopped = stopping(verifying);
    const step = advance(stopped, verified(3, failing, "fp-1"));
    expect(step).toEqual(
      stoppedAt({ ...stopped, receipts: [failing], fingerprints: ["fp-1"] }, "repair"),
    );
    expect(step.delivery.stage).toBe("verify");
    expect(step.delivery.rounds).toEqual({ fix: 0, review: 0 });
  });

  it("takes a review while stopping and stops before record when the run completes", () => {
    const stopped = stopping(reviewing);
    const submission = advance(stopped, submitted(accepted(false)));
    expect(submission.effects).toEqual([]);
    expect(submission.delivery.status).toBe("stopping");
    expect(submission.delivery.reviews.map(({ round }) => round)).toEqual([1]);

    const step = advance(submission.delivery, finished(reviewer, reviewRun));
    expect(step).toEqual(stoppedAt(submission.delivery, "record"));
    expect(step.delivery.stage).toBe("review");
  });

  it("stops before the repair round a blocking review would begin", () => {
    const accepting = fold(stopping(reviewing), submitted(accepted(true)));
    expect(advance(accepting, finished(reviewer, reviewRun))).toEqual(
      stoppedAt({ ...accepting, fingerprints: ["rv-1"] }, "repair"),
    );
  });

  it("still reads the fallback review and asks for its retry while stopping", () => {
    const reading = advance(stopping(reviewing), finished(reviewer, reviewRun));
    expect(reading.effects).toEqual([
      { id: 5, type: "read_fallback_review", threadId: reviewer, runId: reviewRun },
    ]);
    const retry = advance(reading.delivery, {
      type: "review.read",
      effectId: 5,
      judgment: { type: "invalid", problems: ["No fenced block."] },
    });
    expect(retry.effects).toEqual([
      { id: 6, type: "send_review_retry_turn", threadId: reviewer, problems: ["No fenced block."] },
    ]);
    const answered = fold(
      retry.delivery,
      { type: "turn.started", effectId: 6, runId: retryRun },
      finished(reviewer, retryRun),
    );
    expect(answered.status).toBe("stopping");
    const step = advance(answered, { type: "review.read", effectId: 7, judgment: accepted(false) });
    expect(step.delivery.status).toBe("stopped");
    expect(step.delivery.checkpoint).toBe("record");
    expect(step.effects).toEqual([]);
  });

  it("stops at pr with the approval recorded instead of opening the pull request", () => {
    const stopped = stopping(recording);
    const step = advance(stopped, {
      type: "approval.recorded",
      effectId: 5,
      outcome: { type: "approved", evidencePath: "/t3/approval-item.json" },
    });
    expect(step).toEqual(stoppedAt(stopped, "pr"));
    expect(step.delivery.stage).toBe("record");
  });

  it("finishes a repair turn's step and stops at verify", () => {
    const repairing = fold(verifying, verified(3, failing, "fp-1"), {
      type: "turn.started",
      effectId: 4,
      runId: repairRun,
    });
    expect(repairing.stage).toBe("repair");
    const checking = fold(stopping(repairing), finished(author, repairRun));
    expect(checking.awaiting).toEqual({
      type: "effect",
      effect: { id: 5, type: "check_settle", threadId: author, runId: repairRun },
    });
    expect(advance(checking, settled(5))).toEqual(stoppedAt(checking, "verify"));
  });

  it("leaves a stopped delivery where it is: nothing it no longer awaits moves it", () => {
    const stopped = advance(stopping(verifying), verified(3)).delivery;
    for (const event of [
      verified(3),
      finished(author, authorRun),
      { type: "effect.failed", effectId: 3, detail: "No." },
      { type: "thread.deleted", threadId: author },
      { type: "start" },
      stop,
    ] satisfies ReadonlyArray<FactoryEvent>) {
      const step = advance(stopped, event);
      expect(step.delivery).toBe(stopped);
      expect(step.effects).toEqual([]);
    }
  });
});

describe("failures while stopping", () => {
  it("blocks a run that ended without completing, as a running delivery would", () => {
    const step = advance(stopping(authoring), finished(author, authorRun, "failed"));
    expect(step).toEqual({
      delivery: {
        ...authoring,
        status: "blocked",
        awaiting: null,
        block: { reason: "run_ended", threadId: author, runId: authorRun, runStatus: "failed" },
      },
      effects: [],
    });
  });

  const failures: ReadonlyArray<readonly [string, FactoryDeliveryState, FactoryEvent]> = [
    [
      "an unrepairable branch",
      settling,
      { type: "settle.checked", effectId: 2, result: { status: "unrepairable", problems: ["x"] } },
    ],
    ["a failed effect", verifying, { type: "effect.failed", effectId: 3, detail: "No." }],
    ["a deleted thread", verifying, { type: "thread.deleted", threadId: author }],
    [
      "a failed verify with no fix round left",
      { ...verifying, limits: { maxFixRounds: 0, maxReviewRounds: 2 } },
      verified(3, failing, "fp-1"),
    ],
    ["a repeated failure", { ...verifying, fingerprints: ["fp-1"] }, verified(3, failing, "fp-1")],
    [
      "code changed under review",
      reviewing,
      submitted({ type: "code_changed", changes: ["head_changed"] }),
    ],
    [
      "a record mismatch",
      recording,
      {
        type: "approval.recorded",
        effectId: 5,
        outcome: {
          type: "mismatch",
          expected: { headSha: head, tree: "c".repeat(40) },
          actual: { headSha: "d".repeat(40), tree: "c".repeat(40), clean: true },
          differences: ["head_changed"],
        },
      },
    ],
  ];

  it.each(failures)("blocks on %s exactly as a running delivery does", (_, delivery, event) => {
    const whileRunning = advance(delivery, event);
    expect(whileRunning.delivery.status).toBe("blocked");
    expect(advance({ ...delivery, status: "stopping" }, event)).toEqual(whileRunning);
  });
});

describe("stop requests that change nothing", () => {
  it("leaves a stopping delivery as it is", () => {
    const stopped = stopping(authoring);
    const step = advance(stopped, stop);
    expect(step.delivery).toBe(stopped);
    expect(step.effects).toEqual([]);
  });

  const statuses: ReadonlyArray<FactoryDeliveryStatus> = [
    "queued",
    "stopped",
    "blocked",
    "approved",
    "pr_open",
    "done",
    "cancelled",
  ];
  it.each(statuses)("leaves a %s delivery as it is", (status) => {
    const delivery = { ...verifying, status, awaiting: null };
    const step = advance(delivery, stop);
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});

describe("cancel", () => {
  const cases: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
    ["queued", queued],
    ["running, awaiting a run", authoring],
    ["running, awaiting an effect", verifying],
    ["stopping", stopping(reviewing)],
    ["stopped", advance(stopping(verifying), verified(3)).delivery],
    ["blocked", advance(authoring, finished(author, authorRun, "failed")).delivery],
    [
      "approved, opening its pull request",
      fold(recording, {
        type: "approval.recorded",
        effectId: 5,
        outcome: { type: "approved", evidencePath: "/t3/approval-item.json" },
      }),
    ],
  ];

  it.each(cases)("ends a %s delivery, awaiting nothing and issuing nothing", (_, delivery) => {
    // A PR stage still outstanding may have started a watch, which is to be released with it.
    const publishing =
      delivery.awaiting?.type === "effect" && delivery.awaiting.effect.type === "open_pr";
    expect(advance(delivery, cancel)).toEqual({
      delivery: {
        ...delivery,
        status: "cancelled",
        awaiting: null,
        block: null,
        checkpoint: null,
        ...(publishing ? { releaseWatch: true } : {}),
      },
      effects: [],
    });
  });

  it("takes no later run end, result, submission or deletion", () => {
    const cancelled = advance(reviewing, cancel).delivery;
    for (const event of [
      submitted(accepted(false)),
      finished(reviewer, reviewRun),
      finished(reviewer, reviewRun, "interrupted"),
      {
        type: "thread.launched",
        effectId: 4,
        threadId: reviewer,
        runId: reviewRun,
        worktreePath,
        baseline,
      },
      { type: "turn.started", effectId: 4, runId: reviewRun },
      verified(3),
      { type: "effect.failed", effectId: 4, detail: "No." },
      { type: "thread.deleted", threadId: reviewer },
      { type: "start" },
      stop,
      cancel,
    ] satisfies ReadonlyArray<FactoryEvent>) {
      const step = advance(cancelled, event);
      expect(step.delivery).toBe(cancelled);
      expect(step.effects).toEqual([]);
    }
  });

  it.each(["done", "cancelled"] as const)("leaves a %s delivery as it is", (status) => {
    const delivery = { ...authoring, status, awaiting: null };
    const step = advance(delivery, cancel);
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});
