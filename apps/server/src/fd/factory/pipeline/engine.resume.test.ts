import { RunId, ThreadId } from "@t3tools/contracts";
import type {
  FactoryDeliveryStatus,
  FactoryReviewSummary,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState, unrecordedAuthorLaunch } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryResumeCheck,
  FactoryReviewJudgment,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const fixRun = RunId.make("run-fix");
const repairRun = RunId.make("run-repair");
const worktreePath = "/worktrees/item-7";
const baseline = "b".repeat(40);
const head = "a".repeat(40);
const tree = "c".repeat(40);

const receipt = (code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha: head,
  tree,
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
const reviewerLaunched = (effectId: number): FactoryEvent => ({
  type: "thread.launched",
  effectId,
  threadId: reviewer,
  runId: reviewRun,
  worktreePath,
  baseline: head,
});
const submitted = (judgment: FactoryReviewJudgment): FactoryEvent => ({
  type: "review.submitted",
  round: 1,
  threadId: reviewer,
  runId: reviewRun,
  judgment,
});
const approvedAt = (effectId: number): FactoryEvent => ({
  type: "approval.recorded",
  effectId,
  outcome: { type: "approved", evidencePath: "/t3/approval-item.json" },
});
const turnStarted = (effectId: number, runId: RunId): FactoryEvent => ({
  type: "turn.started",
  effectId,
  runId,
});
const stop: FactoryEvent = { type: "stop" };

/** What a resume found: a settled branch at the last receipt's commit, unless told otherwise. */
const check = (
  worktree: Partial<NonNullable<FactoryResumeCheck["worktree"]>> = {},
  deletedThreads: ReadonlyArray<ThreadId> = [],
): FactoryResumeCheck => ({
  deletedThreads,
  unrecordedAuthorRunEnded: false,
  worktree: {
    settle: { status: "settled" },
    commit: { headSha: head, tree },
    approvedSha: null,
    ...worktree,
  },
});
const resumeWith = (found: FactoryResumeCheck | null): FactoryEvent => ({
  type: "resume",
  check: found,
});

const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });
const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  run(delivery, ...events).delivery;

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), record (5) and the PR (6).
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
const verifying = fold(authoring, finished(author, authorRun), settled(2));
const reviewing = fold(verifying, verified(3), reviewerLaunched(4));
const recording = fold(reviewing, submitted(accepted(false)), finished(reviewer, reviewRun));

const stoppedAtVerify = fold(authoring, stop, finished(author, authorRun), settled(2));
const stoppedAtReview = fold(verifying, stop, verified(3));
const stoppedAtRecord = fold(
  reviewing,
  stop,
  submitted(accepted(false)),
  finished(reviewer, reviewRun),
);
const stoppedAtRepair = fold(verifying, stop, verified(3, failing, "fp-1"));
const stoppedAtPr = fold(recording, stop, approvedAt(5));
const blockedInPr = fold(recording, approvedAt(5), {
  type: "effect.failed",
  effectId: 6,
  detail: "No.",
});
const blockedInVerify = fold(verifying, {
  type: "command.finished",
  effectId: 3,
  outcome: { type: "refused", refusals: ["tree_dirty"] },
});
const blockedAtLaunch = fold(
  queued,
  { type: "start" },
  {
    type: "effect.failed",
    effectId: 1,
    detail: "No.",
  },
);

describe("the fixtures", () => {
  it("stop and block where the tests say", () => {
    expect(
      [stoppedAtVerify, stoppedAtReview, stoppedAtRecord, stoppedAtRepair, stoppedAtPr].map(
        ({ status, checkpoint }) => [status, checkpoint],
      ),
    ).toEqual([
      ["stopped", "verify"],
      ["stopped", "review"],
      ["stopped", "record"],
      ["stopped", "repair"],
      ["stopped", "pr"],
    ]);
    expect(
      [blockedInPr, blockedInVerify, blockedAtLaunch].map(({ status, stage, block }) => [
        status,
        stage,
        block?.reason,
      ]),
    ).toEqual([
      ["blocked", "pr", "effect_failed"],
      ["blocked", "verify", "receipt_refused"],
      ["blocked", "author", "effect_failed"],
    ]);
  });
});

