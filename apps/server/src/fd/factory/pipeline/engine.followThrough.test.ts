import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryOpenedPullRequest,
  FactoryResumeCheck,
  FactoryReviewJudgment,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const freshReviewer = ThreadId.make("thread-reviewer-2");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const wakeRun = RunId.make("run-wake");
const freshReviewRun = RunId.make("run-review-2");
const worktreePath = "/worktrees/item-7";
const approved = "a".repeat(40);
const fixed = "d".repeat(40);

const receiptFor = (headSha: string, code = 0): FactoryVerifyReceipt => ({
  version: 1,
  headSha,
  tree: `${headSha.slice(0, 1)}${"c".repeat(39)}`,
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify.log",
  outputHash: "output-1",
});

const pullRequest: FactoryOpenedPullRequest = {
  number: 42,
  url: "https://github.com/acme/alpha/pull/42",
  headBranch: "fd/item-7",
};

const passed = (headSha: string, round: number): FactoryReviewJudgment => ({
  type: "accepted",
  review: {
    source: "mcp",
    summary: {
      headSha,
      verdict: "pass",
      blocking: false,
      findings: { high: 0, medium: 0, low: 0 },
      reviewedAt: "2026-10-24T10:05:00.000Z",
    },
    evidencePath: `/t3/userdata/fd-factory/delivery-1/review-${round}.json`,
  },
});

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), record (5) and the PR (6), whose watch's command is at position 100.
const WATCHED_AFTER = 100;

/** A single item whose pull request is open and watched, awaiting nothing. */
const prOpen = run(
  queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath,
    baseline: "b".repeat(40),
  },
  { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
  { type: "settle.checked", effectId: 2, result: { status: "settled" } },
  {
    type: "command.finished",
    effectId: 3,
    outcome: { type: "receipt", receipt: receiptFor(approved) },
  },
  {
    type: "thread.launched",
    effectId: 4,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath,
    baseline: approved,
  },
  {
    type: "review.submitted",
    round: 1,
    threadId: reviewer,
    runId: reviewRun,
    judgment: passed(approved, 1),
  },
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
  {
    type: "approval.recorded",
    effectId: 5,
    outcome: { type: "approved", evidencePath: "/a.json" },
  },
  { type: "pr.opened", effectId: 6, pullRequest, watchedAfter: WATCHED_AFTER },
).delivery;

const wake = (overrides: Partial<Extract<FactoryEvent, { type: "pr.feedback" }>> = {}) =>
  ({
    type: "pr.feedback",
    threadId: author,
    runId: wakeRun,
    number: pullRequest.number,
    url: pullRequest.url,
    sequence: WATCHED_AFTER + 5,
    ...overrides,
  }) satisfies FactoryEvent;

const wakeEnded = (status: "completed" | "failed" | "interrupted" | "cancelled") =>
  ({ type: "run.finished", threadId: author, runId: wakeRun, status }) satisfies FactoryEvent;
const merged: FactoryEvent = { type: "pr.merged", number: 42, url: pullRequest.url };
const closed: FactoryEvent = { type: "pr.closed", number: 42, url: pullRequest.url };
const resume = (check: Partial<FactoryResumeCheck> = {}): FactoryEvent => ({
  type: "resume",
  check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null, ...check },
});

const adopted = advance(prOpen, wake()).delivery;

/** The adopted round run through its completed run, settle check and verify (effects 7, 8). */
const verifiedRound = (state: FactoryDeliveryState, receipt: FactoryVerifyReceipt) =>
  run(
    advance(state, wake()).delivery,
    wakeEnded("completed"),
    { type: "settle.checked", effectId: 7, result: { status: "settled" } },
    { type: "command.finished", effectId: 8, outcome: { type: "receipt", receipt } },
  );

