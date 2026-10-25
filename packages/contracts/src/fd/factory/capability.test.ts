import * as Exit from "effect/Exit";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationReadScope } from "../../auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "../../clientRpcPermissions.ts";
import {
  ExecutionEnvironmentCapabilities,
  ExecutionEnvironmentDescriptor,
} from "../../environment.ts";
import { WS_METHODS, WsRpcGroup } from "../../rpc.ts";
import {
  FACTORY_CAPABILITY,
  FACTORY_CLIENT_GUARDED_RPC_SCOPES,
  FACTORY_RPC_INSTRUMENTATION,
  FACTORY_RPC_READ_SCOPES,
  FACTORY_WS_METHODS,
  FactoryRpcs,
  factorySupport,
} from "./index.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeCapabilities = Schema.encodeSync(ExecutionEnvironmentCapabilities);
const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.45",
  capabilities: {
    repositoryIdentity: true,
    workManagement: { version: 1, sourceKinds: ["markdown"], features: ["sources"] },
  },
} as const;
const subscribeRpc = FactoryRpcs.find(
  (rpc) => rpc._tag === FACTORY_WS_METHODS.factoryDeliveriesSubscribe,
);
const subscribeSuccess = subscribeRpc?.successSchema;
const decodeEpoch = Schema.decodeUnknownExit(
  subscribeSuccess !== undefined && RpcSchema.isStreamSchema(subscribeSuccess)
    ? subscribeSuccess.success
    : Schema.Never,
);
const withFactory = (factory: unknown) =>
  decodeDescriptor({
    ...descriptor,
    capabilities: { ...descriptor.capabilities, factory },
  }).capabilities;

describe("factorySupport", () => {
  it("leaves a descriptor without Factory unchanged and unsupported", () => {
    const capabilities = decodeDescriptor(descriptor).capabilities;
    expect(capabilities).toEqual(descriptor.capabilities);
    expect("factory" in capabilities).toBe(false);
    expect(factorySupport(capabilities)).toBeUndefined();
  });

  it.each([{ version: 2 }, { version: 0 }, { version: "1" }, { version: 1.5 }, {}, true, null])(
    "treats %j as unsupported without failing the descriptor",
    (factory) => {
      const capabilities = withFactory(factory);
      expect(capabilities.repositoryIdentity).toBe(true);
      expect(capabilities.workManagement).toEqual(descriptor.capabilities.workManagement);
      expect(factorySupport(capabilities)).toBeUndefined();
    },
  );

  it("supports the version 1 capability, even with fields a newer server adds", () => {
    expect(factorySupport(withFactory({ version: 1 }))).toEqual({ version: 1 });
    expect(factorySupport(withFactory({ version: 1, features: ["plans"] }))).toEqual({
      version: 1,
    });
  });

  it("advertises version 1 and encodes it unchanged", () => {
    expect(FACTORY_CAPABILITY).toEqual({ version: 1 });
    const capabilities = withFactory(FACTORY_CAPABILITY);
    expect(factorySupport(capabilities)).toEqual({ version: 1 });
    expect(encodeCapabilities(capabilities).factory).toEqual(FACTORY_CAPABILITY);
  });
});

describe("factory.deliveries.subscribe", () => {
  const method = FACTORY_WS_METHODS.factoryDeliveriesSubscribe;

  it("streams the change epoch, in the Factory and the core RPC group", () => {
    expect(method).toBe("factory.deliveries.subscribe");
    expect(Object.values(WS_METHODS)).toContain(method);
    for (const success of [subscribeSuccess, WsRpcGroup.requests.get(method)?.successSchema]) {
      expect(success !== undefined && RpcSchema.isStreamSchema(success)).toBe(true);
    }
    // An epoch is a non-negative count and carries no delivery data.
    expect(Exit.isSuccess(decodeEpoch(3))).toBe(true);
    expect(Exit.isSuccess(decodeEpoch(-1))).toBe(false);
    expect(Exit.isSuccess(decodeEpoch({ deliveryId: "delivery-1" }))).toBe(false);
  });

  it("is a read: orchestration:read on the server, never guarded on the client", () => {
    expect(FACTORY_RPC_READ_SCOPES[method]).toBe(AuthOrchestrationReadScope);
    expect(Object.hasOwn(FACTORY_CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
    expect(clientRpcRequiredScopes(method, undefined)).toEqual([]);
    expect(FACTORY_RPC_INSTRUMENTATION[method]).toBe("factory");
  });
});
