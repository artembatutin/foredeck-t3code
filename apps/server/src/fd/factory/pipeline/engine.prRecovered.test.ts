import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryPlanTask,
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
} from "./state.ts";

/**
 * A PR stage whose result a restart lost after its watch command, in the pure engine. The boot
 * sweep blocks the delivery on the interrupted effect, then recovers what the watch command's
 * records prove: the delivery records the pull request, the thread it is linked to and the watch,
 * as the result would have, and stays blocked. Anything else ignores the recovery.
 */

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const lastAuthor = ThreadId.make("factory-thread:child-b:1");
const reviewer = ThreadId.make("factory-thread:parent:6");
const reviewRun = RunId.make("run-integrate");
const worktreePath = "/worktrees/fd-parent";
const branchStart = "a".repeat(40);
const approved = "c".repeat(40);

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

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: approved,
  tree: `c${"e".repeat(39)}`,
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: "2026-10-26T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/parent/verify.log",
  outputHash: "output-1",
};

const pullRequest: FactoryOpenedPullRequest = {
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  headBranch: "work/fd-parent",
};

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
// the PR (8), whose watch command committed at position 100.
const WATCHED_AFTER = 100;
const STARTED_AT = "2026-10-26T10:06:00.000Z";

/** A parent whose integrate review passed, awaiting its PR stage. */
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
  { type: "command.finished", effectId: 5, outcome: { type: "receipt", receipt } },
  {
    type: "thread.launched",
    effectId: 6,
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
    judgment: {
      type: "accepted",
      review: {
        source: "mcp",
        summary: {
          headSha: approved,
          verdict: "pass",
          blocking: false,
          findings: { high: 0, medium: 0, low: 0 },
          reviewedAt: "2026-10-26T10:05:00.000Z",
        },
        evidencePath: "/t3/userdata/fd-factory/parent/review-1.json",
      },
    },
  },
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
  {
    type: "approval.recorded",
    effectId: 7,
    outcome: { type: "approved", evidencePath: "/t3/userdata/fd-factory/parent/approval.json" },
  },
).delivery;

const interrupted = "Factory could not open the pull request: a server restart interrupted it.";

/** The parent the boot blocked on its interrupted PR stage. */
const blocked = advance(opening, {
  type: "effect.failed",
  effectId: 8,
  detail: interrupted,
}).delivery;

const recovered: FactoryEvent = {
  type: "pr.recovered",
  effectId: 8,
  pullRequest,
  pullRequestThread: lastAuthor,
  watch: { firstAt: WATCHED_AFTER, at: WATCHED_AFTER + 4, armed: false, held: STARTED_AT },
};

describe("a PR stage result recovered from its watch command", () => {
  it("records the pull request, its thread and Factory's watch, and stays blocked", () => {
    expect(opening.awaiting).toEqual({ type: "effect", effect: { id: 8, type: "open_pr" } });
    expect(blocked.status).toBe("blocked");
    const step = advance(blocked, recovered);
    expect(step.effects).toEqual([]);
    expect(step.delivery).toEqual({
      ...blocked,
      pullRequest,
      pullRequestThread: lastAuthor,
      followThrough: {
        watchedAfter: WATCHED_AFTER,
        armedAt: WATCHED_AFTER + 4,
        watchStartedAt: STARTED_AT,
        heldUntil: null,
        runs: [],
        pending: [],
        watchEnded: false,
      },
    });
    // Resumed, it settles on that thread and verifies its branch again for integrate, awaiting
    // the PR stage no more; recorded, the watch is still marked for release by a cancel then.
    const resumed = advance(step.delivery, {
      type: "resume",
      check: {
        deletedThreads: [],
        unrecordedAuthorRunEnded: false,
        worktree: {
          settle: { status: "settled" },
          commit: { headSha: approved, tree: receipt.tree },
          approvedSha: null,
        },
      } satisfies FactoryResumeCheck,
    }).delivery;
    expect(resumed.status).toBe("running");
    expect(resumed.stage).toBe("verify");
    expect(resumed.awaiting).toEqual({
      type: "effect",
      effect: { id: 9, type: "run_command", stage: "verify" },
    });
    expect(resumed.block).toBeNull();
    expect(advance(resumed, { type: "cancel" }).delivery.releaseWatch).toBe(true);
    // Without the recovery, nothing there would mark it.
    const unrecovered = advance(blocked, {
      type: "resume",
      check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null },
    }).delivery;
    expect(unrecovered.stage).toBe("verify");
    expect(advance(unrecovered, { type: "cancel" }).delivery.releaseWatch).toBeUndefined();
  });

  it("is taken once: a recovery repeated, or of another effect, changes nothing", () => {
    ignores(advance(blocked, recovered).delivery, recovered);
    ignores(blocked, { ...recovered, effectId: 7 });
  });

  it("changes nothing for a delivery not blocked on that PR stage", () => {
    // Still awaiting the effect, its result may yet come.
    ignores(opening, recovered);
    // Blocked otherwise.
    ignores(
      advance(opening, {
        type: "pr.opened",
        effectId: 8,
        pullRequest,
        pullRequestThread: lastAuthor,
        watchFailure: "Factory opened pull request #7 but could not watch it for feedback.",
      }).delivery,
      recovered,
    );
    // Cancelled while blocked.
    ignores(advance(blocked, { type: "cancel" }).delivery, recovered);
  });
});
