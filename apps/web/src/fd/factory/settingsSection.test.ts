import {
  chooseFactoryRoleModel,
  factorySettingsDraft,
  settleFactoryRoleModel,
} from "@t3tools/client-runtime/fd/factory";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_DEFAULT_ROLE_VALUE,
  type FactorySettingsAccess,
  factoryDiscoveryNote,
  factoryFieldProposals,
  factoryPendingModelView,
  factoryRoleChoice,
  factoryRoleDescriptors,
  factorySettingsMode,
  factorySettingsSave,
  type FactorySettingsForm,
  type FactorySettingsTarget,
} from "./settingsSection";

const provider = (
  instanceId: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId.startsWith("claude") ? "claudeAgent" : "codex"),
  displayName: instanceId === "codex" ? "Codex" : "Claude",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T09:00:00.000Z",
  models: models.map((slug) => ({
    slug,
    name: slug.toUpperCase(),
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
  ...overrides,
});

const DESTINATION = [provider("codex", ["gpt-5.5", "gpt-5.5-mini"])];

describe("factoryRoleChoice", () => {
  it("offers the default and only the destination's own providers and models", () => {
    const choice = factoryRoleChoice(
      [
        ...DESTINATION,
        provider("claudeAgent", ["claude-opus-5-5"], { enabled: false }),
        provider("claude_work", ["claude-sonnet-5-5"], { availability: "unavailable" }),
      ],
      null,
    );
    expect(choice.value).toBe(FACTORY_DEFAULT_ROLE_VALUE);
    expect(choice.options.map((option) => [option.label, option.selection])).toStrictEqual([
      ["Default", null],
      ["Codex · GPT-5.5", { instanceId: "codex", model: "gpt-5.5" }],
      ["Codex · GPT-5.5-MINI", { instanceId: "codex", model: "gpt-5.5-mini" }],
    ]);
    expect(choice.options.some((option) => option.unavailable)).toBe(false);
  });

  it("selects a stored selection the destination offers, keeping its options", () => {
    const stored = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5-mini",
      options: [{ id: "effort", value: "high" }],
    };
    const choice = factoryRoleChoice(DESTINATION, stored);
    const selected = choice.options.find((option) => option.value === choice.value);
    expect(selected?.selection).toBe(stored);
    expect(selected?.unavailable).toBe(false);
    expect(choice.options).toHaveLength(3);
  });

  it("flags a stored selection whose provider is missing as unavailable and keeps it", () => {
    const stored = { instanceId: ProviderInstanceId.make("claude_work"), model: "claude-opus-5-5" };
    const choice = factoryRoleChoice(DESTINATION, stored);
    const selected = choice.options.find((option) => option.value === choice.value);
    expect(selected).toMatchObject({ unavailable: true, selection: stored });
    expect(selected?.label).toContain("unavailable");
    // Nothing from another environment or a guessed replacement is added.
    expect(choice.options.filter((option) => !option.unavailable)).toHaveLength(3);
  });

  it("flags a stored selection on a disabled provider as unavailable", () => {
    const stored = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    const choice = factoryRoleChoice([provider("codex", ["gpt-5.5"], { enabled: false })], stored);
    expect(choice.options.map((option) => option.unavailable)).toStrictEqual([false, true]);
    expect(choice.options[1]?.label).toBe("Codex · gpt-5.5 (unavailable)");
  });
});

const decode = Schema.decodeUnknownSync(FactoryProjectSettings);
const SETTINGS = decode({
  verifyCommand: { executable: "vp", args: ["test"] },
  blockingSeverities: ["medium"],
  highRiskEffort: "max",
});
const TARGET: FactorySettingsTarget = {
  environmentId: EnvironmentId.make("env-a"),
  projectId: ProjectId.make("project-a"),
};
const HELD: FactorySettingsAccess = { supported: true, connected: true, writePermitted: true };

const editedForm = (target = TARGET): FactorySettingsForm => {
  const draft = factorySettingsDraft(SETTINGS);
  return { target, draft: { ...draft, limits: { ...draft.limits, maxFixRounds: "5" } } };
};

