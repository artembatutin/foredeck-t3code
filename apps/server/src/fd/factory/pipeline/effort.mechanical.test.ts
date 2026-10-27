import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mechanicalEffort } from "./effort.ts";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("test-provider"),
  model: "test-model",
  options: [
    { id: "fastMode", value: true },
    { id: "agent", value: "build" },
  ],
};
const descriptor = (id: string) => ({
  id,
  type: "select" as const,
  label: "Effort",
  options: ["low", "medium", "high", "xhigh"].map((id) => ({
    id,
    label: id,
    isDefault: id === "high",
  })),
});

describe("mechanicalEffort", () => {
  it.each(
    ["effort", "reasoningEffort", "reasoning", "variant", "thinking"].flatMap((id) =>
      ["low", "medium", "xhigh", undefined].map((value) => ({ id, value })),
    ),
  )("sets $id to medium from $value and preserves the model and other options", ({ id, value }) => {
    const chosen = {
      ...selection,
      options: [...selection.options!, ...(value === undefined ? [] : [{ id, value }])],
    };
    const original = structuredClone(chosen);
    expect(
      mechanicalEffort({
        selection: chosen,
        descriptors: [descriptor("agent"), descriptor(id)],
      }),
    ).toEqual({
      ...selection,
      options: [...selection.options!, { id, value: "medium" }],
    });
    expect(chosen).toEqual(original);
  });

  it("adds medium when the selection has no options and the descriptor's current value is higher", () => {
    const chosen = { instanceId: selection.instanceId, model: selection.model };
    expect(
      mechanicalEffort({
        selection: chosen,
        descriptors: [{ ...descriptor("effort"), currentValue: "xhigh" }],
      }),
    ).toEqual({
      ...chosen,
      options: [{ id: "effort", value: "medium" }],
    });
  });

  it.each([
    ["no descriptors", undefined],
    ["an empty list", []],
    ["another select offering medium", [descriptor("serviceTier")]],
    ["an unknown effort id", [descriptor("thought_level")]],
    ["a boolean thinking toggle", [{ id: "thinking", label: "Thinking", type: "boolean" }]],
    [
      "effort without medium",
      [{ ...descriptor("effort"), options: [{ id: "high", label: "High" }] }],
    ],
  ] satisfies ReadonlyArray<
    readonly [string, ReadonlyArray<ProviderOptionDescriptor> | undefined]
  >)("leaves the selection unchanged with %s", (_, descriptors) => {
    expect(mechanicalEffort({ selection, descriptors })).toBe(selection);
  });
});
