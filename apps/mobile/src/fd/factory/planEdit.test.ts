import {
  addFactoryPlanCriterion,
  addFactoryTestPlanEntry,
  discardFactoryPlanEdits,
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  editFactoryTestPlanEntry,
  FACTORY_PLAN_FIELD_REFUSED,
  FACTORY_PLAN_TASK_REFUSED,
  factoryPlanConfirmed,
  factoryPlanDraft,
  type FactoryPlanDraft,
  factoryPlanDraftState,
  type FactoryPlanGate,
  moveFactoryPlanTask,
  reapplyFactoryPlanEdits,
  removeFactoryPlanCriterion,
  removeFactoryPlanTask,
} from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryError,
  FactoryPlan,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  changeMobilePlanEdit,
  followMobilePlanEdit,
  MOBILE_PLAN_EMPTY,
  mobilePlanEdit,
  type MobilePlanEdit,
  mobilePlanSave,
  mobilePlanTaskErrors,
  refuseMobilePlanEdit,
  settleMobilePlanSave,
} from "./planEdit";
import { mobilePlanActions, mobilePlanDecisionTarget, mobilePlanGate } from "./planGate";
import type { MobilePlanGateInput } from "./planGate";

const environmentId = EnvironmentId.make("env-a");
const otherEnvironment = EnvironmentId.make("env-b");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const D1 = FactoryDeliveryId.make("d1");
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
  projectId: ProjectId.make("p1"),
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
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:10:00.000Z",
  ...overrides,
});

const GRANTED = { update: true, approve: true, reject: true, replan: true };

const gateOf = (overrides: Partial<MobilePlanGateInput> = {}): FactoryPlanGate => {
  const gate = mobilePlanGate({
    environmentId,
    itemRef,
    planning: true,
    connectionState: "connected",
    deliveries: [delivery("d1")],
    permitted: GRANTED,
    ...overrides,
  });
  if (gate === null) throw new Error("Expected the delivery to wait at the plan gate.");
  return gate;
};
// The same delivery, refetched holding `plan`.
const holding = (plan: FactoryPlan) => gateOf({ deliveries: [delivery("d1", { plan })] });

const edited = (gate: FactoryPlanGate, change: (draft: FactoryPlanDraft) => FactoryPlanDraft) =>
  changeMobilePlanEdit(mobilePlanEdit(gate), change);

const tasksOf = (plan: FactoryPlan) => plan.tasks;
const withTask = (id: FactoryTaskId, change: Partial<FactoryPlan["tasks"][number]>) =>
  decodePlan({
    ...PLAN,
    tasks: tasksOf(PLAN).map((planned) =>
      planned.id === id ? { ...planned, ...change } : planned,
    ),
  });
const csv = PLAN.tasks[0]!;
const header = PLAN.tasks[1]!;

