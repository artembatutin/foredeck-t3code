import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryError,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_NOT_CONFIGURED_TEXT,
  type FactoryDeliverInput,
  type FactoryDeliverTarget,
  type FactoryDeliveryKind,
  factoryDeliverable,
  factoryErrorText,
  factoryParentDeliverable,
  factoryStartRequest,
} from "./deliver";
import { factoryPaletteActions } from "./palette";

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const target: FactoryDeliverTarget = { environmentId, projectId, itemRef };

const delivery = (overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make("d1"),
  projectId,
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

const input = (overrides: Partial<FactoryDeliverInput> = {}): FactoryDeliverInput => ({
  environmentId,
  itemRef,
  supported: true,
  planning: true,
  connected: true,
  startPermitted: true,
  deliveries: [],
  started: [],
  ...overrides,
});

const decodeError = Schema.decodeSync(FactoryError);

/** The server's refusal to plan a parent outside a Markdown source, as it reaches a client. */
const NOT_MARKDOWN = decodeError({
  _tag: "FactoryError",
  reason: "unsupported_source",
  message:
    "Factory plans a parent item only from a Markdown Work source, which can hold its child items. Deliver it as a single item instead.",
});
const FALLBACK = "Factory could not complete the request. Try again.";

describe("Deliver as parent", () => {
  it("is offered where Deliver is and the destination plans", () => {
    expect(factoryParentDeliverable(input())).toBe(true);
    expect(factoryParentDeliverable(input({ deliveries: [delivery({ status: "done" })] }))).toBe(
      true,
    );
  });

  it("is not offered without planning, where Deliver alone still is", () => {
    // A server from before planning, and a caller that does not say.
    const { planning: _planning, ...unsaid } = input();
    for (const destination of [input({ planning: false }), unsaid]) {
      expect(factoryParentDeliverable(destination)).toBe(false);
      expect(factoryDeliverable(destination)).toBe(true);
    }
  });

  it.each<[string, Partial<FactoryDeliverInput>]>([
    ["without Factory", { supported: false }],
    ["without a live connection", { connected: false }],
    ["without the start grant", { startPermitted: false }],
    ["before the deliveries load", { deliveries: null }],
    ["while the item has an open delivery", { deliveries: [delivery()] }],
    [
      "while a start just returned a delivery",
      { started: [{ environmentId, delivery: delivery() }] },
    ],
  ])("is not offered %s", (_name, overrides) => {
    expect(factoryParentDeliverable(input(overrides))).toBe(false);
  });

  it("starts the item as a parent, and a single start names no kind", () => {
    expect(factoryStartRequest(target, "parent")).toEqual({
      environmentId,
      input: { itemRef, kind: "parent" },
    });
    expect(factoryStartRequest(target)).toEqual({ environmentId, input: { itemRef } });
    expect(factoryStartRequest(target, "single")).toEqual({ environmentId, input: { itemRef } });
  });

  it("is a palette action of its own where the destination plans", async () => {
    const delivered: Array<[FactoryDeliverTarget, FactoryDeliveryKind]> = [];
    const actionsWith = (planning: boolean) =>
      factoryPaletteActions({
        openItem: { ...target, key: "FD-12" },
        destination: { ...input({ planning }) },
        deliver: async (to, kind) => {
          delivered.push([to, kind]);
        },
      });
    expect(actionsWith(false).map((action) => action.title)).toEqual(["Deliver work item"]);
    const actions = actionsWith(true);
    expect(actions.map((action) => action.title)).toEqual([
      "Deliver work item",
      "Deliver work item as parent",
    ]);
    for (const action of actions) await action.run();
    expect(delivered).toEqual([
      [target, "single"],
      [target, "parent"],
    ]);
  });
});

describe("factoryErrorText", () => {
  it("shows the refusal to plan a parent outside a Markdown source as the server wrote it", () => {
    expect(factoryErrorText(Cause.fail(NOT_MARKDOWN))).toBe(NOT_MARKDOWN.message);
  });

  it("shows other Factory errors' fixed text, with the settings path for a missing verify command", () => {
    const refused = new FactoryError({
      reason: "refused",
      message: "Only a delivery waiting at the plan gate can have its plan approved.",
    });
    expect(factoryErrorText(Cause.fail(refused))).toBe(refused.message);
    const newer = decodeError({
      _tag: "FactoryError",
      reason: "quota_exceeded",
      message: "Factory is busy. Try again later.",
    });
    expect(newer.reason).toBe("unavailable");
    expect(factoryErrorText(Cause.fail(newer))).toBe("Factory is busy. Try again later.");
    expect(
      factoryErrorText(
        Cause.fail(new FactoryError({ reason: "not_configured", message: "Set it." })),
      ),
    ).toBe(FACTORY_NOT_CONFIGURED_TEXT);
  });

  it("falls back to fixed text for an error it cannot read", () => {
    expect(
      factoryErrorText(Cause.fail(new FactoryError({ reason: "refused", message: " " }))),
    ).toBe(FALLBACK);
    expect(factoryErrorText(Cause.fail({ reason: "refused" }))).toBe(FALLBACK);
    expect(factoryErrorText(Cause.die("socket closed"))).toBe(FALLBACK);
    expect(factoryErrorText(Cause.die(new Error("The connection closed.")))).toBe(
      "The connection closed.",
    );
  });
});