describe("factorySettingsSave", () => {
  it.each([
    ["unsupported", { ...HELD, supported: false }, "hidden"],
    ["disconnected", { ...HELD, connected: false }, "read-only"],
    ["without settings:write", { ...HELD, writePermitted: false }, "read-only"],
  ] as const)("does not save when %s", (_, access, mode) => {
    expect(factorySettingsMode(access)).toBe(mode);
    expect(factorySettingsSave(TARGET, access, editedForm())).toStrictEqual({
      _tag: "Unavailable",
    });
  });

  it("saves for the section's own environment and project when everything is held", () => {
    expect(factorySettingsMode(HELD)).toBe("editable");
    const save = factorySettingsSave(TARGET, HELD, editedForm());
    expect(save).toStrictEqual({
      _tag: "Save",
      request: {
        environmentId: "env-a",
        input: {
          projectId: "project-a",
          settings: { ...SETTINGS, limits: { ...SETTINGS.limits, maxFixRounds: 5 } },
        },
      },
    });
  });

  it("never saves a draft loaded for another destination", () => {
    const other: FactorySettingsTarget = {
      environmentId: EnvironmentId.make("env-b"),
      projectId: ProjectId.make("project-a"),
    };
    expect(factorySettingsSave(other, HELD, editedForm())._tag).toBe("Unavailable");
    const otherProject = { ...TARGET, projectId: ProjectId.make("project-b") };
    expect(factorySettingsSave(otherProject, HELD, editedForm())._tag).toBe("Unavailable");
  });

  it("reports field errors and offers nothing to save for an invalid draft", () => {
    const form = editedForm();
    const save = factorySettingsSave(TARGET, HELD, {
      ...form,
      draft: { ...form.draft, limits: { ...form.draft.limits, maxReviewRounds: "11" } },
    });
    expect(save._tag).toBe("Invalid");
    expect(save._tag === "Invalid" ? Object.keys(save.errors) : []).toStrictEqual([
      "limits.maxReviewRounds",
    ]);
  });

  it("offers nothing to save for an unedited draft", () => {
    const form = { target: TARGET, draft: factorySettingsDraft(SETTINGS) };
    expect(factorySettingsSave(TARGET, HELD, form)._tag).toBe("Unavailable");
  });
});