describe("Factory engine: adopting a pull request wake", () => {
  it("awaits the wake's run at follow_through, and reviews the round on a fresh thread", () => {
    // A fix-review round before the pull request left the author's reply to its findings.
    const replied = { ...prOpen, reviewResponse: { threadId: author, runId: authorRun } };
    expect(prOpen.status).toBe("pr_open");
    expect(prOpen.followThrough).toEqual({ watchedAfter: WATCHED_AFTER, runs: [] });

    expect(advance(replied, wake())).toEqual({
      delivery: {
        ...replied,
        status: "running",
        stage: "follow_through",
        awaiting: { type: "run", threadId: author, runId: wakeRun },
        reviewResponse: null,
        followThrough: { watchedAfter: WATCHED_AFTER, runs: [wakeRun] },
      },
      effects: [],
    });
  });

  it("takes no wake while the delivery is in any other status", () => {
    for (const status of [
      "queued",
      "running",
      "stopping",
      "waiting",
      "approved",
      "blocked",
      "stopped",
      "done",
      "cancelled",
    ] as const) {
      const state = { ...prOpen, status };
      expect(advance(state, wake()).delivery).toBe(state);
    }
    // Merged and closing out, it awaits its close-out.
    const closingOut = advance(prOpen, merged).delivery;
    expect(advance(closingOut, wake()).delivery).toBe(closingOut);
    // Once adopted, it runs: neither this wake again nor a later one is another round.
    expect(advance(adopted, wake()).delivery).toBe(adopted);
    const later = wake({ runId: RunId.make("run-wake-2"), sequence: WATCHED_AFTER + 9 });
    expect(advance(adopted, later).delivery).toBe(adopted);
  });

  it("takes no wake of another thread, another pull request or from before its watch", () => {
    for (const event of [
      wake({ threadId: reviewer }),
      wake({ threadId: ThreadId.make("thread-owner") }),
      wake({ number: 43 }),
      wake({ url: "https://github.com/acme/beta/pull/42" }),
      // Committed before or with the watch the PR stage started: it came while a stage ran.
      wake({ sequence: WATCHED_AFTER }),
      wake({ sequence: WATCHED_AFTER - 1 }),
    ]) {
      expect(advance(prOpen, event).delivery).toBe(prOpen);
    }
  });

  it("takes none for a delivery whose pull request is not watched, nor a parent's or a child's", () => {
    const { followThrough: _, ...unwatched } = prOpen;
    for (const state of [
      unwatched,
      { ...prOpen, kind: "parent" as const },
      { ...prOpen, kind: "child" as const },
      // A run it adopted before is never a round again.
      { ...prOpen, followThrough: { watchedAfter: WATCHED_AFTER, runs: [wakeRun] } },
    ]) {
      expect(advance(state, wake()).delivery).toBe(state);
    }
  });
});

describe("Factory engine: a follow-through round after its run", () => {
  it.each([
    { head: "the approved commit, unchanged", headSha: approved },
    { head: "a fix the author committed", headSha: fixed },
  ])("settles, verifies, reviews, records and publishes $head", ({ headSha }) => {
    const settling = advance(adopted, wakeEnded("completed"));
    expect(settling.effects).toEqual([
      { id: 7, type: "check_settle", threadId: author, runId: wakeRun },
    ]);
    const verifying = advance(settling.delivery, {
      type: "settle.checked",
      effectId: 7,
      result: { status: "settled" },
    });
    expect(verifying.effects).toEqual([{ id: 8, type: "run_command", stage: "verify" }]);
    expect(verifying.delivery.stage).toBe("verify");

    // A fresh receipt, never the one the pull request was opened with, then a fresh reviewer.
    const receipt = receiptFor(headSha);
    const reviewing = advance(verifying.delivery, {
      type: "command.finished",
      effectId: 8,
      outcome: { type: "receipt", receipt },
    });
    expect(reviewing.delivery.receipts).toEqual([receiptFor(approved), receipt]);
    expect(reviewing.delivery.reviewRound).toBe(2);
    expect(reviewing.effects).toEqual([
      {
        id: 9,
        type: "launch_thread",
        role: "reviewer",
        workspace: { type: "existing_worktree", worktreePath },
      },
    ]);

    const recording = run(
      reviewing.delivery,
      {
        type: "thread.launched",
        effectId: 9,
        threadId: freshReviewer,
        runId: freshReviewRun,
        worktreePath,
        baseline: headSha,
      },
      {
        type: "review.submitted",
        round: 2,
        threadId: freshReviewer,
        runId: freshReviewRun,
        judgment: passed(headSha, 2),
      },
      { type: "run.finished", threadId: freshReviewer, runId: freshReviewRun, status: "completed" },
    );
    expect(recording.effects).toEqual([{ id: 10, type: "record_approval" }]);

    const publishing = advance(recording.delivery, {
      type: "approval.recorded",
      effectId: 10,
      outcome: { type: "approved", evidencePath: "/a.json" },
    });
    expect(publishing.delivery.status).toBe("approved");
    expect(publishing.delivery.stage).toBe("pr");
    expect(publishing.effects).toEqual([{ id: 11, type: "open_pr" }]);

    // Back to pr_open on the same pull request, watched from the republish's watch on.
    const reopened = advance(publishing.delivery, {
      type: "pr.opened",
      effectId: 11,
      pullRequest,
      watchedAfter: 200,
    }).delivery;
    expect(reopened).toEqual({
      ...recording.delivery,
      status: "pr_open",
      stage: "pr",
      awaiting: null,
      pullRequest,
      followThrough: { watchedAfter: 200, runs: [wakeRun] },
      effectsIssued: 11,
    });
    expect(reopened.threads).toEqual({ author, reviewer: freshReviewer });
    // The wake of the round before stays taken; a later one is the next round.
    expect(advance(reopened, wake({ sequence: 150 })).delivery).toBe(reopened);
    const next = RunId.make("run-wake-2");
    expect(advance(reopened, wake({ runId: next, sequence: 201 })).delivery.awaiting).toEqual({
      type: "run",
      threadId: author,
      runId: next,
    });
  });

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "blocks on a wake run that ended %s",
    (status) => {
      expect(advance(adopted, wakeEnded(status))).toEqual({
        delivery: {
          ...adopted,
          status: "blocked",
          awaiting: null,
          block: { reason: "run_ended", threadId: author, runId: wakeRun, runStatus: status },
        },
        effects: [],
      });
    },
  );

  it("stops where it would verify when its owner stopped it during the run", () => {
    const stopped = run(advance(adopted, { type: "stop" }).delivery, wakeEnded("completed"), {
      type: "settle.checked",
      effectId: 7,
      result: { status: "settled" },
    });
    expect(stopped.effects).toEqual([]);
    expect(stopped.delivery.status).toBe("stopped");
    expect(stopped.delivery.checkpoint).toBe("verify");
  });
});

