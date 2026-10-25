import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryPlanTask,
  type FactoryReviewSummary,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { transitionComment } from "./comments.ts";
import { advance } from "./engine.ts";
import { isProceeding, queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryResumeCheck,
} from "./state.ts";

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const worktreePath = "/worktrees/item-7";

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
const children = [first, second];

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });
const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  run(delivery, ...events).delivery;
/** Every effect the events issue, in order. */
const issued = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce<{ delivery: FactoryDeliveryState; effects: FactoryEffect[] }>(
    (last, event) => {
      const next = advance(last.delivery, event);
      return { delivery: next.delivery, effects: [...last.effects, ...next.effects] };
    },
    { delivery, effects: [] },
  );

/** Asserts the event changes nothing: the very same state, and no effect. */
const ignores = (delivery: FactoryDeliveryState, event: FactoryEvent) => {
  const step = advance(delivery, event);
  expect(step.delivery).toBe(delivery);
  expect(step.effects).toEqual([]);
};

// The parent: planned (effect 1, the planner launch), approved (effect 2, create_children).
const creating = fold(
  queuedDeliveryState({ kind: "parent", branch: "fd/item-7", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath,
    baseline: "a".repeat(40),
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
        evidencePath: "/t3/userdata/fd-factory/d/plan.json",
      },
    },
  },
  { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
  { type: "plan.approved" },
);
const created: FactoryEvent = { type: "children.created", effectId: 2, children };
const started = (effectId: number): FactoryEvent => ({ type: "child.started", effectId });
const approvedChild = (deliveryId: FactoryDeliveryId): FactoryEvent => ({
  type: "child.approved",
  deliveryId,
});
const startChild = (id: number, child: FactoryDeliveryId) =>
  ({ id, type: "start_child", child }) as const;
/** What a resume of an approved parent finds; nothing of it decides where the parent goes. */
const check: FactoryResumeCheck = {
  deletedThreads: [],
  unrecordedAuthorRunEnded: false,
  worktree: null,
};
const resume: FactoryEvent = { type: "resume", check };

// Effect 3 starts the first child; the parent waits on it once the start is taken.
const startingFirst = fold(creating, created);
const onFirst = fold(startingFirst, started(3));
// Effect 4 starts the second, once the first reports its approval.
const startingSecond = fold(onFirst, approvedChild(first));
const onSecond = fold(startingSecond, started(4));

describe("a parent's per-child phase", () => {
  it("starts the first of two or more children with one effect, then waits on that child", () => {
    expect(creating.status).toBe("running");
    expect(creating.awaiting).toEqual({
      type: "effect",
      effect: { id: 2, type: "create_children" },
    });

    expect(advance(creating, created)).toEqual({
      delivery: {
        ...creating,
        stage: "author",
        children,
        effectsIssued: 3,
        awaiting: { type: "effect", effect: startChild(3, first) },
      },
      effects: [startChild(3, first)],
    } satisfies FactoryAdvance);
    // Nothing blocks as an unsupported stage there.
    expect(startingFirst.block).toBeNull();

    // The start's result: the parent waits on that child alone, issuing nothing.
    expect(advance(startingFirst, started(3))).toEqual({
      delivery: { ...startingFirst, awaiting: { type: "child", deliveryId: first } },
      effects: [],
    } satisfies FactoryAdvance);
  });

  it("stops a stopping parent where its first child would start", () => {
    const stopping = fold(creating, { type: "stop" });
    expect(stopping.status).toBe("stopping");
    expect(advance(stopping, created)).toEqual({
      delivery: { ...stopping, status: "stopped", awaiting: null, checkpoint: "author", children },
      effects: [],
    } satisfies FactoryAdvance);
  });

  it("takes only the start it awaits", () => {
    ignores(startingFirst, started(2));
    ignores(startingFirst, started(4));
    ignores(onFirst, started(3));
  });
});

