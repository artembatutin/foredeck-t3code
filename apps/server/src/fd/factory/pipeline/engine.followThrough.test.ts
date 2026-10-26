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
  FactoryWatchState,
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
const STARTED_AT = "2026-10-24T10:06:00.000Z";
const OWNERS = "2026-10-24T11:00:00.000Z";
/**
 * A PR stage's watch result: the delivery's first watch command at `WATCHED_AFTER`, this stage's
 * read or command at `at`, and the watch a Factory command started at `STARTED_AT` on.
 */
const watch = (at: number, armed = true, held: string | null = STARTED_AT): FactoryWatchState => ({
  firstAt: WATCHED_AFTER,
  at,
  armed,
  held,
});
/** Follow-through after the latest PR stage at `armedAt`, on the watch Factory started. */
const watched = (
  runs: ReadonlyArray<RunId> = [],
  pending: ReadonlyArray<RunId> = [],
  armedAt = WATCHED_AFTER,
) => ({
  watchedAfter: WATCHED_AFTER,
  armedAt,
  watchStartedAt: STARTED_AT as string | null,
  heldUntil: null as number | null,
  runs,
  pending,
  watchEnded: false,
});

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
  { type: "pr.opened", effectId: 6, pullRequest, watch: watch(WATCHED_AFTER) },
).delivery;

const wake = (overrides: Partial<Extract<FactoryEvent, { type: "pr.feedback" }>> = {}) =>
  ({
    type: "pr.feedback",
    kind: "feedback",
    threadId: author,
    runId: wakeRun,
    number: pullRequest.number,
    url: pullRequest.url,
    sequence: WATCHED_AFTER + 5,
    // Sent by the watch Factory started; its sync updated the link just before the run.
    watchStartedAt: STARTED_AT as string | null,
    linkSequence: WATCHED_AFTER + 4,
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
    expect(prOpen.followThrough).toEqual(watched());

    expect(advance(replied, wake())).toEqual({
      delivery: {
        ...replied,
        status: "running",
        stage: "follow_through",
        awaiting: { type: "run", threadId: author, runId: wakeRun },
        reviewResponse: null,
        followThrough: watched([wakeRun]),
      },
      effects: [],
    });
  });

  it("keeps a wake that comes while it runs a stage or waits on its owner, without a round", () => {
    const later = RunId.make("run-wake-2");
    for (const state of [
      adopted,
      advance(adopted, { type: "stop" }).delivery,
      { ...prOpen, status: "approved" as const },
      advance(adopted, wakeEnded("failed")).delivery,
      { ...prOpen, status: "stopped" as const },
    ]) {
      const followThrough = state.followThrough ?? watched();
      const step = advance(state, wake({ runId: later, sequence: WATCHED_AFTER + 9 }));
      expect(step.effects).toEqual([]);
      expect(step.delivery).toEqual({
        ...state,
        followThrough: {
          ...followThrough,
          runs: [...followThrough.runs, later],
          pending: [later],
        },
      });
      // Taken once: the same wake again changes nothing.
      const again = advance(step.delivery, wake({ runId: later, sequence: WATCHED_AFTER + 9 }));
      expect(again.delivery).toBe(step.delivery);
    }
  });

  it("takes no wake as a round once the delivery is done or cancelled, or closes out its merge", () => {
    const done = { ...prOpen, status: "done" as const };
    expect(advance(done, wake()).delivery).toBe(done);
    // Cancelled, it only owns the wake, so its run is stopped.
    const cancelled = { ...prOpen, status: "cancelled" as const };
    expect(advance(cancelled, wake())).toEqual({
      delivery: { ...cancelled, followThrough: watched([wakeRun]) },
      effects: [],
    });
    const closingOut = advance(prOpen, merged).delivery;
    expect(advance(closingOut, wake()).delivery).toBe(closingOut);
    // Its adopted wake again is no second round.
    expect(advance(adopted, wake()).delivery).toBe(adopted);
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
      { ...prOpen, followThrough: watched([wakeRun]) },
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
      watch: watch(200),
    }).delivery;
    expect(reopened).toEqual({
      ...recording.delivery,
      status: "pr_open",
      stage: "pr",
      awaiting: null,
      pullRequest,
      followThrough: watched([wakeRun], [], 200),
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
      { type: "pr.opened", effectId: 11, pullRequest, watch: watch(300) } as const,
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
        // The watch Factory started is to be released with it.
        releaseWatch: true,
      },
      effects: [],
    });
  });
});

