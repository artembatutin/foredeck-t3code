import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryPlanTask,
  type FactoryReviewSummary,
  FactoryTaskId,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryResumeCheck,
  FactoryReviewJudgment,
} from "./state.ts";

/**
 * A parent's integrate stage in the pure engine: after its last child's approval it verifies its
 * whole branch afresh, then a new reviewer thread reviews the branch. Neither has a repair round
 * (owner decision): a failure blocks the parent, and a resume integrates again from a new verify.
 */

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const worktreePath = "/worktrees/fd-parent";
const branchStart = "a".repeat(40);

const task = (id: string): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});
const [first, second] = ["child-a", "child-b"].map((id) => FactoryDeliveryId.make(id)) as [
  FactoryDeliveryId,
  FactoryDeliveryId,
];

const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce((current, event) => advance(current, event).delivery, delivery);

/** Asserts the event changes nothing: the very same state, and no effect. */
const ignores = (delivery: FactoryDeliveryState, event: FactoryEvent) => {
  const step = advance(delivery, event);
  expect(step.delivery).toBe(delivery);
  expect(step.effects).toEqual([]);
};

// Planned (effect 1), approved (effect 2), both children started (3, 4) and the first approved:
// the parent waits on its last child, with the default limits, so rounds would be left.
const onLast = fold(
  queuedDeliveryState({ kind: "parent", branch: "work/fd-parent", baseRef: "HEAD" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath,
    baseline: branchStart,
  },
  {
    type: "plan.submitted",
    round: 1,
    threadId: planner,
    runId: planRun,
    judgment: {
      type: "accepted",
      plan: {
        tasks: [task("export-csv"), task("export-header")],
        source: "mcp",
        evidencePath: "/t3/userdata/fd-factory/parent/plan.json",
      },
    },
  },
  { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
  { type: "plan.approved" },
  { type: "children.created", effectId: 2, children: [first, second] },
  { type: "child.started", effectId: 3 },
  { type: "child.approved", deliveryId: first },
  { type: "child.started", effectId: 4 },
);
const lastApproved: FactoryEvent = { type: "child.approved", deliveryId: second };

const head = "c".repeat(40);
const receipt = (code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha: head,
  tree: "d".repeat(40),
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: "2026-10-25T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/parent/verify-1.log",
  outputHash: "output-1",
});
const verified = (effectId: number, code = 0): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: {
    type: "receipt",
    receipt: receipt(code),
    ...(code === 0 ? {} : { fingerprint: "fp" }),
  },
});

const reviewer = ThreadId.make("factory-thread:parent:6");
const reviewRun = RunId.make("run-integrate");
const reviewLaunched: FactoryEvent = {
  type: "thread.launched",
  effectId: 6,
  threadId: reviewer,
  runId: reviewRun,
  worktreePath,
  baseline: head,
};

const summary = (blocking: boolean): FactoryReviewSummary => ({
  headSha: head,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-25T10:05:00.000Z",
});
const accepted = (
  blocking: boolean,
  source: "mcp" | "fallback" = "mcp",
): Extract<FactoryReviewJudgment, { readonly type: "accepted" }> => ({
  type: "accepted",
  review: {
    source,
    summary: summary(blocking),
    evidencePath: "/t3/userdata/fd-factory/parent/review-1.json",
    ...(blocking ? { fingerprint: "review-fp" } : {}),
  },
});
const invalid: FactoryReviewJudgment = {
  type: "invalid",
  problems: ["Criterion 2 has no acceptance entry."],
};
const submitted = (
  judgment: FactoryReviewJudgment,
  from: { readonly threadId?: ThreadId; readonly runId?: RunId; readonly round?: number } = {},
): FactoryEvent => ({
  type: "review.submitted",
  round: from.round ?? 1,
  threadId: from.threadId ?? reviewer,
  runId: from.runId ?? reviewRun,
  judgment,
});
const reviewEnded = (runId: RunId = reviewRun): FactoryEvent => ({
  type: "run.finished",
  threadId: reviewer,
  runId,
  status: "completed",
});

const verifying = fold(onLast, lastApproved);
const launching = fold(verifying, verified(5));
const reviewing = fold(launching, reviewLaunched);

const check: FactoryResumeCheck = {
  deletedThreads: [],
  unrecordedAuthorRunEnded: false,
  worktree: null,
};
const resume = (deletedThreads: ReadonlyArray<ThreadId> = []): FactoryEvent => ({
  type: "resume",
  check: { ...check, deletedThreads },
});

/** Every effect the events issue, in order. */
const issued = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce<{ delivery: FactoryDeliveryState; effects: FactoryEffect[] }>(
    (last, event) => {
      const next = advance(last.delivery, event);
      return { delivery: next.delivery, effects: [...last.effects, ...next.effects] };
    },
    { delivery, effects: [] },
  );

