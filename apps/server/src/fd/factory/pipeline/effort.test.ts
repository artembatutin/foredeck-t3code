import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { escalateEffort } from "./effort.ts";

const levels = (ids: ReadonlyArray<string>, defaultId?: string) =>
  ids.map((id) => ({ id, label: id, ...(id === defaultId ? { isDefault: true } : {}) }));

/** Claude's effort option, lowest to highest. */
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: levels(["low", "medium", "high", "xhigh", "max"], "medium"),
};
const effortWithoutXhigh: ProviderOptionDescriptor = {
  ...effort,
  options: levels(["low", "medium", "high", "max"], "medium"),
};
/** Codex's (and Grok's) reasoning option. */
const reasoningEffort: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: levels(["low", "medium", "high", "xhigh"]),
  currentValue: "medium",
};
/** Pi's thinking levels. */
const thinkingLevels: ProviderOptionDescriptor = {
  id: "thinking",
  label: "Thinking",
  type: "select",
  options: levels(["minimal", "low", "medium", "high", "xhigh"], "medium"),
};
const thinkingToggle: ProviderOptionDescriptor = {
  id: "thinking",
  label: "Thinking",
  type: "boolean",
};
const fastMode: ProviderOptionDescriptor = { id: "fastMode", label: "Fast Mode", type: "boolean" };
const serviceTier: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  options: levels(["default", "xhigh"]),
};

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-model",
};
const withOptions = (options: NonNullable<ModelSelection["options"]>): ModelSelection => ({
  ...selection,
  options,
});

const escalate = (input: {
  readonly selection?: ModelSelection;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  readonly round: number;
  readonly risk?: "normal" | "high";
}) =>
  escalateEffort({
    selection: input.selection ?? selection,
    descriptors: input.descriptors,
    round: input.round,
    risk: input.risk ?? "normal",
    highRiskEffort: "xhigh",
  });

describe("escalateEffort", () => {
  it("never escalates a first-round turn of a normal-risk task", () => {
    const chosen = withOptions([{ id: "effort", value: "low" }]);
    expect(escalate({ selection: chosen, descriptors: [effort], round: 1 })).toBe(chosen);
  });

  it.each([
    ["round 2", { round: 2 }],
    ["round 3", { round: 3 }],
    ["a high-risk task's first round", { round: 1, risk: "high" }],
    ["a high-risk task's later round", { round: 2, risk: "high" }],
  ] as const)("raises the effort on %s when the model offers it", (_, turn) => {
    expect(escalate({ descriptors: [effort], ...turn })).toEqual(
      withOptions([{ id: "effort", value: "xhigh" }]),
    );
  });

  it.each([
    ["Codex's reasoning effort", reasoningEffort],
    ["Pi's thinking levels", thinkingLevels],
  ] as const)("raises %s", (_, descriptor) => {
    expect(escalate({ descriptors: [descriptor], round: 2 })).toEqual(
      withOptions([{ id: descriptor.id, value: "xhigh" }]),
    );
  });

  it("replaces the chosen effort and keeps the other options", () => {
    expect(
      escalate({
        selection: withOptions([
          { id: "fastMode", value: true },
          { id: "effort", value: "low" },
        ]),
        descriptors: [fastMode, effort],
        round: 2,
      }),
    ).toEqual(
      withOptions([
        { id: "fastMode", value: true },
        { id: "effort", value: "xhigh" },
      ]),
    );
  });

  it.each([
    ["a descriptor without that value", [effortWithoutXhigh]],
    ["no effort option", [fastMode]],
    ["a boolean thinking toggle", [thinkingToggle]],
    ["another select offering the value", [serviceTier]],
    ["no descriptors", []],
    ["a provider that lists none", undefined],
  ] as const)("leaves the selection unchanged with %s", (_, descriptors) => {
    const chosen = withOptions([{ id: "fastMode", value: true }]);
    expect(escalate({ selection: chosen, descriptors, round: 2, risk: "high" })).toBe(chosen);
  });

  it.each([
    ["chosen at that value", withOptions([{ id: "effort", value: "xhigh" }]), effort],
    ["chosen above it", withOptions([{ id: "effort", value: "max" }]), effort],
    [
      "above it by the model's default",
      selection,
      { ...effort, options: levels(["low", "medium", "high", "xhigh", "max"], "max") },
    ],
    ["above it by the current value", selection, { ...reasoningEffort, currentValue: "xhigh" }],
  ] as const)("never lowers an effort %s", (_, chosen, descriptor) => {
    expect(escalate({ selection: chosen, descriptors: [descriptor], round: 2 })).toBe(chosen);
  });

  it("raises an effort below the value by the model's current value", () => {
    expect(
      escalate({ descriptors: [{ ...reasoningEffort, currentValue: "high" }], round: 2 }),
    ).toEqual(withOptions([{ id: "reasoningEffort", value: "xhigh" }]));
  });
});
