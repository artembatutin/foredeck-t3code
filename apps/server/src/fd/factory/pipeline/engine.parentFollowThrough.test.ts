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
  FactoryEvent,
  FactoryOpenedPullRequest,
  FactoryResumeCheck,
  FactorySettleResult,
  FactoryWatchState,
} from "./state.ts";

/**
 * A parent's follow-through in the pure engine. Its pull request is linked to its last child's
 * author thread, which the parent records from its PR stage, and core's watch wakes that thread
 * with feedback. The parent adopts the wake's run as a round: the branch is settled on its
 * baseline, verified, reviewed by a fresh integrate reviewer and recorded, then republished to the
 * same pull request. Integrate has no repair round, so a failure blocks the parent.
 */

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const firstAuthor = ThreadId.make("factory-thread:child-a:1");
const lastAuthor = ThreadId.make("factory-thread:child-b:1");
const reviewer = ThreadId.make("factory-thread:parent:6");
const reviewRun = RunId.make("run-integrate");
const freshReviewer = ThreadId.make("factory-thread:parent:11");
const freshReviewRun = RunId.make("run-integrate-2");
const wakeRun = RunId.make("run-wake");
const worktreePath = "/worktrees/fd-parent";
const branchStart = "a".repeat(40);
const approved = "c".repeat(40);
const fixed = "d".repeat(40);

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

const receiptFor = (headSha: string, code = 0): FactoryVerifyReceipt => ({
  version: 1,
  headSha,
  tree: `${headSha.slice(0, 1)}${"e".repeat(39)}`,
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: "2026-10-26T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/parent/verify.log",
  outputHash: "output-1",
});

const summary = (headSha: string, blocking = false): FactoryReviewSummary => ({
  headSha,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-26T10:05:00.000Z",
});

/** The integrate reviewer's submission in `round`, of `headSha`. */
const reviewed = (
  threadId: ThreadId,
  runId: RunId,
  round: number,
  headSha: string,
  blocking = false,
): FactoryEvent => ({
  type: "review.submitted",
  round,
  threadId,
  runId,
  judgment: {
    type: "accepted",
    review: {
      source: "mcp",
      summary: summary(headSha, blocking),
      evidencePath: `/t3/userdata/fd-factory/parent/review-${round}.json`,
      ...(blocking ? { fingerprint: `fp-review-${round}` } : {}),
    },
  },
});

const pullRequest: FactoryOpenedPullRequest = {
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  headBranch: "work/fd-parent",
};

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

/** Asserts the event changes nothing: the very same state, and no effect. */
const ignores = (delivery: FactoryDeliveryState, event: FactoryEvent) => {
  const step = advance(delivery, event);
  expect(step.delivery).toBe(delivery);
  expect(step.effects).toEqual([]);
};

// Effect ids, issued in order: the planner launch (1), the children's creation (2), both
// children's starts (3, 4), the branch's verify (5), the integrate reviewer (6), record (7) and
// the PR (8), whose watch's command is at position 100.
const WATCHED_AFTER = 100;
const STARTED_AT = "2026-10-26T10:06:00.000Z";
const OWNERS = "2026-10-26T11:00:00.000Z";

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

/** A parent whose last child is approved and whose integrate review passed, opening its PR. */
const opening = run(
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
  { type: "child.approved", deliveryId: second },
  {
    type: "command.finished",
    effectId: 5,
    outcome: { type: "receipt", receipt: receiptFor(approved) },
  },
  {
    type: "thread.launched",
    effectId: 6,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath,
    baseline: approved,
  },
  reviewed(reviewer, reviewRun, 1, approved),
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
  {
    type: "approval.recorded",
    effectId: 7,
    outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/parent/approval.json" },
  },
).delivery;

const opened: FactoryEvent = {
  type: "pr.opened",
  effectId: 8,
  pullRequest,
  pullRequestThread: lastAuthor,
  watch: watch(WATCHED_AFTER),
};

/** The parent with its pull request open and watched on its last child's author thread. */
const prOpen = advance(opening, opened).delivery;

