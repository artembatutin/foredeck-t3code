import { describe, expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { type FactoryCommandProposal, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";

import {
  chooseFactoryCommandProposal,
  chooseFactoryRoleModel,
  FACTORY_OPTION_DEFAULT_VALUE,
  FACTORY_SETTINGS_BOUNDS,
  factoryCommandToCheck,
  factoryRoleOptionControls,
  factorySettingsDraft,
  type FactorySettingsDraft,
  factorySettingsDraftAfterSave,
  factorySettingsDraftChanged,
  factorySettingsDraftEdited,
  factorySettingsFromDraft,
  matchingFactoryProposal,
  rebaseFactorySettingsDraft,
  restoreFactoryCustomCommand,
  setFactoryRoleOption,
  settleFactoryRoleModel,
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

  it("clears the verify command when only its executable is cleared", () => {
    const draft = factorySettingsDraft(POPULATED);
    // The form keeps the arguments when the executable input is emptied.
    const cleared = { ...draft, verifyCommand: { ...draft.verifyCommand, executable: "" } };
    expect(cleared.verifyCommand.args).toStrictEqual(["scripts/verify.ts", "--grep", "a b"]);
    const settings = valid(cleared);
    expect(settings.verifyCommand).toBeNull();
    expect(settings.setupCommand).toStrictEqual(POPULATED.setupCommand);
    expect(settings).toStrictEqual({ ...POPULATED, verifyCommand: null });
  });

  it("clears the verify command when its executable and arguments are cleared", () => {
    const draft = factorySettingsDraft(POPULATED);
    const settings = valid({ ...draft, verifyCommand: { executable: "", args: [] } });
    expect(settings.verifyCommand).toBeNull();
    expect(settings.setupCommand).toStrictEqual(POPULATED.setupCommand);
  });

  it("clears the setup command when only its executable is cleared", () => {
    const draft = factorySettingsDraft(POPULATED);
    const settings = valid({ ...draft, setupCommand: { ...draft.setupCommand, executable: "" } });
    expect(settings.setupCommand).toBeNull();
    expect(settings.verifyCommand).toStrictEqual(POPULATED.verifyCommand);
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

  it("rejects a blank executable, with or without arguments", () => {
    const draft = factorySettingsDraft(POPULATED);
    rejects(
      { ...draft, verifyCommand: { executable: "   ", args: ["test"] } },
      "verifyCommand.executable",
    );
    rejects({ ...draft, verifyCommand: { executable: " ", args: [] } }, "verifyCommand.executable");
    rejects(
      { ...draft, setupCommand: { executable: "\t", args: ["i"] } },
      "setupCommand.executable",
    );
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
      verifyCommand: { executable: "  ", args: ["x"] },
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
    pipelineId: "new-pipeline",
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
    expect(rebased.blockingSeverities).toStrictEqual(edited.blockingSeverities);
    // The fields the form does not edit follow the server, so saving never reverts them.
    expect(valid(rebased).pipelineId).toBe("new-pipeline");
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

const instanceId = ProviderInstanceId.make("codex");
const EFFORT: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select",
  options: [
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
  ],
};
const SERVICE_TIER: ProviderOptionDescriptor = {
  id: "serviceTier",
  label: "Service tier",
  description: "A request; the provider decides.",
  type: "select",
  options: [
    { id: "standard", label: "Standard", isDefault: true },
    { id: "priority", label: "Priority" },
  ],
};
const FAST: ProviderOptionDescriptor = { id: "fastMode", label: "Fast mode", type: "boolean" };

const withOptions: ModelSelection = {
  instanceId,
  model: "with-options",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ],
};
const SAVED = decode({
  verifyCommand: { executable: "vp", args: ["test"] },
  roles: { author: withOptions },
});
const other: ModelSelection = { instanceId, model: "other-model" };

describe("role option controls", () => {
  it("generates a control per descriptor, effort and service tier included", () => {
    const controls = factoryRoleOptionControls(withOptions, [EFFORT, SERVICE_TIER, FAST]);
    expect(
      controls.map(({ id, label, value, unsupported }) => [id, label, value, unsupported]),
    ).toEqual([
      ["reasoningEffort", "Reasoning effort", JSON.stringify("high"), false],
      ["serviceTier", "Service tier", JSON.stringify("priority"), false],
      ["fastMode", "Fast mode", FACTORY_OPTION_DEFAULT_VALUE, false],
    ]);
    expect(controls[0]?.choices.map(({ label, selection }) => [label, selection])).toEqual([
      ["Provider default (Medium)", null],
      ["Medium", "medium"],
      ["High", "high"],
      ["Extra high", "xhigh"],
    ]);
    expect(controls[1]?.description).toBe("A request; the provider decides.");
    expect(controls[2]?.choices.map(({ label, selection }) => [label, selection])).toEqual([
      ["Provider default", null],
      ["On", true],
      ["Off", false],
    ]);
  });

  it("gives no control to a model that describes none, or to the default model", () => {
    expect(factoryRoleOptionControls({ instanceId, model: "plain" }, [])).toEqual([]);
    expect(factoryRoleOptionControls(null, [EFFORT])).toEqual([]);
  });

  it("flags a saved value the model does not offer, keeping it listed and in effect", () => {
    const saved: ModelSelection = {
      instanceId,
      model: "m",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    };
    const [control] = factoryRoleOptionControls(saved, [EFFORT]);
    expect(control?.unsupported).toBe(true);
    expect(control?.value).toBe(JSON.stringify("ultra"));
    expect(control?.choices.at(-1)).toEqual({
      value: JSON.stringify("ultra"),
      label: "ultra (not offered)",
      selection: "ultra",
    });
  });

  it("flags a saved option no descriptor names, and a value of the wrong type", () => {
    const saved: ModelSelection = {
      instanceId,
      model: "m",
      options: [
        { id: "serviceTier", value: "priority" },
        { id: "fastMode", value: "yes" },
      ],
    };
    const controls = factoryRoleOptionControls(saved, [FAST]);
    expect(controls.map(({ id, unsupported }) => [id, unsupported])).toEqual([
      ["fastMode", true],
      ["serviceTier", true],
    ]);
    // A model describing nothing still shows every saved option; none is out of sight.
    expect(
      factoryRoleOptionControls(saved, []).map(({ id, unsupported, value }) => [
        id,
        unsupported,
        value,
      ]),
    ).toEqual([
      ["serviceTier", true, JSON.stringify("priority")],
      ["fastMode", true, JSON.stringify("yes")],
    ]);
    expect(factoryRoleOptionControls(saved, [])[0]?.choices[0]).toEqual({
      value: FACTORY_OPTION_DEFAULT_VALUE,
      label: "Remove this option",
      selection: null,
    });
  });

  it("tells a string from the boolean of the same text", () => {
    const saved: ModelSelection = {
      instanceId,
      model: "m",
      options: [{ id: "fastMode", value: "true" }],
    };
    const [control] = factoryRoleOptionControls(saved, [FAST]);
    expect(control?.unsupported).toBe(true);
    expect(control?.choices.map(({ selection }) => selection)).toEqual([null, true, false, "true"]);
  });

  it("sets and removes one option, leaving the rest as saved", () => {
    const draft = factorySettingsDraft(SAVED);
    const changed = setFactoryRoleOption(draft, "author", "reasoningEffort", "xhigh");
    expect(changed.roles.author?.options).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "priority" },
    ]);
    const added = setFactoryRoleOption(changed, "author", "fastMode", false);
    expect(added.roles.author?.options?.at(-1)).toEqual({ id: "fastMode", value: false });
    const removed = setFactoryRoleOption(draft, "author", "serviceTier", null);
    expect(removed.roles.author?.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    const none = setFactoryRoleOption(removed, "author", "reasoningEffort", null);
    expect(none.roles.author).toEqual({ instanceId, model: "with-options" });
    expect(valid(none).roles.author).toEqual({ instanceId, model: "with-options" });
    // The default model has no options to set.
    expect(setFactoryRoleOption(draft, "reviewer", "fastMode", true)).toBe(draft);
  });

  it("counts an option's change as an edit, and setting it back as none", () => {
    const draft = factorySettingsDraft(SAVED);
    const changed = setFactoryRoleOption(draft, "author", "serviceTier", "standard");
    expect(factorySettingsDraftEdited(changed)).toBe(true);
    const back = setFactoryRoleOption(changed, "author", "serviceTier", "priority");
    expect(factorySettingsDraftEdited(back)).toBe(false);
  });

  it("round-trips options through an unrelated edit and the server's schema", () => {
    const draft = withLimit("maxFixRounds", "5", factorySettingsDraft(SAVED));
    const settings = valid({ ...draft, highRiskEffort: "max" });
    expect(settings.roles.author).toStrictEqual(withOptions);
    expect(decode(encode(settings)).roles.author).toStrictEqual(withOptions);
    // A value the model no longer offers is the owner's to resolve, not an edit's to lose.
    const unsupported = decode({
      roles: { author: { instanceId, model: "m", options: [{ id: "gone", value: true }] } },
    });
    const kept = valid(withLimit("maxFixRounds", "5", factorySettingsDraft(unsupported)));
    expect(kept.roles.author?.options).toEqual([{ id: "gone", value: true }]);
  });
});

describe("changing a role's model", () => {
  it("applies at once when the role has no saved options to lose", () => {
    const draft = factorySettingsDraft(decode({ roles: { author: other } }));
    const next: ModelSelection = { instanceId, model: "with-options" };
    const changed = chooseFactoryRoleModel(draft, "author", next);
    expect(changed.roles.author).toEqual(next);
    expect(changed.pendingRoles).toEqual({});
    expect(chooseFactoryRoleModel(draft, "author", null).roles.author).toBeNull();
  });

  it("holds the change, and saves the old value, while the owner has not chosen", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(SAVED), "author", other);
    expect(draft.roles.author).toStrictEqual(withOptions);
    expect(draft.pendingRoles.author).toEqual({ selection: other });
    expect(valid(draft).roles.author).toStrictEqual(withOptions);
    // It owes a choice, so it is the owner's, but a save would change nothing.
    expect(factorySettingsDraftEdited(draft)).toBe(true);
    expect(factorySettingsDraftChanged(draft)).toBe(false);
  });

  it("moves every saved option only when the owner keeps them, even ones not offered", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(SAVED), "author", other);
    const kept = settleFactoryRoleModel(draft, "author", "keep_options");
    expect(kept.roles.author).toEqual({ ...other, options: withOptions.options });
    expect(kept.pendingRoles).toEqual({});
    expect(factoryRoleOptionControls(kept.roles.author, [EFFORT]).at(-1)?.unsupported).toBe(true);
  });

  it("drops saved options only when the owner removes them", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(SAVED), "author", other);
    const cleared = settleFactoryRoleModel(draft, "author", "clear_options");
    expect(cleared.roles.author).toEqual(other);
    expect(cleared.pendingRoles).toEqual({});
  });

  it("takes the change back, by choice and by picking the old model again", () => {
    const initial = factorySettingsDraft(SAVED);
    const draft = chooseFactoryRoleModel(initial, "author", other);
    for (const back of [
      settleFactoryRoleModel(draft, "author", "keep_model"),
      chooseFactoryRoleModel(draft, "author", withOptions),
    ]) {
      expect(back.roles.author).toStrictEqual(withOptions);
      expect(back.pendingRoles).toEqual({});
      expect(factorySettingsDraftEdited(back)).toBe(false);
    }
  });

  it("never carries options to the default model, nor loses them on the way", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(SAVED), "author", null);
    expect(draft.pendingRoles.author).toEqual({ selection: null });
    expect(settleFactoryRoleModel(draft, "author", "keep_options")).toBe(draft);
    expect(settleFactoryRoleModel(draft, "author", "clear_options").roles.author).toBeNull();
  });

  it("settles nothing that is not pending", () => {
    const draft = factorySettingsDraft(SAVED);
    expect(settleFactoryRoleModel(draft, "author", "clear_options")).toBe(draft);
  });

  it("keeps a pending choice through another client's save and through this form's own", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(SAVED), "author", other);
    const moved = decode({ ...encode(SAVED), limits: { maxFixRounds: 9 } });
    const rebased = rebaseFactorySettingsDraft(draft, moved);
    expect(rebased.pendingRoles.author).toEqual({ selection: other });
    expect(rebased.limits.maxFixRounds).toBe(draft.limits.maxFixRounds);

    const saved = factorySettingsDraftAfterSave(withLimit("maxFixRounds", "7", draft), moved);
    expect(saved.pendingRoles.author).toEqual({ selection: other });
    expect(saved.roles.author).toStrictEqual(withOptions);
    expect(saved.limits.maxFixRounds).toBe("9");
  });

  it("takes options another client saved for a role this form left alone", () => {
    const edited = withLimit("maxFixRounds", "7", factorySettingsDraft(SAVED));
    const theirs: ModelSelection = {
      ...withOptions,
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    };
    const moved = decode({ ...encode(SAVED), roles: { author: theirs } });
    const rebased = rebaseFactorySettingsDraft(edited, moved);
    // A save of the limit must not take back what they chose.
    expect(valid(rebased).roles.author).toStrictEqual(theirs);
    expect(valid(rebased).limits.maxFixRounds).toBe(7);
    // A role this form did change stays this form's.
    const mine = setFactoryRoleOption(edited, "author", "serviceTier", "standard");
    expect(rebaseFactorySettingsDraft(mine, moved).roles.author).toStrictEqual(mine.roles.author);
  });
});

