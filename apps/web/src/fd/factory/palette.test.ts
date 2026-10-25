import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryDeliverTarget } from "./deliver";
import { factoryPaletteActions, type FactoryOpenItem } from "./palette";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const openOnA: FactoryOpenItem = {
  environmentId: envA,
  projectId: projectA,
  itemRef,
  key: "fd-7k3qa2",
};

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId: projectA,
  itemRef,
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
  ...overrides,
});

/** The palette's actions, and the targets its runs started. */
const palette = (
  openItem: FactoryOpenItem | null,
  destination: Partial<Parameters<typeof factoryPaletteActions>[0]["destination"]> = {},
) => {
  const delivered: Array<FactoryDeliverTarget> = [];
  const actions = factoryPaletteActions({
    openItem,
    destination: {
      supported: true,
      connected: true,
      startPermitted: true,
      deliveries: [],
      started: [],
      ...destination,
    },
    deliver: async (target) => {
      delivered.push(target);
    },
  });
  return { actions, delivered };
};

describe("factoryPaletteActions", () => {
  it("offers nothing while no Work item detail is open", () => {
    expect(palette(null).actions).toEqual([]);
  });

  it("offers nothing while the open item has an open delivery on its environment", () => {
    expect(palette(openOnA, { deliveries: [delivery("d1")] }).actions).toEqual([]);
    expect(
      palette(openOnA, { deliveries: [delivery("d1", { status: "unknown" })] }).actions,
    ).toEqual([]);
    // Started from another entry point, before the list holds it.
    expect(
      palette(openOnA, { started: [{ environmentId: envA, delivery: delivery("d2") }] }).actions,
    ).toEqual([]);
  });

  it("offers nothing where the shared rule refuses", () => {
    expect(palette(openOnA, { supported: false }).actions).toEqual([]);
    expect(palette(openOnA, { connected: false }).actions).toEqual([]);
    expect(palette(openOnA, { startPermitted: false }).actions).toEqual([]);
    expect(palette(openOnA, { deliveries: null }).actions).toEqual([]);
  });

  it("delivers the open item on its own environment and project", async () => {
    const { actions, delivered } = palette(openOnA, {
      deliveries: [delivery("d1", { status: "done" })],
    });
    expect(actions.map((action) => action.title)).toEqual(["Deliver work item"]);
    await actions[0]!.run();
    expect(delivered).toEqual([{ environmentId: envA, projectId: projectA, itemRef }]);
  });

  it("is not held back by deliveries of the same item on another environment", async () => {
    const { actions, delivered } = palette(openOnA, {
      started: [{ environmentId: envB, delivery: delivery("d-b") }],
    });
    expect(actions).toHaveLength(1);
    await actions[0]!.run();
    expect(delivered).toEqual([{ environmentId: envA, projectId: projectA, itemRef }]);
  });
});