const wake = (overrides: Partial<Extract<FactoryEvent, { type: "pr.feedback" }>> = {}) =>
  ({
    type: "pr.feedback",
    kind: "feedback",
    threadId: lastAuthor,
    runId: wakeRun,
    number: pullRequest.number,
    url: pullRequest.url,
    sequence: WATCHED_AFTER + 5,
    // Sent by the watch Factory started; its sync updated the link just before the run.
    watchStartedAt: STARTED_AT as string | null,
    linkSequence: WATCHED_AFTER + 4,
    ...overrides,
  }) satisfies FactoryEvent;

const wakeEnded = (status: "completed" | "failed" | "interrupted" | "cancelled", runId = wakeRun) =>
  ({ type: "run.finished", threadId: lastAuthor, runId, status }) satisfies FactoryEvent;
const settleChecked = (effectId: number, result: FactorySettleResult): FactoryEvent => ({
  type: "settle.checked",
  effectId,
  result,
});
const verified = (effectId: number, headSha = fixed, code = 0): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: {
    type: "receipt",
    receipt: receiptFor(headSha, code),
    ...(code === 0 ? {} : { fingerprint: `fp-verify-${effectId}` }),
  },
});
const merged: FactoryEvent = {
  type: "pr.merged",
  number: pullRequest.number,
  url: pullRequest.url,
};
const closed: FactoryEvent = {
  type: "pr.closed",
  number: pullRequest.number,
  url: pullRequest.url,
};

/** The owner's resume, finding the branch as `settle` says, at the fix's commit. */
const resume = (
  settle: FactorySettleResult = { status: "settled" },
  deletedThreads: ReadonlyArray<ThreadId> = [],
): FactoryEvent => ({
  type: "resume",
  check: {
    deletedThreads,
    unrecordedAuthorRunEnded: false,
    worktree: {
      settle,
      commit: { headSha: fixed, tree: receiptFor(fixed).tree },
      approvedSha: null,
    },
  } satisfies FactoryResumeCheck,
});

const adopted = advance(prOpen, wake()).delivery;
/** The round after its run, awaiting the branch's verify (effect 10). */
const verifying = run(
  adopted,
  wakeEnded("completed"),
  settleChecked(9, { status: "settled" }),
).delivery;
/** The round's fresh integrate reviewer (effect 11), whose run is going. */
const integrating = run(verifying, verified(10), {
  type: "thread.launched",
  effectId: 11,
  threadId: freshReviewer,
  runId: freshReviewRun,
  worktreePath,
  baseline: fixed,
}).delivery;
const reviewEnded: FactoryEvent = {
  type: "run.finished",
  threadId: freshReviewer,
  runId: freshReviewRun,
  status: "completed",
};
/** The round's record (effect 12), after the fresh review passed the fix. */
const recording = run(
  integrating,
  reviewed(freshReviewer, freshReviewRun, 2, fixed),
  reviewEnded,
).delivery;
const recorded: FactoryEvent = {
  type: "approval.recorded",
  effectId: 12,
  outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/parent/approval.json" },
};
/** The round's PR stage (effect 13), republishing the newly approved commit. */
const republishing = advance(recording, recorded).delivery;

/** An approved child whose author thread is the one the parent's pull request is linked to. */
const lastChild: FactoryDeliveryState = {
  ...queuedDeliveryState({
    kind: "child",
    branch: "work/fd-parent",
    baseRef: "HEAD",
    worktreePath,
  }),
  status: "approved",
  stage: "record",
  baseline: approved,
  threads: { author: lastAuthor, reviewer: ThreadId.make("factory-thread:child-b:4") },
};