describe("a parent waiting on a child", () => {
  it("starts the next child only once the one it waits on reports its approval", () => {
    expect(advance(onFirst, approvedChild(first))).toEqual({
      delivery: {
        ...onFirst,
        approvedChildren: [first],
        effectsIssued: 4,
        awaiting: { type: "effect", effect: startChild(4, second) },
      },
      effects: [startChild(4, second)],
    } satisfies FactoryAdvance);
    expect(onSecond.awaiting).toEqual({ type: "child", deliveryId: second });
  });

  it("enters the stage after its children once the last reports its approval", () => {
    const step = advance(onSecond, approvedChild(second));
    expect(step.delivery.approvedChildren).toEqual(children);
    // Integrate is not built yet, so the parent blocks there, never at its children.
    expect(step).toEqual({
      delivery: {
        ...onSecond,
        approvedChildren: children,
        stage: "integrate",
        status: "blocked",
        awaiting: null,
        block: { reason: "unsupported_stage", stage: "integrate" },
      },
      effects: [],
    } satisfies FactoryAdvance);
  });

  it("changes nothing for a child it does not wait on, or one it took already", () => {
    // The second child's result while it waits on the first, or before the first's start is taken.
    ignores(onFirst, approvedChild(second));
    ignores(startingFirst, approvedChild(second));
    ignores(startingFirst, approvedChild(first));
    // The first child's result again, before and after the second's start is taken.
    ignores(startingSecond, approvedChild(first));
    ignores(onSecond, approvedChild(first));
    // A child that is not the parent's at all.
    ignores(onFirst, approvedChild(FactoryDeliveryId.make("child-elsewhere")));
  });

  it("changes nothing once it no longer runs its stages", () => {
    for (const delivery of [
      fold(onFirst, { type: "cancel" }),
      fold(startingFirst, { type: "effect.failed", effectId: 3, detail: "No." }),
    ]) {
      ignores(delivery, approvedChild(first));
      ignores(delivery, started(3));
    }
  });

  it("blocks when its child cannot be started", () => {
    const failed = fold(startingFirst, { type: "effect.failed", effectId: 3, detail: "No." });
    expect(failed).toMatchObject({
      status: "blocked",
      stage: "author",
      awaiting: null,
      block: { reason: "effect_failed", effect: startChild(3, first), detail: "No." },
    });
  });

  it("goes on waiting while stopping, and stops where it would start the next child", () => {
    const stopping = fold(onFirst, { type: "stop" });
    expect(stopping.status).toBe("stopping");
    expect(advance(stopping, approvedChild(first))).toEqual({
      delivery: {
        ...stopping,
        status: "stopped",
        approvedChildren: [first],
        awaiting: null,
        checkpoint: "author",
      },
      effects: [],
    } satisfies FactoryAdvance);
    // After its last child, it stops where the stage after them would begin.
    const last = advance(fold(onSecond, { type: "stop" }), approvedChild(second));
    expect(last.delivery).toMatchObject({
      status: "stopped",
      stage: "author",
      checkpoint: "integrate",
      approvedChildren: children,
      awaiting: null,
      block: null,
    });
    expect(last.effects).toEqual([]);
  });
});

describe("resuming an approved parent with children", () => {
  it.each([
    ["stopped where it would start it", fold(onFirst, { type: "stop" }, approvedChild(first))],
    [
      "blocked on its start",
      fold(startingSecond, { type: "effect.failed", effectId: 4, detail: "No." }),
    ],
  ])("starts the first child without an approval when %s", (_name, delivery) => {
    expect(delivery.approvedChildren).toEqual([first]);
    expect(delivery.status === "stopped" || delivery.status === "blocked").toBe(true);
    const start = startChild(delivery.effectsIssued + 1, second);
    expect(advance(delivery, resume)).toEqual({
      delivery: {
        ...delivery,
        status: "running",
        stage: "author",
        block: null,
        checkpoint: null,
        effectsIssued: start.id,
        awaiting: { type: "effect", effect: start },
      },
      effects: [start],
    } satisfies FactoryAdvance);
  });

  it("starts its first child again when none reported an approval, and never creates any", () => {
    const blocked = fold(startingFirst, { type: "effect.failed", effectId: 3, detail: "No." });
    const step = advance(blocked, resume);
    expect(step.effects).toEqual([startChild(4, first)]);
    expect(step.delivery.children).toBe(blocked.children);
  });

  it("begins the stage after its children once every one reported its approval", () => {
    const blocked = fold(onSecond, approvedChild(second));
    const step = advance(blocked, resume);
    expect(step.delivery).toMatchObject({
      status: "blocked",
      stage: "integrate",
      block: { reason: "unsupported_stage", stage: "integrate" },
      approvedChildren: children,
    });
    expect(step.effects).toEqual([]);
    // Stopped there, it begins that stage too.
    const stopped = fold(onSecond, { type: "stop" }, approvedChild(second));
    expect(advance(stopped, resume).delivery).toMatchObject({
      stage: "integrate",
      block: { reason: "unsupported_stage", stage: "integrate" },
    });
  });

  it("creates its children again when it has none", () => {
    const blocked = fold(creating, { type: "effect.failed", effectId: 2, detail: "No." });
    expect(blocked.children).toEqual([]);
    expect(advance(blocked, resume).effects).toEqual([{ id: 3, type: "create_children" }]);
  });
});