describe("Factory engine: wakes that come during a round", () => {
  const later = RunId.make("run-wake-2");
  const laterWake = wake({ runId: later, sequence: WATCHED_AFTER + 9 });

  it("runs a wake queued behind the round's run before it judges the branch", () => {
    const queued = advance(adopted, laterWake).delivery;
    const next = advance(queued, wakeEnded("completed"));
    expect(next.effects).toEqual([]);
    expect(next.delivery).toEqual({
      ...queued,
      awaiting: { type: "run", threadId: author, runId: later },
      followThrough: watched([wakeRun, later]),
    });
    // Its end, not the first's, has the branch settled.
    const laterEnded = {
      type: "run.finished",
      threadId: author,
      runId: later,
      status: "completed",
    };
    expect(advance(next.delivery, laterEnded as FactoryEvent).effects).toEqual([
      { id: 7, type: "check_settle", threadId: author, runId: later },
    ]);
  });

  it("adopts a wake that came during review once the pull request is open again", () => {
    const reviewing = run(
      adopted,
      wakeEnded("completed"),
      { type: "settle.checked", effectId: 7, result: { status: "settled" } },
      {
        type: "command.finished",
        effectId: 8,
        outcome: { type: "receipt", receipt: receiptFor(fixed) },
      },
      {
        type: "thread.launched",
        effectId: 9,
        threadId: freshReviewer,
        runId: freshReviewRun,
        worktreePath,
        baseline: fixed,
      },
    ).delivery;
    const kept = advance(reviewing, laterWake).delivery;
    expect(kept.awaiting).toEqual(reviewing.awaiting);
    expect(kept.followThrough).toEqual(watched([wakeRun, later], [later]));

    const republishing = run(
      kept,
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
        outcome: { type: "approved", evidencePath: "/a" },
      },
    );
    expect(republishing.effects).toEqual([{ id: 11, type: "open_pr" }]);
    const reopened = advance(republishing.delivery, {
      type: "pr.opened",
      effectId: 11,
      pullRequest,
      watch: watch(200),
    });
    expect(reopened.effects).toEqual([]);
    expect(reopened.delivery).toEqual({
      ...republishing.delivery,
      status: "running",
      stage: "follow_through",
      awaiting: { type: "run", threadId: author, runId: later },
      reviewResponse: null,
      followThrough: watched([wakeRun, later], [], 200),
    });
  });

  it("takes a wake that only reports passing checks as its own, starting no round", () => {
    const passing = RunId.make("run-passing");
    const notice = wake({ kind: "notice", runId: passing });
    for (const state of [prOpen, adopted, { ...prOpen, status: "blocked" as const }]) {
      const followThrough = state.followThrough ?? watched();
      const step = advance(state, notice);
      expect(step).toEqual({
        delivery: {
          ...state,
          followThrough: { ...followThrough, runs: [...followThrough.runs, passing] },
        },
        effects: [],
      });
      expect(advance(step.delivery, notice).delivery).toBe(step.delivery);
    }
  });
});

