import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";

import {
  FACTORY_SETTINGS_BOUNDS,
  factorySettingsDraft,
  type FactorySettingsDraft,
  factorySettingsDraftEdited,
  factorySettingsFromDraft,
  rebaseFactorySettingsDraft,
} from "./settingsDraft.ts";

const decode = Schema.decodeUnknownSync(FactoryProjectSettings);
const encode = Schema.encodeSync(FactoryProjectSettings);
const DEFAULTS = decode({});
const POPULATED = decode({
  verifyCommand: { executable: "node", args: ["scripts/verify.ts", "--grep", "a b"] },
  setupCommand: { executable: "vp", args: ["i", "--frozen-lockfile"] },
  roles: {
    planner: { instanceId: "codex", model: "gpt-5.5" },
    author: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    },
    reviewer: null,
  },
  limits: { maxFixRounds: 4, maxReviewRounds: 1, verifyTimeoutMinutes: 90 },
  blockingSeverities: ["high", "medium"],
  highRiskEffort: "max",
  pipelineId: "custom-pipeline",
});

const valid = (draft: FactorySettingsDraft) => {
  const result = factorySettingsFromDraft(draft);
  if (result._tag !== "Valid") throw new Error(`invalid draft: ${JSON.stringify(result.errors)}`);
  return result.settings;
};

const withLimit = (
  limit: keyof FactorySettingsDraft["limits"],
  text: string,
  draft = factorySettingsDraft(POPULATED),
): FactorySettingsDraft => ({ ...draft, limits: { ...draft.limits, [limit]: text } });

describe("factorySettingsDraft round trip", () => {
  it("returns the defaults unchanged when nothing is edited", () => {
    const draft = factorySettingsDraft(DEFAULTS);
    expect(factorySettingsDraftEdited(draft)).toBe(false);
    expect(valid(draft)).toStrictEqual(DEFAULTS);
  });

  it("returns populated settings unchanged, untouched fields included", () => {
    const settings = valid(factorySettingsDraft(POPULATED));
    expect(settings).toStrictEqual(POPULATED);
    expect(settings.blockingSeverities).toStrictEqual(["high", "medium"]);
    expect(settings.highRiskEffort).toBe("max");
    expect(settings.pipelineId).toBe("custom-pipeline");
    expect(settings.roles.author?.options).toStrictEqual([{ id: "effort", value: "high" }]);
  });

  it("keeps an argument with spaces, quotes or shell metacharacters as one argument", () => {
    const args = ["a b", '"q"', "$(x);|", "  padded  ", "", "it's & <ok>"];
    const draft = factorySettingsDraft(POPULATED);
    const settings = valid({ ...draft, verifyCommand: { executable: "sh", args } });
    expect(settings.verifyCommand).toStrictEqual({ executable: "sh", args });
    // And back through the server's schema, as the save sends it.
    const saved = decode(encode(settings));
    expect(factorySettingsDraft(saved).verifyCommand.args).toStrictEqual(args);
  });

  it("clears the verify command when its executable and arguments are cleared", () => {
    const draft = factorySettingsDraft(POPULATED);
    const settings = valid({ ...draft, verifyCommand: { executable: "", args: [] } });
    expect(settings.verifyCommand).toBeNull();
    expect(settings.setupCommand).toStrictEqual(POPULATED.setupCommand);
  });

  it("trims the executable it saves", () => {
    const draft = factorySettingsDraft(DEFAULTS);
    const settings = valid({ ...draft, verifyCommand: { executable: "  vp  ", args: ["test"] } });
    expect(settings.verifyCommand).toStrictEqual({ executable: "vp", args: ["test"] });
  });
});

