import {
  type FactorySettingsDraft,
  type FactorySettingsErrors,
  factorySettingsDraftEdited,
  factorySettingsFromDraft,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId, ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { FactorySettingsSetInput } from "@t3tools/contracts/fd/factory";

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
  /** Not editable here, unedited, or a draft loaded from another destination. */
  | { readonly _tag: "Unavailable" };

const sameTarget = (left: FactorySettingsTarget, right: FactorySettingsTarget) =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

/**
 * What saving the form would do. The request always names the section's own environment and
 * project, and a draft loaded for another destination is never saved into this one.
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
  if (!factorySettingsDraftEdited(form.draft)) return { _tag: "Unavailable" };
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
 * every enabled, available provider. A stored selection keeps its options when chosen as is. A
 * stored selection the destination no longer offers is listed as unavailable, never replaced.
 */
export function factoryRoleChoice(
  providers: ReadonlyArray<ServerProvider>,
  stored: ModelSelection | null,
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
  if (stored === null) return { value: FACTORY_DEFAULT_ROLE_VALUE, options };
  const value = roleValue(stored.instanceId, stored.model);
  if (!options.some((option) => option.value === value)) {
    const known = entries.find((entry) => entry.instanceId === stored.instanceId);
    options.push({
      value,
      label: `${known?.displayName ?? stored.instanceId} · ${stored.model} (unavailable)`,
      selection: stored,
      unavailable: true,
    });
  }
  return { value, options };
}