describe("Factory engine: a watch core ended", () => {
  const endedRun = RunId.make("run-ended");
  // Core removed the watch in the sync at 102 that queued the end's run at 103.
  const ended = wake({
    kind: "ended",
    runId: endedRun,
    sequence: WATCHED_AFTER + 3,
    watchStartedAt: null,
    linkSequence: WATCHED_AFTER + 2,
  });

  it("blocks a delivery waiting on its pull request, owns the end's run, and takes it once", () => {
    const step = advance(prOpen, ended);
    expect(step).toEqual({
      delivery: {
        ...prOpen,
        status: "blocked",
        awaiting: null,
        block: { reason: "watch_ended" },
        // The watch Factory started ended there; the end's run is Factory's to cancel.
        followThrough: { ...watched([endedRun]), heldUntil: WATCHED_AFTER + 2, watchEnded: true },
      },
      effects: [],
    });
    expect(advance(step.delivery, ended).delivery).toBe(step.delivery);
    expect(step.delivery.followThrough?.pending).toEqual([]);
  });

  it("blocks at a PR stage that started no watch over an end, and only a new watch clears it", () => {
    const republishing = {
      ...prOpen,
      status: "approved" as const,
      awaiting: { type: "effect" as const, effect: { id: 11, type: "open_pr" as const } },
      effectsIssued: 11,
    };
    const flagged = { ...republishing, followThrough: { ...watched(), watchEnded: true } };
    const opened = (state: FactoryDeliveryState, result: FactoryWatchState) =>
      advance(state, { type: "pr.opened", effectId: 11, pullRequest, watch: result }).delivery;
    // The worker started none over the end it read: the delivery blocks where it would wait.
    const kept = opened(flagged, watch(200, false, null));
    expect(kept.status).toBe("blocked");
    expect(kept.block).toEqual({ reason: "watch_ended" });
    expect(kept.followThrough?.watchEnded).toBe(true);
    // With no end taken, a watch already on is followed as it is.
    expect(opened(republishing, watch(200, false)).status).toBe("pr_open");
    // A watch this stage started is the owner's resume, and clears the end.
    expect(opened(flagged, watch(200)).status).toBe("pr_open");
  });

  it("lets a running round finish, then blocks instead of waiting on the pull request", () => {
    const flagged = advance(adopted, ended).delivery;
    expect(flagged.status).toBe("running");
    expect(flagged.awaiting).toEqual(adopted.awaiting);
    expect(flagged.followThrough?.watchEnded).toBe(true);
    expect(flagged.followThrough?.runs).toEqual([wakeRun, endedRun]);
    // The worker starts no watch then, so the result carries none.
    const blockedAtOpen = advance(
      run(
        flagged,
        wakeEnded("completed"),
        { type: "settle.checked", effectId: 7, result: { status: "settled" } },
        {
          type: "command.finished",
          effectId: 8,
          outcome: { type: "receipt", receipt: receiptFor(approved) },
        },
        {
          type: "thread.launched",
          effectId: 9,
          threadId: freshReviewer,
          runId: freshReviewRun,
          worktreePath,
          baseline: approved,
        },
        {
          type: "review.submitted",
          round: 2,
          threadId: freshReviewer,
          runId: freshReviewRun,
          judgment: passed(approved, 2),
        },
        {
          type: "run.finished",
          threadId: freshReviewer,
          runId: freshReviewRun,
          status: "completed",
        },
        {
          type: "approval.recorded",
          effectId: 10,
          outcome: { type: "approved", evidencePath: "/a" },
        },
      ).delivery,
      // The worker started no watch over the end it took, and holds none.
      { type: "pr.opened", effectId: 11, pullRequest, watch: watch(300, false, null) },
    ).delivery;
    expect(blockedAtOpen.status).toBe("blocked");
    expect(blockedAtOpen.block).toEqual({ reason: "watch_ended" });
    expect(blockedAtOpen.pullRequest).toEqual(pullRequest);

    // A resume is the owner's decision to watch again: the PR stage runs, and its watch counts.
    const resumed = advance(
      blockedAtOpen,
      resume({
        worktree: {
          settle: { status: "settled" },
          commit: { headSha: approved, tree: receiptFor(approved).tree },
          approvedSha: approved,
        },
      }),
    );
    expect(resumed.effects).toEqual([{ id: 12, type: "open_pr" }]);
    expect(resumed.delivery.followThrough?.watchEnded).toBe(false);
    const reopened = advance(resumed.delivery, {
      type: "pr.opened",
      effectId: 12,
      pullRequest,
      watch: watch(400),
    }).delivery;
    expect(reopened.status).toBe("pr_open");
    expect(reopened.followThrough).toEqual(watched([wakeRun, endedRun], [], 400));
  });
});

