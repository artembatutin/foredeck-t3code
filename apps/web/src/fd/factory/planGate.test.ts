import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryPlan,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { factoryItemPlanGate } from "./planGate";

const environmentId = EnvironmentId.make("env-a");
const otherEnvironment = EnvironmentId.make("env-b");
const projectId = ProjectId.make("project-a");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const PLAN = Schema.decodeSync(FactoryPlan)({
  tasks: [
    {
      id: "export-csv",
      title: "Export CSV",
      kind: "feature",
      summary: "Build export-csv.",
      acceptance: ["export-csv works."],
      testPlan: [{ criterion: 1, check: "export-csv is tested.", paths: ["src/csv.test.ts"] }],
      likelyPaths: ["src/csv.ts"],
      risk: "normal",
    },
  ],
});

const delivery = (id: string): FactoryDelivery => ({
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
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:10:00.000Z",
});

const gateOf = (overrides: Partial<Parameters<typeof factoryItemPlanGate>[0]>) =>
  factoryItemPlanGate({
    environmentId,
    itemRef,
    planning: true,
    connected: true,
    deliveries: [],
    started: [],
    permitted: { update: true, approve: true, reject: true, replan: true },
    ...overrides,
  });

describe("the plan gate of an item's section", () => {
  it("counts a delivery a start just returned until the list holds it", () => {
    expect(gateOf({ started: [{ environmentId, delivery: delivery("d2") }] })?.destination).toEqual(
      { environmentId, deliveryId: "d2" },
    );
    // A start on another environment never counts, and nothing shows before the list loads.
    expect(
      gateOf({ started: [{ environmentId: otherEnvironment, delivery: delivery("d2") }] }),
    ).toBeNull();
    expect(
      gateOf({ deliveries: null, started: [{ environmentId, delivery: delivery("d2") }] }),
    ).toBeNull();
  });
});
