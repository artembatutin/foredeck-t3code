import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../../auth.ts";
import { NonNegativeInt } from "../../baseSchemas.ts";
import {
  FactoryDelivery,
  FactoryDeliveryList,
  FactoryDeliveryListInput,
  FactoryDeliveryRefInput,
  FactoryDeliveryStartInput,
  FactoryError,
  FactoryProjectSettings,
  FactorySettingsGetInput,
  FactorySettingsSetInput,
} from "./schemas.ts";

/**
 * The Factory WebSocket methods. Core `rpc.ts` spreads these into `WS_METHODS` and
 * `FactoryRpcs` into the RPC group; the scope and instrumentation tables below are spread into
 * their core maps the same way, so each core edit stays one line.
 */
export const FACTORY_WS_METHODS = {
  factorySettingsGet: "factory.settings.get",
  factorySettingsSet: "factory.settings.set",
  factoryDeliveriesStart: "factory.deliveries.start",
  factoryDeliveriesStop: "factory.deliveries.stop",
  factoryDeliveriesResume: "factory.deliveries.resume",
  factoryDeliveriesCancel: "factory.deliveries.cancel",
  factoryDeliveriesGet: "factory.deliveries.get",
  factoryDeliveriesList: "factory.deliveries.list",
  factoryDeliveriesSubscribe: "factory.deliveries.subscribe",
} as const;

const FactoryRpcError = Schema.Union([FactoryError, EnvironmentAuthorizationError]);

const WsFactorySettingsGetRpc = Rpc.make(FACTORY_WS_METHODS.factorySettingsGet, {
  payload: FactorySettingsGetInput,
  success: FactoryProjectSettings,
  error: FactoryRpcError,
});
/** Answers the settings as stored, defaults filled in. */
const WsFactorySettingsSetRpc = Rpc.make(FACTORY_WS_METHODS.factorySettingsSet, {
  payload: FactorySettingsSetInput,
  success: FactoryProjectSettings,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesStartRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesStart, {
  payload: FactoryDeliveryStartInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesStopRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesStop, {
  payload: FactoryDeliveryRefInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesResumeRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesResume, {
  payload: FactoryDeliveryRefInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesCancelRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesCancel, {
  payload: FactoryDeliveryRefInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesGetRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesGet, {
  payload: FactoryDeliveryRefInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryDeliveriesListRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesList, {
  payload: FactoryDeliveryListInput,
  success: FactoryDeliveryList,
  error: FactoryRpcError,
});

/**
 * An epoch that moves after every committed delivery write, Work's refresh epoch for Factory:
 * clients refetch the deliveries they show on each value. It carries no delivery data.
 */
const WsFactoryDeliveriesSubscribeRpc = Rpc.make(FACTORY_WS_METHODS.factoryDeliveriesSubscribe, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const FactoryRpcs = [
  WsFactorySettingsGetRpc,
  WsFactorySettingsSetRpc,
  WsFactoryDeliveriesStartRpc,
  WsFactoryDeliveriesStopRpc,
  WsFactoryDeliveriesResumeRpc,
  WsFactoryDeliveriesCancelRpc,
  WsFactoryDeliveriesGetRpc,
  WsFactoryDeliveriesListRpc,
  WsFactoryDeliveriesSubscribeRpc,
] as const;

/** Reads, authorized server-side only; the client never guards them. */
export const FACTORY_RPC_READ_SCOPES = {
  [FACTORY_WS_METHODS.factorySettingsGet]: AuthOrchestrationReadScope,
  [FACTORY_WS_METHODS.factoryDeliveriesGet]: AuthOrchestrationReadScope,
  [FACTORY_WS_METHODS.factoryDeliveriesList]: AuthOrchestrationReadScope,
  [FACTORY_WS_METHODS.factoryDeliveriesSubscribe]: AuthOrchestrationReadScope,
} as const;

/**
 * Writes, guarded on the client through `permissionAtom` and again on the server. Delivery
 * controls run and interrupt agent threads, as starting a thread does.
 */
export const FACTORY_CLIENT_GUARDED_RPC_SCOPES = {
  [FACTORY_WS_METHODS.factorySettingsSet]: AuthSettingsWriteScope,
  [FACTORY_WS_METHODS.factoryDeliveriesStart]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesStop]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesResume]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesCancel]: AuthOrchestrationOperateScope,
} as const;

/** Every Factory method under one instrumentation class. */
export const FACTORY_RPC_INSTRUMENTATION = Object.fromEntries(
  Object.values(FACTORY_WS_METHODS).map((method) => [method, "factory"] as const),
) as {
  readonly [Method in (typeof FACTORY_WS_METHODS)[keyof typeof FACTORY_WS_METHODS]]: "factory";
};