describe("command proposals", () => {
  const proposal = (name: string, executable: string, args: ReadonlyArray<string>) =>
    ({
      id: `script:${name}`,
      label: [executable, ...args].join(" "),
      source: "script",
      purpose: "any",
      command: { executable, args },
    }) satisfies FactoryCommandProposal;
  const test = proposal("test", "pnpm", ["run", "test"]);
  const check = proposal("check", "pnpm", ["run", "check"]);
  const proposals = [test, check];

  it("fills the executable and arguments, as separate fields, with no text to parse", () => {
    const draft = chooseFactoryCommandProposal(
      factorySettingsDraft(decode({})),
      "verifyCommand",
      test,
      proposals,
    );
    expect(draft.verifyCommand).toEqual({ executable: "pnpm", args: ["run", "test"] });
    expect(valid(draft).verifyCommand).toEqual({ executable: "pnpm", args: ["run", "test"] });
    expect(draft.customCommands).toEqual({});
    expect(matchingFactoryProposal(draft.verifyCommand, proposals)).toBe(test);
  });

  it("keeps a custom command through any choice, and gives it back exactly", () => {
    const custom = { executable: "./ci/verify 2.sh", args: ["--flag", "a b", ""] };
    const saved = decode({ verifyCommand: custom });
    const draft = factorySettingsDraft(saved);
    expect(matchingFactoryProposal(draft.verifyCommand, proposals)).toBeUndefined();

    const chosen = chooseFactoryCommandProposal(draft, "verifyCommand", test, proposals);
    expect(chosen.verifyCommand.executable).toBe("pnpm");
    // Moving between proposals does not take its place.
    const next = chooseFactoryCommandProposal(chosen, "verifyCommand", check, proposals);
    expect(next.customCommands.verifyCommand).toEqual(custom);

    const restored = restoreFactoryCustomCommand(next, "verifyCommand");
    expect(restored.verifyCommand).toEqual(custom);
    expect(restored.customCommands).toEqual({});
    expect(factorySettingsDraftEdited(restored)).toBe(false);
    expect(valid(restored).verifyCommand).toEqual(custom);
    // Nothing kept, nothing changes.
    expect(restoreFactoryCustomCommand(restored, "verifyCommand")).toBe(restored);
  });

  it("keeps each field's custom command to itself", () => {
    const draft = factorySettingsDraft(
      decode({
        verifyCommand: { executable: "custom-verify", args: [] },
        setupCommand: { executable: "custom-setup", args: [] },
      }),
    );
    const chosen = chooseFactoryCommandProposal(draft, "setupCommand", check, proposals);
    expect(chosen.verifyCommand.executable).toBe("custom-verify");
    expect(chosen.customCommands).toEqual({
      setupCommand: { executable: "custom-setup", args: [] },
    });
  });

  it("checks only a command the form could save, as it would save it", () => {
    expect(factoryCommandToCheck({ executable: "  vp ", args: ["a b"] }, "verifyCommand")).toEqual({
      executable: "vp",
      args: ["a b"],
    });
    expect(factoryCommandToCheck({ executable: "", args: ["x"] }, "verifyCommand")).toBeNull();
    expect(factoryCommandToCheck({ executable: "  ", args: [] }, "setupCommand")).toBeNull();
    expect(
      factoryCommandToCheck({ executable: "x".repeat(1025), args: [] }, "setupCommand"),
    ).toBeNull();
  });
});
