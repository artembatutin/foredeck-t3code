import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  cancelConfirmationTarget,
  type FactoryControlPermissions,
  factoryDeliveryView,
  type FactoryDeliveryView,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

/** What the Work item screen's Factory section reads of the item's environment. */
export interface MobileFactoryDestination {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  /** The environment's connection on this device; undefined when the device does not know it. */
  readonly connectionState: EnvironmentConnectionPhase | undefined;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  readonly permitted: FactoryControlPermissions;
}

/**
 * The item's current delivery as the section shows it, or null: the shared section view, with
 * controls only while the environment is connected. Reconnecting, a reconnect's backoff included,
 * offers nothing, though the deliveries read before still show.
 */
export const mobileFactorySection = (input: MobileFactoryDestination): FactoryDeliveryView | null =>
  factoryDeliveryView({ ...input, connected: input.connectionState === "connected" });

/**
 * What confirming a cancel opened for `openedFor` cancels, read when the owner confirms: that
 * delivery while it is still current and cancellable in `view`, otherwise null and nothing is
 * cancelled. A native alert cannot close itself when the delivery changes, so the press checks.
 */
export const mobileCancelTarget = (
  view: FactoryDeliveryView | null,
  openedFor: FactoryDeliveryId,
): FactoryDeliveryId | null => cancelConfirmationTarget(view, openedFor);
