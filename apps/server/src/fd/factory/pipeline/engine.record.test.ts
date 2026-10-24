import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryRecordOutcome,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const worktreePath = "/worktrees/item-7";
const head = "a".repeat(40);
const tree = "c".repeat(40);

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: head,
  tree,
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

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), then the record effect (5) once the passing review's run completes.
const RECORD = 5;

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

const reviewed = run(
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
  { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
  {
    type: "thread.launched",
    effectId: 4,
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
        summary: {
          headSha: head,
          verdict: "pass",
          blocking: false,
          findings: { high: 0, medium: 0, low: 0 },
          reviewedAt: "2026-10-24T10:05:00.000Z",
        },
        evidencePath: "/t3/userdata/fd-factory/delivery-1/review-1.json",
      },
    },
  },
);
const entering = advance(reviewed.delivery, {
  type: "run.finished",
  threadId: reviewer,
  runId: reviewRun,
  status: "completed",
});
const recording = entering.delivery;

const approved: FactoryRecordOutcome = {
  type: "approved",
  evidencePath: "/t3/userdata/fd-factory/delivery-1/approval-item.json",
};
const mismatch: FactoryRecordOutcome = {
  type: "mismatch",
  expected: { headSha: head, tree },
  actual: { headSha: "d".repeat(40), tree: "e".repeat(40), clean: true },
  differences: ["head_changed", "tree_changed", "not_reviewed"],
};
const recorded = (outcome: FactoryRecordOutcome, effectId = RECORD): FactoryEvent => ({
  type: "approval.recorded",
  effectId,
  outcome,
});
const approvedState = advance(recording, recorded(approved)).delivery;

describe("entering record", () => {
  it("issues the record effect once the passing review's run completes", () => {
    const effect = { id: RECORD, type: "record_approval" } as const;
    expect(entering).toEqual({
      delivery: {
        ...reviewed.delivery,
        stage: "record",
        effectsIssued: RECORD,
        awaiting: { type: "effect", effect },
      },
      effects: [effect],
    });
    expect(recording.status).toBe("running");
  });
});

describe("the record result", () => {
  it("leaves an approved delivery at record, awaiting nothing", () => {
    expect(advance(recording, recorded(approved))).toEqual({
      delivery: { ...recording, status: "approved", awaiting: null },
      effects: [],
    });
    expect(approvedState.stage).toBe("record");
    expect(approvedState.block).toBeNull();
  });

  it("blocks on a mismatch with the expected and actual commit and what differed", () => {
    expect(advance(recording, recorded(mismatch))).toEqual({
      delivery: {
        ...recording,
        status: "blocked",
        awaiting: null,
        block: {
          reason: "record_mismatch",
          expected: { headSha: head, tree },
          actual: { headSha: "d".repeat(40), tree: "e".repeat(40), clean: true },
          differences: ["head_changed", "tree_changed", "not_reviewed"],
        },
      },
      effects: [],
    });
  });

  it("blocks when the worker cannot record the approval", () => {
    expect(advance(recording, { type: "effect.failed", effectId: RECORD, detail: "No." })).toEqual({
      delivery: {
        ...recording,
        status: "blocked",
        awaiting: null,
        block: {
          reason: "effect_failed",
          effect: { id: RECORD, type: "record_approval" },
          detail: "No.",
        },
      },
      effects: [],
    });
  });
});

describe("stale record events", () => {
  it.each([
    ["a record result naming another effect", recording, recorded(approved, RECORD - 1)],
    ["a record result naming a later effect", recording, recorded(mismatch, RECORD + 1)],
    [
      "a record result while the reviewer runs",
      reviewed.delivery,
      recorded(approved, reviewed.delivery.effectsIssued),
    ],
    ["a repeated record result once approved", approvedState, recorded(mismatch)],
    [
      "a record result once blocked on a mismatch",
      advance(recording, recorded(mismatch)).delivery,
      recorded(approved),
    ],
    [
      "the reviewer run's end again once approved",
      approvedState,
      { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
    ],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const result = advance(delivery, event);
    expect(result.delivery).toBe(delivery);
    expect(result.effects).toEqual([]);
  });
});

describe("record steps", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it.each([
    ["an approval", recorded(approved)],
    ["a mismatch", recorded(mismatch)],
  ] as const)("never mutate their input: %s", (_, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(recording));
    const first = advance(input, deepFreeze(structuredClone(event)));
    expect(advance(structuredClone(recording), structuredClone(event))).toEqual(first);
    expect(input).toEqual(recording);
  });
});