describe("Factory engine: a pull request published whose watch could not start", () => {
  // The single item from the fixture, at its first PR stage, before `pr.opened`.
  const opening = run(
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
  ).delivery;
  const detail =
    "Factory opened pull request #42 but could not watch it for feedback (OrchestratorDispatchError).";
  const unwatched = advance(opening, {
    type: "pr.opened",
    effectId: 6,
    pullRequest,
    watchFailure: detail,
  }).delivery;

  it("records the pull request and blocks", () => {
    expect(opening.status).toBe("approved");
    expect(unwatched).toEqual({
      ...opening,
      status: "blocked",
      awaiting: null,
      pullRequest,
      block: { reason: "effect_failed", effect: { id: 6, type: "open_pr" }, detail },
    });
    expect(unwatched.followThrough).toBeUndefined();
  });

  it("takes that pull request's merge or close while blocked", () => {
    expect(advance(unwatched, closed).delivery.status).toBe("cancelled");
    const closing = advance(unwatched, merged);
    expect(closing.effects).toEqual([{ id: 7, type: "close_out" }]);
    expect(closing.delivery.status).toBe("pr_open");
  });

  it("resumes into the PR stage with the pull request still recorded", () => {
    const resumed = advance(
      unwatched,
      resume({
        worktree: {
          settle: { status: "settled" },
          commit: { headSha: approved, tree: receiptFor(approved).tree },
          approvedSha: approved,
        },
      }),
    );
    expect(resumed.effects).toEqual([{ id: 7, type: "open_pr" }]);
    expect(resumed.delivery.pullRequest).toEqual(pullRequest);
  });
});

describe("Factory engine: wakes and watches across a republish", () => {
  const later = RunId.make("run-wake-2");

  it("keeps the first watch's position, so a wake committed before a later one is taken", () => {
    // Republished: the latest watch command is at 200, the first one's stays at 100.
    const rearmed = { ...prOpen, followThrough: watched([wakeRun], [], 200) };
    const step = advance(rearmed, wake({ runId: later, sequence: 150 }));
    expect(step.delivery.awaiting).toEqual({ type: "run", threadId: author, runId: later });
    expect(step.delivery.followThrough).toEqual(watched([wakeRun, later], [], 200));
    // From before the first watch, it is nobody's to take.
    expect(advance(rearmed, wake({ runId: later, sequence: 90 })).delivery).toBe(rearmed);
  });

  it("takes which watch is Factory's, and its first watch's position, from the PR stage", () => {
    const republishing = {
      ...adopted,
      status: "approved" as const,
      awaiting: { type: "effect" as const, effect: { id: 11, type: "open_pr" as const } },
      effectsIssued: 11,
    };
    const opened = (result: FactoryWatchState) =>
      advance(republishing, { type: "pr.opened", effectId: 11, pullRequest, watch: result })
        .delivery.followThrough;
    expect(opened(watch(200, false))).toEqual(watched([wakeRun], [], 200));
    // The owner's watch, which the PR stage read on and left, is not Factory's.
    expect(opened(watch(200, false, null))).toEqual({
      ...watched([wakeRun], [], 200),
      watchStartedAt: null,
    });
    // A result that was never stored loses no position: the first watch's stays the first.
    const { followThrough: _, ...unwatched } = prOpen;
    const first = advance(
      {
        ...unwatched,
        status: "approved" as const,
        awaiting: { type: "effect" as const, effect: { id: 13, type: "open_pr" as const } },
        effectsIssued: 13,
      },
      { type: "pr.opened", effectId: 13, pullRequest, watch: watch(300, false) },
    ).delivery.followThrough;
    expect(first).toEqual(watched([], [], 300));
  });

  it("marks the watch for release on cancel, and a close's cancel, once a PR stage ran", () => {
    for (const event of [{ type: "cancel" } as const, closed]) {
      const cancelled = advance(adopted, event).delivery;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.releaseWatch).toBe(true);
      // Released while cancelled: nothing else changes.
      const released = advance(cancelled, { type: "watch.released" });
      const { releaseWatch: _, ...rest } = cancelled;
      expect(released.delivery).toEqual(rest);
      expect(advance(released.delivery, { type: "watch.released" }).delivery).toBe(
        released.delivery,
      );
    }
    // A PR stage still outstanding, or one whose result was lost, may have started one.
    const { followThrough: _, ...unwatched } = prOpen;
    const effect = { id: 6, type: "open_pr" as const };
    for (const state of [
      { ...unwatched, status: "approved" as const, awaiting: { type: "effect" as const, effect } },
      {
        ...unwatched,
        status: "blocked" as const,
        block: { reason: "effect_failed" as const, effect, detail: "lost" },
      },
    ]) {
      expect(advance(state, { type: "cancel" }).delivery.releaseWatch).toBe(true);
    }
    // Before any PR stage, there is nothing to release.
    const running = { ...unwatched, status: "running" as const };
    expect(advance(running, { type: "cancel" }).delivery.releaseWatch).toBeUndefined();
  });

  it("records where the watch Factory started ended, creating follow-through when it was lost", () => {
    const cancelled = advance(adopted, { type: "cancel" }).delivery;
    const end = { type: "watch.ended", startedAt: STARTED_AT, at: 250, firstAt: 90 } as const;
    const step = advance(cancelled, end);
    expect(step.effects).toEqual([]);
    expect(step.delivery).toEqual({
      ...cancelled,
      followThrough: { ...watched([wakeRun]), heldUntil: 250 },
    });
    expect(advance(step.delivery, end).delivery).toBe(step.delivery);
    // The PR stage's result was never stored: the watch's commands give the positions.
    const { followThrough: _, ...unwatched } = cancelled;
    expect(advance(unwatched, end).delivery.followThrough).toEqual({
      ...watched([], [], 90),
      watchedAfter: 90,
      heldUntil: 250,
    });
  });
});