describe("a role's options against what the destination offers", () => {
  const effort = {
    id: "reasoningEffort",
    label: "Effort",
    type: "select" as const,
    options: [{ id: "high", label: "High" }],
  };
  const tier = {
    id: "serviceTier",
    label: "Tier",
    type: "select" as const,
    options: [{ id: "priority", label: "Priority" }],
  };
  const offering = (
    capabilities: Readonly<Record<string, ReadonlyArray<typeof effort>>>,
    overrides: Partial<ServerProvider> = {},
  ) =>
    provider("codex", Object.keys(capabilities), {
      models: Object.entries(capabilities).map(([slug, optionDescriptors]) => ({
        slug,
        name: slug.toUpperCase(),
        isCustom: false,
        capabilities: { optionDescriptors },
      })),
      ...overrides,
    });
  const providers = [offering({ both: [effort, tier], "effort-only": [effort], none: [] })];
  const stored = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "both",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  };
  const settings = decode({
    verifyCommand: { executable: "vp", args: ["test"] },
    roles: { reviewer: stored },
  });

  it("reads descriptors only of a model the destination offers", () => {
    expect(factoryRoleDescriptors(providers, stored)).toEqual([effort, tier]);
    expect(factoryRoleDescriptors(providers, { ...stored, model: "none" })).toEqual([]);
    expect(factoryRoleDescriptors(providers, { ...stored, model: "gone" })).toEqual([]);
    expect(factoryRoleDescriptors(providers, null)).toEqual([]);
    expect(
      factoryRoleDescriptors(
        [offering({ both: [effort] }, { availability: "unavailable" })],
        stored,
      ),
    ).toEqual([]);
  });

  it("offers another model bare, and choosing it loses nothing without the owner's say", () => {
    const initial = factorySettingsDraft(settings);
    const choice = factoryRoleChoice(providers, stored);
    const next = choice.options.find((option) => option.label === "Codex · EFFORT-ONLY");
    expect(next?.selection).toEqual({ instanceId: "codex", model: "effort-only" });

    const draft = chooseFactoryRoleModel(initial, "reviewer", next?.selection ?? null);
    // What the control shows is the owner's pick; what the role holds and saves is unchanged.
    const shown = factoryRoleChoice(providers, draft.roles.reviewer, draft.pendingRoles.reviewer);
    expect(shown.value).toBe(next?.value);
    expect(draft.roles.reviewer).toStrictEqual(stored);
    const edited = { ...draft, limits: { ...draft.limits, maxFixRounds: "5" } };
    const save = factorySettingsSave(TARGET, HELD, { target: TARGET, draft: edited });
    expect(save._tag).toBe("Save");
    expect(save._tag === "Save" ? save.request.input.settings.roles.reviewer : null).toStrictEqual(
      stored,
    );
  });

  it("offers nothing to save while a pending choice is all the draft holds", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(settings), "reviewer", null);
    expect(factorySettingsSave(TARGET, HELD, { target: TARGET, draft })._tag).toBe("Unavailable");
  });

  it("saves the new model only once the owner has chosen", () => {
    const pending = chooseFactoryRoleModel(factorySettingsDraft(settings), "reviewer", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "effort-only",
    });
    const draft = settleFactoryRoleModel(pending, "reviewer", "keep_options");
    const save = factorySettingsSave(TARGET, HELD, { target: TARGET, draft });
    expect(save._tag === "Save" ? save.request.input.settings.roles.reviewer : null).toEqual({
      instanceId: "codex",
      model: "effort-only",
      options: stored.options,
    });
  });

  it("says which saved options the pending model offers", () => {
    const draft = chooseFactoryRoleModel(factorySettingsDraft(settings), "reviewer", {
      instanceId: ProviderInstanceId.make("codex"),
      model: "effort-only",
    });
    expect(factoryPendingModelView(providers, draft, "reviewer")).toEqual({
      currentLabel: "Codex · BOTH",
      nextLabel: "Codex · EFFORT-ONLY",
      options: [
        { id: "reasoningEffort", value: "high", offered: true },
        { id: "serviceTier", value: "priority", offered: false },
      ],
      canKeepOptions: true,
    });
    expect(
      factoryPendingModelView(providers, factorySettingsDraft(settings), "reviewer"),
    ).toBeNull();
    const toDefault = chooseFactoryRoleModel(factorySettingsDraft(settings), "reviewer", null);
    expect(factoryPendingModelView(providers, toDefault, "reviewer")).toMatchObject({
      nextLabel: "Default",
      canKeepOptions: false,
    });
  });
});

describe("what a command field proposes", () => {
  const proposal = (id: string, purpose: "verify" | "setup" | "any") => ({
    id,
    label: id,
    source: "preset" as const,
    purpose,
    command: { executable: id, args: [] },
  });
  const discovery = {
    scripts: "found" as const,
    packageManager: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    proposals: [
      proposal("script", "any"),
      proposal("install", "setup"),
      proposal("test", "verify"),
    ],
    omittedScripts: 0,
  };

  it("lists what suits the field first, then what suits either, and never the other's", () => {
    expect(factoryFieldProposals(discovery, "verifyCommand").map(({ id }) => id)).toEqual([
      "test",
      "script",
    ]);
    expect(factoryFieldProposals(discovery, "setupCommand").map(({ id }) => id)).toEqual([
      "install",
      "script",
    ]);
    expect(factoryFieldProposals(null, "setupCommand")).toEqual([]);
  });

  it("says what the owner should know of how the checkout read, and nothing otherwise", () => {
    expect(factoryDiscoveryNote(null)).toBeUndefined();
    expect(factoryDiscoveryNote(discovery)).toBeUndefined();
    expect(factoryDiscoveryNote({ ...discovery, scripts: "unreadable" })).toContain(
      "could not read this project's package.json",
    );
    expect(factoryDiscoveryNote({ ...discovery, packageManager: null, lockfiles: [] })).toContain(
      "scripts use npm",
    );
    expect(
      factoryDiscoveryNote({ ...discovery, lockfiles: ["yarn.lock", "package-lock.json"] }),
    ).toContain("several lockfiles (yarn.lock, package-lock.json); commands use pnpm");
    expect(factoryDiscoveryNote({ ...discovery, omittedScripts: 1 })).toContain("1 more script is");
  });
});
