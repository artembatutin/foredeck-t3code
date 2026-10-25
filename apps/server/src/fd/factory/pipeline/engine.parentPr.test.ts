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
import { isProceeding, queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryResumeCheck,
} from "./state.ts";

/**
 * A parent's record gate and pull request in the pure engine: a passing integrate review enters
 * record, which approves the whole branch's reviewed commit, and only then does the parent open
 * its one pull request. Its children end approved at their own record and open none.
 */

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const worktreePath = "/worktrees/fd-parent";
const branchStart = "a".repeat(40);
const head = "c".repeat(40);
const tree = "d".repeat(40);

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

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: head,
  tree,
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: "2026-10-25T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/parent/verify-1.log",
  outputHash: "output-1",
};
const summary: FactoryReviewSummary = {
  headSha: head,
  verdict: "pass",
  blocking: false,
  findings: { high: 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-25T10:05:00.000Z",
};

const reviewer = ThreadId.make("factory-thread:parent:6");
const reviewRun = RunId.make("run-integrate");
const reviewEnded: FactoryEvent = {
  type: "run.finished",
  threadId: reviewer,
  runId: reviewRun,
  status: "completed",
};

// Planned (effect 1), approved (2), both children started (3, 4) and approved, the branch
// verified (5) and its integrate reviewer launched (6), which submitted a passing review.
const reviewed = fold(
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
  { type: "command.finished", effectId: 5, outcome: { type: "receipt", receipt } },
  {
    type: "thread.launched",
    effectId: 6,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath,
    baseline: head,
  },
  {
    type: "review.submitted",
    round: 1,
    threadId: reviewer,
    runId: reviewRun,
    judgment: {
      type: "accepted",
      review: {
        source: "mcp",
        summary,
        evidencePath: "/t3/userdata/fd-factory/parent/review-1.json",
      },
    },
  },
);
const recording = fold(reviewed, reviewEnded);

const approved: FactoryEvent = {
  type: "approval.recorded",
  effectId: 7,
  outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/parent/approval.json" },
};
const moved = { headSha: "e".repeat(40), tree: "f".repeat(40), clean: true };
const mismatch: FactoryEvent = {
  type: "approval.recorded",
  effectId: 7,
  outcome: {
    type: "mismatch",
    expected: { headSha: head, tree },
    actual: moved,
    differences: ["head_changed", "tree_changed", "not_reviewed"],
  },
};
const pullRequest = { number: 7, url: "https://example.test/pr/7", headBranch: "work/fd-parent" };
const opened: FactoryEvent = { type: "pr.opened", effectId: 8, pullRequest };

const check: FactoryResumeCheck = {
  deletedThreads: [],
  unrecordedAuthorRunEnded: false,
  worktree: null,
};
const resume: FactoryEvent = { type: "resume", check };

describe("a parent's record gate", () => {
  it("records the integrate review's commit before the PR stage, opening nothing yet", () => {
    const record = { id: 7, type: "record_approval" } as const;
    expect(advance(reviewed, reviewEnded)).toEqual({
      delivery: {
        ...reviewed,
        stage: "record",
        effectsIssued: record.id,
        awaiting: { type: "effect", effect: record },
      },
      effects: [record],
    } satisfies FactoryAdvance);
    expect(recording.status).toBe("running");
    expect(recording.pullRequest).toBeNull();
  });

  it("blocks with record_mismatch naming both commits, and integrates afresh on resume", () => {
    const step = advance(recording, mismatch);
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "record",
      awaiting: null,
      pullRequest: null,
      block: {
        reason: "record_mismatch",
        expected: { headSha: head, tree },
        actual: moved,
        differences: ["head_changed", "tree_changed", "not_reviewed"],
      },
    });
    // No pull request opens on a resume: the branch is verified again, then reviewed afresh.
    expect(advance(step.delivery, resume).effects).toEqual([
      { id: 8, type: "run_command", stage: "verify" },
    ]);
  });

  it("stops a stopping parent where record would begin, and integrates again on resume", () => {
    const step = advance(fold(reviewed, { type: "stop" }), reviewEnded);
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      status: "stopped",
      stage: "integrate",
      checkpoint: "record",
      awaiting: null,
    });
    expect(advance(step.delivery, resume).effects).toEqual([
      { id: 7, type: "run_command", stage: "verify" },
    ]);
  });
});