describe("Factory engine: wakes a cancelled delivery takes", () => {
  const ownerRun = RunId.make("run-owner-wake");
  const endRun = RunId.make("run-end");
  const cancelled = advance(adopted, { type: "cancel" }).delivery;

  it("owns a wake the watch Factory started sent, and the end that removed it, nothing more", () => {
    const later = wake({ runId: ownerRun, sequence: WATCHED_AFTER + 20 });
    const step = advance(cancelled, later);
    expect(step).toEqual({
      delivery: { ...cancelled, followThrough: watched([wakeRun, ownerRun]) },
      effects: [],
    });
    const ended = advance(cancelled, {
      type: "watch.ended",
      startedAt: STARTED_AT,
      at: 300,
      firstAt: 100,
    }).delivery;
    const end = wake({
      kind: "ended",
      runId: endRun,
      sequence: 301,
      watchStartedAt: null,
      linkSequence: 300,
    });
    expect(advance(ended, end).delivery.followThrough?.runs).toEqual([wakeRun, endRun]);
    expect(advance(ended, end).delivery.status).toBe("cancelled");
    // Another watch's wake, another end, or any wake when it started no watch: not its own.
    for (const [state, event] of [
      [cancelled, wake({ runId: ownerRun, sequence: 120, watchStartedAt: OWNERS })],
      [ended, { ...end, linkSequence: 299 }],
      [cancelled, end],
      [{ ...cancelled, followThrough: { ...watched([wakeRun]), watchStartedAt: null } }, later],
    ] as const) {
      expect(advance(state, event).delivery).toBe(state);
    }
  });

  it("owns its watch's wake when the pull request it published was never recorded", () => {
    const { followThrough: _, ...unwatched } = cancelled;
    const lost = advance(
      { ...unwatched, pullRequest: null },
      { type: "watch.ended", startedAt: STARTED_AT, at: 300, firstAt: 100 },
    ).delivery;
    expect(advance(lost, wake()).delivery.followThrough?.runs).toEqual([wakeRun]);
  });
});

describe("Factory engine: a stop with a wake pending", () => {
  it("keeps the stop through the pending wake's run, and stops where verify would begin", () => {
    const later = RunId.make("run-wake-2");
    const stopping = run(adopted, wake({ runId: later, sequence: WATCHED_AFTER + 9 }), {
      type: "stop",
    }).delivery;
    expect(stopping.status).toBe("stopping");
    const waiting = advance(stopping, wakeEnded("completed")).delivery;
    expect(waiting.status).toBe("stopping");
    expect(waiting.awaiting).toEqual({ type: "run", threadId: author, runId: later });
    const settling = advance(waiting, {
      type: "run.finished",
      threadId: author,
      runId: later,
      status: "completed",
    });
    expect(settling.effects).toEqual([
      { id: 7, type: "check_settle", threadId: author, runId: later },
    ]);
    const stopped = advance(settling.delivery, {
      type: "settle.checked",
      effectId: 7,
      result: { status: "settled" },
    });
    expect(stopped.effects).toEqual([]);
    expect(stopped.delivery.status).toBe("stopped");
    expect(stopped.delivery.checkpoint).toBe("verify");
  });
});
