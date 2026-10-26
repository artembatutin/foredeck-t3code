import type { FactoryFleetRow, FactoryFleetState } from "@t3tools/client-runtime/fd/factory";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";

/**
 * Where a fleet row leads: its item in the Work page, in the delivery's own project, through the
 * search Work's page already reads, so Work needs nothing from Factory.
 */
export const factoryFleetRowTarget = (
  row: Pick<FactoryFleetRow, "environmentId" | "projectId" | "itemRef">,
) => ({
  to: "/work" as const,
  search: {
    project: scopedProjectKey(scopeProjectRef(row.environmentId, row.projectId)),
    item: workItemRefString(row.itemRef),
  },
});

/** What the Factory page says about its servers, beside the rows. */
export interface FactoryFleetNotices {
  /** False only when no environment advertises Factory, connected or not. */
  readonly available: boolean;
  /** Names the connected Factory servers whose deliveries could not be read. */
  readonly failed: string | null;
  /** Names the Factory servers that are not connected, whose deliveries are not shown. */
  readonly disconnected: string | null;
  /** What an empty list says; nothing while no Factory server is connected to read. */
  readonly empty: string | null;
}

/** Words the fleet's state, naming servers by their labels (an id stands in for a missing one). */
export function factoryFleetNotices(
  fleet: Pick<FactoryFleetState, "environments" | "failed" | "disconnected">,
  labels: ReadonlyMap<EnvironmentId, string>,
): FactoryFleetNotices {
  const names = (environmentIds: ReadonlyArray<EnvironmentId>) =>
    environmentIds.map((environmentId) => labels.get(environmentId) ?? environmentId).join(", ");
  return {
    available: fleet.environments.length > 0 || fleet.disconnected.length > 0,
    failed:
      fleet.failed.length === 0 ? null : `Could not read deliveries on ${names(fleet.failed)}.`,
    disconnected:
      fleet.disconnected.length === 0
        ? null
        : `Not connected to ${names(fleet.disconnected)}; ${
            fleet.disconnected.length === 1 ? "its" : "their"
          } deliveries are not shown.`,
    empty: fleet.environments.length > 0 ? "No active deliveries." : null,
  };
}
