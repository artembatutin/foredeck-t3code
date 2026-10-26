import { RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { isProceeding, queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryOpenedPullRequest,
  FactoryResumeCheck,
} from "./state.ts";

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

const pullRequest: FactoryOpenedPullRequest = {
  number: 42,
  url: "https://github.com/acme/alpha/pull/42",
  headBranch: "fd/item-7",
};

// Effect ids, issued in order: the author launch (1), its settle check (2), verify (3), the
// reviewer launch (4), record (5), the PR (6), then the close-out (7) once the PR merges.
const CLOSE_OUT = 7;

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

/** A single item whose pull request is open, awaiting nothing. */
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
  {
    type: "approval.recorded",
    effectId: 5,
    outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/delivery-1/approval.json" },
  },
  { type: "pr.opened", effectId: 6, pullRequest },
).delivery;

const merged: FactoryEvent = { type: "pr.merged", number: 42, url: pullRequest.url };
const closed: FactoryEvent = { type: "pr.closed", number: 42, url: pullRequest.url };
const closedOut = (effectId = CLOSE_OUT): FactoryEvent => ({ type: "closed_out", effectId });
const closeOutFailed: FactoryEvent = {
  type: "effect.failed",
  effectId: CLOSE_OUT,
  detail: "Factory could not close out the merged pull request (WorkSourceUnavailable).",
};
const resume = (check: Partial<FactoryResumeCheck> = {}): FactoryEvent => ({
  type: "resume",
  check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null, ...check },
});

const closingOut = advance(prOpen, merged);

describe("Factory engine: a delivery whose pull request merged", () => {
  it("starts from an open pull request that awaits nothing", () => {
    expect(prOpen.status).toBe("pr_open");
    expect(prOpen.stage).toBe("pr");
    expect(prOpen.awaiting).toBeNull();
    expect(prOpen.pullRequest).toEqual(pullRequest);
    expect(isProceeding(prOpen)).toBe(false);
  });

  it("issues one close-out in follow-through, still pr_open, and is done once it reports", () => {
    const effect = { id: CLOSE_OUT, type: "close_out" } as const;
    expect(closingOut).toEqual({
      delivery: {
        ...prOpen,
        stage: "follow_through",
        pullRequest: { ...pullRequest, outcome: "merged" },
        effectsIssued: CLOSE_OUT,
        awaiting: { type: "effect", effect },
      },
      effects: [effect],
    });
    // The server moves it on by itself while the close-out runs.
    expect(isProceeding(closingOut.delivery)).toBe(true);

    expect(advance(closingOut.delivery, closedOut())).toEqual({
      delivery: { ...closingOut.delivery, status: "done", awaiting: null },
      effects: [],
    });
  });

  it("takes a merge once: a repeated merge, or a close, while closing out or done is inert", () => {
    const done = advance(closingOut.delivery, closedOut()).delivery;
    for (const state of [closingOut.delivery, done]) {
      for (const event of [merged, closed]) {
        const step = advance(state, event);
        expect(step.delivery).toBe(state);
        expect(step.effects).toEqual([]);
      }
    }
    // A stale or repeated close-out result changes nothing either.
    expect(advance(closingOut.delivery, closedOut(CLOSE_OUT - 1)).delivery).toBe(
      closingOut.delivery,
    );
    expect(advance(done, closedOut()).delivery).toBe(done);
    expect(advance(prOpen, closedOut()).delivery).toBe(prOpen);
  });

  it("blocks with the effect failure when the close-out fails, and a resume runs it again", () => {
    const blocked = advance(closingOut.delivery, closeOutFailed).delivery;
    expect(blocked).toEqual({
      ...closingOut.delivery,
      status: "blocked",
      awaiting: null,
      block: {
        reason: "effect_failed",
        effect: { id: CLOSE_OUT, type: "close_out" },
        detail: "Factory could not close out the merged pull request (WorkSourceUnavailable).",
      },
    });
    // Blocked, it takes no merge, and a late result of the failed close-out changes nothing.
    expect(advance(blocked, merged).delivery).toBe(blocked);
    expect(advance(blocked, closedOut()).delivery).toBe(blocked);

    // A resume closes out again, whatever it read of the threads and the worktree: neither is
    // used to finish a merged pull request.
    for (const check of [{}, { deletedThreads: [author] }]) {
      const again = advance(blocked, resume(check));
      const effect = { id: CLOSE_OUT + 1, type: "close_out" } as const;
      expect(again).toEqual({
        delivery: {
          ...blocked,
          status: "pr_open",
          block: null,
          effectsIssued: CLOSE_OUT + 1,
          awaiting: { type: "effect", effect },
        },
        effects: [effect],
      });
      expect(advance(again.delivery, closedOut(CLOSE_OUT + 1)).delivery.status).toBe("done");
      // The failed attempt's result is still stale.
      expect(advance(again.delivery, closedOut()).delivery).toBe(again.delivery);
    }
  });

  it("is cancelled by its owner while closing out, and the late result changes nothing", () => {
    const cancelled = advance(closingOut.delivery, { type: "cancel" }).delivery;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.awaiting).toBeNull();
    expect(advance(cancelled, closedOut()).delivery).toBe(cancelled);
  });
});

