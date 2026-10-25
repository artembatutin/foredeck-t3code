import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "./state.ts";

/**
 * A parent stored before planner launches recorded where its branch started: it takes a child's
 * approval only once it has that commit, which taking the child's start again establishes.
 */

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const branchStart = "a".repeat(40);
const [first, second] = ["child-a", "child-b"].map((id) => FactoryDeliveryId.make(id)) as [
  FactoryDeliveryId,
  FactoryDeliveryId,
];

const task = (id: string): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});

const fold = (delivery: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, delivery);

/** A parent waiting on its first child (effect 3 started it), of `ids` children. */
const waitingOnFirst = (ids: ReadonlyArray<FactoryDeliveryId>) =>
  fold(
    queuedDeliveryState({ kind: "parent", branch: "fd/item-7", baseRef: "main" }),
    { type: "start" },
    {
      type: "thread.launched",
      effectId: 1,
      threadId: planner,
      runId: planRun,
      worktreePath: "/worktrees/item-7",
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
          tasks: ids.map((_, index) => task(`task-${index + 1}`)),
          source: "mcp",
          evidencePath: "/t3/userdata/fd-factory/d/plan.json",
        },
      },
    },
    { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
    { type: "plan.approved" },
    { type: "children.created", effectId: 2, children: ids },
    { type: "child.started", effectId: 3 },
  );

describe("a parent without a recorded branch start", () => {
  it.each([
    ["one child", [first]],
    ["two children", [first, second]],
  ] as const)("with %s takes its child's start again before its approval", (_name, ids) => {
    const legacy = { ...waitingOnFirst(ids), baseline: null };
    const approval: FactoryEvent = { type: "child.approved", deliveryId: first };

    const retaking = advance(legacy, approval);
    expect(retaking.effects).toEqual([{ id: 4, type: "start_child", child: first }]);
    expect(retaking.delivery.approvedChildren).toEqual([]);
    expect(retaking.delivery.stage).toBe("author");

    // The start, taken with where the branch started, records it; then the approval is taken.
    const restarted = advance(retaking.delivery, {
      type: "child.started",
      effectId: 4,
      baseline: branchStart,
    });
    expect(restarted.delivery.baseline).toBe(branchStart);
    expect(restarted.delivery.awaiting).toEqual({ type: "child", deliveryId: first });
    const taken = advance(restarted.delivery, approval);
    expect(taken.delivery.approvedChildren).toEqual([first]);
    // Its only child taken, it begins integrate with a verify of the whole branch.
    expect(taken.delivery.stage).toBe(ids.length === 1 ? "verify" : "author");

    // A start that cannot be taken blocks it, with the approval not taken.
    const refused = advance(retaking.delivery, {
      type: "effect.failed",
      effectId: 4,
      detail: "Factory could not start the child delivery (FactoryChildStartError).",
    });
    expect(refused.delivery.status).toBe("blocked");
    expect(refused.delivery.approvedChildren).toEqual([]);
    expect(refused.delivery.baseline).toBeNull();
  });

  it("is not a parent that recorded it, which takes the approval at once", () => {
    const recorded = waitingOnFirst([first, second]);
    expect(recorded.baseline).toBe(branchStart);
    const taken = advance(recorded, { type: "child.approved", deliveryId: first });
    expect(taken.delivery.approvedChildren).toEqual([first]);
    expect(taken.effects).toEqual([{ id: 4, type: "start_child", child: second }]);
  });
});
