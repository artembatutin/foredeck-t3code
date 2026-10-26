import {
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  factoryPlanDraft,
  type FactoryPlanDraft,
  moveFactoryPlanTask,
  reapplyFactoryPlanEdits,
  removeFactoryPlanTask,
} from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryError,
  FactoryPlan,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_PLAN_FIELD_REFUSED,
  FACTORY_PLAN_TASK_REFUSED,
  factoryPlanDecision,
  factoryPlanDraftState,
  type FactoryPlanGate,
  factoryPlanGate,
  factoryPlanGateActions,
  type FactoryPlanGatePermissions,
  factoryPlanRefusal,
  factoryPlanSave,
  factoryPlanTaskErrors,
  factoryReplanRequest,
  followFactoryPlan,
} from "./planGate";

const environmentId = EnvironmentId.make("env-a");
const otherEnvironment = EnvironmentId.make("env-b");
const projectId = ProjectId.make("project-a");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const CSV = FactoryTaskId.make("export-csv");
const HEADER = FactoryTaskId.make("export-header");

const decodePlan = Schema.decodeUnknownSync(FactoryPlan);
const task = (id: string, title: string) => ({
  id,
  title,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`, `${id} is documented.`],
  testPlan: [
    { criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] },
    { criterion: 2, check: `${id} has docs.`, paths: [`docs/${id}.md`] },
  ],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});
const PLAN = decodePlan({
  tasks: [task("export-csv", "Export CSV"), task("export-header", "Add a header row")],
  note: "Two tasks.",
});
// The planner's revision after a replan, or another client's saved edit.
const NEXT = decodePlan({
  tasks: [task("export-csv", "Export CSV files"), task("export-header", "Add a header row")],
  note: "Two tasks.",
});

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId,
  itemRef,
  childIds: [],
  status: "waiting",
  stage: { name: "approve_plan", kind: "gate" },
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  plan: PLAN,
  needsYou: "A plan of 2 tasks awaits your approval.",
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:10:00.000Z",
  ...overrides,
});

const ALL: FactoryPlanGatePermissions = { update: true, approve: true, reject: true, replan: true };
const NONE: FactoryPlanGatePermissions = {
  update: false,
  approve: false,
  reject: false,
  replan: false,
};

const gateOf = (
  overrides: Partial<Parameters<typeof factoryPlanGate>[0]> = {},
): FactoryPlanGate | null =>
  factoryPlanGate({
    environmentId,
    itemRef,
    planning: true,
    connected: true,
    deliveries: [delivery("d1")],
    started: [],
    permitted: ALL,
    ...overrides,
  });
const waitingGate = (overrides: Partial<Parameters<typeof factoryPlanGate>[0]> = {}) => {
  const gate = gateOf(overrides);
  if (gate === null) throw new Error("Expected the delivery to wait at the plan gate.");
  return gate;
};
const HERE = { environmentId, deliveryId: FactoryDeliveryId.make("d1") };

const refusalOf = (error: unknown) => factoryPlanRefusal(Cause.fail(error));
const EDIT_REFUSED =
  "Factory refused the edited plan. An edited plan follows the planner's rules: nonblank text within its bounds, and a test plan entry for every criterion. An edit can change task titles, summaries, acceptance criteria and test plans, reorder tasks and remove some; it cannot add tasks, empty the plan, or change task ids, kinds, likely paths, risk or the planner's note.";

describe("the plan gate of an item's current delivery", () => {
  it("shows the plan a delivery waits on at the gate, pinned to that delivery", () => {
    expect(gateOf()).toEqual({ destination: HERE, plan: PLAN, offered: ALL });
    // A delivery a start just returned counts until the list holds it, as the section shows it.
    expect(
      gateOf({ deliveries: [], started: [{ environmentId, delivery: delivery("d2") }] })
        ?.destination,
    ).toEqual({ environmentId, deliveryId: "d2" });
  });

  it.each<[string, Partial<Parameters<typeof factoryPlanGate>[0]>]>([
    ["a running delivery", { deliveries: [delivery("d1", { status: "running" })] }],
    ["a delivery stopped at the gate", { deliveries: [delivery("d1", { status: "stopped" })] }],
    ["a status this build does not know", { deliveries: [delivery("d1", { status: "unknown" })] }],
    [
      "a delivery waiting elsewhere",
      { deliveries: [delivery("d1", { stage: { name: "unknown", kind: "gate" } })] },
    ],
    ["a gate without a plan", { deliveries: [delivery("d1", { plan: undefined })] }],
    ["a server that does not plan", { planning: false }],
    ["deliveries not loaded yet", { deliveries: null }],
    [
      "another item's delivery",
      {
        deliveries: [
          delivery("d1", { itemRef: { ...itemRef, itemId: WorkItemId.make("fd-other") } }),
        ],
      },
    ],
  ])("is not shown for %s", (_name, overrides) => {
    expect(gateOf(overrides)).toBeNull();
  });

  it("offers each action only on a live connection holding its grant", () => {
    expect(waitingGate({ connected: false }).offered).toEqual(NONE);
    expect(waitingGate({ permitted: NONE }).offered).toEqual(NONE);
    expect(waitingGate({ permitted: { ...ALL, approve: false, replan: false } }).offered).toEqual({
      update: true,
      approve: false,
      reject: true,
      replan: false,
    });
    // A gate of a stage kind this build does not know shows read-only.
    expect(
      waitingGate({
        deliveries: [delivery("d1", { stage: { name: "approve_plan", kind: "unknown" } })],
      }).offered,
    ).toEqual(NONE);
  });
});

describe("saving the plan draft", () => {
  const gate = waitingGate();
  const fresh = followFactoryPlan(null, gate);

  it("sends the edited plan, in the owner's order, as the plan update's exact payload", () => {
    const edited = moveFactoryPlanTask(
      editFactoryPlanTask(fresh, CSV, { title: "Export CSV files", summary: "  Exports.  " }),
      HEADER,
      -1,
    );
    expect(factoryPlanDraftState(edited)).toBe("edited");
    const [csv, header] = PLAN.tasks;
    const plan = {
      tasks: [header, { ...csv!, title: "Export CSV files", summary: "Exports." }],
      note: "Two tasks.",
    };
    expect(factoryPlanSave(gate, edited)).toEqual({
      _tag: "Save",
      plan,
      request: { environmentId, input: { deliveryId: "d1", plan } },
    });
    // Removing a task sends the plan without it.
    const removed = factoryPlanSave(gate, removeFactoryPlanTask(fresh, HEADER));
    expect(removed._tag === "Save" && removed.request.input.plan).toEqual({
      tasks: [csv],
      note: "Two tasks.",
    });
  });

  it("sends nothing unedited, emptied, refused by the draft, or where update is not offered", () => {
    expect(factoryPlanSave(gate, fresh)).toEqual({ _tag: "Unavailable" });
    const emptied = removeFactoryPlanTask(removeFactoryPlanTask(fresh, CSV), HEADER);
    expect(factoryPlanSave(gate, emptied)).toEqual({ _tag: "Unavailable" });
    expect(factoryPlanSave(gate, editFactoryPlanTask(fresh, CSV, { title: "" }))).toEqual({
      _tag: "Invalid",
      errors: { [CSV]: { title: "Enter a single-line title." } },
    });
    const edited = editFactoryPlanTask(fresh, CSV, { title: "Export CSV files" });
    expect(factoryPlanSave(waitingGate({ connected: false }), edited)).toEqual({
      _tag: "Unavailable",
    });
    expect(factoryPlanSave(waitingGate({ permitted: { ...ALL, update: false } }), edited)).toEqual({
      _tag: "Unavailable",
    });
    // A draft made for the same delivery id on another environment is never saved here.
    const elsewhere = editFactoryPlanTask(
      factoryPlanDraft({ ...HERE, environmentId: otherEnvironment }, PLAN),
      CSV,
      { title: "Export CSV files" },
    );
    expect(factoryPlanSave(gate, elsewhere)).toEqual({ _tag: "Unavailable" });
  });
});

describe("a server refusal of the plan", () => {
  it("puts the fields a Factory error names on those fields of the named tasks", () => {
    const refusal = refusalOf(
      new FactoryError({
        reason: "invalid_request",
        message: EDIT_REFUSED,
        deliveryId: FactoryDeliveryId.make("d1"),
        fields: [
          { taskId: CSV, field: "title" },
          { taskId: CSV, field: "acceptance.2.testPlan" },
          { taskId: CSV, field: "testPlan.1.paths" },
          { taskId: HEADER },
          // A field this build does not know stands for the whole task.
          { taskId: FactoryTaskId.make("export-footer"), field: "estimate" },
        ],
      }),
    );
    expect(refusal).toEqual({
      message: EDIT_REFUSED,
      fields: {
        [CSV]: {
          title: FACTORY_PLAN_FIELD_REFUSED,
          "acceptance.2.testPlan": "Add a test plan entry for criterion 2.",
          "testPlan.1.paths": FACTORY_PLAN_FIELD_REFUSED,
        },
      },
      tasks: { [HEADER]: FACTORY_PLAN_TASK_REFUSED, "export-footer": FACTORY_PLAN_TASK_REFUSED },
    });
    // The draft's own message on a field comes first; the refusal's fill the rest.
    expect(
      factoryPlanTaskErrors({ [CSV]: { title: "Enter a single-line title." } }, refusal, CSV),
    ).toEqual({
      title: "Enter a single-line title.",
      "acceptance.2.testPlan": "Add a test plan entry for criterion 2.",
      "testPlan.1.paths": FACTORY_PLAN_FIELD_REFUSED,
    });
    expect(factoryPlanTaskErrors({}, null, CSV)).toEqual({});
  });

  it("shows only the message of an error that names no field", () => {
    const refused = "Only a delivery waiting at the plan gate can have its plan approved.";
    expect(refusalOf(new FactoryError({ reason: "refused", message: refused }))).toEqual({
      message: refused,
      fields: {},
      tasks: {},
    });
    expect(factoryPlanRefusal(Cause.die("socket closed"))).toEqual({
      message: "Factory could not complete the request. Try again.",
      fields: {},
      tasks: {},
    });
  });
});

describe("a plan that changes on the server", () => {
  const gate = waitingGate();
  const changedGate = waitingGate({ deliveries: [delivery("d1", { plan: NEXT })] });
  const fresh = followFactoryPlan(null, gate);

  it("is followed by a draft without edits", () => {
    const followed = followFactoryPlan(fresh, changedGate);
    expect(followed).toEqual(factoryPlanDraft(HERE, NEXT));
    expect(factoryPlanDraftState(followed)).toBe("unedited");
  });

  it("flags a draft with edits, which neither saves nor approves until resolved", () => {
    const edited = editFactoryPlanCriterion(fresh, HEADER, 1, "The header row is written.");
    const flagged = followFactoryPlan(edited, changedGate);
    expect(factoryPlanDraftState(flagged)).toBe("changed");
    expect(flagged.current).toEqual(NEXT);
    expect(factoryPlanSave(changedGate, flagged)).toEqual({ _tag: "Changed" });
    expect(factoryPlanGateActions(changedGate, flagged)).toEqual({
      approve: false,
      reject: true,
      replan: true,
    });
    // Keeping the edits over the new plan rebases them onto it, to be saved.
    const rebased: FactoryPlanDraft = reapplyFactoryPlanEdits(flagged);
    expect(factoryPlanDraftState(rebased)).toBe("edited");
    const saved = factoryPlanSave(changedGate, rebased);
    expect(saved._tag === "Save" && saved.plan.tasks.map(({ title }) => title)).toEqual([
      "Export CSV files",
      "Add a header row",
    ]);
    expect(saved._tag === "Save" && saved.plan.tasks[1]!.acceptance[0]).toBe(
      "The header row is written.",
    );
    // The server's plan returning to the draft's base clears the flag.
    expect(factoryPlanDraftState(followFactoryPlan(flagged, gate))).toBe("edited");
  });

  it("starts over for a draft made for another delivery", () => {
    const other = factoryPlanDraft(
      { environmentId, deliveryId: FactoryDeliveryId.make("d0") },
      NEXT,
    );
    expect(followFactoryPlan(other, gate)).toEqual(fresh);
  });
});

describe("approve, reject and replan", () => {
  const gate = waitingGate();
  const fresh = followFactoryPlan(null, gate);
  const send = { _tag: "Send", request: { environmentId, input: { deliveryId: "d1" } } };

  it("approve and reject ask first, then send only for the delivery confirmed", () => {
    for (const decision of ["approve", "reject"] as const) {
      expect(factoryPlanDecision(gate, fresh, decision, null)).toEqual({ _tag: "Confirm" });
      expect(factoryPlanDecision(gate, fresh, decision, FactoryDeliveryId.make("d1"))).toEqual(
        send,
      );
      // Confirmed for a delivery the gate no longer shows: ask again, never send for this one.
      expect(factoryPlanDecision(gate, fresh, decision, FactoryDeliveryId.make("d0"))).toEqual({
        _tag: "Confirm",
      });
    }
  });

  it("approve is offered only on the unedited plan the owner sees", () => {
    const edited = editFactoryPlanTask(fresh, CSV, { title: "Export CSV files" });
    expect(factoryPlanGateActions(gate, fresh)).toEqual({
      approve: true,
      reject: true,
      replan: true,
    });
    expect(factoryPlanGateActions(gate, edited).approve).toBe(false);
    expect(factoryPlanDecision(gate, edited, "approve", FactoryDeliveryId.make("d1"))).toEqual({
      _tag: "Unavailable",
    });
    expect(factoryPlanDecision(gate, edited, "reject", FactoryDeliveryId.make("d1"))).toEqual(send);
  });

  it.each<[string, Partial<Parameters<typeof factoryPlanGate>[0]>]>([
    ["without a live connection", { connected: false }],
    ["without the operate grant", { permitted: NONE }],
  ])("offers none %s", (_name, overrides) => {
    const offline = waitingGate(overrides);
    expect(factoryPlanGateActions(offline, fresh)).toEqual({
      approve: false,
      reject: false,
      replan: false,
    });
    for (const decision of ["approve", "reject"] as const) {
      expect(factoryPlanDecision(offline, fresh, decision, FactoryDeliveryId.make("d1"))).toEqual({
        _tag: "Unavailable",
      });
    }
    expect(factoryReplanRequest(offline, "Split the export.")).toEqual({ _tag: "Unavailable" });
  });

  it("replan sends a trimmed note, and refuses a blank or overlong one", () => {
    expect(factoryReplanRequest(gate, "  Split the export.\n")).toEqual({
      _tag: "Send",
      request: { environmentId, input: { deliveryId: "d1", note: "Split the export." } },
    });
    for (const blank of ["", "  \n\t "]) {
      expect(factoryReplanRequest(gate, blank)).toEqual({
        _tag: "Invalid",
        message: "Write what the planner should change.",
      });
    }
    expect(factoryReplanRequest(gate, "n".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH + 1))).toEqual({
      _tag: "Invalid",
      message: `Use at most ${FACTORY_REPLAN_NOTE_MAX_LENGTH} characters.`,
    });
    expect(factoryReplanRequest(gate, ` ${"n".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH)} `)._tag).toBe(
      "Send",
    );
  });
});
