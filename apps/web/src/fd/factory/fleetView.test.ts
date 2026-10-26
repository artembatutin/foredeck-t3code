import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { factoryFleetNotices, factoryFleetRowTarget } from "./fleetView";

describe("factoryFleetRowTarget", () => {
  it("opens the row's item in the Work page of the delivery's project", () => {
    const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
    expect(
      factoryFleetRowTarget({
        environmentId: EnvironmentId.make("env-b"),
        projectId: ProjectId.make("project-b"),
        itemRef: { sourceId, itemId: WorkItemId.make("fd-7k3qa2") },
      }),
    ).toEqual({
      to: "/work",
      search: {
        project: "env-b:project-b",
        item: "6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4:fd-7k3qa2",
      },
    });
  });
});

describe("factoryFleetNotices", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const envC = EnvironmentId.make("env-c");
  const labels = new Map([
    [envA, "Laptop"],
    [envB, "Server"],
  ]);
  const connected = (environmentId: EnvironmentId) => ({
    environmentId,
    supported: true,
    deliveries: [],
  });

  it("is not available only when no environment advertises Factory", () => {
    expect(factoryFleetNotices({ environments: [], failed: [], disconnected: [] }, labels)).toEqual(
      { available: false, failed: null, disconnected: null, empty: null },
    );
  });

  it("names a Factory server that is not connected, even when none is connected", () => {
    expect(
      factoryFleetNotices({ environments: [], failed: [], disconnected: [envB] }, labels),
    ).toEqual({
      available: true,
      failed: null,
      disconnected: "Not connected to Server; its deliveries are not shown.",
      // Nothing is read, so the list does not claim there are no deliveries.
      empty: null,
    });
  });

  it("names failed and disconnected servers beside the connected ones", () => {
    expect(
      factoryFleetNotices(
        { environments: [connected(envA), connected(envB)], failed: [envB], disconnected: [envC] },
        labels,
      ),
    ).toEqual({
      available: true,
      failed: "Could not read deliveries on Server.",
      // An id stands in for a server with no label.
      disconnected: "Not connected to env-c; its deliveries are not shown.",
      empty: "No active deliveries.",
    });
    expect(
      factoryFleetNotices(
        { environments: [connected(envC)], failed: [], disconnected: [envA, envB] },
        labels,
      ),
    ).toMatchObject({
      failed: null,
      disconnected: "Not connected to Laptop, Server; their deliveries are not shown.",
      empty: "No active deliveries.",
    });
  });
});
