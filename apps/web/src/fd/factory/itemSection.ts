import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  cancelConfirmationTarget as deliveryCancelTarget,
  type FactoryControlPermissions,
  factoryDeliveryView,
  type FactoryDeliveryView,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

import { buildThreadRouteParams } from "../../threadRoutes";
import { deliveriesWithStarted, factoryDeliverable, type FactoryStartedDelivery } from "./deliver";

export type { FactoryReviewLine } from "@t3tools/client-runtime/fd/factory";

/** Whether this session holds each command's grant where the destination serves Factory. */
export interface FactoryItemPermissions extends FactoryControlPermissions {
  readonly start: boolean;
}

export interface FactoryItemSectionView {
  readonly deliver: boolean;
  readonly delivery: FactoryDeliveryView | null;
}

/**
 * What a Work item's Factory section shows, or null when it shows nothing: on a server without
 * Factory, before the project's deliveries load, and for an item with no delivery the session
 * cannot start. Deliver follows `factoryDeliverable`, the rule every Deliver entry point shares;
 * the delivery is the shared section view, with each thread as this client's route params.
 */
export function factoryItemSection(input: {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  readonly connected: boolean;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  /** Every delivery a start in this session returned, counted until the list holds it. */
  readonly started: ReadonlyArray<FactoryStartedDelivery>;
  readonly permitted: FactoryItemPermissions;
}): FactoryItemSectionView | null {
  const deliveries = deliveriesWithStarted(input);
  if (!input.supported || deliveries === null) return null;
  const deliver = factoryDeliverable({ ...input, startPermitted: input.permitted.start });
  const delivery = factoryDeliveryView({ ...input, deliveries });
  if (delivery === null) return deliver ? { deliver, delivery: null } : null;
  return {
    deliver,
    delivery: {
      ...delivery,
      timeline: delivery.timeline.map((row) => ({
        ...row,
        thread:
          row.thread === null
            ? null
            : buildThreadRouteParams(scopeThreadRef(row.thread.environmentId, row.thread.threadId)),
      })),
    },
  };
}

/** The delivery an open cancel confirmation cancels; see the shared `cancelConfirmationTarget`. */
export const cancelConfirmationTarget = (
  view: FactoryItemSectionView | null,
  openedFor: FactoryDeliveryId | null,
): FactoryDeliveryId | null => deliveryCancelTarget(view?.delivery ?? null, openedFor);
