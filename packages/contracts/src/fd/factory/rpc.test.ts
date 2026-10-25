import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "../../auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "../../clientRpcPermissions.ts";
import { WS_METHODS, WsRpcGroup } from "../../rpc.ts";
import {
  FACTORY_CLIENT_GUARDED_RPC_SCOPES,
  FACTORY_RPC_INSTRUMENTATION,
  FACTORY_RPC_READ_SCOPES,
  FACTORY_WS_METHODS,
  FactoryDeliveryStartInput,
  FactoryError,
  FactoryRpcs,
} from "./index.ts";

const methods = Object.values(FACTORY_WS_METHODS);

describe("Factory RPC methods", () => {
  it("define one RPC per method", () => {
    expect(FactoryRpcs.map((rpc) => rpc._tag).sort()).toEqual([...methods].sort());
  });

  it("have an entry in exactly one of the read or guarded scope maps", () => {
    const reads = Object.keys(FACTORY_RPC_READ_SCOPES);
    const guarded = Object.keys(FACTORY_CLIENT_GUARDED_RPC_SCOPES);
    // The server spreads both into one table; a method in both would silently take the read
    // scope and downgrade a write.
    expect(reads.filter((method) => guarded.includes(method))).toEqual([]);
    expect([...reads, ...guarded].sort()).toEqual([...methods].sort());
    expect(Object.keys(FACTORY_RPC_INSTRUMENTATION).sort()).toEqual([...methods].sort());
  });

  it("guard exactly the five mutations, each with its grant", () => {
    expect(FACTORY_CLIENT_GUARDED_RPC_SCOPES).toEqual({
      "factory.settings.set": AuthSettingsWriteScope,
      "factory.deliveries.start": AuthOrchestrationOperateScope,
      "factory.deliveries.stop": AuthOrchestrationOperateScope,
      "factory.deliveries.resume": AuthOrchestrationOperateScope,
      "factory.deliveries.cancel": AuthOrchestrationOperateScope,
    });
    expect(FACTORY_RPC_READ_SCOPES).toEqual({
      "factory.settings.get": AuthOrchestrationReadScope,
      "factory.deliveries.get": AuthOrchestrationReadScope,
      "factory.deliveries.list": AuthOrchestrationReadScope,
      "factory.deliveries.subscribe": AuthOrchestrationReadScope,
    });
  });

  it("are spread into the core method table, RPC group and client guards", () => {
    const coreMethods: ReadonlyArray<string> = Object.values(WS_METHODS);
    const coreRpcs = new Set<string>(WsRpcGroup.requests.keys());
    for (const method of methods) {
      expect(coreMethods).toContain(method);
      expect(coreRpcs.has(method)).toBe(true);
    }
    for (const [method, scope] of Object.entries(FACTORY_CLIENT_GUARDED_RPC_SCOPES)) {
      expect(CLIENT_GUARDED_RPC_SCOPES).toHaveProperty([method], scope);
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([scope]);
    }
    // Reads are authorized on the server only: a read-only client is never told it may not look.
    for (const method of Object.keys(FACTORY_RPC_READ_SCOPES)) {
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([]);
    }
  });
});

describe("Factory RPC payloads", () => {
  const decodeStart = Schema.decodeUnknownSync(FactoryDeliveryStartInput);
  const itemRef = { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-aaaaaa" };

  it("starts a single item with or without its kind", () => {
    expect(decodeStart({ itemRef })).toEqual({ itemRef });
    expect(decodeStart({ itemRef, kind: "single" })).toEqual({ itemRef, kind: "single" });
  });

  it("reads an error reason from a newer server as unavailable", () => {
    const decodeError = Schema.decodeUnknownSync(FactoryError);
    expect(
      decodeError({ _tag: "FactoryError", reason: "quota_exceeded", message: "Later." }).reason,
    ).toBe("unavailable");
    expect(
      decodeError({ _tag: "FactoryError", reason: "conflict", message: "Taken." }).reason,
    ).toBe("conflict");
  });
});
