import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryPlan, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";

import {
  discardFactoryPlanEdits,
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  factoryPlanDraft,
  type FactoryPlanDraft,
  factoryPlanFromDraft,
  moveFactoryPlanTask,
  reapplyFactoryPlanEdits,
  rebaseFactoryPlanDraft,
  removeFactoryPlanTask,
} from "./planDraft.ts";

const decode = Schema.decodeUnknownSync(FactoryPlan);
const SCHEMA = FactoryTaskId.make("schema");
const SERVER = FactoryTaskId.make("server");
const WEB = FactoryTaskId.make("web");
const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const DELIVERY_1 = FactoryDeliveryId.make("delivery-1");
const DELIVERY_2 = FactoryDeliveryId.make("delivery-2");
const HERE = { environmentId: ENV_A, deliveryId: DELIVERY_1 };

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  kind: "feature",
  summary: `Summary of ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `Check ${id}.`, paths: [`apps/${id}/a.test.ts`] }],
  likelyPaths: [`apps/${id}/a.ts`],
  risk: "normal",
  ...extra,
});

const PLAN_INPUT = {
  tasks: [
    task("schema", "Add the plan schema"),
    task("server", "Validate plans"),
    task("web", "Show the plan"),
  ],
  note: "Three tasks.",
};
const PLAN = decode(PLAN_INPUT);

// The planner's revision: a new title and risk on existing tasks, a new task and a new note.
const NEXT = decode({
  tasks: [
    task("schema", "Declare the plan schema"),
    task("server", "Validate plans", { risk: "high" }),
    task("web", "Show the plan"),
    task("docs", "Document plans"),
  ],
  note: "Four tasks.",
});

const taskOf = (plan: FactoryPlan, id: FactoryTaskId) => plan.tasks.find((task) => task.id === id)!;

const ids = (plan: FactoryPlan) => plan.tasks.map((task) => task.id);

const validPlan = (draft: FactoryPlanDraft) => {
  const result = factoryPlanFromDraft(draft, HERE);
  if (result._tag !== "Valid") throw new Error(`expected a valid draft, got ${result._tag}`);
  expect(decode(result.plan)).toStrictEqual(result.plan);
  return result.plan;
};

const withTask = (plan: FactoryPlan, id: string, edit: Partial<FactoryPlan["tasks"][number]>) => ({
  ...plan,
  tasks: plan.tasks.map((task) => (task.id === id ? { ...task, ...edit } : task)),
});

describe("plan draft destination", () => {
  it("submits only for the environment and delivery it was made for", () => {
    const draft = factoryPlanDraft(HERE, PLAN);
    expect(draft).toMatchObject({ environmentId: ENV_A, deliveryId: DELIVERY_1 });
    for (const requested of [
      { environmentId: ENV_B, deliveryId: DELIVERY_1 },
      { environmentId: ENV_A, deliveryId: DELIVERY_2 },
    ]) {
      const result = factoryPlanFromDraft(draft, requested);
      expect(result).toStrictEqual({ _tag: "Mismatch", draft: HERE, requested });
      expect(result).not.toHaveProperty("plan");
    }
    expect(factoryPlanFromDraft(draft, HERE)).toStrictEqual({ _tag: "Valid", plan: PLAN });
  });

  it("refuses another delivery even with edits, and checks the destination before a change", () => {
    const edited = editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), SCHEMA, { summary: "Mine." });
    const changed = rebaseFactoryPlanDraft(edited, HERE, NEXT);
    const other = { environmentId: ENV_B, deliveryId: DELIVERY_1 };
    for (const draft of [edited, changed, reapplyFactoryPlanEdits(changed)]) {
      expect(factoryPlanFromDraft(draft, other)._tag).toBe("Mismatch");
    }
  });

  it("ignores a plan of another delivery", () => {
    const draft = factoryPlanDraft(HERE, PLAN);
    const edited = editFactoryPlanTask(draft, SCHEMA, { summary: "Mine." });
    for (const other of [
      { environmentId: ENV_B, deliveryId: DELIVERY_1 },
      { environmentId: ENV_A, deliveryId: DELIVERY_2 },
    ]) {
      expect(rebaseFactoryPlanDraft(draft, other, NEXT)).toBe(draft);
      expect(rebaseFactoryPlanDraft(edited, other, NEXT)).toBe(edited);
    }
  });
});

describe("rebasing an unedited draft", () => {
  it("follows the new plan", () => {
    const rebased = rebaseFactoryPlanDraft(factoryPlanDraft(HERE, PLAN), HERE, NEXT);
    expect(rebased).toStrictEqual(factoryPlanDraft(HERE, NEXT));
    expect(validPlan(rebased)).toStrictEqual(NEXT);
  });
});

describe("rebasing an edited draft", () => {
  const edited = editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), SCHEMA, {
    summary: "My summary.",
  });
  const changed = rebaseFactoryPlanDraft(edited, HERE, NEXT);

  it("keeps every edit, shows the new plan and submits nothing until resolved", () => {
    expect(changed.tasks).toStrictEqual(edited.tasks);
    expect(changed.base).toBe(PLAN);
    expect(changed.current).toBe(NEXT);
    expect(factoryPlanFromDraft(changed, HERE)).toStrictEqual({ _tag: "Changed", current: NEXT });
  });

  it("keeps edits made while the change is shown", () => {
    const more = editFactoryPlanTask(changed, WEB, { title: "Render the plan" });
    expect(more.current).toBe(NEXT);
    expect(factoryPlanFromDraft(more, HERE)._tag).toBe("Changed");
    const plan = validPlan(reapplyFactoryPlanEdits(more));
    expect(plan.tasks.find((task) => task.id === WEB)?.title).toBe("Render the plan");
  });

  it("discards to the new plan, unedited", () => {
    const discarded = discardFactoryPlanEdits(changed);
    expect(discarded).toStrictEqual(factoryPlanDraft(HERE, NEXT));
    expect(validPlan(discarded)).toStrictEqual(NEXT);
  });

  it("reapplies the edit over the new plan", () => {
    const reapplied = reapplyFactoryPlanEdits(changed);
    expect(reapplied.base).toBe(NEXT);
    expect(reapplied.current).toBeNull();
    expect(validPlan(reapplied)).toStrictEqual(withTask(NEXT, SCHEMA, { summary: "My summary." }));
  });

  it("keeps the owner's value of a field both changed, and criteria with their entries", () => {
    const draft = editFactoryPlanCriterion(
      editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), SCHEMA, { title: "My title" }),
      SERVER,
      1,
      "My criterion.",
    );
    const revised = withTask(withTask(NEXT, SERVER, { summary: "Planner summary." }), SERVER, {
      acceptance: ["Planner criterion.", "Another."],
      testPlan: [
        { criterion: 1, check: "Planner check.", paths: [] },
        { criterion: 2, check: "Another check.", paths: [] },
      ],
    });
    const plan = validPlan(reapplyFactoryPlanEdits(rebaseFactoryPlanDraft(draft, HERE, revised)));
    expect(plan).toStrictEqual(
      withTask(withTask(revised, SCHEMA, { title: "My title" }), SERVER, {
        acceptance: ["My criterion."],
        testPlan: taskOf(PLAN, SERVER).testPlan,
      }),
    );
  });

  it("shows the newest plan when the server's plan moves again", () => {
    const newer = decode({ ...PLAN_INPUT, note: "Newest." });
    const again = rebaseFactoryPlanDraft(changed, HERE, newer);
    expect(again.tasks).toStrictEqual(edited.tasks);
    expect(again.current).toBe(newer);
    expect(rebaseFactoryPlanDraft(again, HERE, decode({ ...PLAN_INPUT, note: "Newest." }))).toBe(
      again,
    );
  });

  it("drops the change when the server's plan returns to the base", () => {
    const back = rebaseFactoryPlanDraft(changed, HERE, decode(PLAN_INPUT));
    expect(back).toStrictEqual(edited);
    expect(factoryPlanFromDraft(back, HERE)._tag).toBe("Valid");
  });
});

describe("reapplying edits", () => {
  it("drops edits of a task the new plan removed and keeps the new plan's task ids", () => {
    const draft = editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), WEB, { summary: "Mine." });
    const withoutWeb = decode({ ...PLAN_INPUT, tasks: [PLAN_INPUT.tasks[1], PLAN_INPUT.tasks[0]] });
    const plan = validPlan(
      reapplyFactoryPlanEdits(rebaseFactoryPlanDraft(draft, HERE, withoutWeb)),
    );
    expect(ids(plan)).toStrictEqual(ids(withoutWeb));
    expect(plan).toStrictEqual(withoutWeb);
  });

  it("never brings back a task the owner removed or adds one the new plan lacks", () => {
    const draft = removeFactoryPlanTask(
      editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), WEB, { summary: "Mine." }),
      SERVER,
    );
    const plan = validPlan(reapplyFactoryPlanEdits(rebaseFactoryPlanDraft(draft, HERE, NEXT)));
    expect(ids(plan)).toStrictEqual(["schema", "web", "docs"]);
    for (const id of ids(plan)) expect(ids(NEXT)).toContain(id);
  });

  it("keeps the owner's order, with the new plan's added tasks after it", () => {
    const draft = moveFactoryPlanTask(factoryPlanDraft(HERE, PLAN), WEB, -1);
    const plan = validPlan(reapplyFactoryPlanEdits(rebaseFactoryPlanDraft(draft, HERE, NEXT)));
    expect(ids(plan)).toStrictEqual(["schema", "web", "server", "docs"]);
    expect(taskOf(plan, SERVER)).toStrictEqual(taskOf(NEXT, SERVER));
  });

  it("leaves a draft without a change as it is", () => {
    const edited = editFactoryPlanTask(factoryPlanDraft(HERE, PLAN), SCHEMA, { summary: "Mine." });
    expect(reapplyFactoryPlanEdits(edited)).toBe(edited);
    expect(discardFactoryPlanEdits(edited)).toBe(edited);
  });
});

describe("rebasing onto the base", () => {
  it("leaves the draft as it was", () => {
    const unedited = factoryPlanDraft(HERE, PLAN);
    const edited = moveFactoryPlanTask(
      editFactoryPlanTask(unedited, SCHEMA, { summary: "Mine." }),
      WEB,
      -1,
    );
    expect(rebaseFactoryPlanDraft(unedited, HERE, decode(PLAN_INPUT))).toBe(unedited);
    expect(rebaseFactoryPlanDraft(edited, HERE, decode(PLAN_INPUT))).toBe(edited);
    expect(rebaseFactoryPlanDraft(edited, HERE, PLAN)).toBe(edited);
  });
});
