import {
  type FactoryCommandName,
  type FactoryRoleName,
  type FactoryRolePendingModel,
  type FactorySettingsDraft,
  type FactorySettingsErrors,
  factoryRoleOptionControls,
  factorySettingsDraftChanged,
  factorySettingsFromDraft,
} from "@t3tools/client-runtime/fd/factory";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";
import type {
  FactoryCommandDiscovery,
  FactoryCommandProposal,
  FactorySettingsSetInput,
} from "@t3tools/contracts/fd/factory";

import { deriveProviderInstanceEntries } from "../../providerInstances";

/** The project member, on its owning environment, whose Factory settings a section edits. */
export interface FactorySettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** What the section reads of its destination. */
export interface FactorySettingsAccess {
  readonly supported: boolean;
  readonly connected: boolean;
  /** Whether this session holds settings:write on the destination. */
  readonly writePermitted: boolean;
}

/** Hidden on a server without Factory; editable only while connected with the write grant. */
export type FactorySettingsMode = "hidden" | "read-only" | "editable";

export const factorySettingsMode = (access: FactorySettingsAccess): FactorySettingsMode =>
  !access.supported
    ? "hidden"
    : access.connected && access.writePermitted
      ? "editable"
      : "read-only";

/** A draft and the destination it was loaded from. */
export interface FactorySettingsForm {
  readonly target: FactorySettingsTarget;
  readonly draft: FactorySettingsDraft;
}

export type FactorySettingsSave =
  | {
      readonly _tag: "Save";
      readonly request: {
        readonly environmentId: EnvironmentId;
        readonly input: FactorySettingsSetInput;
      };
    }
  | { readonly _tag: "Invalid"; readonly errors: FactorySettingsErrors }
  /** Not editable here, nothing a save would change, or a draft from another destination. */
  | { readonly _tag: "Unavailable" };

const sameTarget = (left: FactorySettingsTarget, right: FactorySettingsTarget) =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

/**
 * What saving the form would do. The request always names the section's own environment and
 * project, and a draft loaded for another destination is never saved into this one. A model change
 * still waiting on the owner's choice is not saved: its role saves what it had.
 */
export const factorySettingsSave = (
  target: FactorySettingsTarget,
  access: FactorySettingsAccess,
  form: FactorySettingsForm,
): FactorySettingsSave => {
  if (factorySettingsMode(access) !== "editable" || !sameTarget(target, form.target)) {
    return { _tag: "Unavailable" };
  }
  const result = factorySettingsFromDraft(form.draft);
  if (result._tag === "Invalid") return result;
  if (!factorySettingsDraftChanged(form.draft)) return { _tag: "Unavailable" };
  return {
    _tag: "Save",
    request: {
      environmentId: target.environmentId,
      input: { projectId: target.projectId, settings: result.settings },
    },
  };
};

/** The choice value of the default model, which saves null. */
export const FACTORY_DEFAULT_ROLE_VALUE = "default";

export interface FactoryRoleOption {
  readonly value: string;
  readonly label: string;
  readonly selection: ModelSelection | null;
  /** A stored selection the destination no longer offers, kept as stored. */
  readonly unavailable: boolean;
}

export interface FactoryRoleChoice {
  readonly value: string;
  readonly options: ReadonlyArray<FactoryRoleOption>;
}

const roleValue = (instanceId: string, model: string) => JSON.stringify([instanceId, model]);

/**
 * A role's model choices from the destination's own providers: the default, then each model of
 * every enabled, available provider. The stored selection is listed as stored; any other is a model
 * alone, which `chooseFactoryRoleModel` holds as pending while the role has saved options, so
 * choosing one never drops them. A stored selection the destination no longer offers is listed as
 * unavailable, never replaced. `value` is what the control shows: a pending model once one is
 * chosen, though the role still saves its stored selection.
 */
