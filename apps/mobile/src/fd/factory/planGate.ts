import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  type FactoryPlanConfirmed,
  type FactoryPlanDecision,
  factoryPlanDecision,
  factoryPlanDraft,
  type FactoryPlanGate,
  factoryPlanGate,
  type FactoryPlanGateActions,
  factoryPlanGateActions,
  type FactoryPlanGatePermissions,
  factoryReplanRequest,
  type FactoryReplanRequest,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryDeliveryRefInput,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

/** What the Work item screen's plan gate reads of the item's environment. */
export interface MobilePlanGateInput {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  /** Whether this client's view of the server's config advertises Factory planning. */
  readonly planning: boolean;
  /** The environment's connection on this device; undefined when the device does not know it. */
  readonly connectionState: EnvironmentConnectionPhase | undefined;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  readonly permitted: Omit<FactoryPlanGatePermissions, "update">;
}

/**
 * The plan gate of the item's current delivery, or null; see the shared `factoryPlanGate`. Its
 * actions are offered only while the environment is connected. The plan shows read-only here, so
 * no edit is offered.
 */
export const mobilePlanGate = (input: MobilePlanGateInput): FactoryPlanGate | null =>
  factoryPlanGate({
    ...input,
    connected: input.connectionState === "connected",
    permitted: { ...input.permitted, update: false },
  });

/** The plan as the gate shows it: the server's, unedited, so approving approves what shows. */
const shown = (gate: FactoryPlanGate) => factoryPlanDraft(gate.destination, gate.plan);

/** Which of approve, reject and replan the gate offers now. */
export const mobilePlanActions = (gate: FactoryPlanGate): FactoryPlanGateActions =>
  factoryPlanGateActions(gate, shown(gate));

/**
 * What confirming an approve or reject alert opened for `openedFor` sends, read when the owner
 * presses it: the decision for the gate's own delivery while that is still the delivery the alert
 * was opened for, its server still holds the plan the alert showed and the gate still offers the
 * decision. Otherwise null and nothing is sent. A native alert cannot close itself when the gate
 * changes, so the press checks.
 */
export const mobilePlanDecisionTarget = (
  gate: FactoryPlanGate | null,
  decision: FactoryPlanDecision,
  openedFor: FactoryPlanConfirmed,
): { readonly environmentId: EnvironmentId; readonly input: FactoryDeliveryRefInput } | null => {
  if (gate === null) return null;
  const outcome = factoryPlanDecision(gate, shown(gate), decision, openedFor);
  return outcome._tag === "Send" ? outcome.request : null;
};

/**
 * What sending a replan note written for `writtenFor` sends: the shared request for the gate's own
 * delivery, refused while the note is blank or past its bound, and unavailable once the gate is
 * gone, belongs to another delivery or no longer offers replan.
 */
export const mobileReplanRequest = (
  gate: FactoryPlanGate | null,
  writtenFor: FactoryDeliveryId,
  note: string,
): FactoryReplanRequest =>
  gate === null || gate.destination.deliveryId !== writtenFor
    ? { _tag: "Unavailable" }
    : factoryReplanRequest(gate, note);