describe("saving the mobile plan edit (criterion 1)", () => {
  const gate = gateOf();

  it.each([
    [
      "a title",
      (draft: FactoryPlanDraft) => editFactoryPlanTask(draft, CSV, { title: "Export CSV files" }),
      withTask(CSV, { title: "Export CSV files" }),
    ],
    [
      "a summary, trimmed",
      (draft: FactoryPlanDraft) =>
        editFactoryPlanTask(draft, HEADER, { summary: "  Write the header row first.  " }),
      withTask(HEADER, { summary: "Write the header row first." }),
    ],
    [
      "a criterion",
      (draft: FactoryPlanDraft) =>
        editFactoryPlanCriterion(draft, CSV, 2, "The export is documented in the guide."),
      withTask(CSV, {
        acceptance: ["export-csv works.", "The export is documented in the guide."],
      }),
    ],
    [
      "a test plan check and its paths",
      (draft: FactoryPlanDraft) =>
        editFactoryTestPlanEntry(draft, CSV, 0, {
          check: "Export a fixture and compare it.",
          paths: ["src/export.test.ts", "src/fixture.csv"],
        }),
      withTask(CSV, {
        testPlan: [
          {
            criterion: 1,
            check: "Export a fixture and compare it.",
            paths: ["src/export.test.ts", "src/fixture.csv"],
          },
          csv.testPlan[1]!,
        ],
      }),
    ],
    [
      "an added criterion with its test",
      (draft: FactoryPlanDraft) =>
        editFactoryTestPlanEntry(
          addFactoryTestPlanEntry(
            editFactoryPlanCriterion(addFactoryPlanCriterion(draft, CSV), CSV, 3, "It is fast."),
            CSV,
            3,
          ),
          CSV,
          2,
          { check: "Time a large export." },
        ),
      withTask(CSV, {
        acceptance: [...csv.acceptance, "It is fast."],
        testPlan: [...csv.testPlan, { criterion: 3, check: "Time a large export.", paths: [] }],
      }),
    ],
    [
      "a removed criterion with its test",
      (draft: FactoryPlanDraft) => removeFactoryPlanCriterion(draft, CSV, 1),
      withTask(CSV, {
        acceptance: [csv.acceptance[1]!],
        testPlan: [{ ...csv.testPlan[1]!, criterion: 1 }],
      }),
    ],
    [
      "a task moved down",
      (draft: FactoryPlanDraft) => moveFactoryPlanTask(draft, CSV, 1),
      decodePlan({ ...PLAN, tasks: [header, csv] }),
    ],
    [
      "a task moved up",
      (draft: FactoryPlanDraft) => moveFactoryPlanTask(draft, HEADER, -1),
      decodePlan({ ...PLAN, tasks: [header, csv] }),
    ],
    [
      "a removed task",
      (draft: FactoryPlanDraft) => removeFactoryPlanTask(draft, CSV),
      decodePlan({ ...PLAN, tasks: [header] }),
    ],
  ] as const)("sends %s as the plan update of the gate's delivery", (_, change, plan) => {
    expect(mobilePlanSave(gate, edited(gate, change).draft)).toEqual({
      _tag: "Save",
      plan,
      request: { environmentId, input: { deliveryId: D1, plan } },
    });
  });

  it("sends to the gate's own environment", () => {
    const elsewhere = gateOf({ environmentId: otherEnvironment });
    const save = mobilePlanSave(
      elsewhere,
      edited(elsewhere, (draft) => moveFactoryPlanTask(draft, CSV, 1)).draft,
    );
    expect(save._tag === "Save" && save.request.environmentId).toBe(otherEnvironment);
  });

  it("saves nothing unedited, offline or without the update grant", () => {
    expect(mobilePlanSave(gate, mobilePlanEdit(gate).draft)).toEqual({ _tag: "Unavailable" });
    const move = (draft: FactoryPlanDraft) => moveFactoryPlanTask(draft, CSV, 1);
    const offline = gateOf({ connectionState: "reconnecting" });
    expect(offline.offered.update).toBe(false);
    expect(mobilePlanSave(offline, edited(offline, move).draft)).toEqual({ _tag: "Unavailable" });
    const ungranted = gateOf({ permitted: { ...GRANTED, update: false } });
    expect(mobilePlanSave(ungranted, edited(ungranted, move).draft)).toEqual({
      _tag: "Unavailable",
    });
  });

  it("never saves a draft made for another delivery here", () => {
    const move = (draft: FactoryPlanDraft) => moveFactoryPlanTask(draft, CSV, 1);
    // The same delivery id on another environment, and another delivery of this environment.
    const otherEnv = move(
      factoryPlanDraft({ environmentId: otherEnvironment, deliveryId: D1 }, PLAN),
    );
    const otherDelivery = move(
      factoryPlanDraft({ environmentId, deliveryId: FactoryDeliveryId.make("d2") }, PLAN),
    );
    expect(mobilePlanSave(gate, otherEnv)).toEqual({ _tag: "Unavailable" });
    expect(mobilePlanSave(gate, otherDelivery)).toEqual({ _tag: "Unavailable" });
  });

  it("refuses a draft with no tasks and says why", () => {
    const empty = edited(gate, (draft) =>
      removeFactoryPlanTask(removeFactoryPlanTask(draft, CSV), HEADER),
    );
    expect(empty.draft.tasks).toEqual([]);
    expect(mobilePlanSave(gate, empty.draft)).toEqual({
      _tag: "Empty",
      message: MOBILE_PLAN_EMPTY,
    });
  });

  it("refuses a draft past its bounds with a message on each field", () => {
    const over = edited(gate, (draft) =>
      editFactoryTestPlanEntry(
        editFactoryPlanTask(draft, CSV, { title: "x".repeat(513), summary: "   " }),
        HEADER,
        1,
        { paths: ["../outside.ts"] },
      ),
    );
    const save = mobilePlanSave(gate, over.draft);
    expect(save._tag).toBe("Invalid");
    expect(mobilePlanTaskErrors(save, null, CSV)).toEqual({
      title: "Use at most 512 characters.",
      summary: "Enter some text.",
    });
    expect(mobilePlanTaskErrors(save, null, HEADER)).toEqual({
      "testPlan.1.paths": "Use a normalized repository-relative path outside .git: ../outside.ts",
    });
    // The longest title the contract takes saves.
    const longest = edited(gate, (draft) =>
      editFactoryPlanTask(draft, CSV, { title: "x".repeat(512) }),
    );
    expect(mobilePlanSave(gate, longest.draft)._tag).toBe("Save");
  });
});