describe("resume a stopping delivery", () => {
  it("runs on awaiting the same run and issues nothing; the run's end then goes on", () => {
    const stopping = advance(authoring, stop).delivery;
    const step = advance(stopping, resumeWith(null));
    expect(step).toEqual({ delivery: authoring, effects: [] });

    // Its run's end gets the settle check, and a settled branch is verified, not stopped.
    const checking = advance(step.delivery, finished(author, authorRun));
    expect(checking.effects).toEqual([
      { id: 2, type: "check_settle", threadId: author, runId: authorRun },
    ]);
    const next = advance(checking.delivery, settled(2));
    expect(next.delivery.status).toBe("running");
    expect(next.effects).toEqual([{ id: 3, type: "run_command", stage: "verify" }]);
  });

  it("runs on awaiting the same effect, whose result then begins the next stage", () => {
    const stopping = advance(verifying, stop).delivery;
    const step = advance(stopping, resumeWith(null));
    expect(step).toEqual({ delivery: verifying, effects: [] });
    const next = advance(step.delivery, verified(3));
    expect(next.delivery.status).toBe("running");
    expect(next.effects.map(({ type }) => type)).toEqual(["launch_thread"]);
  });
});

describe("resume with a settled branch", () => {
  const cases: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
    ["stopped at verify", stoppedAtVerify],
    ["stopped at review", stoppedAtReview],
    ["stopped at record", stoppedAtRecord],
    ["stopped at a repair round", stoppedAtRepair],
    ["stopped at pr with no approval found", stoppedAtPr],
    ["blocked in verify", blockedInVerify],
  ];

  it.each(cases)("verifies a delivery %s again, keeping its history", (_, delivery) => {
    const command = { id: delivery.effectsIssued + 1, type: "run_command", stage: "verify" };
    expect(advance(delivery, resumeWith(check()))).toEqual({
      delivery: {
        ...delivery,
        status: "running",
        stage: "verify",
        block: null,
        checkpoint: null,
        fingerprints: [],
        effectsIssued: command.id,
        awaiting: { type: "effect", effect: command },
      },
      effects: [command],
    });
  });

  it("records a fresh receipt for the same commit, then reviews it", () => {
    const resumed = run(stoppedAtReview, resumeWith(check()), verified(4));
    expect(resumed.delivery.receipts).toEqual([passing, passing]);
    expect(resumed.delivery.stage).toBe("review");
    expect(resumed.delivery.reviewRound).toBe(1);
    expect(resumed.effects).toEqual([
      {
        id: 5,
        type: "launch_thread",
        role: "reviewer",
        workspace: { type: "existing_worktree", worktreePath },
      },
    ]);
  });

  it("follows a fix-review round with a turn on the same reviewer thread", () => {
    // Round 1 blocked, the author answered, and the delivery stopped once the branch settled.
    const answered = fold(
      reviewing,
      submitted(accepted(true)),
      finished(reviewer, reviewRun),
      turnStarted(5, repairRun),
      stop,
      finished(author, repairRun),
      settled(6),
    );
    expect(answered.status).toBe("stopped");
    expect(answered.rounds).toEqual({ fix: 0, review: 1 });

    const step = run(answered, resumeWith(check()), verified(7));
    expect(step.delivery.rounds).toEqual({ fix: 0, review: 0 });
    expect(step.effects).toEqual([
      { id: 8, type: "send_review_follow_up_turn", threadId: reviewer, round: 2 },
    ]);
  });
});

describe("resume into the PR stage", () => {
  const approved = check({ approvedSha: head });

  it.each([
    ["stopped at pr", stoppedAtPr],
    ["blocked in pr", blockedInPr],
  ] as const)("opens the pull request of a delivery %s on its approved commit", (_, delivery) => {
    const pr = { id: delivery.effectsIssued + 1, type: "open_pr" };
    const step = advance(delivery, resumeWith(approved));
    expect(step).toEqual({
      delivery: {
        ...delivery,
        status: "approved",
        stage: "pr",
        block: null,
        checkpoint: null,
        effectsIssued: pr.id,
        awaiting: { type: "effect", effect: pr },
      },
      effects: [pr],
    });
    // No receipt is added: the approval covers this very commit.
    expect(step.delivery.receipts).toEqual(delivery.receipts);
  });

  const differences: ReadonlyArray<readonly [string, FactoryResumeCheck]> = [
    ["HEAD moved", check({ commit: { headSha: "d".repeat(40), tree }, approvedSha: head })],
    [
      "the tree differs",
      check({ commit: { headSha: head, tree: "e".repeat(40) }, approvedSha: head }),
    ],
    ["the task has no approval", check({ approvedSha: null })],
    ["the task was approved for another commit", check({ approvedSha: "d".repeat(40) })],
    ["HEAD could not be read", check({ commit: null, approvedSha: head })],
  ];

  it.each(differences)("verifies and reviews again first when %s", (_, found) => {
    expect(advance(stoppedAtPr, resumeWith(found)).effects).toEqual([
      { id: 6, type: "run_command", stage: "verify" },
    ]);
  });

  it("takes the shortcut only from the PR stage", () => {
    expect(advance(stoppedAtRecord, resumeWith(approved)).effects).toEqual([
      { id: 5, type: "run_command", stage: "verify" },
    ]);
  });
});

