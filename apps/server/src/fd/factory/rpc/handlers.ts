import { RpcScopeAuthorization } from "@t3tools/contracts";
import {
  FACTORY_WS_METHODS,
  type FactoryDeliveryId,
  FactoryRpcs,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { RpcInstrumentation } from "../../../observability/RpcInstrumentation.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import type * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { toFactoryDelivery } from "../snapshot.ts";
import { type FactoryServiceError, toFactoryError } from "../wireError.ts";

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