describe("a parent's pull request feedback", () => {
  it("records the thread its PR stage linked the pull request to", () => {
    expect(opening.status).toBe("approved");
    expect(opening.threads.author).toBeUndefined();
    expect(advance(opening, opened)).toEqual({
      delivery: {
        ...opening,
        status: "pr_open",
        awaiting: null,
        pullRequest,
        pullRequestThread: lastAuthor,
        followThrough: watched(),
      },
      effects: [],
    } satisfies FactoryAdvance);
    // A republish that names none keeps the thread recorded; a single item records none, since
    // its pull request is linked to its own author thread.
    const { pullRequestThread: _, ...unnamed } = opened as Extract<
      FactoryEvent,
      { type: "pr.opened" }
    >;
    expect(advance({ ...opening, pullRequestThread: lastAuthor }, unnamed).delivery).toEqual(
      prOpen,
    );
    const single = { ...opening, kind: "single" as const };
    expect(advance(single, opened).delivery).not.toHaveProperty("pullRequestThread");
  });

  it("adopts feedback on that thread for its open pull request as a round", () => {
    expect(advance(prOpen, wake())).toEqual({
      delivery: {
        ...prOpen,
        status: "running",
        stage: "follow_through",
        awaiting: { type: "run", threadId: lastAuthor, runId: wakeRun },
        followThrough: watched([wakeRun]),
      },
      effects: [],
    } satisfies FactoryAdvance);
    // Each run once.
    ignores(adopted, wake());
    ignores({ ...prOpen, followThrough: watched([wakeRun]) }, wake());
  });

  it("takes no wake of another thread, another pull request or from before its watch", () => {
    for (const event of [
      wake({ threadId: firstAuthor }),
      wake({ threadId: reviewer }),
      wake({ threadId: ThreadId.make("thread-owner") }),
      wake({ number: 8 }),
      wake({ url: "https://github.com/acme/beta/pull/7" }),
      wake({ sequence: WATCHED_AFTER }),
      wake({ sequence: WATCHED_AFTER - 1 }),
    ]) {
      ignores(prOpen, event);
    }
  });

  it("takes none without the thread recorded or the pull request watched", () => {
    const { pullRequestThread: _, ...storedBefore } = prOpen;
    const { followThrough: __, ...unwatched } = prOpen;
    for (const state of [storedBefore, unwatched, { ...prOpen, pullRequest: null }]) {
      ignores(state, wake());
    }
  });

  it("starts no round for a notice, and blocks for an end while it waits on its pull request", () => {
    const notice = wake({ kind: "notice", runId: RunId.make("run-passing") });
    expect(advance(prOpen, notice)).toEqual({
      delivery: { ...prOpen, followThrough: watched([RunId.make("run-passing")]) },
      effects: [],
    } satisfies FactoryAdvance);

    const endRun = RunId.make("run-ended");
    const ended = wake({
      kind: "ended",
      runId: endRun,
      sequence: WATCHED_AFTER + 3,
      watchStartedAt: null,
      linkSequence: WATCHED_AFTER + 2,
    });
    expect(advance(prOpen, ended)).toEqual({
      delivery: {
        ...prOpen,
        status: "blocked",
        awaiting: null,
        block: { reason: "watch_ended" },
        followThrough: { ...watched([endRun]), heldUntil: WATCHED_AFTER + 2, watchEnded: true },
      },
      effects: [],
    } satisfies FactoryAdvance);
  });

  it("leaves the approved child its thread names as it is", () => {
    for (const event of [
      wake(),
      wake({ kind: "notice" }),
      wake({ kind: "ended", watchStartedAt: null }),
      wakeEnded("completed"),
    ]) {
      ignores(lastChild, event);
    }
  });
});

