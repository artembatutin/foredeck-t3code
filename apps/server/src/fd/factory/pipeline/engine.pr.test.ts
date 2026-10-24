import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { standardStages } from "./definitions.ts";
import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryOpenedPullRequest,
} from "./state.ts";
import { stageHandler } from "./stages/registry.ts";

const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const authorRun = RunId.make("run-author");
const reviewRun = RunId.make("run-review");
const worktreePath = "/worktrees/item-7";
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

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), record (5), then the PR effect (6) once record approves the task.
const RECORD = 5;
const OPEN_PR = 6;

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

const recording = run(
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
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
).delivery;

const approval: FactoryEvent = {
  type: "approval.recorded",
  effectId: RECORD,
  outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/delivery-1/approval.json" },
};
const entering = advance(recording, approval);
const opening = entering.delivery;

const pullRequest: FactoryOpenedPullRequest = {
  number: 42,
  url: "https://github.com/acme/alpha/pull/42",
  headBranch: "fd/item-7",
};
const opened = (effectId = OPEN_PR): FactoryEvent => ({ type: "pr.opened", effectId, pullRequest });
const prOpen = advance(opening, opened()).delivery;
const failed = (effectId = OPEN_PR): FactoryEvent => ({
  type: "effect.failed",
  effectId,
  detail: "Factory could not open the pull request (GitManagerError).",
});

describe("the PR stage kind", () => {
  it("is supported: pr opens the pull request, and follow-through blocks as unsupported", () => {
    const lookup = stageHandler("pr");
    if (lookup.type !== "supported") throw new Error("pr stages are supported");
    const approved = { ...recording, status: "approved" as const };

    const effect = { id: OPEN_PR, type: "open_pr" } as const;
    expect(lookup.handler.begin(approved, standardStages.pr)).toEqual({
      delivery: {
        ...approved,
        stage: "pr",
        effectsIssued: OPEN_PR,
        awaiting: { type: "effect", effect },
      },
      effects: [effect],
    });
    expect(lookup.handler.begin(approved, standardStages.follow_through)).toEqual({
      delivery: {
        ...approved,
        stage: "follow_through",
        status: "blocked",
        awaiting: null,
        block: { reason: "unsupported_stage", stage: "follow_through" },
      },
      effects: [],
    });
  });
});

describe("entering pr", () => {
  it("approves the task and issues one open_pr effect, the delivery approved at pr", () => {
    expect(recording.stage).toBe("record");
    expect(recording.status).toBe("running");
    const effect = { id: OPEN_PR, type: "open_pr" } as const;
    expect(entering).toEqual({
      delivery: {
        ...recording,
        status: "approved",
        stage: "pr",
        effectsIssued: OPEN_PR,
        awaiting: { type: "effect", effect },
      },
      effects: [effect],
    });
  });
});

describe("the PR result", () => {
  it("leaves the delivery pr_open with the pull request, awaiting nothing", () => {
    expect(advance(opening, opened())).toEqual({
      delivery: { ...opening, status: "pr_open", awaiting: null, pullRequest },
      effects: [],
    });
    expect(prOpen.stage).toBe("pr");
    expect(prOpen.block).toBeNull();
    expect(opening.pullRequest).toBeNull();
  });

  it("blocks naming the effect when the worker cannot open the pull request", () => {
    expect(advance(opening, failed())).toEqual({
      delivery: {
        ...opening,
        status: "blocked",
        awaiting: null,
        block: {
          reason: "effect_failed",
          effect: { id: OPEN_PR, type: "open_pr" },
          detail: "Factory could not open the pull request (GitManagerError).",
        },
      },
      effects: [],
    });
  });
});

describe("stale PR events", () => {
  const blockedState = advance(opening, failed()).delivery;
  it.each([
    ["a PR result naming the record effect", opening, opened(RECORD)],
    ["a PR result naming a later effect", opening, opened(OPEN_PR + 1)],
    ["a PR result while record runs", recording, opened(RECORD)],
    ["a repeated PR result once open", prOpen, opened()],
    ["a failure of the PR effect once open", prOpen, failed()],
    ["a PR result once blocked", blockedState, opened()],
    ["a failure naming another effect", opening, failed(RECORD)],
    ["a repeated record result", opening, approval],
    [
      "the reviewer run's end again",
      opening,
      { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "failed" },
    ],
    ["the author thread's deletion", opening, { type: "thread.deleted", threadId: author }],
    [
      "the author thread's deletion once open",
      prOpen,
      { type: "thread.deleted", threadId: author },
    ],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const result = advance(delivery, event);
    expect(result.delivery).toBe(delivery);
    expect(result.effects).toEqual([]);
  });
});

describe("PR steps", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it.each([
    ["an approval", recording, approval],
    ["a PR result", opening, opened()],
    ["a PR failure", opening, failed()],
  ] as const)("never mutate their input: %s", (_, state, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(state));
    const first = advance(input, deepFreeze(structuredClone(event)));
    expect(advance(structuredClone(state), structuredClone(event))).toEqual(first);
    expect(input).toEqual(state);
  });
});