describe("Factory engine: a follow-through round's failures", () => {
  const failing = (fingerprint: string) => ({
    type: "receipt" as const,
    receipt: receiptFor(fixed, 1),
    fingerprint,
  });

  it("repairs a failed verify on the author thread, counting on from the task's rounds", () => {
    const step = run(
      advance({ ...prOpen, rounds: { fix: 1, review: 1 } }, wake()).delivery,
      wakeEnded("completed"),
      { type: "settle.checked", effectId: 7, result: { status: "settled" } },
      { type: "command.finished", effectId: 8, outcome: failing("fp-new") },
    );
    expect(step.effects).toEqual([
      { id: 9, type: "send_repair_turn", kind: "fix-verify", threadId: author, round: 2 },
    ]);
    expect(step.delivery.rounds).toEqual({ fix: 2, review: 1 });
  });

  it("blocks verify_failed with the task's fix rounds spent, never taking it as a pass", () => {
    const spent = { ...prOpen, rounds: { fix: 2, review: 0 } };
    const step = run(
      advance(spent, wake()).delivery,
      wakeEnded("completed"),
      { type: "settle.checked", effectId: 7, result: { status: "settled" } },
      { type: "command.finished", effectId: 8, outcome: failing("fp-new") },
    );
    expect(step.effects).toEqual([]);
    expect(step.delivery.status).toBe("blocked");
    expect(step.delivery.block).toEqual({ reason: "verify_failed" });
    expect(step.delivery.fingerprints).toEqual(["fp-new"]);
  });

  it("blocks repeated_failure on a failure the task saw before, with rounds left", () => {
    const seen = { ...prOpen, fingerprints: ["fp-seen"] };
    const step = run(
      advance(seen, wake()).delivery,
      wakeEnded("completed"),
      { type: "settle.checked", effectId: 7, result: { status: "settled" } },
      { type: "command.finished", effectId: 8, outcome: failing("fp-seen") },
    );
    expect(step.delivery.block).toEqual({ reason: "repeated_failure", stage: "verify" });
    expect(step.delivery.rounds).toEqual({ fix: 0, review: 0 });
  });

  it("resumes such a block with a fresh verify and the resume's fresh rounds", () => {
    const blocked = run(
      advance({ ...prOpen, rounds: { fix: 2, review: 2 } }, wake()).delivery,
      wakeEnded("completed"),
      { type: "settle.checked", effectId: 7, result: { status: "settled" } },
      { type: "command.finished", effectId: 8, outcome: failing("fp-new") },
    ).delivery;
    const resumed = advance(
      blocked,
      resume({
        worktree: {
          settle: { status: "settled" },
          commit: { headSha: fixed, tree: receiptFor(fixed).tree },
          approvedSha: approved,
        },
      }),
    );
    expect(resumed.effects).toEqual([{ id: 9, type: "run_command", stage: "verify" }]);
    expect(resumed.delivery.status).toBe("running");
    expect(resumed.delivery.rounds).toEqual({ fix: 0, review: 0 });
    expect(resumed.delivery.fingerprints).toEqual([]);
  });

  it("refuses a review submitted after the code changed, and a record that finds it changed", () => {
    const reviewing = run(verifiedRound(prOpen, receiptFor(fixed)).delivery, {
      type: "thread.launched",
      effectId: 9,
      threadId: freshReviewer,
      runId: freshReviewRun,
      worktreePath,
      baseline: fixed,
    }).delivery;
    const changed = advance(reviewing, {
      type: "review.submitted",
      round: 2,
      threadId: freshReviewer,
      runId: freshReviewRun,
      judgment: { type: "code_changed", changes: ["head_changed"] },
    }).delivery;
    expect(changed.status).toBe("blocked");
    expect(changed.block).toEqual({ reason: "code_changed", changes: ["head_changed"] });

    const mismatch = run(
      reviewing,
      {
        type: "review.submitted",
        round: 2,
        threadId: freshReviewer,
        runId: freshReviewRun,
        judgment: passed(fixed, 2),
      },
      { type: "run.finished", threadId: freshReviewer, runId: freshReviewRun, status: "completed" },
      {
        type: "approval.recorded",
        effectId: 10,
        outcome: {
          type: "mismatch",
          expected: { headSha: fixed, tree: receiptFor(fixed).tree },
          actual: { headSha: "e".repeat(40), tree: "f".repeat(40), clean: true },
          differences: ["head_changed", "tree_changed", "not_reviewed"],
        },
      },
    ).delivery;
    expect(mismatch.status).toBe("blocked");
    expect(mismatch.block?.reason).toBe("record_mismatch");
  });
});

