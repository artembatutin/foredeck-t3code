import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryReviewSummary, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryReviewJudgment,
  FactoryReviewSource,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const retryRun = RunId.make("run-retry");
const otherRun = RunId.make("run-other");
const worktreePath = "/worktrees/item-7";
const baseline = "b".repeat(40);
const head = "a".repeat(40);

const receipt: FactoryVerifyReceipt = {
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
};

// Effect ids, issued in order: the author launch (1), its settle check (2) and verify (3), then
// the reviewer launch (4). A run that ends without an accepted review gets the fallback read (5);
// an invalid one the retry turn (6), whose run gets the second fallback read (7).
const VERIFY = 3;
const REVIEW_LAUNCH = 4;
const FALLBACK = 5;
const RETRY_TURN = 6;
const SECOND_FALLBACK = 7;

const summary = (blocking: boolean): FactoryReviewSummary => ({
  headSha: head,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
});
const evidencePath = "/t3/userdata/fd-factory/delivery-1/review-1.json";
const accepted = (source: FactoryReviewSource, blocking: boolean): FactoryReviewJudgment => ({
  type: "accepted",
  review: { source, summary: summary(blocking), evidencePath },
});
const invalid = (problem: string): FactoryReviewJudgment => ({
  type: "invalid",
  problems: [problem],
});
const codeChanged: FactoryReviewJudgment = { type: "code_changed", changes: ["head_changed"] };

const submitted = (
  judgment: FactoryReviewJudgment,
  overrides: Partial<Extract<FactoryEvent, { readonly type: "review.submitted" }>> = {},
): FactoryEvent => ({
  type: "review.submitted",
  round: 1,
  threadId: reviewer,
  runId: reviewRun,
  judgment,
  ...overrides,
});
const read = (effectId: number, judgment: FactoryReviewJudgment): FactoryEvent => ({
  type: "review.read",
  effectId,
  judgment,
});
const finished = (
  threadId: ThreadId,
  runId: RunId,
  status: Extract<FactoryEvent, { readonly type: "run.finished" }>["status"] = "completed",
): FactoryEvent => ({ type: "run.finished", threadId, runId, status });

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

const verifying = run(
  queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" }),
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
  { type: "settle.checked", effectId: 2, result: { status: "settled" } },
).delivery;
const awaitingReviewer = run(verifying, {
  type: "command.finished",
  effectId: VERIFY,
  outcome: { type: "receipt", receipt },
}).delivery;
const reviewing = run(awaitingReviewer, {
  type: "thread.launched",
  effectId: REVIEW_LAUNCH,
  threadId: reviewer,
  runId: reviewRun,
  worktreePath,
  // A reviewer's launch reports its worktree's HEAD, the commit it reviews.
  baseline: head,
}).delivery;
const awaitingFallback = run(reviewing, finished(reviewer, reviewRun)).delivery;
const awaitingRetryTurn = run(
  awaitingFallback,
  read(FALLBACK, invalid("No fenced block.")),
).delivery;
const retrying = run(awaitingRetryTurn, {
  type: "turn.started",
  effectId: RETRY_TURN,
  runId: retryRun,
}).delivery;
const awaitingSecondFallback = run(retrying, finished(reviewer, retryRun)).delivery;
const acceptedPassing = run(reviewing, submitted(accepted("mcp", false))).delivery;

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

describe("entering review", () => {
  it("launches a reviewer on the delivery worktree once verify passes", () => {
    expect(
      advance(verifying, {
        type: "command.finished",
        effectId: VERIFY,
        outcome: { type: "receipt", receipt },
      }),
    ).toEqual(
      issued(
        {
          ...verifying,
          stage: "review",
          reviewRound: 1,
          invalidSubmissions: 0,
          receipts: [receipt],
        },
        {
          id: REVIEW_LAUNCH,
          type: "launch_thread",
          role: "reviewer",
          workspace: { type: "existing_worktree", worktreePath },
        },
      ),
    );
  });

  it("records the reviewer and awaits its run, keeping the author's task baseline", () => {
    expect(reviewing).toEqual({
      ...awaitingReviewer,
      threads: { author, reviewer },
      awaiting: { type: "run", threadId: reviewer, runId: reviewRun },
    });
    expect(reviewing.baseline).toBe(baseline);
  });
});

