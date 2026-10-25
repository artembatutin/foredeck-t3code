import { RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { planAtGate, queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryResumeCheck,
} from "./state.ts";

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");

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
const tasks = [task("export-csv"), task("export-header"), task("export-footer")];
const children = ["child-a", "child-b", "child-c"].map((id) => FactoryDeliveryId.make(id));

const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce((current, event) => advance(current, event).delivery, delivery);

const planning = fold(
  queuedDeliveryState({ kind: "parent", branch: "fd/item-7", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath: "/worktrees/item-7",
    baseline: "a".repeat(40),
  },
);
const waiting = fold(
  planning,
  {
    type: "plan.submitted",
    round: 1,
    threadId: planner,
    runId: planRun,
    judgment: {
      type: "accepted",
      plan: { tasks, source: "mcp", evidencePath: "/t3/userdata/fd-factory/d/plan.json" },
    },
  },
  { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
);

const approved: FactoryEvent = { type: "plan.approved" };
const createChildren = { id: 2, type: "create_children" } as const;
const creating = advance(waiting, approved).delivery;
const created = (effectId: number): FactoryEvent => ({
  type: "children.created",
  effectId,
  children,
});
const failed = (effectId: number): FactoryEvent => ({
  type: "effect.failed",
  effectId,
  detail: "Factory could not create the child items (WorkUnavailable).",
});
/** What a resume of an approved parent finds; nothing of it decides where the parent goes. */
const check = (deletedThreads: ReadonlyArray<ThreadId> = []): FactoryResumeCheck => ({
  deletedThreads,
  unrecordedAuthorRunEnded: false,
  worktree: null,
});
/** The first child's start, as the effect after `effectsIssued`. */
const startFirst = (effectsIssued: number) =>
  ({ id: effectsIssued + 1, type: "start_child", child: children[0]! }) as const;
/** A parent with its children that waits on the start of the first. */
const startingFirst = (effectsIssued: number) =>
  ({
    status: "running",
    stage: "author",
    children,
    effectsIssued: effectsIssued + 1,
    awaiting: { type: "effect", effect: startFirst(effectsIssued) },
  }) as const;

describe("a plan approval", () => {
  it("freezes the plan at the gate and asks for the children, running", () => {
    expect(advance(waiting, approved)).toEqual({
      delivery: {
        ...waiting,
        status: "running",
        planApproved: true,
        effectsIssued: 2,
        awaiting: { type: "effect", effect: createChildren },
      },
      effects: [createChildren],
    } satisfies FactoryAdvance);
    // Still at the gate's stage, with the plan it waited on.
    expect(creating.stage).toBe("approve_plan");
    expect(creating.plan).toBe(waiting.plan);
    expect(creating.children).toEqual([]);
  });

  it.each([
    ["approved", creating],
    ["with its children", fold(creating, created(2))],
  ])("takes no plan action again once %s", (_name, delivery) => {
    expect(planAtGate(delivery)).toBeUndefined();
    for (const event of [
      approved,
      { type: "plan.updated", tasks: [tasks[0]!] },
      { type: "plan.replanned", note: "Split it." },
      { type: "plan.rejected" },
    ] satisfies ReadonlyArray<FactoryEvent>) {
      const step = advance(delivery, event);
      expect(step.delivery).toBe(delivery);
      expect(step.effects).toEqual([]);
    }
  });

  it.each([
    ["planning", planning],
    ["stopped before the gate", fold(planning, { type: "stop" })],
    ["cancelled at the gate", fold(waiting, { type: "cancel" })],
    ["planning again after a replan", fold(waiting, { type: "plan.replanned", note: "Again." })],
  ])("changes nothing when %s", (_name, delivery) => {
    const step = advance(delivery, approved);
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});

describe("a parent's created children", () => {
  it("are recorded in plan order, and the parent starts the first", () => {
    expect(advance(creating, created(2))).toEqual({
      delivery: { ...creating, ...startingFirst(2) },
      effects: [startFirst(2)],
    } satisfies FactoryAdvance);
  });

  it("stop a stopping parent where its per-child phase would begin", () => {
    const stopping = fold(creating, { type: "stop" });
    expect(stopping.status).toBe("stopping");
    expect(advance(stopping, created(2)).delivery).toEqual({
      ...stopping,
      status: "stopped",
      awaiting: null,
      checkpoint: "author",
      children,
    });
  });

  it("change nothing when they answer another effect or the parent was cancelled", () => {
    for (const [delivery, event] of [
      [creating, created(3)],
      [fold(creating, { type: "cancel" }), created(2)],
    ] as const) {
      const step = advance(delivery, event);
      expect(step.delivery).toBe(delivery);
      expect(step.effects).toEqual([]);
    }
  });
});

describe("resuming an approved parent", () => {
  it("creates its children again after a failure, in a new effect", () => {
    const blocked = fold(creating, failed(2));
    expect(blocked.status).toBe("blocked");
    expect(blocked.block?.reason).toBe("effect_failed");
    const retry = { id: 3, type: "create_children" } as const;
    expect(advance(blocked, { type: "resume", check: check() })).toEqual({
      delivery: {
        ...blocked,
        status: "running",
        stage: "approve_plan",
        block: null,
        effectsIssued: 3,
        awaiting: { type: "effect", effect: retry },
      },
      effects: [retry],
    } satisfies FactoryAdvance);
    // The new effect's children are taken; the failed one's never are.
    const resumed = fold(blocked, { type: "resume", check: check() });
    expect(advance(resumed, created(2)).delivery).toBe(resumed);
    expect(advance(resumed, created(3)).delivery).toMatchObject(startingFirst(3));
  });

  it("is not held by its planner thread's deletion, which it no longer needs", () => {
    const blocked = fold(creating, { type: "thread.deleted", threadId: planner });
    expect(blocked.block).toEqual({ reason: "thread_deleted", threadId: planner });
    const step = advance(blocked, { type: "resume", check: check([planner]) });
    expect(step.delivery.status).toBe("running");
    expect(step.effects).toEqual([{ id: 3, type: "create_children" }]);
  });

  it.each([
    [
      "blocked at its per-child phase by an earlier server",
      {
        ...fold(creating, created(2)),
        effectsIssued: 2,
        awaiting: null,
        status: "blocked",
        block: { reason: "unsupported_stage", stage: "author" },
      } satisfies FactoryDeliveryState,
    ],
    ["stopped where that phase would begin", fold(creating, { type: "stop" }, created(2))],
  ])("with its children, starts the first without creating any when %s", (_name, delivery) => {
    const step = advance(delivery, { type: "resume", check: check() });
    expect(step).toEqual({
      delivery: { ...delivery, ...startingFirst(2), block: null, checkpoint: null },
      effects: [startFirst(2)],
    } satisfies FactoryAdvance);
  });
});
