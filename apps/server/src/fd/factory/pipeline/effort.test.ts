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
/** OpenCode's reasoning variants and its agent, as `provider-opencode` advertises them. */
const openCodeVariant: ProviderOptionDescriptor = {
  id: "variant",
  label: "Reasoning",
  type: "select",
  options: levels(["low", "medium", "high", "xhigh"], "medium"),
  currentValue: "medium",
};
const openCodeAgent: ProviderOptionDescriptor = {
  id: "agent",
  label: "Agent",
  type: "select",
  options: levels(["build", "plan"], "build"),
  currentValue: "build",
};
/** Cursor passes its SDK's `reasoning` parameter through under that id. */
const cursorReasoning: ProviderOptionDescriptor = {
  id: "reasoning",
  label: "Reasoning",
  type: "select",
  options: levels(["low", "medium", "high", "xhigh"], "medium"),
};
/** An ACP registry agent's thought level, under an id the agent chose. */
const acpThoughtLevel: ProviderOptionDescriptor = {
  id: "thought_level",
  label: "Thought level",
  type: "select",
  options: levels(["low", "medium", "high", "xhigh"], "medium"),
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
    ["Cursor's reasoning", cursorReasoning],
    ["Pi's thinking levels", thinkingLevels],
  ] as const)("raises %s", (_, descriptor) => {
    expect(escalate({ descriptors: [descriptor], round: 2 })).toEqual(
      withOptions([{ id: descriptor.id, value: "xhigh" }]),
    );
  });

  it.each([
    ["round 2", { round: 2 }],
    ["a high-risk task's first round", { round: 1, risk: "high" }],
  ] as const)("raises OpenCode's reasoning variant on %s and keeps its agent", (_, turn) => {
    expect(
      escalate({
        selection: withOptions([
          { id: "variant", value: "medium" },
          { id: "agent", value: "build" },
        ]),
        descriptors: [openCodeVariant, openCodeAgent],
        ...turn,
      }),
    ).toEqual(
      withOptions([
        { id: "agent", value: "build" },
        { id: "variant", value: "xhigh" },
      ]),
    );
  });

  it("raises OpenCode's reasoning variant from the model's default", () => {
    expect(escalate({ descriptors: [openCodeAgent, openCodeVariant], round: 2 })).toEqual(
      withOptions([{ id: "variant", value: "xhigh" }]),
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
    [
      "OpenCode variants without that value",
      [{ ...openCodeVariant, options: levels(["high", "max"], "high"), currentValue: "high" }],
    ],
    ["only OpenCode's agent", [openCodeAgent]],
    ["an ACP agent's own thought-level option", [acpThoughtLevel]],
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
    [
      "chosen at that OpenCode variant",
      withOptions([{ id: "variant", value: "xhigh" }]),
      openCodeVariant,
    ],
  ] as const)("never lowers an effort %s", (_, chosen, descriptor) => {
    expect(escalate({ selection: chosen, descriptors: [descriptor], round: 2 })).toBe(chosen);
  });

  it("raises an effort below the value by the model's current value", () => {
    expect(
      escalate({ descriptors: [{ ...reasoningEffort, currentValue: "high" }], round: 2 }),
    ).toEqual(withOptions([{ id: "reasoningEffort", value: "xhigh" }]));
  });
});