describe("the server's plan changing under the mobile edit (criterion 2)", () => {
  const gate = gateOf();
  const renamed = (draft: FactoryPlanDraft) =>
    editFactoryPlanTask(draft, HEADER, { title: "Write a header row" });

  it("flags an edited draft changed, and reapply or discard resolve it", () => {
    const changed = followMobilePlanEdit(edited(gate, renamed), holding(NEXT));
    const next = holding(NEXT);
    expect(factoryPlanDraftState(changed.draft)).toBe("changed");
    expect(changed.draft.tasks[1]?.title).toBe("Write a header row");
    expect(mobilePlanSave(next, changed.draft)).toEqual({ _tag: "Changed" });
    expect(mobilePlanActions(next, changed.draft).approve).toBe(false);

    // Reapplied: the owner's title over the new plan, which now saves.
    const reapplied = changeMobilePlanEdit(changed, reapplyFactoryPlanEdits);
    expect(factoryPlanDraftState(reapplied.draft)).toBe("edited");
    const save = mobilePlanSave(next, reapplied.draft);
    expect(save._tag === "Save" && save.plan.tasks.map((planned) => planned.title)).toEqual([
      "Export CSV files",
      "Write a header row",
    ]);

    // Discarded: the new plan unedited, which the owner may approve.
    const discarded = changeMobilePlanEdit(changed, discardFactoryPlanEdits);
    expect(factoryPlanDraftState(discarded.draft)).toBe("unedited");
    expect(discarded.draft.base).toBe(NEXT);
    expect(mobilePlanActions(next, discarded.draft).approve).toBe(true);
  });

  it("lets an unedited draft follow the new plan", () => {
    const followed = followMobilePlanEdit(mobilePlanEdit(gate), holding(NEXT));
    expect(followed.followed).toBe(NEXT);
    expect(factoryPlanDraftState(followed.draft)).toBe("unedited");
    expect(followed.draft.base).toBe(NEXT);
    expect(followed.draft.tasks[0]?.title).toBe("Export CSV files");
  });

  it("keeps the editor while the gate holds the plan it follows", () => {
    const edit = edited(gate, renamed);
    expect(followMobilePlanEdit(edit, gate)).toBe(edit);
  });

  it("starts afresh on another delivery's gate", () => {
    const other = gateOf({ deliveries: [delivery("d2", { plan: NEXT })] });
    const moved = followMobilePlanEdit(edited(gate, renamed), other);
    expect(moved.draft).toEqual(factoryPlanDraft(other.destination, NEXT));
  });

  it("keeps the newer plan seen before a save settles", () => {
    const edit = edited(gate, renamed);
    const save = mobilePlanSave(gate, edit.draft);
    if (save._tag !== "Save") throw new Error("Expected a save.");
    // Another client's save lands and is seen while this save is in flight.
    const seen = followMobilePlanEdit(edit, holding(NEXT));
    const settled = settleMobilePlanSave(seen, gate.destination, PLAN, save.plan);
    expect(settled.draft.base).toBe(NEXT);
    expect(factoryPlanDraftState(settled.draft)).toBe("unedited");
    expect(mobilePlanActions(holding(NEXT), settled.draft).approve).toBe(true);
  });

  it("holds the saved plan until the server is seen holding it", () => {
    const edit = edited(gate, renamed);
    const save = mobilePlanSave(gate, edit.draft);
    if (save._tag !== "Save") throw new Error("Expected a save.");
    const settled = settleMobilePlanSave(edit, gate.destination, PLAN, save.plan);
    expect(settled.draft.base).toEqual(save.plan);
    expect(factoryPlanDraftState(settled.draft)).toBe("unedited");
    // The refetch has not arrived: approving would approve a plan the server is not seen holding.
    expect(mobilePlanActions(gate, settled.draft).approve).toBe(false);
    const refetched = holding(save.plan);
    const loaded = followMobilePlanEdit(settled, refetched);
    expect(mobilePlanActions(refetched, loaded.draft).approve).toBe(true);
  });

  it("leaves an editor of another delivery when a save settles", () => {
    const edit = edited(gate, renamed);
    const elsewhere = { environmentId: otherEnvironment, deliveryId: D1 };
    expect(settleMobilePlanSave(edit, elsewhere, PLAN, NEXT)).toBe(edit);
  });
});

