import type { FactoryFleetRow } from "@t3tools/client-runtime/fd/factory";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
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
