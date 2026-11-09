import {
  FACTORY_PENDING_REASON_MAX,
  type FactoryPendingAction,
} from "@t3tools/contracts/fd/factory";
import type { ProjectId } from "@t3tools/contracts";
import { HOST_POLICY_ACTION, PLAN_GATE_ACTION } from "@t3tools/shared/fd/approvals";

import type { FactoryFamilyRequest } from "./FactoryActivity.ts";
import type { FactoryRuntimeModeRefusedError } from "./FactoryThreadEffects.ts";
import type * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";

/**
 * What a delivery itself waits on its owner for, which no provider request stands behind: its plan
 * gate, or a mode the provider's host policy refused. A refused launch has no thread yet, so it is
 * decided on the delivery's item; a refused turn on the thread that would have run it. A read of the
 * state it is given, so reading it writes nothing.
 */
export const ownerPendingActions = ({
  projectId,
  itemRef,
  state,
}: Pick<
  FactoryDeliveryStore.StoredFactoryDelivery,
  "projectId" | "itemRef" | "state"
>): ReadonlyArray<FactoryPendingAction> => {
  const onDelivery = {
    runClass: null,
    threadId: null,
    projectId,
    requestId: null,
    capability: "live" as const,
    item: itemRef,
  };
  if (state.status === "waiting") {
    return [{ ...onDelivery, kind: PLAN_GATE_ACTION, runtimeMode: null }];
  }
  const { block } = state;
  if (state.status !== "blocked" || block?.reason !== "effect_failed") return [];
  const { hostRefused } = block;
  if (hostRefused === undefined) return [];
  const { runtimeMode, threadId, ...refused } = hostRefused;
  return [
    {
      ...onDelivery,
      ...(threadId === undefined ? {} : { threadId }),
      kind: HOST_POLICY_ACTION,
      runtimeMode,
      refused,
    },
  ];
};

/**
 * An automatic turn the host refused, as clients read it: decided on its thread, whose mode is what
 * would have to change.
 */
export const refusedTurnPendingAction = (
  projectId: ProjectId,
  refusal: FactoryRuntimeModeRefusedError,
): FactoryPendingAction => {
  const { runtimeMode, threadId, provider, driver, detail, choose, alternatives } = refusal;
  return {
    kind: HOST_POLICY_ACTION,
    runClass: null,
    runtimeMode,
    threadId: threadId ?? null,
    projectId,
    requestId: null,
    capability: "live",
    refused: {
      provider,
      driver,
      ...(detail === undefined ? {} : { detail }),
      choose,
      alternatives,
    },
  };
};

/** What a delivery waits on, and the refused turns on threads not already shown refused by it. */
export const withRefusedTurns = (
  owner: ReadonlyArray<FactoryPendingAction>,
  refused: ReadonlyArray<FactoryPendingAction>,
): ReadonlyArray<FactoryPendingAction> => [
  ...owner,
  ...refused.filter(
    ({ threadId }) =>
      !owner.some((action) => action.kind === HOST_POLICY_ACTION && action.threadId === threadId),
  ),
];

/** A request pending on one of a delivery's threads, as clients read it. */
export const requestPendingAction = (request: FactoryFamilyRequest): FactoryPendingAction => ({
  kind: request.kind,
  runClass: request.run?.class ?? null,
  runtimeMode: request.runtimeMode,
  threadId: request.threadId,
  projectId: request.projectId,
  requestId: request.requestId,
  capability: request.capability,
  ...(request.reason === undefined
    ? {}
    : { reason: request.reason.slice(0, FACTORY_PENDING_REASON_MAX) }),
});