describe("resume with an unsettled branch", () => {
  const problems = ["Worktree has uncommitted or untracked changes."];
  const dirty = check({ settle: { status: "repairable", problems } });

  it("sends one fix-commit turn naming the checkpoint, and blocks if it does not settle", () => {
    const turn = {
      id: 4,
      type: "send_fix_commit_turn",
      threadId: author,
      problems,
      checkpoint: "review",
    };
    const step = advance(stoppedAtReview, resumeWith(dirty));
    expect(step).toEqual({
      delivery: {
        ...stoppedAtReview,
        status: "running",
        stage: "repair",
        checkpoint: null,
        fixCommitTurns: 1,
        effectsIssued: 4,
        awaiting: { type: "effect", effect: turn },
      },
      effects: [turn],
    });

    // The turn's run ends and the branch is checked as after any author turn.
    const fixed = fold(step.delivery, turnStarted(4, fixRun), finished(author, fixRun));
    expect(fixed.awaiting).toEqual({
      type: "effect",
      effect: { id: 5, type: "check_settle", threadId: author, runId: fixRun },
    });
    expect(
      advance(fixed, {
        type: "settle.checked",
        effectId: 5,
        result: { status: "repairable", problems },
      }),
    ).toEqual({
      delivery: {
        ...fixed,
        status: "blocked",
        awaiting: null,
        block: { reason: "unsettled", problems },
      },
      effects: [],
    });
    // Settled, it is verified again.
    expect(advance(fixed, settled(5)).effects).toEqual([
      { id: 6, type: "run_command", stage: "verify" },
    ]);
  });

  it("names the stage a blocked delivery blocked in", () => {
    expect(advance(blockedInVerify, resumeWith(dirty)).effects).toEqual([
      { id: 4, type: "send_fix_commit_turn", threadId: author, problems, checkpoint: "verify" },
    ]);
  });

  it("blocks an unrepairable branch at once and keeps the checkpoint for a later resume", () => {
    const identity = ["Commit aaaaaaaaaaaa author identity names an AI agent, model or provider."];
    const step = advance(
      stoppedAtPr,
      resumeWith(
        check({ settle: { status: "unrepairable", problems: identity }, approvedSha: head }),
      ),
    );
    expect(step).toEqual({
      delivery: {
        ...stoppedAtPr,
        status: "blocked",
        awaiting: null,
        block: { reason: "unsettled", problems: identity },
      },
      effects: [],
    });
    // Once the owner repaired it outside Factory, a resume still finds the PR stage.
    expect(advance(step.delivery, resumeWith(check({ approvedSha: head }))).effects).toEqual([
      { id: 6, type: "open_pr" },
    ]);
  });
});

