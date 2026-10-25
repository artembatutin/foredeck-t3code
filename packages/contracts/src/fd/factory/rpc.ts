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
  FactoryPlanReplanInput,
  FactoryPlanUpdateInput,
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
  factoryPlanUpdate: "factory.plan.update",
  factoryPlanReject: "factory.plan.reject",
  factoryPlanReplan: "factory.plan.replan",
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
 * The plan gate's owner actions, each on a delivery waiting at the gate and refused on any other.
 * Update stores the edited plan, which keeps the delivery waiting; reject cancels the delivery;
 * replan sends the note to the planner thread and plans again. Servers advertising `planning`
 * serve them.
 */
const WsFactoryPlanUpdateRpc = Rpc.make(FACTORY_WS_METHODS.factoryPlanUpdate, {
  payload: FactoryPlanUpdateInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryPlanRejectRpc = Rpc.make(FACTORY_WS_METHODS.factoryPlanReject, {
  payload: FactoryDeliveryRefInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});
const WsFactoryPlanReplanRpc = Rpc.make(FACTORY_WS_METHODS.factoryPlanReplan, {
  payload: FactoryPlanReplanInput,
  success: FactoryDelivery,
  error: FactoryRpcError,
});

/**
 * An epoch that moves after every committed delivery or settings write, Work's refresh epoch for
 * Factory: clients refetch the deliveries and settings they show on each value. It carries no data.
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
  WsFactoryPlanUpdateRpc,
  WsFactoryPlanRejectRpc,
  WsFactoryPlanReplanRpc,
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
 * controls and the plan gate's actions run and interrupt agent threads, as starting a thread does.
 */
export const FACTORY_CLIENT_GUARDED_RPC_SCOPES = {
  [FACTORY_WS_METHODS.factorySettingsSet]: AuthSettingsWriteScope,
  [FACTORY_WS_METHODS.factoryDeliveriesStart]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesStop]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesResume]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryDeliveriesCancel]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryPlanUpdate]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryPlanReject]: AuthOrchestrationOperateScope,
  [FACTORY_WS_METHODS.factoryPlanReplan]: AuthOrchestrationOperateScope,
} as const;

/** Every Factory method under one instrumentation class. */
export const FACTORY_RPC_INSTRUMENTATION = Object.fromEntries(
  Object.values(FACTORY_WS_METHODS).map((method) => [method, "factory"] as const),
) as {
  readonly [Method in (typeof FACTORY_WS_METHODS)[keyof typeof FACTORY_WS_METHODS]]: "factory";
};
