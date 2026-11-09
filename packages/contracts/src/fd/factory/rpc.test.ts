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
  FactoryCommandDiscovery,
  FactoryCommandValidateInput,
  FactoryCommandValidation,
  FactoryDelivery,
  FactoryDeliveryExecution,
  FactoryDeliveryStartInput,
  FactoryError,
  FactoryRpcs,
} from "./index.ts";

const methods = Object.values(FACTORY_WS_METHODS);
const decodeValidate = Schema.decodeUnknownSync(FactoryCommandValidateInput);
const decodeDiscovery = Schema.decodeUnknownSync(FactoryCommandDiscovery);
const decodeValidation = Schema.decodeUnknownSync(FactoryCommandValidation);
const decodeExecution = Schema.decodeUnknownSync(FactoryDeliveryExecution);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const encodeDelivery = Schema.encodeSync(FactoryDelivery);

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

  it("guard exactly the nine mutations and the two reads that serve one, each with its grant", () => {
    expect(FACTORY_CLIENT_GUARDED_RPC_SCOPES).toEqual({
      "factory.settings.set": AuthSettingsWriteScope,
      // They answer with what the server's checkout and environment hold, and serve only that write.
      "factory.commands.discover": AuthSettingsWriteScope,
      "factory.commands.validate": AuthSettingsWriteScope,
      "factory.deliveries.start": AuthOrchestrationOperateScope,
      "factory.deliveries.stop": AuthOrchestrationOperateScope,
      "factory.deliveries.resume": AuthOrchestrationOperateScope,
      "factory.deliveries.cancel": AuthOrchestrationOperateScope,
      // The plan gate's actions run and interrupt planner threads, as delivery controls do.
      "factory.plan.update": AuthOrchestrationOperateScope,
      // Approval starts creating child items and deliveries.
      "factory.plan.approve": AuthOrchestrationOperateScope,
      "factory.plan.reject": AuthOrchestrationOperateScope,
      "factory.plan.replan": AuthOrchestrationOperateScope,
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

  it("takes only a command Factory could save for validation", () => {
    const command = { executable: "vp", args: ["test", "a b"] };
    expect(decodeValidate({ projectId: "p", command }).command).toEqual(command);
    expect(() =>
      decodeValidate({ projectId: "p", command: { executable: " ", args: [] } }),
    ).toThrow();
    expect(() =>
      decodeValidate({ projectId: "p", command: { executable: "x".repeat(1025), args: [] } }),
    ).toThrow();
  });

  it("reads what a newer server says of commands without failing the answer", () => {
    const discovery = decodeDiscovery({
      scripts: "from_a_later_format",
      packageManager: "pnpm",
      lockfiles: ["pnpm-lock.yaml"],
      proposals: [
        {
          id: "script:test",
          label: "pnpm run test",
          source: "plugin",
          purpose: "deploy",
          command: { executable: "pnpm", args: ["run", "test"] },
        },
        { id: "unreadable", command: { executable: "" } },
      ],
      omittedScripts: 0,
    });
    expect(discovery.scripts).toBe("unknown");
    expect(discovery.proposals).toEqual([
      {
        id: "script:test",
        label: "pnpm run test",
        source: "unknown",
        // A purpose this build does not know suits either field rather than being lost.
        purpose: "any",
        command: { executable: "pnpm", args: ["run", "test"] },
      },
    ]);
    expect(
      decodeValidation({
        status: "needs_container",
        resolvedPath: null,
        message: "Later.",
      }).status,
    ).toBe("unknown");
  });

  it("keeps a role's binding and report apart, and reads what it cannot as unknown", () => {
    const selection = { instanceId: "codex", model: "gpt-6-astra" };
    const execution = decodeExecution({
      roles: [
        { role: "author", selection, binding: "reviewed", acknowledged: selection },
        { role: "auditor", selection, binding: "frozen" },
        { role: "reviewer", binding: "read_now" },
      ],
    });
    expect(execution.roles).toEqual([
      { role: "author", selection, binding: "reviewed", acknowledged: selection },
      { role: "unknown", selection, binding: "unknown" },
    ]);
  });

  it("carries a delivery's roles across the wire, boolean options and all", () => {
    const selection = {
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [
        { id: "serviceTier", value: "priority" },
        { id: "fastMode", value: false },
      ],
    };
    const wire = {
      deliveryId: "delivery-1",
      projectId: "p",
      itemRef,
      childIds: [],
      status: "running",
      rounds: { fix: 0, review: 0 },
      threads: {},
      receipts: [],
      reviews: [],
      stageRuns: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const execution = {
      roles: [
        { role: "author", selection, binding: "reviewed", reviewed: selection },
        { role: "reviewer", selection, binding: "read_now", acknowledged: selection },
      ],
    };
    const decoded = decodeDelivery({ ...wire, execution });
    expect(decoded.execution).toEqual(execution);
    expect(decodeDelivery(encodeDelivery(decoded)).execution).toEqual(execution);
    // An older server sends none, and one this build cannot read fails nothing around it.
    expect(decodeDelivery(wire).execution).toBeUndefined();
    expect(decodeDelivery({ ...wire, execution: "from a later format" }).execution).toBeUndefined();
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