describe("factorySettingsFromDraft validation", () => {
  const rejects = (draft: FactorySettingsDraft, field: string) => {
    const result = factorySettingsFromDraft(draft);
    expect(result._tag).toBe("Invalid");
    expect(result).not.toHaveProperty("settings");
    if (result._tag === "Invalid") {
      expect(Object.keys(result.errors)).toStrictEqual([field]);
      expect(result.errors[field as keyof typeof result.errors]).toMatch(/\S/);
    }
  };

  it.each(["-1", "11", "2.5", "", "two"])("rejects maxFixRounds %j", (text) => {
    rejects(withLimit("maxFixRounds", text), "limits.maxFixRounds");
  });

  it.each(["-1", "11"])("rejects maxReviewRounds %j", (text) => {
    rejects(withLimit("maxReviewRounds", text), "limits.maxReviewRounds");
  });

  it.each(["0", "1441"])("rejects verifyTimeoutMinutes %j", (text) => {
    rejects(withLimit("verifyTimeoutMinutes", text), "limits.verifyTimeoutMinutes");
  });

  it("accepts the boundary values, which the schema accepts too", () => {
    for (const [maxFixRounds, maxReviewRounds, verifyTimeoutMinutes] of [
      ["0", "0", "1"],
      ["10", "10", "1440"],
    ] as const) {
      const draft = withLimit(
        "verifyTimeoutMinutes",
        verifyTimeoutMinutes,
        withLimit("maxReviewRounds", maxReviewRounds, withLimit("maxFixRounds", maxFixRounds)),
      );
      const settings = valid(draft);
      expect(settings.limits).toStrictEqual({
        maxFixRounds: Number(maxFixRounds),
        maxReviewRounds: Number(maxReviewRounds),
        verifyTimeoutMinutes: Number(verifyTimeoutMinutes),
      });
      expect(decode(encode(settings))).toStrictEqual(settings);
    }
  });

  it("uses the same bounds the schema decodes with", () => {
    const { rounds, verifyTimeoutMinutes, executableLength } = FACTORY_SETTINGS_BOUNDS;
    expect(() => decode({ limits: { maxFixRounds: rounds.minimum - 1 } })).toThrow();
    expect(() => decode({ limits: { maxReviewRounds: rounds.maximum + 1 } })).toThrow();
    expect(() =>
      decode({ limits: { verifyTimeoutMinutes: verifyTimeoutMinutes.minimum - 1 } }),
    ).toThrow();
    expect(() =>
      decode({ limits: { verifyTimeoutMinutes: verifyTimeoutMinutes.maximum + 1 } }),
    ).toThrow();
    expect(() =>
      decode({ verifyCommand: { executable: "x".repeat(executableLength + 1), args: [] } }),
    ).toThrow();
    expect(() =>
      decode({ verifyCommand: { executable: "x".repeat(executableLength), args: [] } }),
    ).not.toThrow();
  });

  it("rejects a blank executable that still has arguments", () => {
    const draft = factorySettingsDraft(POPULATED);
    rejects(
      { ...draft, verifyCommand: { executable: "   ", args: ["test"] } },
      "verifyCommand.executable",
    );
    rejects({ ...draft, setupCommand: { executable: "", args: ["i"] } }, "setupCommand.executable");
  });

  it("rejects an executable over 1024 characters and accepts one of 1024", () => {
    const draft = factorySettingsDraft(POPULATED);
    rejects(
      { ...draft, verifyCommand: { executable: "x".repeat(1025), args: [] } },
      "verifyCommand.executable",
    );
    expect(
      valid({ ...draft, verifyCommand: { executable: "x".repeat(1024), args: [] } }).verifyCommand
        ?.executable,
    ).toHaveLength(1024);
  });

  it("rejects too many or too long arguments", () => {
    const draft = factorySettingsDraft(POPULATED);
    rejects(
      {
        ...draft,
        setupCommand: { executable: "vp", args: Array.from({ length: 257 }, () => "a") },
      },
      "setupCommand.args",
    );
    rejects(
      { ...draft, verifyCommand: { executable: "vp", args: ["x".repeat(8193)] } },
      "verifyCommand.args",
    );
  });

  it("reports every invalid field at once", () => {
    const draft = withLimit("maxFixRounds", "11", withLimit("verifyTimeoutMinutes", "0"));
    const result = factorySettingsFromDraft({
      ...draft,
      verifyCommand: { executable: "", args: ["x"] },
    });
    expect(result._tag === "Invalid" ? Object.keys(result.errors).toSorted() : []).toStrictEqual([
      "limits.maxFixRounds",
      "limits.verifyTimeoutMinutes",
      "verifyCommand.executable",
    ]);
  });
});

describe("rebaseFactorySettingsDraft", () => {
  const v1 = POPULATED;
  const v2 = decode({
    ...encode(POPULATED),
    verifyCommand: { executable: "vp", args: ["test", "run"] },
    blockingSeverities: ["high", "medium", "low"],
  });

  it("replaces an unedited draft with the new server value", () => {
    const rebased = rebaseFactorySettingsDraft(factorySettingsDraft(v1), v2);
    expect(rebased).toStrictEqual(factorySettingsDraft(v2));
    expect(valid(rebased)).toStrictEqual(v2);
  });

  it("keeps an edited draft, and discard restores the new value", () => {
    const edited = withLimit("maxFixRounds", "7", factorySettingsDraft(v1));
    expect(factorySettingsDraftEdited(edited)).toBe(true);
    const rebased = rebaseFactorySettingsDraft(edited, v2);
    expect(rebased.limits.maxFixRounds).toBe("7");
    expect(rebased.verifyCommand).toStrictEqual(edited.verifyCommand);
    // The fields the form does not edit follow the server, so saving never reverts them.
    expect(valid(rebased).blockingSeverities).toStrictEqual(["high", "medium", "low"]);
    // Discard is the server's current value as a fresh draft.
    expect(valid(factorySettingsDraft(v2))).toStrictEqual(v2);
  });

  it("counts a changed role selection as an edit", () => {
    const draft = factorySettingsDraft(v1);
    const edited: FactorySettingsDraft = {
      ...draft,
      roles: {
        ...draft.roles,
        reviewer: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      },
    };
    expect(factorySettingsDraftEdited(edited)).toBe(true);
    expect(rebaseFactorySettingsDraft(edited, v2).roles.reviewer?.model).toBe("gpt-5.5");
    expect(factorySettingsDraftEdited({ ...draft, roles: { ...v1.roles } })).toBe(false);
  });
});