describe("a parent's integrate verify", () => {
  it("runs once its last child reports its approval, never taking a child's receipt", () => {
    const verify = { id: 5, type: "run_command", stage: "verify" } as const;
    expect(advance(onLast, lastApproved)).toEqual({
      delivery: {
        ...onLast,
        approvedChildren: [first, second],
        stage: "verify",
        effectsIssued: verify.id,
        awaiting: { type: "effect", effect: verify },
      },
      effects: [verify],
    } satisfies FactoryAdvance);
    expect(verifying.receipts).toEqual([]);
  });

  it("records a passing receipt and launches a new reviewer on the shared worktree", () => {
    const launch = {
      id: 6,
      type: "launch_thread",
      role: "reviewer",
      workspace: { type: "existing_worktree", worktreePath },
    } as const;
    expect(advance(verifying, verified(5))).toEqual({
      delivery: {
        ...verifying,
        stage: "integrate",
        receipts: [receipt(0)],
        reviewRound: 1,
        invalidSubmissions: 0,
        effectsIssued: launch.id,
        awaiting: { type: "effect", effect: launch },
      },
      effects: [launch],
    } satisfies FactoryAdvance);
    // The launch records its thread as the parent's reviewer and awaits its run; the parent's
    // baseline, where its branch started, stays the base the review covers.
    expect(reviewing).toMatchObject({
      stage: "integrate",
      threads: { planner, reviewer },
      baseline: branchStart,
      awaiting: { type: "run", threadId: reviewer, runId: reviewRun },
    });
  });

  it("blocks with receipt_refused on a refused run, recording no receipt", () => {
    const step = advance(verifying, {
      type: "command.finished",
      effectId: 5,
      outcome: { type: "refused", refusals: ["head_changed"] },
    });
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "verify",
      awaiting: null,
      receipts: [],
      block: { reason: "receipt_refused", refusals: ["head_changed"] },
    });
  });

  it("blocks as verify_failed on a failed receipt, with no repair turn though rounds are left", () => {
    expect(verifying.limits.maxFixRounds).toBeGreaterThan(0);
    const step = advance(verifying, verified(5, 1));
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "verify",
      awaiting: null,
      receipts: [receipt(1)],
      rounds: { fix: 0, review: 0 },
      block: { reason: "verify_failed" },
    });
  });

  it("stops a stopping parent where the integrate review would begin", () => {
    const step = advance(fold(verifying, { type: "stop" }), verified(5));
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "stopped",
      stage: "verify",
      checkpoint: "integrate",
      awaiting: null,
      receipts: [receipt(0)],
    });
    expect(advance(step.delivery, resume()).effects).toEqual([
      { id: 6, type: "run_command", stage: "verify" },
    ]);
  });
});

