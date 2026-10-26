import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { factoryFleet, type FactoryFleetEnvironment } from "./fleet.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");

const delivery = (
  id: string,
  createdAt: string,
  overrides: Partial<FactoryDelivery> = {},
): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId: projectA,
  itemRef: { sourceId, itemId: WorkItemId.make(`item-${id}`) },
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

const env = (
  environmentId: EnvironmentId,
  deliveries: ReadonlyArray<FactoryDelivery> | null,
  supported = true,
): FactoryFleetEnvironment => ({ environmentId, supported, deliveries });

const keys = (environments: ReadonlyArray<FactoryFleetEnvironment>) =>
  factoryFleet(environments).map((row) => row.key);

describe("factoryFleet", () => {
  it("lists active deliveries of both environments, needing you first, each group newest first", () => {
    const rows = factoryFleet([
      env(envA, [
        delivery("a-new", "2026-10-26T10:00:00.000Z", { stage: { name: "author", kind: "agent" } }),
        delivery("a-blocked", "2026-10-26T08:00:00.000Z", {
          status: "blocked",
          needsYou: "Verify failed twice with the same failure.",
        }),
        delivery("a-done", "2026-10-26T11:00:00.000Z", { status: "done" }),
      ]),
      env(envB, [
        delivery("b-waiting", "2026-10-26T09:00:00.000Z", {
          status: "waiting",
          projectId: projectB,
          stage: { name: "approve_plan", kind: "gate" },
        }),
        delivery("b-pr", "2026-10-26T07:00:00.000Z", { status: "pr_open" }),
        delivery("b-cancelled", "2026-10-26T12:00:00.000Z", { status: "cancelled" }),
      ]),
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      "env-b:b-waiting",
      "env-a:a-blocked",
      "env-a:a-new",
      "env-b:b-pr",
    ]);
    expect(rows[0]).toEqual({
      key: "env-b:b-waiting",
      environmentId: envB,
      deliveryId: "b-waiting",
      projectId: projectB,
      itemRef: { sourceId, itemId: "item-b-waiting" },
      status: "Waiting for you",
      stage: "Plan approval",
      // The server sent no reason, so the shared fallback stands.
      needsYou: "Factory is waiting for your decision.",
      readOnly: false,
    });
    expect(rows[1]!.needsYou).toBe("Verify failed twice with the same failure.");
    expect(rows[2]).toMatchObject({ status: "Running", stage: "Author", needsYou: undefined });
    expect(rows[3]).toMatchObject({ status: "PR open", needsYou: undefined });
  });

  it("orders ties the same whatever the input order", () => {
    const at = "2026-10-26T10:00:00.000Z";
    const first = [
      env(envA, [
        delivery("d1", at),
        delivery("d2", at),
        delivery("d3", at, { status: "blocked" }),
      ]),
      env(envB, [delivery("d1", at), delivery("d3", at, { status: "blocked" })]),
    ];
    const reversed = first
      .map((entry) => env(entry.environmentId, (entry.deliveries ?? []).toReversed()))
      .toReversed();
    const expected = ["env-a:d3", "env-b:d3", "env-a:d2", "env-a:d1", "env-b:d1"];
    expect(keys(first)).toEqual(expected);
    expect(keys(reversed)).toEqual(expected);
  });

  it("keeps a delivery with an unknown status or stage listed, read-only", () => {
    const rows = factoryFleet([
      env(envA, [
        delivery("unknown-status", "2026-10-26T10:00:00.000Z", { status: "unknown" }),
        delivery("unknown-stage", "2026-10-26T09:00:00.000Z", {
          stage: { name: "unknown", kind: "unknown" },
        }),
        delivery("unstarted", "2026-10-26T08:00:00.000Z", { status: "queued" }),
      ]),
    ]);
    expect(rows).toMatchObject([
      { key: "env-a:unknown-status", status: "Unknown", needsYou: undefined, readOnly: true },
      { key: "env-a:unknown-stage", stage: "Unknown stage", readOnly: true },
      { key: "env-a:unstarted", status: "Queued", stage: undefined, readOnly: false },
    ]);
  });

  it("adds nothing for an environment without Factory or before its deliveries load", () => {
    const listed = [delivery("d1", "2026-10-26T10:00:00.000Z", { status: "blocked" })];
    expect(keys([env(envA, listed, false), env(envB, null)])).toEqual([]);
    expect(keys([env(envA, listed, false), env(envB, listed)])).toEqual(["env-b:d1"]);
  });
});