describe("resume without an author or with a deleted thread", () => {
  const firstLaunch = {
    id: 1,
    type: "launch_thread",
    role: "author",
    workspace: { type: "worktree", branch: "fd/item-7", baseRef: "main" },
  } as const;
  const nothingRecorded: FactoryResumeCheck = {
    deletedThreads: [],
    unrecordedAuthorRunEnded: false,
    worktree: null,
  };
  const runEnded: FactoryResumeCheck = { ...nothingRecorded, unrecordedAuthorRunEnded: true };
  const relaunched: FactoryEvent = {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath,
    baseline,
  };

  it("records the author launch as it issues it", () => {
    expect(authoring.authorLaunch).toEqual(firstLaunch);
    expect(blockedAtLaunch.authorLaunch).toEqual(firstLaunch);
    // A reviewer launch is not the author's.
    expect(reviewing.authorLaunch).toEqual(firstLaunch);
  });

  it("issues the author launch it never recorded again, under its own id", () => {
    // The launch may have gone through before its result was lost: under the same id it replays
    // that thread, run and worktree instead of starting a second author on the branch.
    expect(advance(blockedAtLaunch, resumeWith(nothingRecorded))).toEqual({
      delivery: {
        ...blockedAtLaunch,
        status: "running",
        stage: "author",
        block: null,
        awaiting: { type: "effect", effect: firstLaunch },
      },
      effects: [firstLaunch],
    });
  });

  it("awaits a replayed run still going, and blocks if it then fails", () => {
    const awaiting = fold(blockedAtLaunch, resumeWith(nothingRecorded), relaunched);
    expect(awaiting.threads).toEqual({ author });
    expect(awaiting.worktreePath).toBe(worktreePath);
    expect(awaiting.awaiting).toEqual({ type: "run", threadId: author, runId: authorRun });
    // Completed, its branch is settled as after any author turn.
    expect(advance(awaiting, finished(author, authorRun)).effects).toEqual([
      { id: 2, type: "check_settle", threadId: author, runId: authorRun },
    ]);
    // A failure after the resume is a failure like any other.
    expect(advance(awaiting, finished(author, authorRun, "failed")).delivery.block).toEqual({
      reason: "run_ended",
      threadId: author,
      runId: authorRun,
      runStatus: "failed",
    });
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "settles the branch a replayed run left once it had ended %s",
    (status) => {
      const replay = { ...firstLaunch, resumeCheckpoint: "author" };
      const resumed = advance(blockedAtLaunch, resumeWith(runEnded));
      expect(resumed.effects).toEqual([replay]);
      expect(resumed.delivery.authorLaunch).toEqual(firstLaunch);

      // Recorded, the author's branch is settled at once; the run's end that the worker read
      // with the launch's result is no news.
      const settling = fold(resumed.delivery, relaunched);
      const settle = {
        id: 2,
        type: "check_settle",
        threadId: author,
        runId: authorRun,
        checkpoint: "author",
      };
      expect(settling).toEqual({
        ...resumed.delivery,
        threads: { author },
        worktreePath,
        baseline,
        effectsIssued: 2,
        awaiting: { type: "effect", effect: settle },
      });
      expect(advance(settling, finished(author, authorRun, status)).delivery).toBe(settling);
      // Settled, it is verified afresh; with repairable problems, one turn names the checkpoint.
      expect(advance(settling, settled(2)).effects).toEqual([
        { id: 3, type: "run_command", stage: "verify" },
      ]);
      const problems = ["Worktree has uncommitted or untracked changes."];
      expect(
        advance(settling, {
          type: "settle.checked",
          effectId: 2,
          result: { status: "repairable", problems },
        }).effects,
      ).toEqual([
        { id: 3, type: "send_fix_commit_turn", threadId: author, problems, checkpoint: "author" },
      ]);
    },
  );

  it("launches the author as start does only when it never issued an author launch", () => {
    const delivery = {
      ...blockedAtLaunch,
      authorLaunch: null,
      block: { reason: "unsettled", problems: [] },
    } as const;
    const launch = { ...firstLaunch, id: 2 };
    const step = advance(delivery, resumeWith(nothingRecorded));
    expect(step.effects).toEqual([launch]);
    expect(step.delivery.authorLaunch).toEqual(launch);
  });

  it("stays blocked on every resume once the thread of its unrecorded launch is deleted", () => {
    const thread = ThreadId.make("factory-thread:delivery:1");
    const deleted = { ...nothingRecorded, deletedThreads: [thread] };
    const first = advance(blockedAtLaunch, resumeWith(deleted));
    expect(first).toEqual({
      delivery: { ...blockedAtLaunch, block: { reason: "thread_deleted", threadId: thread } },
      effects: [],
    });
    // The new block does not hide the launch, so the next resume still asks after its thread...
    expect(unrecordedAuthorLaunch(first.delivery)).toEqual(firstLaunch);
    const second = advance(first.delivery, resumeWith(deleted));
    expect(second.delivery).toEqual(first.delivery);
    expect(second.effects).toEqual([]);
    // ...and nothing it could find would launch another author: only the same launch, again.
    expect(advance(first.delivery, resumeWith(nothingRecorded)).effects).toEqual([firstLaunch]);
  });

  it("finds the launch in the block of a row stored before launches were recorded", () => {
    const thread = ThreadId.make("factory-thread:delivery:1");
    const stored = { ...blockedAtLaunch, authorLaunch: null };
    expect(advance(stored, resumeWith(nothingRecorded)).effects).toEqual([firstLaunch]);
    // A resume that blocks again records it, since the new block no longer names it.
    const blocked = advance(stored, resumeWith({ ...nothingRecorded, deletedThreads: [thread] }));
    expect(blocked.delivery.authorLaunch).toEqual(firstLaunch);
    expect(advance(blocked.delivery, resumeWith(nothingRecorded)).effects).toEqual([firstLaunch]);
  });

  it.each([
    ["the author", [author], author],
    ["the reviewer", [reviewer], reviewer],
    ["both, naming the author", [reviewer, author], author],
  ] as const)("blocks again when %s was deleted, launching nothing", (_, deleted, named) => {
    expect(advance(stoppedAtRecord, resumeWith(check({}, deleted)))).toEqual({
      delivery: {
        ...stoppedAtRecord,
        status: "blocked",
        awaiting: null,
        block: { reason: "thread_deleted", threadId: named },
      },
      effects: [],
    });
  });
});

// Owner decision: an explicit resume grants a fresh retry allowance. Rounds, fix-commit turns and
// fingerprints start over; the limits stay, and hold within the resumed attempt.
describe("a resume's retry allowance", () => {
  const repairOnce = (delivery: FactoryDeliveryState, from: number, runId: RunId) =>
    fold(delivery, turnStarted(from, runId), finished(author, runId), settled(from + 1));

  it("starts rounds and fingerprints over, and a repeated failure still stops the loop", () => {
    // Fix round 1 left the failure as it was: blocked as a repeated failure.
    const repeated = fold(
      repairOnce(fold(verifying, verified(3, failing, "fp-1")), 4, repairRun),
      verified(6, failing, "fp-1"),
    );
    expect(repeated.block).toEqual({ reason: "repeated_failure", stage: "verify" });
    expect(repeated.rounds).toEqual({ fix: 1, review: 0 });
    expect(repeated.fingerprints).toEqual(["fp-1"]);

    const resumed = advance(repeated, resumeWith(check())).delivery;
    expect(resumed.rounds).toEqual({ fix: 0, review: 0 });
    expect(resumed.fingerprints).toEqual([]);
    expect(resumed.fixCommitTurns).toBe(0);
    expect(resumed.limits).toEqual(repeated.limits);
    expect(resumed.receipts).toEqual(repeated.receipts);

    // The same failure earns a repair round again...
    const again = advance(resumed, verified(7, failing, "fp-1"));
    expect(again.effects).toEqual([
      { id: 8, type: "send_repair_turn", kind: "fix-verify", threadId: author, round: 1 },
    ]);
    // ...and failing the same way after it blocks within this attempt.
    const secondRun = RunId.make("run-repair-2");
    expect(
      fold(repairOnce(again.delivery, 8, secondRun), verified(10, failing, "fp-1")).block,
    ).toEqual({ reason: "repeated_failure", stage: "verify" });
  });

  it("keeps the limits the delivery started with", () => {
    const limits = { maxFixRounds: 1, maxReviewRounds: 2 };
    const exhausted = fold(
      repairOnce(fold({ ...verifying, limits }, verified(3, failing, "fp-a")), 4, repairRun),
      verified(6, failing, "fp-b"),
    );
    expect(exhausted.block).toEqual({ reason: "verify_failed" });

    const resumed = run(exhausted, resumeWith(check()), verified(7, failing, "fp-c"));
    expect(resumed.delivery.limits).toEqual(limits);
    expect(resumed.effects).toEqual([
      { id: 8, type: "send_repair_turn", kind: "fix-verify", threadId: author, round: 1 },
    ]);
    const secondRun = RunId.make("run-repair-2");
    expect(
      fold(repairOnce(resumed.delivery, 8, secondRun), verified(10, failing, "fp-d")).block,
    ).toEqual({ reason: "verify_failed" });
  });
});

describe("resume requests that change nothing", () => {
  const statuses: ReadonlyArray<FactoryDeliveryStatus> = [
    "queued",
    "running",
    "approved",
    "pr_open",
    "done",
    "cancelled",
  ];

  it.each(statuses)("leaves a %s delivery as it is", (status) => {
    const delivery = { ...authoring, status };
    const step = advance(delivery, resumeWith(check()));
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });

  it.each([
    ["stopped", stoppedAtReview],
    ["blocked", blockedInVerify],
  ] as const)("leaves a %s delivery as it is when nothing was read", (_, delivery) => {
    const step = advance(delivery, resumeWith(null));
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});
