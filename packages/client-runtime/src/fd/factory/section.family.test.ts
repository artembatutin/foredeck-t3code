import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDelivery as FactoryDeliverySchema,
  FactoryDeliveryId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import { FACTORY_CANCEL_TEXT, factoryDeliveryFamily, factoryDeliveryView } from "./section.ts";

const environmentId = EnvironmentId.make("env-1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const decodeDelivery = Schema.decodeUnknownSync(FactoryDeliverySchema);
const PARENT = FactoryDeliveryId.make("parent-1");
const CHILDREN = [FactoryDeliveryId.make("child-1"), FactoryDeliveryId.make("child-2")];

const delivery = (overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make("d1"),
  projectId: ProjectId.make("p1"),
  itemRef,
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:00:00.000Z",
  ...overrides,
});

const familyShown = (overrides: Partial<FactoryDelivery>) =>
  factoryDeliveryView({
    environmentId,
    itemRef,
    supported: true,
    connected: true,
    deliveries: [delivery(overrides)],
    permitted: { stop: true, resume: true, cancel: true },
  })?.family;

describe("a delivery's family", () => {
  it("is single for a delivery on its own, as every server from before planning sends it", () => {
    const older = decodeDelivery({
      deliveryId: "d1",
      projectId: "p1",
      itemRef,
      childIds: [],
      status: "running",
      rounds: { fix: 0, review: 0 },
      threads: {},
      receipts: [],
      reviews: [],
      createdAt: "2026-10-25T09:00:00.000Z",
      updatedAt: "2026-10-25T09:00:00.000Z",
    });
    expect(factoryDeliveryFamily(older)).toBe("single");
    expect(familyShown({})).toBe("single");
    // A parent still planning has no child deliveries yet, so cancelling it ends it alone.
    expect(familyShown({ status: "waiting", stage: { name: "approve_plan", kind: "gate" } })).toBe(
      "single",
    );
  });

  it("is parent once an approved plan gave it child deliveries, and child for each of them", () => {
    expect(familyShown({ childIds: CHILDREN })).toBe("parent");
    expect(familyShown({ parentId: PARENT })).toBe("child");
  });
});

describe("FACTORY_CANCEL_TEXT", () => {
  it("keeps the wording of a delivery on its own", () => {
    expect(FACTORY_CANCEL_TEXT.single).toBe(
      "Its agents stop what they are working on and the delivery ends. Its branch, worktree and commits stay; delivering the item again starts on a new branch.",
    );
  });

  it("says what else a parent's or a child's cancel ends, and what stays", () => {
    expect(FACTORY_CANCEL_TEXT.parent).toContain(
      "and so does each of its child deliveries not yet approved",
    );
    expect(FACTORY_CANCEL_TEXT.child).toContain(
      "Cancelling it ends it, its parent and each of the parent's other child deliveries not yet approved",
    );
    for (const text of [FACTORY_CANCEL_TEXT.parent, FACTORY_CANCEL_TEXT.child]) {
      expect(text).toContain("Approved children keep their approval.");
      expect(text).toMatch(/branch, worktree and commits stay/);
    }
  });
});
