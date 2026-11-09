import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  cancelConfirmationTarget,
  type FactoryControlPermissions,
  type FactoryDeliveryFamily,
  factoryDeliveryView,
  type FactoryDeliveryView,
  factoryPendingActionDestination,
  factoryPendingActionTarget,
} from "@t3tools/client-runtime/fd/factory";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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

interface MobileNamedEntity {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

/**
 * The section's pending actions with each one's target by name and where it is decided, since a
 * family's approvals otherwise read alike until they are opened. Names come from this environment.
 */
export const mobilePendingActionRows = (input: {
  readonly environmentId: EnvironmentId;
  readonly view: FactoryDeliveryView;
  readonly shownItem: WorkItemRef;
  readonly projects: ReadonlyArray<MobileNamedEntity>;
  readonly threads: ReadonlyArray<MobileNamedEntity>;
}) => {
  const titleIn = (entries: ReadonlyArray<MobileNamedEntity>, id: string) =>
    entries.find((entry) => entry.id === id && entry.environmentId === input.environmentId)?.title;
  return input.view.pendingActions.rows.map((row) => ({
    ...row,
    target: factoryPendingActionTarget(row, {
      project: (id) => titleIn(input.projects, id),
      thread: (id) => titleIn(input.threads, id),
    }),
    destination: factoryPendingActionDestination(row, input.shownItem),
  }));
};

/** What an open cancel confirmation was opened for: a delivery, and what it said cancelling ends. */
export interface MobileCancelConfirmation {
  readonly deliveryId: FactoryDeliveryId;
  readonly family: FactoryDeliveryFamily;
}

/**
 * What confirming a cancel opened for `openedFor` cancels, read when the owner confirms: that
 * delivery while it is still current, cancellable and of the family the confirmation described
 * in `view`, otherwise null and nothing is cancelled. A native alert cannot close itself when the
 * delivery changes, so the press checks; a parent whose plan was approved meanwhile now has
 * children its cancel would end, which the alert did not say.
 */
export const mobileCancelTarget = (
  view: FactoryDeliveryView | null,
  openedFor: MobileCancelConfirmation,
): FactoryDeliveryId | null =>
  view?.family === openedFor.family ? cancelConfirmationTarget(view, openedFor.deliveryId) : null;

/** A failed command's text: a Factory error's own fixed message, or a fallback. */
export function factoryCommandError(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Factory could not complete the request. Try again.";
}