describe("a submission while the reviewer runs", () => {
  it("records an accepted review with its source and waits for the run to complete", () => {
    const step = advance(reviewing, submitted(accepted("mcp", false)));
    expect(step).toEqual({
      delivery: {
        ...reviewing,
        reviews: [{ round: 1, source: "mcp", summary: summary(false), evidencePath }],
      },
      effects: [],
    });
    expect(step.delivery.status).toBe("running");
  });

  it("moves a passing review to record once the run completes", () => {
    // Record is not built yet: the delivery blocks there, past the review.
    expect(advance(acceptedPassing, finished(reviewer, reviewRun))).toEqual(
      blockedState(
        { ...acceptedPassing, stage: "record" },
        { reason: "unsupported_stage", stage: "record" },
      ),
    );
  });

  it("blocks a blocking review with its summary once the run completes", () => {
    const accepting = run(reviewing, submitted(accepted("mcp", true))).delivery;
    expect(advance(accepting, finished(reviewer, reviewRun))).toEqual(
      blockedState(accepting, { reason: "review_changes_required", summary: summary(true) }),
    );
  });

  it("blocks on the run's failure even after a review was accepted", () => {
    expect(advance(acceptedPassing, finished(reviewer, reviewRun, "failed"))).toEqual(
      blockedState(acceptedPassing, {
        reason: "run_ended",
        threadId: reviewer,
        runId: reviewRun,
        runStatus: "failed",
      }),
    );
  });

  it("counts a first invalid submission for the reviewer to correct in its turn", () => {
    expect(advance(reviewing, submitted(invalid("Duplicate finding id.")))).toEqual({
      delivery: { ...reviewing, invalidSubmissions: 1 },
      effects: [],
    });
  });

  it("blocks on a second invalid submission with its problems", () => {
    expect(
      run(
        reviewing,
        submitted(invalid("Duplicate finding id.")),
        submitted(invalid("Evidence path missing.")),
      ),
    ).toEqual(
      blockedState(
        { ...reviewing, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["Evidence path missing."] },
      ),
    );
  });

  it("accepts a corrected submission after an invalid one", () => {
    const corrected = run(
      reviewing,
      submitted(invalid("Duplicate finding id.")),
      submitted(accepted("mcp", false)),
    ).delivery;
    expect(corrected.reviews).toHaveLength(1);
    expect(corrected.invalidSubmissions).toBe(1);
    expect(advance(corrected, finished(reviewer, reviewRun)).delivery.stage).toBe("record");
  });

  it("blocks when the code changed under review", () => {
    expect(advance(reviewing, submitted(codeChanged))).toEqual(
      blockedState(reviewing, { reason: "code_changed", changes: ["head_changed"] }),
    );
  });

  it("blocks when the reviewer thread is deleted", () => {
    expect(advance(reviewing, { type: "thread.deleted", threadId: reviewer })).toEqual(
      blockedState(reviewing, { reason: "thread_deleted", threadId: reviewer }),
    );
  });
});

describe("the fenced-JSON fallback", () => {
  it("reads the last message of a run that completed without an accepted review", () => {
    expect(advance(reviewing, finished(reviewer, reviewRun))).toEqual(
      issued(reviewing, {
        id: FALLBACK,
        type: "read_fallback_review",
        threadId: reviewer,
        runId: reviewRun,
      }),
    );
  });

  it.each([
    [false, "record"],
    [true, "review"],
  ] as const)("acts at once on an accepted review (blocking: %s)", (blocking, stage) => {
    const step = advance(awaitingFallback, read(FALLBACK, accepted("fallback", blocking)));
    const reviews: FactoryDeliveryState["reviews"] = [
      { round: 1, source: "fallback", summary: summary(blocking), evidencePath },
    ];
    expect(step).toEqual(
      blockedState(
        { ...awaitingFallback, stage, reviews },
        blocking
          ? { reason: "review_changes_required", summary: summary(true) }
          : { reason: "unsupported_stage", stage: "record" },
      ),
    );
  });

  it("asks the reviewer thread for one retry turn listing the problems", () => {
    expect(advance(awaitingFallback, read(FALLBACK, invalid("No fenced block.")))).toEqual(
      issued(
        { ...awaitingFallback, invalidSubmissions: 1 },
        {
          id: RETRY_TURN,
          type: "send_review_retry_turn",
          threadId: reviewer,
          problems: ["No fenced block."],
        },
      ),
    );
  });

  it("awaits the retry turn's run, then reads its last message", () => {
    expect(retrying.awaiting).toEqual({ type: "run", threadId: reviewer, runId: retryRun });
    expect(advance(retrying, finished(reviewer, retryRun))).toEqual(
      issued(retrying, {
        id: SECOND_FALLBACK,
        type: "read_fallback_review",
        threadId: reviewer,
        runId: retryRun,
      }),
    );
  });

  it("accepts a submission made during the retry turn", () => {
    const corrected = run(
      retrying,
      submitted(accepted("mcp", false), { runId: retryRun }),
      finished(reviewer, retryRun),
    ).delivery;
    expect(corrected.stage).toBe("record");
    expect(corrected.reviews.map(({ source }) => source)).toEqual(["mcp"]);
  });

  it("blocks when the retry's answer is invalid too", () => {
    expect(
      advance(awaitingSecondFallback, read(SECOND_FALLBACK, invalid("Not valid JSON."))),
    ).toEqual(
      blockedState(
        { ...awaitingSecondFallback, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["Not valid JSON."] },
      ),
    );
  });

  it("blocks without a retry turn after an invalid submission on the tool path", () => {
    const afterTool = run(
      reviewing,
      submitted(invalid("Duplicate finding id.")),
      finished(reviewer, reviewRun),
    ).delivery;
    expect(advance(afterTool, read(FALLBACK, invalid("No fenced block.")))).toEqual(
      blockedState(
        { ...afterTool, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["No fenced block."] },
      ),
    );
  });

  it("blocks when the code changed under review", () => {
    expect(advance(awaitingFallback, read(FALLBACK, codeChanged))).toEqual(
      blockedState(awaitingFallback, { reason: "code_changed", changes: ["head_changed"] }),
    );
  });

  it.each([
    ["fallback read", awaitingFallback],
    ["retry turn", awaitingRetryTurn],
  ] as const)("blocks when the worker cannot carry out the %s", (_, delivery) => {
    if (delivery.awaiting?.type !== "effect") throw new Error("the state awaits an effect");
    const { effect } = delivery.awaiting;
    expect(
      advance(delivery, { type: "effect.failed", effectId: effect.id, detail: "No." }),
    ).toEqual(blockedState(delivery, { reason: "effect_failed", effect, detail: "No." }));
  });
});