describe("a parent's follow-through round", () => {
  it("settles on that thread, verifies, integrates afresh, records and republishes", () => {
    const settling = advance(adopted, wakeEnded("completed"));
    expect(settling.effects).toEqual([
      { id: 9, type: "check_settle", threadId: lastAuthor, runId: wakeRun },
    ]);
    const verifyingStep = advance(settling.delivery, settleChecked(9, { status: "settled" }));
    expect(verifyingStep.effects).toEqual([{ id: 10, type: "run_command", stage: "verify" }]);
    expect(verifyingStep.delivery.stage).toBe("verify");

    // A fresh receipt, then a fresh integrate reviewer in a new review round.
    const integratingStep = advance(verifyingStep.delivery, verified(10));
    expect(integratingStep.delivery.receipts).toEqual([receiptFor(approved), receiptFor(fixed)]);
    expect(integratingStep.delivery.stage).toBe("integrate");
    expect(integratingStep.delivery.reviewRound).toBe(2);
    expect(integratingStep.effects).toEqual([
      {
        id: 11,
        type: "launch_thread",
        role: "reviewer",
        workspace: { type: "existing_worktree", worktreePath },
      },
    ]);

    const recordingStep = run(
      integratingStep.delivery,
      {
        type: "thread.launched",
        effectId: 11,
        threadId: freshReviewer,
        runId: freshReviewRun,
        worktreePath,
        baseline: fixed,
      },
      reviewed(freshReviewer, freshReviewRun, 2, fixed),
      reviewEnded,
    );
    expect(recordingStep.effects).toEqual([{ id: 12, type: "record_approval" }]);

    const publishing = advance(recordingStep.delivery, recorded);
    expect(publishing.effects).toEqual([{ id: 13, type: "open_pr" }]);
    expect(publishing.delivery).toMatchObject({
      status: "approved",
      stage: "pr",
      // Recorded, so the PR stage pushes to it rather than open another.
      pullRequest,
      pullRequestThread: lastAuthor,
      threads: { planner, reviewer: freshReviewer },
    });

    const reopened = advance(publishing.delivery, {
      ...opened,
      effectId: 13,
      watch: watch(200, false),
    }).delivery;
    expect(reopened).toEqual({
      ...publishing.delivery,
      status: "pr_open",
      awaiting: null,
      followThrough: watched([wakeRun], [], 200),
    });
    // The next wake is the next round.
    const next = RunId.make("run-wake-2");
    expect(advance(reopened, wake({ runId: next, sequence: 201 })).delivery.awaiting).toEqual({
      type: "run",
      threadId: lastAuthor,
      runId: next,
    });
  });

  it("sends one fix-commit turn to that thread for a repairable branch, then blocks", () => {
    const problems = ["Commit 1234567 has no Conventional Commit subject."];
    const fixing = advance(
      advance(adopted, wakeEnded("completed")).delivery,
      settleChecked(9, { status: "repairable", problems }),
    );
    expect(fixing.effects).toEqual([
      { id: 10, type: "send_fix_commit_turn", threadId: lastAuthor, problems },
    ]);
    expect(fixing.delivery.fixCommitTurns).toBe(1);

    const fixRun = RunId.make("run-fix-commit");
    const settlingAgain = run(
      fixing.delivery,
      { type: "turn.started", effectId: 10, runId: fixRun },
      wakeEnded("completed", fixRun),
    );
    expect(settlingAgain.effects).toEqual([
      { id: 11, type: "check_settle", threadId: lastAuthor, runId: fixRun },
    ]);
    // Settled after the turn, the round goes on to verify.
    expect(
      advance(settlingAgain.delivery, settleChecked(11, { status: "settled" })).effects,
    ).toEqual([{ id: 12, type: "run_command", stage: "verify" }]);
    expect(
      advance(settlingAgain.delivery, settleChecked(11, { status: "repairable", problems }))
        .delivery,
    ).toMatchObject({
      status: "blocked",
      awaiting: null,
      block: { reason: "unsettled", problems },
    });
    // A branch that cannot be repaired blocks at once.
    expect(
      advance(
        advance(adopted, wakeEnded("completed")).delivery,
        settleChecked(9, { status: "unrepairable", problems }),
      ).delivery.block,
    ).toEqual({ reason: "unsettled", problems });
  });

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "blocks on a feedback run that ended %s",
    (status) => {
      expect(advance(adopted, wakeEnded(status))).toEqual({
        delivery: {
          ...adopted,
          status: "blocked",
          awaiting: null,
          block: { reason: "run_ended", threadId: lastAuthor, runId: wakeRun, runStatus: status },
        },
        effects: [],
      } satisfies FactoryAdvance);
    },
  );

  it("blocks when the thread its pull request is linked to is deleted during the round", () => {
    expect(advance(integrating, { type: "thread.deleted", threadId: lastAuthor }).delivery).toEqual(
      {
        ...integrating,
        status: "blocked",
        awaiting: null,
        block: { reason: "thread_deleted", threadId: lastAuthor },
      },
    );
    ignores(integrating, { type: "thread.deleted", threadId: firstAuthor });
  });
});