describe("approve on the mobile gate (criterion 3)", () => {
  const gate = gateOf();
  const openedFor = factoryPlanConfirmed(gate);
  const target = (draft: FactoryPlanDraft, decision: "approve" | "reject") =>
    mobilePlanDecisionTarget(gate, draft, decision, openedFor);

  it("is offered and sent for an unedited draft of the server's plan", () => {
    const draft = mobilePlanEdit(gate).draft;
    expect(mobilePlanActions(gate, draft)).toEqual({ approve: true, reject: true, replan: true });
    expect(target(draft, "approve")).toEqual({ environmentId, input: { deliveryId: D1 } });
  });

  it("is neither offered nor sent for an edited draft, though reject still is", () => {
    const draft = edited(gate, (current) => moveFactoryPlanTask(current, CSV, 1)).draft;
    expect(mobilePlanActions(gate, draft)).toEqual({ approve: false, reject: true, replan: true });
    expect(target(draft, "approve")).toBeNull();
    expect(target(draft, "reject")).toEqual({ environmentId, input: { deliveryId: D1 } });
  });

  it("is not offered for a changed draft or one of a plan the server no longer holds", () => {
    const changed = followMobilePlanEdit(
      edited(gate, (current) => moveFactoryPlanTask(current, CSV, 1)),
      holding(NEXT),
    ).draft;
    expect(mobilePlanActions(holding(NEXT), changed).approve).toBe(false);
    // A draft of PLAN while the server is seen holding NEXT.
    const stale = factoryPlanDraft(gate.destination, PLAN);
    expect(mobilePlanActions(holding(NEXT), stale).approve).toBe(false);
    expect(
      mobilePlanDecisionTarget(
        holding(NEXT),
        stale,
        "approve",
        factoryPlanConfirmed(holding(NEXT)),
      ),
    ).toBeNull();
  });
});

describe("a refused save or approval on mobile (criterion 4)", () => {
  const gate = gateOf();
  const EDIT_REFUSED = "Factory refused the edited plan.";
  const refused = (edit: MobilePlanEdit, error: unknown) =>
    refuseMobilePlanEdit(edit, gate.destination, AsyncResult.failure(Cause.fail(error)));

  it("puts the client's own message on each named field, and the task's on an unknown one", () => {
    const edit = edited(gate, (draft) =>
      editFactoryPlanTask(draft, CSV, { title: "Export the CSV" }),
    );
    const after = refused(
      edit,
      new FactoryError({
        reason: "invalid_request",
        message: EDIT_REFUSED,
        deliveryId: D1,
        fields: [
          { taskId: CSV, field: "title" },
          { taskId: CSV, field: "acceptance.2.testPlan" },
          { taskId: CSV, field: "testPlan.0.paths" },
          { taskId: HEADER, field: "estimate" },
        ],
      }),
    );
    expect(after.draft).toBe(edit.draft);
    expect(after.refusal?.message).toBe(EDIT_REFUSED);
    const save = mobilePlanSave(gate, after.draft);
    expect(mobilePlanTaskErrors(save, after.refusal, CSV)).toEqual({
      title: FACTORY_PLAN_FIELD_REFUSED,
      "acceptance.2.testPlan": "Add a test plan entry for criterion 2.",
      "testPlan.0.paths": FACTORY_PLAN_FIELD_REFUSED,
    });
    expect(mobilePlanTaskErrors(save, after.refusal, HEADER)).toEqual({});
    expect(after.refusal?.tasks).toEqual({ [HEADER]: FACTORY_PLAN_TASK_REFUSED });
    // The draft's own message on a field comes first.
    const blank = changeMobilePlanEdit(after, (draft) =>
      editFactoryPlanTask(draft, CSV, { title: " " }),
    );
    expect(mobilePlanTaskErrors(mobilePlanSave(gate, blank.draft), blank.refusal, CSV).title).toBe(
      "Enter a single-line title.",
    );
  });

  it("keeps a refusal across a refetch of the same plan and drops it once the plan changes", () => {
    const after = refused(
      mobilePlanEdit(gate),
      new FactoryError({
        reason: "invalid_request",
        message: EDIT_REFUSED,
        fields: [{ taskId: CSV }],
      }),
    );
    expect(followMobilePlanEdit(after, holding(decodePlan(PLAN))).refusal).toBe(after.refusal);
    expect(followMobilePlanEdit(after, holding(NEXT)).refusal).toBeNull();
  });

  it("shows only the text of a refused approval and leaves the draft", () => {
    const edit = mobilePlanEdit(gate);
    const message = "Only a delivery waiting at the plan gate can have its plan approved.";
    const after = refused(edit, new FactoryError({ reason: "refused", message }));
    expect(after.draft).toBe(edit.draft);
    expect(after.refusal).toEqual({ message, fields: {}, tasks: {} });
    const lost = refused(edit, "socket closed");
    expect(lost.refusal?.message).toBe("Factory could not complete the request. Try again.");
  });

  it("leaves an editor of another delivery", () => {
    const edit = mobilePlanEdit(gate);
    const elsewhere = { environmentId: otherEnvironment, deliveryId: D1 };
    expect(
      refuseMobilePlanEdit(
        edit,
        elsewhere,
        AsyncResult.failure(Cause.fail(new FactoryError({ reason: "refused", message: "No." }))),
      ),
    ).toBe(edit);
  });
});