describe("stale review events", () => {
  it.each([
    ["a submission for another round", reviewing, submitted(accepted("mcp", false), { round: 2 })],
    [
      "a submission from an earlier run of the reviewer",
      retrying,
      submitted(accepted("mcp", false), { runId: reviewRun }),
    ],
    ["a submission naming another run", reviewing, submitted(invalid("x"), { runId: otherRun })],
    [
      "a submission from another thread",
      reviewing,
      submitted(codeChanged, { threadId: author, runId: reviewRun }),
    ],
    [
      "a second submission once the round's review is accepted",
      acceptedPassing,
      submitted(invalid("x")),
    ],
    ["a submission while the fallback is read", awaitingFallback, submitted(codeChanged)],
    ["a submission while verify runs", verifying, submitted(codeChanged, { round: 0 })],
    ["a submission before the reviewer launched", awaitingReviewer, submitted(codeChanged)],
    [
      "a submission to a blocked delivery",
      run(reviewing, submitted(codeChanged)).delivery,
      submitted(accepted("mcp", false)),
    ],
    ["a fallback result naming another effect", awaitingFallback, read(REVIEW_LAUNCH, codeChanged)],
    [
      "the first fallback's result while the second is awaited",
      awaitingSecondFallback,
      read(FALLBACK, accepted("fallback", false)),
    ],
    [
      "a fallback result naming the awaited effect of another type",
      awaitingRetryTurn,
      read(RETRY_TURN, codeChanged),
    ],
    ["a fallback result while the reviewer runs", reviewing, read(FALLBACK, codeChanged)],
    [
      "a retry turn's result naming another effect",
      awaitingRetryTurn,
      { type: "turn.started", effectId: FALLBACK, runId: retryRun },
    ],
    [
      "a retry turn's result once its run is awaited",
      retrying,
      { type: "turn.started", effectId: RETRY_TURN, runId: otherRun },
    ],
    ["the first reviewer run's end during the retry", retrying, finished(reviewer, reviewRun)],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const result = advance(delivery, event);
    expect(result.delivery).toBe(delivery);
    expect(result.effects).toEqual([]);
  });
});

describe("review steps", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it.each([
    ["a submission", reviewing, submitted(accepted("mcp", true))],
    ["an invalid submission", reviewing, submitted(invalid("x"))],
    ["the run's end", acceptedPassing, finished(reviewer, reviewRun)],
    ["the fallback's result", awaitingFallback, read(FALLBACK, invalid("x"))],
    [
      "the retry turn's result",
      awaitingRetryTurn,
      { type: "turn.started", effectId: RETRY_TURN, runId: retryRun },
    ],
  ] as const)("never mutate their input: %s", (_, delivery, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(delivery));
    const first = advance(input, deepFreeze(structuredClone(event)));
    expect(advance(structuredClone(delivery), structuredClone(event))).toEqual(first);
    expect(input).toEqual(delivery);
  });
});