/**
 * Resumes the parent with a settled branch and walks the stages it then runs: a fresh verify, a
 * new integrate reviewer in a new review round and record, then the PR stage on the pull request
 * it recorded.
 */
const republishesAfterResume = (state: FactoryDeliveryState) => {
  const next = state.effectsIssued + 1;
  const resumed = advance(state, resume());
  expect(resumed.effects).toEqual([{ id: next, type: "run_command", stage: "verify" }]);
  expect(resumed.delivery).toMatchObject({
    status: "running",
    stage: "verify",
    block: null,
    checkpoint: null,
  });

  const launching = advance(resumed.delivery, verified(next));
  expect(launching.effects).toEqual([
    {
      id: next + 1,
      type: "launch_thread",
      role: "reviewer",
      workspace: { type: "existing_worktree", worktreePath },
    },
  ]);
  const round = launching.delivery.reviewRound;
  expect(round).toBe(state.reviewRound + 1);
  const resumedReviewer = ThreadId.make(`factory-thread:parent:${next + 1}`);
  const resumedRun = RunId.make(`run-integrate-${next + 1}`);
  const recordingStep = run(
    launching.delivery,
    {
      type: "thread.launched",
      effectId: next + 1,
      threadId: resumedReviewer,
      runId: resumedRun,
      worktreePath,
      baseline: fixed,
    },
    reviewed(resumedReviewer, resumedRun, round, fixed),
    { type: "run.finished", threadId: resumedReviewer, runId: resumedRun, status: "completed" },
  );
  expect(recordingStep.effects).toEqual([{ id: next + 2, type: "record_approval" }]);
  const publishing = advance(recordingStep.delivery, {
    ...recorded,
    effectId: next + 2,
  } as FactoryEvent);
  expect(publishing.effects).toEqual([{ id: next + 3, type: "open_pr" }]);
  expect(publishing.delivery).toMatchObject({ status: "approved", stage: "pr", pullRequest });
};

describe("a parent's follow-through round without a repair round", () => {
  const failedVerify = advance(verifying, verified(10, fixed, 1));
  const blockingReview = run(
    integrating,
    reviewed(freshReviewer, freshReviewRun, 2, fixed, true),
    reviewEnded,
  );

  it("blocks on a failed verify, sending no repair turn", () => {
    expect(failedVerify.effects).toEqual([]);
    expect(failedVerify.delivery).toEqual({
      ...verifying,
      status: "blocked",
      awaiting: null,
      receipts: [receiptFor(approved), receiptFor(fixed, 1)],
      block: { reason: "verify_failed" },
    });
  });

  it("blocks on a blocking integrate review, sending no repair turn", () => {
    expect(blockingReview.effects).toEqual([]);
    expect(blockingReview.delivery).toMatchObject({
      status: "blocked",
      stage: "integrate",
      awaiting: null,
      rounds: { fix: 0, review: 0 },
      block: { reason: "review_changes_required", summary: summary(fixed, true) },
    });
  });

  // A stopping parent finishes the step it is in, and stops where the next stage would begin.
  const stoppedAt: ReadonlyArray<readonly [string, FactoryAdvance]> = [
    [
      "verify",
      run(
        advance(adopted, { type: "stop" }).delivery,
        wakeEnded("completed"),
        settleChecked(9, { status: "settled" }),
      ),
    ],
    ["integrate", run(advance(verifying, { type: "stop" }).delivery, verified(10))],
    [
      "record",
      run(
        advance(integrating, { type: "stop" }).delivery,
        reviewed(freshReviewer, freshReviewRun, 2, fixed),
        reviewEnded,
      ),
    ],
    ["pr", advance(advance(recording, { type: "stop" }).delivery, recorded)],
  ];

  it.each(stoppedAt)("stops where %s would begin", (checkpoint, step) => {
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({ status: "stopped", awaiting: null, checkpoint });
  });

  const resumable: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
    ["a failed verify", failedVerify.delivery],
    ["a blocking integrate review", blockingReview.delivery],
    ["a feedback run that failed", advance(adopted, wakeEnded("failed")).delivery],
    ...stoppedAt.map(
      ([checkpoint, step]) => [`a stop before ${checkpoint}`, step.delivery] as const,
    ),
  ];

  it.each(resumable)(
    "resumes from %s with a fresh verify and integrate, then republishes",
    (_, state) => {
      republishesAfterResume(state);
    },
  );

  it("resumes an unsettled branch with one fix-commit turn on that thread, naming the checkpoint", () => {
    const problems = ["The worktree has uncommitted changes."];
    const step = advance(failedVerify.delivery, resume({ status: "repairable", problems }));
    expect(step.effects).toEqual([
      {
        id: 11,
        type: "send_fix_commit_turn",
        threadId: lastAuthor,
        problems,
        checkpoint: "verify",
      },
    ]);
    expect(step.delivery).toMatchObject({ status: "running", stage: "repair", fixCommitTurns: 1 });
    expect(
      advance(failedVerify.delivery, resume({ status: "unrepairable", problems })).delivery,
    ).toMatchObject({ status: "blocked", block: { reason: "unsettled", problems } });
    // That thread deleted, there is nowhere for a round's turn to go; other threads do not hold it.
    expect(advance(failedVerify.delivery, resume(undefined, [lastAuthor])).delivery.block).toEqual({
      reason: "thread_deleted",
      threadId: lastAuthor,
    });
    expect(advance(failedVerify.delivery, resume(undefined, [reviewer, planner])).effects).toEqual([
      { id: 11, type: "run_command", stage: "verify" },
    ]);
  });

  it("watches its pull request again on resume after core's watch ended", () => {
    const ended = advance(
      prOpen,
      wake({ kind: "ended", watchStartedAt: null, linkSequence: WATCHED_AFTER + 2 }),
    ).delivery;
    expect(ended.block).toEqual({ reason: "watch_ended" });
    const step = advance(ended, resume());
    expect(step.effects).toEqual([{ id: 9, type: "run_command", stage: "verify" }]);
    expect(step.delivery.followThrough?.watchEnded).toBe(false);
  });
});

