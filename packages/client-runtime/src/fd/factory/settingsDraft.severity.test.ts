import { describe, expect, it } from "@effect/vitest";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";

import {
  factorySettingsDraft,
  factorySettingsDraftEdited,
  factorySettingsFromDraft,
  rebaseFactorySettingsDraft,
  type FactorySettingsDraft,
} from "./settingsDraft.ts";

const decode = Schema.decodeUnknownSync(FactoryProjectSettings);
const encode = Schema.encodeSync(FactoryProjectSettings);
const stored = decode({
  blockingSeverities: ["high", "low"],
  highRiskEffort: "max",
  pipelineId: "stored-pipeline",
});
const saved = (draft: FactorySettingsDraft) => {
  const result = factorySettingsFromDraft(draft);
  if (result._tag !== "Valid") throw new Error("Expected a valid settings draft.");
  // The request and response must still round-trip through the wire schema.
  return decode(encode(result.settings));
};

describe("Factory review policy settings draft", () => {
  it("loads and round-trips stored severities, effort and the uneditable pipeline", () => {
    const draft = factorySettingsDraft(stored);
    expect(draft.blockingSeverities).toStrictEqual(["high", "low"]);
    expect(draft.highRiskEffort).toBe("max");
    expect(factorySettingsDraftEdited(draft)).toBe(false);
    expect(saved(draft)).toStrictEqual(stored);
  });

  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "saves severity subset %i in high, medium, low order, including no severities",
    (mask) => {
      const selected = (["high", "medium", "low"] as const).filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const result = saved({
        ...factorySettingsDraft(stored),
        blockingSeverities: selected.toReversed(),
        highRiskEffort: "  custom-effort  ",
      });
      expect(result).toStrictEqual({
        ...stored,
        blockingSeverities: selected,
        highRiskEffort: "custom-effort",
      });
    },
  );

  it("treats severities as a subset rather than counting order or duplicates as edits", () => {
    const draft = {
      ...factorySettingsDraft(stored),
      blockingSeverities: ["low", "high", "low"] as const,
    };
    expect(factorySettingsDraftEdited(draft)).toBe(false);
    expect(saved(draft).blockingSeverities).toStrictEqual(["high", "low"]);
  });

  it.each(["", " \t\n ", "x".repeat(65), ` ${"x".repeat(65)} `])(
    "refuses invalid effort %j with a field error",
    (highRiskEffort) => {
      const result = factorySettingsFromDraft({ ...factorySettingsDraft(stored), highRiskEffort });
      expect(result._tag).toBe("Invalid");
      if (result._tag !== "Invalid") return;
      expect(Object.keys(result.errors)).toStrictEqual(["highRiskEffort"]);
      expect(result.errors.highRiskEffort).toMatch(/\S/);
    },
  );

  it("accepts 64 characters after trimming, matching the server bound", () => {
    const effort = "x".repeat(64);
    expect(
      saved({ ...factorySettingsDraft(stored), highRiskEffort: ` ${effort} ` }).highRiskEffort,
    ).toBe(effort);
    expect(() => decode({ highRiskEffort: "x".repeat(65) })).toThrow();
    expect(() => decode({ highRiskEffort: " " })).toThrow();
  });

  const next = decode({
    blockingSeverities: ["medium"],
    highRiskEffort: "high",
    pipelineId: "next-pipeline",
  });

  it("takes both new server values when rebasing an unedited draft", () => {
    const rebased = rebaseFactorySettingsDraft(factorySettingsDraft(stored), next);
    expect(rebased).toStrictEqual(factorySettingsDraft(next));
    expect(saved(rebased)).toStrictEqual(next);
    expect(factorySettingsDraftEdited(rebased)).toBe(false);
  });

  it.each([
    { blockingSeverities: ["low"] as const },
    { blockingSeverities: [] },
    { highRiskEffort: " custom " },
    { blockingSeverities: ["low", "medium"] as const, highRiskEffort: " custom " },
  ])("detects and keeps policy edits on rebase: %j", (edit) => {
    const edited = { ...factorySettingsDraft(stored), ...edit };
    expect(factorySettingsDraftEdited(edited)).toBe(true);
    const rebased = rebaseFactorySettingsDraft(edited, next);
    // Follow the existing whole-draft rebase policy, including every editable field.
    expect(rebased).toStrictEqual({ ...edited, base: next });
    expect(factorySettingsDraftEdited(rebased)).toBe(true);
    expect(saved(rebased)).toStrictEqual({ ...saved(edited), pipelineId: next.pipelineId });
  });
});