describe("Factory engine: a delivery whose pull request closed without merging", () => {
  it("ends cancelled in follow-through, awaiting nothing, with no effect", () => {
    expect(advance(prOpen, closed)).toEqual({
      delivery: {
        ...prOpen,
        status: "cancelled",
        stage: "follow_through",
        pullRequest: { ...pullRequest, outcome: "closed" },
        awaiting: null,
      },
      effects: [],
    });
  });

  it("takes a close once: a repeated close or a later merge is inert", () => {
    const cancelled = advance(prOpen, closed).delivery;
    for (const event of [closed, merged]) {
      expect(advance(cancelled, event).delivery).toBe(cancelled);
    }
  });
});

describe("Factory engine: merges and closes it does not take", () => {
  it("ignores another pull request's merge or close", () => {
    for (const type of ["pr.merged", "pr.closed"] as const) {
      for (const event of [
        { type, number: 43, url: pullRequest.url },
        { type, number: 42, url: "https://github.com/acme/beta/pull/42" },
      ]) {
        const step = advance(prOpen, event);
        expect(step.delivery).toBe(prOpen);
        expect(step.effects).toEqual([]);
      }
    }
  });

  it("ignores them in every other status, terminal ones included", () => {
    for (const status of ["running", "approved", "blocked", "done", "cancelled"] as const) {
      const state = { ...prOpen, status };
      for (const event of [merged, closed]) {
        const step = advance(state, event);
        expect(step.delivery).toBe(state);
        expect(step.effects).toEqual([]);
      }
    }
  });

  it("ignores them before a pull request is recorded", () => {
    const unrecorded = { ...prOpen, pullRequest: null };
    expect(advance(unrecorded, merged).delivery).toBe(unrecorded);
    expect(advance(unrecorded, closed).delivery).toBe(unrecorded);
  });
});

describe("Factory engine: a parent's merge and its children", () => {
  const children = [FactoryDeliveryId.make("child-1"), FactoryDeliveryId.make("child-2")];
  const parent: FactoryDeliveryState = {
    ...prOpen,
    kind: "parent",
    threads: { reviewer },
    children,
    approvedChildren: children,
  };

  it("closes a merged parent out like a single item, and cancels a closed one", () => {
    const closing = advance(parent, merged);
    expect(closing.effects).toEqual([{ id: CLOSE_OUT, type: "close_out" }]);
    expect(advance(closing.delivery, closedOut()).delivery.status).toBe("done");
    expect(advance(parent, closed).delivery.status).toBe("cancelled");
  });

  it("makes an approved child done once its parent is, and nothing else", () => {
    const child: FactoryDeliveryState = { ...prOpen, kind: "child", status: "approved" };
    expect(advance(child, { type: "parent.done" })).toEqual({
      delivery: { ...child, status: "done" },
      effects: [],
    });
    for (const state of [
      { ...child, status: "running" as const },
      { ...child, status: "cancelled" as const },
      { ...child, status: "done" as const },
      // A single item's own pull request carries its work.
      { ...child, kind: "single" as const },
    ]) {
      expect(advance(state, { type: "parent.done" }).delivery).toBe(state);
    }
  });
});