describe("a parent's wakes, cancel and pull request during a round", () => {
  const later = RunId.make("run-wake-2");
  const laterWake = wake({ runId: later, sequence: WATCHED_AFTER + 9 });

  it("keeps a wake that comes during integrate pending, and adopts it once the pull request is open", () => {
    const kept = advance(integrating, laterWake);
    expect(kept.effects).toEqual([]);
    expect(kept.delivery).toEqual({
      ...integrating,
      followThrough: watched([wakeRun, later], [later]),
    });

    const publishing = run(
      kept.delivery,
      reviewed(freshReviewer, freshReviewRun, 2, fixed),
      reviewEnded,
      recorded,
    ).delivery;
    expect(publishing.status).toBe("approved");
    const reopened = advance(publishing, { ...opened, effectId: 13, watch: watch(200, false) });
    expect(reopened.effects).toEqual([]);
    expect(reopened.delivery).toEqual({
      ...publishing,
      status: "running",
      stage: "follow_through",
      awaiting: { type: "run", threadId: lastAuthor, runId: later },
      followThrough: watched([wakeRun, later], [], 200),
    });
  });

  it("keeps a wake that comes while it waits on its owner, or republishes", () => {
    for (const state of [
      republishing,
      advance(adopted, wakeEnded("failed")).delivery,
      run(advance(verifying, { type: "stop" }).delivery, verified(10)).delivery,
    ]) {
      const step = advance(state, laterWake);
      expect(step.delivery).toEqual({
        ...state,
        followThrough: watched([wakeRun, later], [later]),
      });
      ignores(step.delivery, laterWake);
    }
  });

  it("runs a wake queued behind the round's run before it judges the branch", () => {
    const next = advance(advance(adopted, laterWake).delivery, wakeEnded("completed"));
    expect(next.effects).toEqual([]);
    expect(next.delivery.awaiting).toEqual({ type: "run", threadId: lastAuthor, runId: later });
    expect(advance(next.delivery, wakeEnded("completed", later)).effects).toEqual([
      { id: 9, type: "check_settle", threadId: lastAuthor, runId: later },
    ]);
  });

  it("marks its watch for release on a cancel once a PR stage ran, and not before", () => {
    for (const state of [opening, prOpen, adopted, integrating, republishing]) {
      const cancelled = advance(state, { type: "cancel" });
      expect(cancelled.effects).toEqual([]);
      expect(cancelled.delivery).toMatchObject({
        status: "cancelled",
        awaiting: null,
        releaseWatch: true,
      });
    }
    // Integrating before its first PR stage, it has no watch to release.
    const { followThrough: _, pullRequestThread: __, ...unwatched } = integrating;
    const beforePr = { ...unwatched, pullRequest: null };
    expect(advance(beforePr, { type: "cancel" }).delivery.releaseWatch).toBeUndefined();
    // Its child opens no pull request, and has none of its own to release.
    expect(
      advance({ ...lastChild, status: "running" as const }, { type: "cancel" }).delivery
        .releaseWatch,
    ).toBeUndefined();
  });

  it("takes only the wakes Factory's watch sent once cancelled, and revives nothing", () => {
    const cancelled = advance(adopted, { type: "cancel" }).delivery;
    const ownerRun = RunId.make("run-owner-wake");
    const step = advance(cancelled, wake({ runId: ownerRun, sequence: WATCHED_AFTER + 20 }));
    expect(step).toEqual({
      delivery: { ...cancelled, followThrough: watched([wakeRun, ownerRun]) },
      effects: [],
    } satisfies FactoryAdvance);
    for (const event of [
      // Another watch's wake, another pull request's, another thread's.
      wake({ runId: ownerRun, sequence: 120, watchStartedAt: OWNERS }),
      wake({ runId: ownerRun, sequence: 120, number: 8 }),
      wake({ runId: ownerRun, sequence: 120, threadId: firstAuthor }),
      // An end, until the release found where Factory's watch ended.
      wake({ kind: "ended", runId: ownerRun, sequence: 120, watchStartedAt: null }),
    ]) {
      ignores(cancelled, event);
    }
    // The end that removed Factory's watch, at the link update the release found.
    const released = advance(cancelled, {
      type: "watch.ended",
      startedAt: STARTED_AT,
      at: 300,
      firstAt: WATCHED_AFTER,
      number: pullRequest.number,
      url: pullRequest.url,
    }).delivery;
    const end = wake({
      kind: "ended",
      runId: ownerRun,
      sequence: 301,
      watchStartedAt: null,
      linkSequence: 300,
    });
    expect(advance(released, end).delivery).toMatchObject({
      status: "cancelled",
      awaiting: null,
      followThrough: { runs: [wakeRun, ownerRun], pending: [] },
    });
  });

  const rounds: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
    ["awaiting the wake's run", adopted],
    ["stopping during the wake's run", advance(adopted, { type: "stop" }).delivery],
    ["verifying", verifying],
    ["integrating", integrating],
    ["recording", recording],
    ["republishing its approved commit", republishing],
    ["blocked", advance(adopted, wakeEnded("failed")).delivery],
    ["stopped", run(advance(verifying, { type: "stop" }).delivery, verified(10)).delivery],
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
    } satisfies FactoryAdvance);
    // What the round was doing no longer moves it.
    for (const event of [
      wakeEnded("completed"),
      reviewEnded,
      { ...opened, effectId: 13 },
      wake({ runId: RunId.make("run-wake-3"), sequence: 400 }),
    ]) {
      ignores(step.delivery, event);
    }
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
        releaseWatch: true,
      },
      effects: [],
    } satisfies FactoryAdvance);
  });

  it("is done once its merge is closed out, and then its approved children are", () => {
    const closingOut = advance(integrating, merged).delivery;
    const done = advance(closingOut, {
      type: "closed_out",
      effectId: closingOut.effectsIssued,
    }).delivery;
    expect(done.status).toBe("done");
    expect(done.children).toEqual([first, second]);
    expect(done.approvedChildren).toEqual([first, second]);
    // Its round left the child as it was; its close-out makes the child done with it.
    expect(advance(lastChild, { type: "parent.done" })).toEqual({
      delivery: { ...lastChild, status: "done" },
      effects: [],
    } satisfies FactoryAdvance);
  });
});
