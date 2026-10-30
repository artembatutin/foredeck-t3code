import {
  factoryFleet,
  type FactoryFleetEnvironment,
  type FactoryFleetRow,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/** The Work item screen's params for a row's item, so Work needs nothing from Factory. */
export interface MobileFleetTarget {
  readonly name: "WorkItem";
  readonly params: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly sourceId: string;
    readonly itemId: string;
  };
}

/** One row of the mobile Factory list. */
export interface MobileFleetRow {
  readonly key: string;
  /** The project's title, with its environment's label while more than one serves Factory. */
  readonly project: string;
  /** The Work item the delivery is for. */
  readonly item: string;
  readonly status: string;
  readonly stage: string | undefined;
  readonly needsYou: string | undefined;
  readonly capacityNote: string | undefined;
  readonly target: MobileFleetTarget;
}

/** What the list names projects and environments by; an id stands in for a missing name. */
export interface MobileFleetLabels {
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
  }>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
}

/** Where a fleet row leads: its item's Work item screen, whose Factory section shows the rest. */
export const mobileFleetRowTarget = (
  row: Pick<FactoryFleetRow, "environmentId" | "projectId" | "itemRef">,
): MobileFleetTarget => ({
  name: "WorkItem",
  params: {
    environmentId: row.environmentId,
    projectId: row.projectId,
    sourceId: row.itemRef.sourceId,
    itemId: row.itemRef.itemId,
  },
});

/**
 * The mobile list's rows: the shared fleet, in its order (needing you first, no done or
 * cancelled deliveries), each named for display and carrying where it leads.
 */
export function mobileFleetRows(
  environments: ReadonlyArray<FactoryFleetEnvironment>,
  labels: MobileFleetLabels,
): ReadonlyArray<MobileFleetRow> {
  const titles = new Map(
    labels.projects.map((project) => [
      JSON.stringify([project.environmentId, project.id]),
      project.title,
    ]),
  );
  const environmentLabels = new Map(
    labels.environments.map((entry) => [entry.environmentId, entry.environmentLabel]),
  );
  const multipleEnvironments = environments.filter((entry) => entry.supported).length > 1;
  return factoryFleet(environments).map((row) => {
    const title = titles.get(JSON.stringify([row.environmentId, row.projectId])) ?? row.projectId;
    return {
      key: row.key,
      project: multipleEnvironments
        ? `${title} · ${environmentLabels.get(row.environmentId) ?? row.environmentId}`
        : title,
      item: row.itemRef.itemId,
      status: row.status,
      stage: row.stage,
      needsYou: row.needsYou,
      capacityNote: row.capacityNote,
      target: mobileFleetRowTarget(row),
    };
  });
}
