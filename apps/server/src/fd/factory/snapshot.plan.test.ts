import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryPlanTask,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import type { FactoryDeliveryWithRuns } from "./FactoryService.ts";
import { transitionComment } from "./pipeline/comments.ts";
import {
  type FactoryBlock,
  type FactoryDeliveryState,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import { toFactoryDelivery } from "./snapshot.ts";

const planner = ThreadId.make("thread-planner");

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

const planning: FactoryDeliveryState = {
  ...queuedDeliveryState({ kind: "parent", branch: "work/fd-aaaaaa-export", baseRef: "HEAD" }),
  status: "running",
  stage: "plan",
  worktreePath: "/worktrees/fd-aaaaaa",
  threads: { planner },
  awaiting: { type: "run", threadId: planner, runId: RunId.make("run-plan") },
  effectsIssued: 1,
  planRound: 1,
};

const withPlan = (tasks: ReadonlyArray<FactoryPlanTask>): FactoryDeliveryState => ({
  ...planning,
  status: "waiting",
  stage: "approve_plan",
  awaiting: null,
  plan: {
    tasks,
    round: 1,
    source: "mcp",
    evidencePath: "/home/owner/.t3/userdata/fd-factory/delivery-1/plan-1.json",
  },
});

const blocked = (block: FactoryBlock): FactoryDeliveryState => ({
  ...planning,
  status: "blocked",
  awaiting: null,
  block,
});

const stored = (state: FactoryDeliveryState): FactoryDeliveryWithRuns => ({
  deliveryId: FactoryDeliveryId.make("delivery-1"),
  projectId: ProjectId.make("project-alpha"),
  itemRef: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-aaaaaa"),
  },
  parentId: null,
  state,
  stageRuns: [],
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T10:06:00.000Z",
});

const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const roundTrip = (snapshot: FactoryDelivery) => decodeDelivery(encodeDelivery(snapshot));

const PREFIX = "The planner found nothing to plan: ";

describe("needsYou while planning", () => {
  it("needs nothing from the owner while the planner runs", () => {
    expect(toFactoryDelivery(stored(planning))).not.toHaveProperty("needsYou");
  });

  it.each([
    [[task("a"), task("b"), task("c")], "A plan of 3 tasks awaits your approval."],
    [[task("a")], "A plan of 1 task awaits your approval."],
  ] as const)("names the plan waiting at the gate: %#", (tasks, needsYou) => {
    const snapshot = toFactoryDelivery(stored(withPlan(tasks)));
    expect(snapshot.status).toBe("waiting");
    expect(snapshot.stage).toEqual({ name: "approve_plan", kind: "gate" });
    expect(snapshot.needsYou).toBe(needsYou);
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);
  });

  it("shows the planner's note for an empty plan, on one line", () => {
    const snapshot = toFactoryDelivery(
      stored(
        blocked({ reason: "plan_empty", note: "Already shipped in #12.\n\n  See the changelog." }),
      ),
    );
    expect(snapshot.needsYou).toBe(`${PREFIX}Already shipped in #12. See the changelog.`);
    expect(roundTrip(snapshot)).toStrictEqual(snapshot);
  });

  it("says an empty plan without a note ended planning", () => {
    expect(toFactoryDelivery(stored(blocked({ reason: "plan_empty", note: null }))).needsYou).toBe(
      "The planner found nothing to plan.",
    );
  });

  it("bounds a long note", () => {
    const note = `${"Nothing to do here. ".repeat(399)}End.`;
    const { needsYou } = toFactoryDelivery(stored(blocked({ reason: "plan_empty", note })));
    expect(needsYou).toHaveLength(280);
    expect(needsYou?.startsWith(`${PREFIX}Nothing to do here.`)).toBe(true);
    expect(needsYou?.endsWith("…")).toBe(true);
    expect(needsYou).not.toContain("End.");
  });

  it("names the planner when its plan was invalid again", () => {
    expect(
      toFactoryDelivery(
        stored(blocked({ reason: "invalid_submission", problems: ["Task 1 has no test plan."] })),
      ).needsYou,
    ).toBe("The planner's plan was invalid again: Task 1 has no test plan.");
  });
});

describe("the Work comment on an empty plan", () => {
  const blockedText = (reason: string) =>
    `Factory is blocked on this item and needs you. ${reason} Resume or cancel the delivery in Foredeck.`;

  it("gives the planner's note", () => {
    expect(
      transitionComment(planning, blocked({ reason: "plan_empty", note: "Already shipped." })),
    ).toEqual({ status: "blocked", body: blockedText(`${PREFIX}Already shipped.`) });
  });

  it.each(["Claude already did this.", "Co-authored-by: an AI assistant", "Ask @octocat first."])(
    "drops a note that cannot be published, keeping the fixed text: %s",
    (note) => {
      expect(transitionComment(planning, blocked({ reason: "plan_empty", note }))).toEqual({
        status: "blocked",
        body: blockedText("The planner found nothing to plan."),
      });
    },
  );

  it("announces the plan gate once, on entering it", () => {
    const gate = withPlan([task("a")]);
    expect(transitionComment(planning, gate)?.status).toBe("waiting");
    expect(transitionComment(gate, gate)).toBeUndefined();
  });
});
