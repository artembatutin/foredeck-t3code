import { RpcScopeAuthorization } from "@t3tools/contracts";
import {
  FACTORY_WS_METHODS,
  type FactoryDeliveryId,
  FactoryError,
  FactoryRpcs,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { RpcInstrumentation } from "../../../observability/RpcInstrumentation.ts";
import type * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import type * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import type { WorkDomainError } from "../../work-management/index.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import type * as FactoryThreadEffects from "../FactoryThreadEffects.ts";
import type { FactoryBranchUnavailableError } from "../git/freshBranch.ts";
import type { FactoryStoreError } from "../persistence/errors.ts";
import type * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { toFactoryDelivery } from "../snapshot.ts";

/**
 * The Factory procedures with the server's middleware, in core's order (instrumentation wraps
 * authorization). `ws.ts` serves this layer beside its own and leaves these methods out of its
 * handler object, as it does Work's.
 */
const FactoryServerRpcGroup = RpcGroup.make(...FactoryRpcs)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

type FactoryHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof FactoryServerRpcGroup>>;

/** The methods `ws.ts` leaves out of its own handler layer. */
export const WS_METHOD_TAGS = Object.values(FACTORY_WS_METHODS);

/** What the Factory services fail with, as these handlers meet them. */
type FactoryServiceError =
  | WorkDomainError
  | FactorySettings.FactorySettingsStorageError
  | FactorySettings.FactoryUnknownPipelineError
  | FactorySettings.FactoryVerifyCommandMissingError
  | FactoryService.FactoryDeliveryIdError
  | FactoryService.FactoryDeliveryNotFoundError
  | FactoryService.FactoryStopRefusedError
  | FactoryService.FactoryResumeRefusedError
  | FactoryService.FactoryCancelRefusedError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryThreadEffects.FactoryProjectMissingError
  | FactoryBranchUnavailableError
  | FactoryStoreError
  | ThreadLaunch.ThreadLaunchBaseRefError
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | ServerRuntimeStartup.ServerRuntimeStartupError;

const STORAGE_FAILED = "Factory could not read or save its records. Try again.";

/**
 * The wire error for one service error: Factory's fixed text and bounded attributes, never a
 * cause. Work's errors keep their messages, which Work's own RPC sends as they are.
 */
const toFactoryError = (error: FactoryServiceError): FactoryError => {
  switch (error._tag) {
    case "FactoryVerifyCommandMissingError":
      return new FactoryError({
        reason: "not_configured",
        message:
          "Set a verify command in the project's Factory settings before starting a delivery.",
      });
    case "FactoryDeliveryActive":
      return new FactoryError({
        reason: "conflict",
        message: "This Work item already has a Factory delivery that is not done or cancelled.",
        deliveryId: error.deliveryId,
      });
    case "FactoryDeliveryNotFoundError":
      return new FactoryError({
        reason: "not_found",
        message: "This Factory delivery does not exist.",
        deliveryId: error.deliveryId,
      });
    case "FactoryStopRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `Only a running delivery can stop after its step; this one is ${error.status}.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryResumeRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `Only a stopping, stopped or blocked delivery can resume; this one is ${error.status}.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryCancelRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `This delivery is already ${error.status}, so it cannot be cancelled.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryProjectMissingError":
      return new FactoryError({
        reason: "not_found",
        message: "The item's project is not on this environment.",
      });
    case "ThreadLaunchBaseRefError":
      return new FactoryError({
        reason: "refused",
        message: "The project's checkout has no commit to start the delivery's worktree from.",
      });
    case "FactoryBranchUnavailableError":
      return new FactoryError({
        reason: "refused",
        message: "Factory found no free branch name for a new delivery of this item.",
      });
    case "FactoryUnknownPipelineError":
      return new FactoryError({
        reason: "invalid_request",
        message: "This server does not have the selected Factory pipeline.",
      });
    case "FactoryDeliveryIdError":
      return new FactoryError({
        reason: "unavailable",
        message: "Factory could not start the delivery. Try again.",
      });
    case "ServerRuntimeStartupError":
      return new FactoryError({
        reason: "unavailable",
        message: "The server failed to start, so Factory cannot run deliveries.",
      });
    case "FactoryStoreError":
    case "FactorySettingsStorageError":
    case "ProjectStoreV2Error":
    case "ProjectionStoreSetupError":
    case "ProjectionStoreApplyEventError":
    case "ProjectionStoreThreadNotFoundError":
    case "ProjectionStoreReadError":
      return new FactoryError({ reason: "unavailable", message: STORAGE_FAILED });
    case "WorkSourceNotFound":
    case "WorkItemNotFound":
      return new FactoryError({ reason: "not_found", message: error.message });
    case "WorkInvalid":
      return new FactoryError({ reason: "invalid_request", message: error.message });
    case "WorkPermissionDenied":
    case "WorkStale":
    case "WorkSourceStale":
    case "WorkConflict":
    case "WorkUnsupported":
    case "WorkUnavailable":
    case "WorkUnauthenticated":
    case "WorkForbidden":
    case "WorkRateLimited":
      return new FactoryError({ reason: "unavailable", message: error.message });
  }
};

const snapshot = (
  effect: Effect.Effect<FactoryDeliveryStore.StoredFactoryDelivery, FactoryServiceError>,
) => effect.pipe(Effect.map(toFactoryDelivery), Effect.mapError(toFactoryError));

const forDelivery = <A, E>(deliveryId: FactoryDeliveryId, effect: Effect.Effect<A, E>) =>
  Effect.annotateCurrentSpan({ "factory.delivery_id": deliveryId }).pipe(Effect.andThen(effect));

/**
 * Thin WebSocket handlers: decode is done by the group, each entry calls one service method and
 * maps its errors to the wire error. Deliveries go out as snapshots.
 */
export const wsHandlers = (input: {
  readonly factory: FactoryService.FactoryService["Service"];
  readonly settings: FactorySettings.FactorySettings["Service"];
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
}) => {
  const { factory, settings, startup } = input;
  // Direct WebSocket calls are not gated on command readiness, so delivery controls, which run
  // and interrupt threads, queue like core's commands.
  const command = (
    effect: Effect.Effect<FactoryDeliveryStore.StoredFactoryDelivery, FactoryServiceError>,
  ) => snapshot(startup.enqueueCommand(effect));
  return {
    [FACTORY_WS_METHODS.factorySettingsGet]: ({ projectId }) =>
      settings.get(projectId).pipe(Effect.mapError(toFactoryError)),
    // The payload decoded with the defaults filled in, which is what the store keeps.
    [FACTORY_WS_METHODS.factorySettingsSet]: (payload) =>
      settings
        .set(payload.projectId, payload.settings)
        .pipe(Effect.as(payload.settings), Effect.mapError(toFactoryError)),
    [FACTORY_WS_METHODS.factoryDeliveriesStart]: ({ itemRef }) =>
      Effect.annotateCurrentSpan({
        "work.source_id": itemRef.sourceId,
        "work.item_id": itemRef.itemId,
      }).pipe(Effect.andThen(command(factory.start({ itemRef })))),
    [FACTORY_WS_METHODS.factoryDeliveriesStop]: ({ deliveryId }) =>
      forDelivery(deliveryId, command(factory.stop(deliveryId))),
    [FACTORY_WS_METHODS.factoryDeliveriesResume]: ({ deliveryId }) =>
      forDelivery(deliveryId, command(factory.resume(deliveryId))),
    [FACTORY_WS_METHODS.factoryDeliveriesCancel]: ({ deliveryId }) =>
      forDelivery(deliveryId, command(factory.cancel(deliveryId))),
    [FACTORY_WS_METHODS.factoryDeliveriesGet]: ({ deliveryId }) =>
      forDelivery(
        deliveryId,
        snapshot(
          factory.get(deliveryId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new FactoryService.FactoryDeliveryNotFoundError({ deliveryId })),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
      ),
    [FACTORY_WS_METHODS.factoryDeliveriesList]: (query) =>
      factory.list(query).pipe(
        Effect.map((deliveries) => ({ deliveries: deliveries.map(toFactoryDelivery) })),
        Effect.mapError(toFactoryError),
      ),
  } satisfies FactoryHandlers;
};

/** The Factory handler layer. Factory acts for the environment, so it needs no session. */
export const layerWsRpc = FactoryServerRpcGroup.toLayer(
  Effect.gen(function* () {
    const factory = yield* FactoryService.FactoryService;
    const settings = yield* FactorySettings.FactorySettings;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return wsHandlers({ factory, settings, startup });
  }),
);