describe("a parent's pull request", () => {
  it("is opened once record approves the branch, and recorded when the PR stage reports it", () => {
    const pr = { id: 8, type: "open_pr" } as const;
    const opening = advance(recording, approved);
    expect(opening).toEqual({
      delivery: {
        ...recording,
        status: "approved",
        stage: "pr",
        effectsIssued: pr.id,
        awaiting: { type: "effect", effect: pr },
      },
      effects: [pr],
    } satisfies FactoryAdvance);
    expect(isProceeding(opening.delivery)).toBe(true);

    const open = advance(opening.delivery, opened);
    expect(open).toEqual({
      delivery: { ...opening.delivery, status: "pr_open", awaiting: null, pullRequest },
      effects: [],
    } satisfies FactoryAdvance);
    // A repeated or late result changes nothing, so no second pull request is recorded.
    ignores(open.delivery, { ...opened, pullRequest: { ...pullRequest, number: 8 } });
    ignores(open.delivery, { type: "effect.failed", effectId: 8, detail: "Late." });
  });

  it("blocks on a failed PR effect with the pull request unrecorded", () => {
    const step = advance(fold(recording, approved), {
      type: "effect.failed",
      effectId: 8,
      detail: "Factory could not open the pull request (GitManagerError).",
    });
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "pr",
      pullRequest: null,
      block: { reason: "effect_failed", effect: { id: 8, type: "open_pr" } },
    });
  });

  it("stops a stopping parent where the PR stage would begin, and integrates again on resume", () => {
    const step = advance(fold(recording, { type: "stop" }), approved);
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({ status: "stopped", stage: "record", checkpoint: "pr" });
    expect(advance(step.delivery, resume).effects).toEqual([
      { id: 8, type: "run_command", stage: "verify" },
    ]);
  });
});

describe("a parent's child at its record", () => {
  const childAuthor = ThreadId.make("thread-child-author");
  const childReviewer = ThreadId.make("thread-child-reviewer");
  const childRecording = fold(
    queuedDeliveryState({ kind: "child", branch: "work/fd-parent", baseRef: "HEAD", worktreePath }),
    { type: "start", baseline: branchStart },
    {
      type: "thread.launched",
      effectId: 1,
      threadId: childAuthor,
      runId: RunId.make("run-child-author"),
      worktreePath,
      baseline: branchStart,
    },
    {
      type: "run.finished",
      threadId: childAuthor,
      runId: RunId.make("run-child-author"),
      status: "completed",
    },
    { type: "settle.checked", effectId: 2, result: { status: "settled" } },
    { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
    {
      type: "thread.launched",
      effectId: 4,
      threadId: childReviewer,
      runId: RunId.make("run-child-review"),
      worktreePath,
      baseline: head,
    },
    {
      type: "review.submitted",
      round: 1,
      threadId: childReviewer,
      runId: RunId.make("run-child-review"),
      judgment: {
        type: "accepted",
        review: { source: "mcp", summary, evidencePath: "/t3/userdata/fd-factory/a/review-1.json" },
      },
    },
    {
      type: "run.finished",
      threadId: childReviewer,
      runId: RunId.make("run-child-review"),
      status: "completed",
    },
  );

  it("ends approved with no pull request, issuing no PR effect, and takes no PR result", () => {
    expect(childRecording.stage).toBe("record");
    const step = advance(childRecording, {
      type: "approval.recorded",
      effectId: 5,
      outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/a/approval-a.json" },
    });
    expect(step.effects).toEqual([]);
    expect(step.delivery).toMatchObject({
      kind: "child",
      status: "approved",
      stage: "record",
      awaiting: null,
      pullRequest: null,
    });
    expect(isProceeding(step.delivery)).toBe(false);
    ignores(step.delivery, { type: "pr.opened", effectId: 6, pullRequest });
  });
});