describe("the integrate review", () => {
  it("takes the awaited run's review, and a passing one leaves integrate once that run ends", () => {
    const taken = advance(reviewing, submitted(accepted(false)));
    expect(taken.effects).toEqual([]);
    expect(taken.delivery.awaiting).toEqual(reviewing.awaiting);
    expect(taken.delivery.reviews).toEqual([{ ...accepted(false).review, round: 1 }]);

    const done = advance(taken.delivery, reviewEnded());
    expect(done.effects).toEqual([{ id: 7, type: "open_pr" }]);
    expect(done.delivery).toMatchObject({ status: "approved", stage: "pr", block: null });
  });

  it("blocks with a blocking review's summary, with no repair turn though rounds are left", () => {
    expect(reviewing.limits.maxReviewRounds).toBeGreaterThan(0);
    const { delivery, effects } = issued(reviewing, submitted(accepted(true)), reviewEnded());
    expect(effects).toEqual([]);
    expect(delivery).toMatchObject({
      status: "blocked",
      stage: "integrate",
      awaiting: null,
      rounds: { fix: 0, review: 0 },
      block: { reason: "review_changes_required", summary: summary(true) },
    });
  });

  it("takes no submission from another thread, a later run, another round or outside it", () => {
    ignores(reviewing, submitted(accepted(false), { threadId: ThreadId.make("child-reviewer") }));
    ignores(reviewing, submitted(invalid, { runId: RunId.make("run-integrate-next") }));
    ignores(reviewing, submitted(accepted(false), { round: 2 }));
    // Waiting on its child, verifying, or launching its reviewer, it reviews nothing.
    for (const delivery of [onLast, verifying, launching]) {
      ignores(delivery, submitted(accepted(false)));
    }
    // Once the round's review is taken, a second is not.
    ignores(fold(reviewing, submitted(accepted(false))), submitted(accepted(true)));
  });

  it("reads the fenced review of a run that ends without one, then takes a corrected one", () => {
    const read = { id: 7, type: "read_fallback_review", threadId: reviewer, runId: reviewRun };
    const reading = advance(reviewing, reviewEnded());
    expect(reading.effects).toEqual([read]);

    const retry = advance(reading.delivery, {
      type: "review.read",
      effectId: 7,
      judgment: invalid,
    });
    expect(retry.effects).toEqual([
      { id: 8, type: "send_review_retry_turn", threadId: reviewer, problems: invalid.problems },
    ]);
    expect(retry.delivery.invalidSubmissions).toBe(1);

    const retryRun = RunId.make("run-integrate-retry");
    const corrected = fold(
      retry.delivery,
      { type: "turn.started", effectId: 8, runId: retryRun },
      reviewEnded(retryRun),
    );
    expect(corrected.awaiting).toMatchObject({ type: "effect", effect: { id: 9 } });
    const done = advance(corrected, {
      type: "review.read",
      effectId: 9,
      judgment: accepted(false, "fallback"),
    });
    expect(done.delivery).toMatchObject({ status: "approved", stage: "pr" });
    expect(done.delivery.reviews.at(-1)?.source).toBe("fallback");
  });

  it("blocks on the second invalid submission of the round, by either path", () => {
    const viaTool = issued(reviewing, submitted(invalid), submitted(invalid));
    expect(viaTool.effects).toEqual([]);
    expect(viaTool.delivery).toMatchObject({
      status: "blocked",
      invalidSubmissions: 2,
      block: { reason: "invalid_submission", problems: invalid.problems },
    });

    const retryRun = RunId.make("run-integrate-retry");
    const viaFence = fold(
      reviewing,
      reviewEnded(),
      { type: "review.read", effectId: 7, judgment: invalid },
      { type: "turn.started", effectId: 8, runId: retryRun },
      reviewEnded(retryRun),
      { type: "review.read", effectId: 9, judgment: invalid },
    );
    expect(viaFence).toMatchObject({
      status: "blocked",
      block: { reason: "invalid_submission", problems: invalid.problems },
    });
  });

  it("blocks with code_changed on a submission made after HEAD moved", () => {
    const step = advance(
      reviewing,
      submitted({ type: "code_changed", changes: ["head_changed", "tree_dirty"] }),
    );
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "integrate",
      block: { reason: "code_changed", changes: ["head_changed", "tree_dirty"] },
    });
  });

  it("blocks when the reviewer's run does not complete", () => {
    expect(
      fold(reviewing, {
        type: "run.finished",
        threadId: reviewer,
        runId: reviewRun,
        status: "failed",
      }).block,
    ).toEqual({ reason: "run_ended", threadId: reviewer, runId: reviewRun, runStatus: "failed" });
  });
});

describe("resuming a parent blocked in integrate", () => {
  it.each([
    ["verify_failed", fold(verifying, verified(5, 1))],
    [
      "receipt_refused",
      fold(verifying, {
        type: "command.finished",
        effectId: 5,
        outcome: { type: "refused", refusals: ["tree_dirty"] },
      }),
    ],
    ["review_changes_required", fold(reviewing, submitted(accepted(true)), reviewEnded())],
    ["invalid_submission", fold(reviewing, submitted(invalid), submitted(invalid))],
    ["code_changed", fold(reviewing, submitted({ type: "code_changed", changes: ["tree_dirty"] }))],
    ["thread_deleted", fold(reviewing, { type: "thread.deleted", threadId: reviewer })],
  ] as const)("verifies afresh, then launches a new reviewer, after %s", (reason, blocked) => {
    expect(blocked.status).toBe("blocked");
    expect(blocked.block?.reason).toBe(reason);
    const deleted = reason === "thread_deleted" ? [reviewer] : [];

    const resumed = advance(blocked, resume(deleted));
    const verify = { id: blocked.effectsIssued + 1, type: "run_command", stage: "verify" } as const;
    expect(resumed.effects).toEqual([verify]);
    expect(resumed.delivery).toMatchObject({
      status: "running",
      stage: "verify",
      block: null,
      receipts: blocked.receipts,
      awaiting: { type: "effect", effect: verify },
    });

    // The fresh receipt begins a new round with a thread of its own, not a turn on the old one.
    const relaunch = advance(resumed.delivery, verified(verify.id));
    expect(relaunch.effects).toEqual([
      {
        id: verify.id + 1,
        type: "launch_thread",
        role: "reviewer",
        workspace: { type: "existing_worktree", worktreePath },
      },
    ]);
    expect(relaunch.delivery).toMatchObject({
      stage: "integrate",
      reviewRound: blocked.reviewRound + 1,
      invalidSubmissions: 0,
      receipts: [...blocked.receipts, receipt(0)],
    });
  });
});
