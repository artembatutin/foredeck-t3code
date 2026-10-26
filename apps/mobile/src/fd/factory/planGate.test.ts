import {
  factoryPlanConfirmed,
  type FactoryPlanConfirmed,
  type FactoryPlanDecision as Decision,
  factoryPlanDraft,
  type FactoryPlanGate,
} from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryPlan,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  mobilePlanActions,
  mobilePlanDecisionTarget,
  mobilePlanGate,
  type MobilePlanGateInput,
  mobileReplanRequest,
} from "./planGate";

const environmentId = EnvironmentId.make("env-a");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const D1 = FactoryDeliveryId.make("d1");
const D2 = FactoryDeliveryId.make("d2");

const decodePlan = Schema.decodeUnknownSync(FactoryPlan);
const task = (id: string, title: string) => ({
  id,
  title,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});
const PLAN = decodePlan({
  tasks: [task("export-csv", "Export CSV"), task("export-header", "Add a header row")],
  note: "Two tasks.",
});
// Another client's saved edit, or the planner's revision after a replan.
// The item's later delivery, waiting at its own gate after the first was rejected.
const replacedBy = () => [
  delivery("d2", { createdAt: "2026-10-25T10:00:00.000Z" }),
  delivery("d1", { status: "cancelled" }),
];
const EDITED = decodePlan({
  tasks: [task("export-header", "Add a header row"), task("export-csv", "Export CSV")],
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

const ALL = { approve: true, reject: true, replan: true };
const NOTHING = { approve: false, reject: false, replan: false };
const GRANTED = { ...ALL, update: true };
const NONE_GRANTED = { ...NOTHING, update: false };

// The draft of the plan the gate holds, unedited.
const shown = (gate: FactoryPlanGate) => factoryPlanDraft(gate.destination, gate.plan);
const actionsOf = (gate: FactoryPlanGate) => mobilePlanActions(gate, shown(gate));
const targetOf = (gate: FactoryPlanGate | null, ...rest: [Decision, FactoryPlanConfirmed]) =>
  mobilePlanDecisionTarget(gate, gate === null ? shown(gateOf()!) : shown(gate), ...rest);

const gateOf = (overrides: Partial<MobilePlanGateInput> = {}) =>
  mobilePlanGate({
    environmentId,
    itemRef,
    planning: true,
    connectionState: "connected",
    deliveries: [delivery("d1")],
    permitted: GRANTED,
    ...overrides,
  });

describe("mobilePlanGate", () => {
  it("shows the plan of a delivery waiting at the gate, with every granted action offered", () => {
    const gate = gateOf();
    expect(gate).toMatchObject({ destination: { environmentId, deliveryId: D1 }, plan: PLAN });
    expect(gate?.offered).toEqual(GRANTED);
    expect(actionsOf(gate!)).toEqual(ALL);
  });

  it.each(["reconnecting", "connecting", "offline", "error", undefined] as const)(
    "shows the plan read-only while %s",
    (connectionState) => {
      const gate = gateOf({ connectionState });
      expect(gate?.plan).toBe(PLAN);
      expect(actionsOf(gate!)).toEqual(NOTHING);
    },
  );

  it("offers each action only with its grant, and nothing without any", () => {
    expect(actionsOf(gateOf({ permitted: { ...GRANTED, approve: false } })!)).toEqual({
      approve: false,
      reject: true,
      replan: true,
    });
    const gate = gateOf({ permitted: NONE_GRANTED });
    expect(gate?.plan).toBe(PLAN);
    expect(actionsOf(gate!)).toEqual(NOTHING);
  });

  it("shows no gate on a server that does not advertise planning", () => {
    expect(gateOf({ planning: false })).toBeNull();
  });

  it.each([
    ["before the deliveries load", { deliveries: null }],
    ["for an item without a delivery", { deliveries: [] }],
    ["for an unknown status", { deliveries: [delivery("d1", { status: "unknown" })] }],
    [
      "for a delivery past the gate",
      {
        deliveries: [
          delivery("d1", { status: "running", stage: { name: "author", kind: "agent" } }),
        ],
      },
    ],
    [
      "for a waiting delivery at another stage",
      { deliveries: [delivery("d1", { stage: { name: "unknown", kind: "gate" } })] },
    ],
    ["for a gate without a plan", { deliveries: [delivery("d1", { plan: undefined })] }],
    [
      "for an earlier delivery the current one replaced",
      {
        deliveries: [
          delivery("d2", {
            status: "running",
            stage: { name: "plan", kind: "agent" },
            createdAt: "2026-10-25T10:00:00.000Z",
          }),
          delivery("d1", { status: "cancelled" }),
        ],
      },
    ],
  ] as const)("shows no gate %s", (_, overrides) => {
    expect(gateOf(overrides)).toBeNull();
  });

  it("shows a gate of an unknown stage kind read-only", () => {
    const gate = gateOf({
      deliveries: [delivery("d1", { stage: { name: "approve_plan", kind: "unknown" } })],
    });
    expect(gate?.plan).toBe(PLAN);
    expect(actionsOf(gate!)).toEqual(NOTHING);
  });
});

describe("mobilePlanDecisionTarget", () => {
  const openedFor = factoryPlanConfirmed(gateOf()!);

  it.each(["approve", "reject"] as const)(
    "sends %s for the delivery and plan the alert was opened for",
    (decision) => {
      // Refetched since, as an equal plan the server still holds.
      const now = gateOf({ deliveries: [delivery("d1", { plan: decodePlan(PLAN) })] });
      expect(targetOf(now, decision, openedFor)).toEqual({
        environmentId,
        input: { deliveryId: D1 },
      });
    },
  );

  it.each(["approve", "reject"] as const)(
    "sends no %s once another delivery replaced the one the alert was opened for",
    (decision) => {
      const replaced = gateOf({ deliveries: replacedBy() });
      expect(replaced?.destination.deliveryId).toBe(D2);
      expect(targetOf(replaced, decision, openedFor)).toBeNull();
    },
  );

  it.each(["approve", "reject"] as const)(
    "sends no %s once the server's plan changed under the alert",
    (decision) => {
      const changed = gateOf({ deliveries: [delivery("d1", { plan: EDITED })] });
      expect(targetOf(changed, decision, openedFor)).toBeNull();
    },
  );

  it.each(["approve", "reject"] as const)(
    "sends no %s once the gate is gone or no longer offers it",
    (decision) => {
      expect(targetOf(null, decision, openedFor)).toBeNull();
      expect(
        targetOf(
          gateOf({ deliveries: [delivery("d1", { status: "cancelled" })] }),
          decision,
          openedFor,
        ),
      ).toBeNull();
      expect(targetOf(gateOf({ connectionState: "reconnecting" }), decision, openedFor)).toBeNull();
      expect(targetOf(gateOf({ permitted: NONE_GRANTED }), decision, openedFor)).toBeNull();
      expect(targetOf(gateOf({ planning: false }), decision, openedFor)).toBeNull();
    },
  );

  it("sends a decision only it was opened for while its own grant holds", () => {
    const rejectOnly = gateOf({ permitted: { ...NONE_GRANTED, reject: true } });
    expect(targetOf(rejectOnly, "approve", openedFor)).toBeNull();
    expect(targetOf(rejectOnly, "reject", openedFor)).not.toBeNull();
  });
});

describe("mobileReplanRequest", () => {
  it.each([
    ["an empty note", ""],
    ["a whitespace-only note", "  \n\t "],
    ["a note past its bound", "x".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH + 1)],
  ])("refuses %s before sending", (_, note) => {
    expect(mobileReplanRequest(gateOf(), D1, note)._tag).toBe("Invalid");
  });

  it("sends the trimmed note to the gate's own environment and delivery", () => {
    const gate = gateOf({ environmentId: EnvironmentId.make("env-b") });
    expect(mobileReplanRequest(gate, D1, "  Split the export into two tasks. ")).toEqual({
      _tag: "Send",
      request: {
        environmentId: EnvironmentId.make("env-b"),
        input: { deliveryId: D1, note: "Split the export into two tasks." },
      },
    });
    const longest = "x".repeat(FACTORY_REPLAN_NOTE_MAX_LENGTH);
    expect(mobileReplanRequest(gate, D1, longest)._tag).toBe("Send");
  });

  it("sends nothing once the gate is gone, replaced or no longer offers replan", () => {
    const note = "Split the export.";
    expect(mobileReplanRequest(null, D1, note)._tag).toBe("Unavailable");
    expect(mobileReplanRequest(gateOf({ deliveries: replacedBy() }), D1, note)._tag).toBe(
      "Unavailable",
    );
    expect(mobileReplanRequest(gateOf({ connectionState: "offline" }), D1, note)._tag).toBe(
      "Unavailable",
    );
    expect(
      mobileReplanRequest(gateOf({ permitted: { ...GRANTED, replan: false } }), D1, note)._tag,
    ).toBe("Unavailable");
  });
});