describe("Factory engine: a merge or close during a follow-through round", () => {
  const verifying = run(adopted, wakeEnded("completed"), {
    type: "settle.checked",
    effectId: 7,
    result: { status: "settled" },
  }).delivery;
  const republishing = run(
    verifiedRound(prOpen, receiptFor(fixed)).delivery,
    {
      type: "thread.launched",
      effectId: 9,
      threadId: freshReviewer,
      runId: freshReviewRun,
      worktreePath,
      baseline: fixed,
    },
    {
      type: "review.submitted",
      round: 2,
      threadId: freshReviewer,
      runId: freshReviewRun,
      judgment: passed(fixed, 2),
    },
    { type: "run.finished", threadId: freshReviewer, runId: freshReviewRun, status: "completed" },
    { type: "approval.recorded", effectId: 10, outcome: { type: "approved", evidencePath: "/a" } },
  ).delivery;
  const rounds: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
    ["awaiting the wake's run", adopted],
    ["stopping during the wake's run", advance(adopted, { type: "stop" }).delivery],
    ["verifying", verifying],
    ["republishing its approved commit", republishing],
    ["blocked", advance(adopted, wakeEnded("failed")).delivery],
    [
      "stopped",
      run(advance(adopted, { type: "stop" }).delivery, wakeEnded("completed"), {
        type: "settle.checked",
        effectId: 7,
        result: { status: "settled" },
      }).delivery,
    ],
  ];

  it.each(rounds)("closes a merge out while %s", (_, state) => {
    const step = advance(state, merged);
    const closeOut = { id: state.effectsIssued + 1, type: "close_out" } as const;
    expect(step).toEqual({
      delivery: {
        ...state,
        status: "pr_open",
        stage: "follow_through",
        pullRequest: { ...pullRequest, outcome: "merged" },
        awaiting: { type: "effect", effect: closeOut },
        effectsIssued: closeOut.id,
        block: null,
        checkpoint: null,
      },
      effects: [closeOut],
    });
    // What the round was doing no longer moves it: not the wake run's end, nor its PR result.
    for (const event of [
      wakeEnded("completed"),
      { type: "pr.opened", effectId: 11, pullRequest, watchedAfter: 300 } as const,
      wake({ runId: RunId.make("run-wake-2"), sequence: 400 }),
    ]) {
      expect(advance(step.delivery, event).delivery).toBe(step.delivery);
    }
    expect(
      advance(step.delivery, { type: "closed_out", effectId: closeOut.id }).delivery.status,
    ).toBe("done");
  });

  it.each(rounds)("cancels on a close without merging while %s", (_, state) => {
    expect(advance(state, closed)).toEqual({
      delivery: {
        ...state,
        status: "cancelled",
        stage: "follow_through",
        pullRequest: { ...pullRequest, outcome: "closed" },
        awaiting: null,
        block: null,
        checkpoint: null,
      },
      effects: [],
    });
  });
});