// A child, as plan approval stores it: on the parent's branch and worktree, with its own limits.
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const head = "c".repeat(40);
const receipt = (code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha: head,
  tree: "d".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:01:00.000Z",
  code,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/child-a/verify-1.log",
  outputHash: "output-1",
});
const summary = (blocking: boolean): FactoryReviewSummary => ({
  headSha: head,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
});
const queuedChild = (kind: "child" | "single") =>
  queuedDeliveryState({
    kind,
    branch: "fd/item-7",
    baseRef: "main",
    worktreePath,
    limits: { maxFixRounds: 1, maxReviewRounds: 1 },
  });
const finished = (threadId: ThreadId, runId: RunId): FactoryEvent => ({
  type: "run.finished",
  threadId,
  runId,
  status: "completed",
});
const settled = (effectId: number): FactoryEvent => ({
  type: "settle.checked",
  effectId,
  result: { status: "settled" },
});
const verified = (effectId: number, code: number, fingerprint?: string): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome: {
    type: "receipt",
    receipt: receipt(code),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  },
});
const reviewed = (round: number, runId: RunId, blocking: boolean): FactoryEvent => ({
  type: "review.submitted",
  round,
  threadId: reviewer,
  runId,
  judgment: {
    type: "accepted",
    review: {
      source: "mcp",
      summary: summary(blocking),
      evidencePath: `/t3/userdata/fd-factory/child-a/review-${round}.json`,
      ...(blocking ? { fingerprint: `review-${round}` } : {}),
    },
  },
});

/**
 * Author, a failed verify and its fix-verify round, a blocking review and its fix-review round,
 * then a passing follow-up review: the record effect is the twelfth.
 */
const throughRecord: ReadonlyArray<FactoryEvent> = [
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath,
    baseline: "b".repeat(40),
  },
  finished(author, authorRun),
  settled(2),
  verified(3, 1, "verify-1"),
  { type: "turn.started", effectId: 4, runId: RunId.make("run-fix-verify") },
  finished(author, RunId.make("run-fix-verify")),
  settled(5),
  verified(6, 0),
  {
    type: "thread.launched",
    effectId: 7,
    threadId: reviewer,
    runId: RunId.make("run-review-1"),
    worktreePath,
    baseline: head,
  },
  reviewed(1, RunId.make("run-review-1"), true),
  finished(reviewer, RunId.make("run-review-1")),
  { type: "turn.started", effectId: 8, runId: RunId.make("run-fix-review") },
  finished(author, RunId.make("run-fix-review")),
  settled(9),
  verified(10, 0),
  { type: "turn.started", effectId: 11, runId: RunId.make("run-review-2") },
  reviewed(2, RunId.make("run-review-2"), false),
  finished(reviewer, RunId.make("run-review-2")),
];
const approvedAtRecord: FactoryEvent = {
  type: "approval.recorded",
  effectId: 12,
  outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/d/approval-a.json" },
};