export function factoryRoleChoice(
  providers: ReadonlyArray<ServerProvider>,
  stored: ModelSelection | null,
  pending?: FactoryRolePendingModel,
): FactoryRoleChoice {
  const entries = deriveProviderInstanceEntries(providers);
  const offered = entries.filter((entry) => entry.enabled && entry.isAvailable);
  const options: Array<FactoryRoleOption> = [
    {
      value: FACTORY_DEFAULT_ROLE_VALUE,
      label: "Default",
      selection: null,
      unavailable: false,
    },
  ];
  for (const entry of offered) {
    for (const model of entry.models) {
      const value = roleValue(entry.instanceId, model.slug);
      const isStored = stored?.instanceId === entry.instanceId && stored.model === model.slug;
      options.push({
        value,
        label: `${entry.displayName} · ${model.name}`,
        selection: isStored ? stored : { instanceId: entry.instanceId, model: model.slug },
        unavailable: false,
      });
    }
  }
  const valueOf = (selection: ModelSelection | null) =>
    selection === null
      ? FACTORY_DEFAULT_ROLE_VALUE
      : roleValue(selection.instanceId, selection.model);
  if (stored !== null && !options.some((option) => option.value === valueOf(stored))) {
    const known = entries.find((entry) => entry.instanceId === stored.instanceId);
    options.push({
      value: valueOf(stored),
      label: `${known?.displayName ?? stored.instanceId} · ${stored.model} (unavailable)`,
      selection: stored,
      unavailable: true,
    });
  }
  return { value: valueOf(pending === undefined ? stored : pending.selection), options };
}

/** What a role's model describes on the destination; none for a model it does not offer. */
export const factoryRoleDescriptors = (
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null,
): ReadonlyArray<ProviderOptionDescriptor> =>
  selection === null
    ? []
    : (deriveProviderInstanceEntries(providers)
        .filter((entry) => entry.enabled && entry.isAvailable)
        .find((entry) => entry.instanceId === selection.instanceId)
        ?.models.find((model) => model.slug === selection.model)?.capabilities?.optionDescriptors ??
      []);

/** A saved option as the decision about a pending model names it. */
interface FactoryPendingModelOption {
  readonly id: string;
  readonly value: string;
  /** Whether the pending model offers it as saved. */
  readonly offered: boolean;
}

/** What the owner decides before a pending model takes effect. */
interface FactoryPendingModelView {
  /** The model the role keeps and saves until they decide. */
  readonly currentLabel: string;
  readonly nextLabel: string;
  readonly options: ReadonlyArray<FactoryPendingModelOption>;
  /** False for the default model, which carries no options. */
  readonly canKeepOptions: boolean;
}

/** The decision a role owes, or null when it owes none. */
export const factoryPendingModelView = (
  providers: ReadonlyArray<ServerProvider>,
  draft: FactorySettingsDraft,
  role: FactoryRoleName,
): FactoryPendingModelView | null => {
  const pending = draft.pendingRoles[role];
  const current = draft.roles[role];
  if (pending === undefined || current === null) return null;
  const choice = factoryRoleChoice(providers, current, pending);
  const labelOf = (value: string) =>
    choice.options.find((option) => option.value === value)?.label ?? value;
  const { selection: next } = pending;
  const carried: ModelSelection | null =
    next === null ? null : { ...next, options: current.options ?? [] };
  const controls = factoryRoleOptionControls(carried, factoryRoleDescriptors(providers, next));
  return {
    currentLabel: labelOf(roleValue(current.instanceId, current.model)),
    nextLabel: labelOf(choice.value),
    options: (current.options ?? []).map(({ id, value }) => ({
      id,
      value: typeof value === "string" ? value : value ? "On" : "Off",
      offered: controls.some((control) => control.id === id && !control.unsupported),
    })),
    canKeepOptions: next !== null,
  };
};

/** What one command field offers: what suits it, then what suits either. */
export const factoryFieldProposals = (
  discovery: FactoryCommandDiscovery | null,
  name: FactoryCommandName,
): ReadonlyArray<FactoryCommandProposal> => {
  if (discovery === null) return [];
  const wanted = name === "verifyCommand" ? "verify" : "setup";
  return [
    ...discovery.proposals.filter(({ purpose }) => purpose === wanted),
    ...discovery.proposals.filter(({ purpose }) => purpose === "any"),
  ];
};

/** What the owner should know of how discovery read the checkout; undefined when nothing. */
export const factoryDiscoveryNote = (discovery: FactoryCommandDiscovery | null) => {
  if (discovery === null) return undefined;
  const notes: Array<string> = [];
  if (discovery.scripts === "unreadable") {
    notes.push("Factory could not read this project's package.json, so it lists no scripts.");
  }
  if (discovery.scripts === "found" && discovery.packageManager === null) {
    notes.push("No lockfile says which package manager this project uses, so scripts use npm.");
  }
  if (discovery.lockfiles.length > 1) {
    notes.push(
      `This project has several lockfiles (${discovery.lockfiles.join(", ")}); commands use ${discovery.packageManager}.`,
    );
  }
  if (discovery.omittedScripts > 0) {
    notes.push(
      `${discovery.omittedScripts} more ${discovery.omittedScripts === 1 ? "script is" : "scripts are"} not listed; enter one below.`,
    );
  }
  return notes.length === 0 ? undefined : notes.join(" ");
};
