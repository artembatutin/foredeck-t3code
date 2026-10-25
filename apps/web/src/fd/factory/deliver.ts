import { currentDelivery } from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryStartInput } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

/** Shown when a start is refused because the project has no verify command. */
export const FACTORY_NOT_CONFIGURED_TEXT =
  "Set a verify command in Project settings → Factory before delivering this item.";

const FALLBACK_ERROR_TEXT = "Factory could not complete the request. Try again.";

/**
 * The text a failed Factory command shows: fixed text naming the settings path for a missing
 * verify command, a Factory error's own fixed message otherwise (a newer server's unknown reasons
 * included), and the failure's message for anything else.
 */
export function factoryErrorText(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause)) as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (error !== null && typeof error === "object" && error._tag === "FactoryError") {
    if (error.reason === "not_configured") return FACTORY_NOT_CONFIGURED_TEXT;
    return typeof error.message === "string" && error.message.trim().length > 0
      ? error.message
      : FALLBACK_ERROR_TEXT;
  }
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : FALLBACK_ERROR_TEXT;
}

/** An item to deliver, on the environment and in the project that own it. */
export interface FactoryDeliverTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly itemRef: WorkItemRef;
}

/** A delivery a start in this session returned, with the environment that returned it. */
export interface FactoryStartedDelivery {
  readonly environmentId: EnvironmentId;
  readonly delivery: FactoryDelivery;
}

/** What the Deliver rule reads of one item's destination. */
export interface FactoryDeliverInput {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly supported: boolean;
  readonly connected: boolean;
  /** Whether this session holds the start grant on the destination. */
  readonly startPermitted: boolean;
  /** The project's deliveries on the destination; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  /** Every delivery a start in this session returned, on any environment. */
  readonly started: ReadonlyArray<FactoryStartedDelivery>;
}

const sameItem = (left: WorkItemRef, right: WorkItemRef) =>
  left.sourceId === right.sourceId && left.itemId === right.itemId;

/** Records a start's delivery, replacing an earlier start of the same item on that environment. */
export const recordStarted = (
  started: ReadonlyArray<FactoryStartedDelivery>,
  environmentId: EnvironmentId,
  delivery: FactoryDelivery,
): ReadonlyArray<FactoryStartedDelivery> => [
  ...started.filter(
    (entry) =>
      entry.environmentId !== environmentId || !sameItem(entry.delivery.itemRef, delivery.itemRef),
  ),
  { environmentId, delivery },
];

/**
 * The project's deliveries with the item's just-started delivery added until the list holds it,
 * so the item does not look free between a start and the refetch it causes. Starts on other
 * environments never count.
 */
export const deliveriesWithStarted = (
  input: Pick<FactoryDeliverInput, "environmentId" | "itemRef" | "deliveries" | "started">,
): ReadonlyArray<FactoryDelivery> | null => {
  const { deliveries } = input;
  if (deliveries === null) return null;
  const started = input.started.find(
    (entry) =>
      entry.environmentId === input.environmentId &&
      sameItem(entry.delivery.itemRef, input.itemRef),
  )?.delivery;
  return started === undefined ||
    deliveries.some((delivery) => delivery.deliveryId === started.deliveryId)
    ? deliveries
    : [started, ...deliveries];
};

const isTerminal = (delivery: FactoryDelivery) =>
  delivery.status === "done" || delivery.status === "cancelled";

/**
 * Whether Deliver is offered for an item, the one rule of every Deliver entry point: the
 * destination advertises Factory, is connected, the session holds the start grant, the project's
 * deliveries have loaded, and no delivery of the item is open. A status this build does not know
 * counts as open, and so does a delivery a start just returned until the list holds it.
 */
export const factoryDeliverable = (input: FactoryDeliverInput): boolean => {
  if (!input.supported || !input.connected || !input.startPermitted) return false;
  const deliveries = deliveriesWithStarted(input);
  if (deliveries === null) return false;
  const current = currentDelivery(deliveries, input.itemRef);
  return current === undefined || isTerminal(current);
};

/** The start command a Deliver entry point sends for its item. */
export const factoryStartRequest = (
  target: FactoryDeliverTarget,
): { readonly environmentId: EnvironmentId; readonly input: FactoryDeliveryStartInput } => ({
  environmentId: target.environmentId,
  input: { itemRef: target.itemRef },
});
