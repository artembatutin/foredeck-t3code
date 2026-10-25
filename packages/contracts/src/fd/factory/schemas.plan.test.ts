import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FactoryDeliveryStartInput, FactoryError, FactoryMcpFailure } from "./index.ts";

const itemRef = { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-aaaaaa" };
const decodeStart = Schema.decodeUnknownSync(FactoryDeliveryStartInput);
const decodeError = Schema.decodeUnknownSync(FactoryError);
const encodeError = Schema.encodeSync(FactoryError);
const decodeMcpFailure = Schema.decodeUnknownSync(FactoryMcpFailure);

describe("Factory start input kinds", () => {
  it("decodes a parent, a single item and a start without a kind", () => {
    expect(decodeStart({ itemRef, kind: "parent" })).toEqual({ itemRef, kind: "parent" });
    expect(decodeStart({ itemRef, kind: "single" })).toEqual({ itemRef, kind: "single" });
    expect(decodeStart({ itemRef })).toEqual({ itemRef });
  });

  it.each(["child", "PARENT", "", null, 1])("rejects the kind %j", (kind) => {
    expect(() => decodeStart({ itemRef, kind })).toThrow();
  });
});

describe("Factory refusals of a parent outside Markdown", () => {
  it("carries its own wire reason", () => {
    const wire = {
      _tag: "FactoryError",
      reason: "unsupported_source",
      message: "Markdown only.",
    } as const;
    expect(decodeError(wire).reason).toBe("unsupported_source");
    expect(encodeError(new FactoryError(wire))).toEqual(wire);
  });

  it("carries its own MCP code, as do the plan submission refusals", () => {
    for (const code of ["unsupported_source", "not_planner", "plan_not_active", "invalid_plan"]) {
      expect(decodeMcpFailure({ _tag: "FactoryMcpFailure", code, message: "Fixed." }).code).toBe(
        code,
      );
    }
  });
});