describe("a child delivery", () => {
  it("runs author, verify, review and repair rounds on its own limits and fingerprints", () => {
    const { delivery, effects } = issued(queuedChild("child"), ...throughRecord);
    expect(effects.map((effect) => effect.type)).toEqual([
      "launch_thread",
      "check_settle",
      "run_command",
      "send_repair_turn",
      "check_settle",
      "run_command",
      "launch_thread",
      "send_repair_turn",
      "check_settle",
      "run_command",
      "send_review_follow_up_turn",
      "record_approval",
    ]);
    // Its author works in the parent's worktree, which it was stored with.
    expect(effects[0]).toMatchObject({
      role: "author",
      workspace: { type: "existing_worktree", worktreePath },
    });
    expect(delivery).toMatchObject({
      kind: "child",
      status: "running",
      stage: "record",
      rounds: { fix: 1, review: 1 },
      fingerprints: ["verify-1", "review-1"],
    });
  });

  it("ends approved at record without a pull request, stopping or not", () => {
    const recording = fold(queuedChild("child"), ...throughRecord);
    for (const delivery of [recording, fold(recording, { type: "stop" })]) {
      expect(advance(delivery, approvedAtRecord)).toEqual({
        delivery: { ...delivery, status: "approved", awaiting: null },
        effects: [],
      } satisfies FactoryAdvance);
    }
    const approved = fold(recording, approvedAtRecord);
    expect(approved.stage).toBe("record");
    expect(approved.pullRequest).toBeNull();
    // Nothing is left for the server to move on; a pull request result is no answer.
    expect(isProceeding(approved)).toBe(false);
    ignores(approved, {
      type: "pr.opened",
      effectId: 13,
      pullRequest: { number: 7, url: "https://example.test/pr/7", headBranch: "fd/item-7" },
    });
    ignores(approved, { type: "effect.failed", effectId: 12, detail: "No." });
    ignores(approved, { type: "resume", check: null });
  });

  it("still leaves a single item to open its pull request after record", () => {
    const step = advance(fold(queuedChild("single"), ...throughRecord), approvedAtRecord);
    expect(step.delivery).toMatchObject({ kind: "single", status: "approved", stage: "pr" });
    expect(step.effects).toEqual([{ id: 13, type: "open_pr" }]);
    expect(isProceeding(step.delivery)).toBe(true);
  });

  it("blocks on its own spent limits, not its parent's", () => {
    const strict = { ...queuedChild("child"), limits: { maxFixRounds: 0, maxReviewRounds: 0 } };
    expect(fold(strict, ...throughRecord.slice(0, 5))).toMatchObject({
      status: "blocked",
      block: { reason: "verify_failed" },
      fingerprints: ["verify-1"],
    });
  });

  it("resumes as a single item does, from its checkpoint", () => {
    const blocked = fold(queuedChild("child"), ...throughRecord, {
      type: "approval.recorded",
      effectId: 12,
      outcome: {
        type: "mismatch",
        expected: { headSha: head, tree: "d".repeat(40) },
        actual: { headSha: "e".repeat(40), tree: "f".repeat(40), clean: true },
        differences: ["head_changed", "tree_changed", "not_reviewed"],
      },
    });
    expect(blocked.block?.reason).toBe("record_mismatch");
    const step = advance(blocked, {
      type: "resume",
      check: {
        deletedThreads: [],
        unrecordedAuthorRunEnded: false,
        worktree: {
          settle: { status: "settled" },
          commit: { headSha: "e".repeat(40), tree: "f".repeat(40) },
          approvedSha: null,
        },
      },
    });
    expect(step.delivery).toMatchObject({ kind: "child", status: "running", stage: "verify" });
    expect(step.effects).toEqual([{ id: 13, type: "run_command", stage: "verify" }]);
  });

  it("announces its approval without promising a pull request of its own", () => {
    const recording = fold(queuedChild("child"), ...throughRecord);
    expect(transitionComment(recording, fold(recording, approvedAtRecord))).toEqual({
      status: "approved",
      body: `Factory approved commit ${head} for this item after verify and review.`,
    });
    const single = fold(queuedChild("single"), ...throughRecord);
    expect(transitionComment(single, fold(single, approvedAtRecord))?.body).toBe(
      `Factory approved commit ${head} for this item after verify and review, and is opening its pull request.`,
    );
  });
});
