import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryDeliveryListInput,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

import {
  FACTORY_STAGE_LABELS,
  FACTORY_STATUS_LABELS,
  factoryCapacityNote,
  type FactoryItemFact,
  factoryItemFacts,
  factoryNeedsYou,
  factoryNextAction,
  type FactoryNextAction,
} from "./model.ts";

/**
 * What the fleet reads of each environment: only deliveries not done or cancelled, so ended ones
 * with their receipts, reviews and attempts never cross the wire. A server older than the filter
 * lists every delivery, and `factoryFleet` drops the ended ones itself.
 */
export const FACTORY_FLEET_INPUT: FactoryDeliveryListInput = { activeOnly: true };

/** One environment's part of the fleet: whether it serves Factory, and its deliveries once read. */
export interface FactoryFleetEnvironment {
  readonly environmentId: EnvironmentId;
  readonly supported: boolean;
  /** Every delivery of the environment, as the server lists them; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
}

/** One active delivery of the fleet, on the environment that owns it. */
export interface FactoryFleetRow {
  /** Unique across environments: `<environmentId>:<deliveryId>`. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly deliveryId: FactoryDeliveryId;
  readonly projectId: ProjectId;
  readonly itemRef: WorkItemRef;
  /** Its Work item's title, or its id when its source could not be read. */
  readonly title: string;
  /** What it comes to now, read from its current state. */
  readonly nextAction: FactoryNextAction;
  /** The item's status, queue priority, assignee and delivery, each labelled as itself. */
  readonly facts: ReadonlyArray<FactoryItemFact>;
  readonly status: string;
  /** The current stage; undefined before the first stage starts. */
  readonly stage: string | undefined;
  /** Why it waits on its owner; undefined when it does not. */
  readonly needsYou: string | undefined;
  /** That it waits for a project assistant slot, which asks nothing of its owner. */
  readonly capacityNote: string | undefined;
  /** The delivery's branch, once it has one. */
  readonly branch: string | undefined;
  /** When the delivery last changed, as the server reports it. */
  readonly updatedAt: string;
  /** A status or stage this build does not know: shown, but nothing is offered on it. */
  readonly readOnly: boolean;
}

interface Listed {
  readonly environmentId: EnvironmentId;
  readonly delivery: FactoryDelivery;
}

/** Newest first, then the greater id as the server lists them, then the environment. */
const compare = (left: Listed, right: Listed) => {
  const newer = Date.parse(right.delivery.createdAt) - Date.parse(left.delivery.createdAt);
  if (newer !== 0) return newer;
  if (left.delivery.deliveryId !== right.delivery.deliveryId) {
    return left.delivery.deliveryId > right.delivery.deliveryId ? -1 : 1;
  }
  return left.environmentId < right.environmentId
    ? -1
    : left.environmentId > right.environmentId
      ? 1
      : 0;
};

const row = ({ environmentId, delivery }: Listed): FactoryFleetRow => ({
  key: `${environmentId}:${delivery.deliveryId}`,
  environmentId,
  deliveryId: delivery.deliveryId,
  projectId: delivery.projectId,
  itemRef: delivery.itemRef,
  title: delivery.source?.title ?? delivery.itemRef.itemId,
  nextAction: factoryNextAction({
    status: delivery.status,
    needsYou: delivery.needsYou,
    child: delivery.parentId !== undefined,
    pullRequest: delivery.pullRequest,
    proceeding: delivery.proceeding,
  }),
  facts: factoryItemFacts({
    source: delivery.source,
    queuePriority: delivery.queuePriority,
    delivery: { status: delivery.status, stage: delivery.stage?.name },
  }),
  status: FACTORY_STATUS_LABELS[delivery.status],
  stage: delivery.stage === undefined ? undefined : FACTORY_STAGE_LABELS[delivery.stage.name],
  needsYou: factoryNeedsYou(delivery),
  capacityNote: factoryCapacityNote(delivery),
  branch: delivery.branch,
  updatedAt: delivery.updatedAt,
  readOnly:
    delivery.status === "unknown" ||
    delivery.stage?.name === "unknown" ||
    delivery.stage?.kind === "unknown",
});

/**
 * Every delivery not done or cancelled across the environments that serve Factory, the ones that
 * need their owner first and the rest after, each group newest first. The order never depends on
 * the order environments or deliveries arrive in. A delivery this build cannot fully read stays
 * listed, read-only, since it may still be running.
 */
export function factoryFleet(
  environments: ReadonlyArray<FactoryFleetEnvironment>,
): ReadonlyArray<FactoryFleetRow> {
  const listed: Array<Listed> = [];
  for (const { environmentId, supported, deliveries } of environments) {
    if (!supported || deliveries === null) continue;
    for (const delivery of deliveries) {
      // Older servers ignore `FACTORY_FLEET_INPUT`'s filter.
      if (delivery.status === "done" || delivery.status === "cancelled") continue;
      listed.push({ environmentId, delivery });
    }
  }
  const rows = listed.sort(compare).map(row);
  return [
    ...rows.filter((entry) => entry.needsYou !== undefined),
    ...rows.filter((entry) => entry.needsYou === undefined),
  ];
}
