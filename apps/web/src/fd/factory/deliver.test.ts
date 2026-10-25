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
  factoryDeliverable,
  factoryErrorText,
  factoryStartRequest,
  recordStarted,
} from "./deliver";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectId = ProjectId.make("p1");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const otherRef = { sourceId, itemId: WorkItemId.make("fd-9x1zz0") };

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId,
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

const decodeFactoryError = Schema.decodeUnknownSync(FactoryError);

const input = (overrides: Partial<FactoryDeliverInput> = {}): FactoryDeliverInput => ({
  environmentId: envA,
  itemRef,
  supported: true,
  connected: true,
  startPermitted: true,
  deliveries: [],
  started: [],
  ...overrides,
});

describe("factoryDeliverable", () => {
  const cases: ReadonlyArray<readonly [string, Partial<FactoryDeliverInput>, boolean]> = [
    ["an item without deliveries", {}, true],
    ["a server without Factory", { supported: false }, false],
    ["a disconnected destination", { connected: false }, false],
    ["a session without the start grant", { startPermitted: false }, false],
    ["deliveries not loaded yet", { deliveries: null }, false],
    ["an open delivery", { deliveries: [delivery("d1", { status: "blocked" })] }, false],
    [
      "a delivery with an unknown status",
      { deliveries: [delivery("d1", { status: "unknown" })] },
      false,
    ],
    [
      "a terminal-only history",
      {
        deliveries: [
          delivery("d1", { status: "done" }),
          delivery("d2", { status: "cancelled", createdAt: "2026-10-22T09:00:00.000Z" }),
        ],
      },
      true,
    ],
    [
      "an open delivery behind a newer terminal one",
      {
        deliveries: [
          delivery("d1", { status: "stopped" }),
          delivery("d2", { status: "cancelled", createdAt: "2026-10-22T09:00:00.000Z" }),
        ],
      },
      false,
    ],
    [
      "a just-started delivery the list does not hold yet",
      {
        deliveries: [delivery("d1", { status: "done" })],
        started: [{ environmentId: envA, delivery: delivery("d2", { status: "queued" }) }],
      },
      false,
    ],
    [
      "a just-started delivery the list now holds as cancelled",
      {
        deliveries: [delivery("d2", { status: "cancelled" })],
        started: [{ environmentId: envA, delivery: delivery("d2", { status: "queued" }) }],
      },
      true,
    ],
    [
      "a just-started delivery of the same item on another environment",
      { started: [{ environmentId: envB, delivery: delivery("d2", { status: "queued" }) }] },
      true,
    ],
    [
      "another item's open delivery",
      {
        deliveries: [delivery("d1", { itemRef: otherRef })],
        started: [{ environmentId: envA, delivery: delivery("d2", { itemRef: otherRef }) }],
      },
      true,
    ],
  ];

  it.each(cases)("with %s", (_name, overrides, offered) => {
    expect(factoryDeliverable(input(overrides))).toBe(offered);
  });
});

describe("recordStarted", () => {
  it("keeps one start per item and environment, the latest", () => {
    const first = delivery("d1", { status: "queued" });
    const second = delivery("d2", { status: "queued" });
    const onB = delivery("d3", { status: "queued" });
    const started = recordStarted(
      recordStarted(recordStarted([], envA, first), envB, onB),
      envA,
      second,
    );
    expect(started).toEqual([
      { environmentId: envB, delivery: onB },
      { environmentId: envA, delivery: second },
    ]);
  });
});

describe("factoryStartRequest", () => {
  it("starts the target's item on the target's environment", () => {
    expect(factoryStartRequest({ environmentId: envB, projectId, itemRef })).toEqual({
      environmentId: envB,
      input: { itemRef },
    });
  });
});

describe("factoryErrorText", () => {
  const failure = (reason: FactoryError["reason"], message: string) =>
    Cause.fail(new FactoryError({ reason, message }));

  it("names Project settings → Factory when the project has no verify command", () => {
    const text = factoryErrorText(
      failure(
        "not_configured",
        "Set a verify command in the project's Factory settings before starting a delivery.",
      ),
    );
    expect(text).toBe(FACTORY_NOT_CONFIGURED_TEXT);
    expect(text).toContain("Project settings → Factory");
  });

  it("shows a Factory error's own fixed message for other reasons", () => {
    const conflict = "This Work item already has a Factory delivery that is not done or cancelled.";
    expect(factoryErrorText(failure("conflict", conflict))).toBe(conflict);
    const refused = "Only a running delivery can stop after its step; this one is blocked.";
    expect(factoryErrorText(failure("refused", refused))).toBe(refused);
  });

  it("shows the message of a reason this build does not know", () => {
    const error = decodeFactoryError({
      _tag: "FactoryError",
      reason: "quota_exceeded",
      message: "Factory has too many deliveries running.",
    });
    expect(error.reason).toBe("unavailable");
    expect(factoryErrorText(Cause.fail(error))).toBe("Factory has too many deliveries running.");
  });

  it("falls back to fixed text when a failure carries no message", () => {
    const fallback = "Factory could not complete the request. Try again.";
    expect(factoryErrorText(failure("unavailable", "  "))).toBe(fallback);
    expect(factoryErrorText(Cause.die("boom"))).toBe(fallback);
    expect(factoryErrorText(Cause.fail(new Error("The connection closed.")))).toBe(
      "The connection closed.",
    );
  });
});
