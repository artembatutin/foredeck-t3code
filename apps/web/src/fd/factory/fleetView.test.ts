import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { factoryFleetRowTarget } from "./fleetView";

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
