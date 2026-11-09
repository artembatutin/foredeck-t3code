import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue,
} from "@t3tools/contracts";
import type {
  FactoryCommand,
  FactoryCommandProposal,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";

/** The bounds `FactoryProjectSettings` decodes with; the draft refuses anything outside them. */
export const FACTORY_SETTINGS_BOUNDS = {
  rounds: { minimum: 0, maximum: 10 },
  verifyTimeoutMinutes: { minimum: 1, maximum: 1440 },
  executableLength: 1024,
  argLength: 8192,
  argCount: 256,
  highRiskEffortLength: 64,
} as const;

/** A command as the form edits it: the executable and each argument on its own, never a shell line. */
export interface FactoryCommandDraft {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export type FactoryRoleName = keyof FactoryProjectSettings["roles"];
export type FactoryLimitName = keyof FactoryProjectSettings["limits"];
export type FactoryCommandName = "verifyCommand" | "setupCommand";

/** The model the owner picked for a role with saved options, held until they say what of those. */
export interface FactoryRolePendingModel {
  /** Null for the default model, which carries no options. */
  readonly selection: ModelSelection | null;
}

/**
 * Project settings as the Factory form edits them. Limits hold the text their inputs hold.
 * `base` is the server value the draft keeps the fields it does not edit from (pipeline).
 */
export interface FactorySettingsDraft {
  readonly base: FactoryProjectSettings;
  readonly verifyCommand: FactoryCommandDraft;
  readonly setupCommand: FactoryCommandDraft;
  readonly roles: FactoryProjectSettings["roles"];
  readonly limits: Readonly<Record<FactoryLimitName, string>>;
  readonly blockingSeverities: FactoryProjectSettings["blockingSeverities"];
  readonly highRiskEffort: string;
  /** Model changes waiting on the owner's choice; `roles` and any save keep the old value till then. */
  readonly pendingRoles: Partial<Record<FactoryRoleName, FactoryRolePendingModel>>;
  /** What each field held when a proposal replaced it, so choosing one never loses a custom value. */
  readonly customCommands: Partial<Record<FactoryCommandName, FactoryCommandDraft>>;
}

export type FactorySettingsField =
  | `${FactoryCommandName}.executable`
  | `${FactoryCommandName}.args`
  | "highRiskEffort"
  | `limits.${FactoryLimitName}`;

export type FactorySettingsErrors = Partial<Record<FactorySettingsField, string>>;

export type FactorySettingsDraftResult =
  | { readonly _tag: "Valid"; readonly settings: FactoryProjectSettings }
  | { readonly _tag: "Invalid"; readonly errors: FactorySettingsErrors };

const commandDraft = (command: FactoryCommand | null): FactoryCommandDraft =>
  command === null
    ? { executable: "", args: [] }
    : { executable: command.executable, args: [...command.args] };

/** The draft of a server value, unedited. */
export const factorySettingsDraft = (settings: FactoryProjectSettings): FactorySettingsDraft => ({
  base: settings,
  verifyCommand: commandDraft(settings.verifyCommand),
  setupCommand: commandDraft(settings.setupCommand),
  roles: settings.roles,
  blockingSeverities: [...settings.blockingSeverities],
  highRiskEffort: settings.highRiskEffort,
  limits: {
    maxFixRounds: String(settings.limits.maxFixRounds),
    maxReviewRounds: String(settings.limits.maxReviewRounds),
    verifyTimeoutMinutes: String(settings.limits.verifyTimeoutMinutes),
  },
  pendingRoles: {},
  customCommands: {},
});

/**
 * A command from its draft. A cleared executable removes the command, whatever arguments the form
 * still holds; one of only whitespace is refused as blank. Arguments are kept exactly as entered.
 */
const commandFromDraft = (
  name: FactoryCommandName,
  draft: FactoryCommandDraft,
  errors: FactorySettingsErrors,
): FactoryCommand | null => {
  if (draft.executable.length === 0) return null;
  const executable = draft.executable.trim();
  if (executable.length === 0) {
    errors[`${name}.executable`] =
      "Enter the executable, or clear the field to remove the command.";
    return null;
  }
  if (executable.length > FACTORY_SETTINGS_BOUNDS.executableLength) {
    errors[`${name}.executable`] =
      `Use at most ${FACTORY_SETTINGS_BOUNDS.executableLength} characters.`;
  }
  if (draft.args.length > FACTORY_SETTINGS_BOUNDS.argCount) {
    errors[`${name}.args`] = `Use at most ${FACTORY_SETTINGS_BOUNDS.argCount} arguments.`;
  } else if (draft.args.some((arg) => arg.length > FACTORY_SETTINGS_BOUNDS.argLength)) {
    errors[`${name}.args`] =
      `Keep each argument to at most ${FACTORY_SETTINGS_BOUNDS.argLength} characters.`;
  }
  return { executable, args: [...draft.args] };
};

const limitFromDraft = (
  name: FactoryLimitName,
  text: string,
  bounds: { readonly minimum: number; readonly maximum: number },
  errors: FactorySettingsErrors,
): number => {
  const value = /^\s*-?\d+\s*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    errors[`limits.${name}`] = `Enter a whole number from ${bounds.minimum} to ${bounds.maximum}.`;
  }
  return value;
};

/**
 * The settings a draft saves, or a message for each field it cannot save. The fields the draft
 * does not edit come from its base unchanged.
 */
export const factorySettingsFromDraft = (
  draft: FactorySettingsDraft,
): FactorySettingsDraftResult => {
  const errors: FactorySettingsErrors = {};
  const verifyCommand = commandFromDraft("verifyCommand", draft.verifyCommand, errors);
  const setupCommand = commandFromDraft("setupCommand", draft.setupCommand, errors);
  const highRiskEffort = draft.highRiskEffort.trim();
  if (highRiskEffort.length === 0) {
    errors.highRiskEffort = "Enter an effort value.";
  } else if (highRiskEffort.length > FACTORY_SETTINGS_BOUNDS.highRiskEffortLength) {
    errors.highRiskEffort = `Use at most ${FACTORY_SETTINGS_BOUNDS.highRiskEffortLength} characters.`;
  }
  const blockingSeverities = (["high", "medium", "low"] as const).filter((severity) =>
    draft.blockingSeverities.includes(severity),
  );
  const { rounds, verifyTimeoutMinutes } = FACTORY_SETTINGS_BOUNDS;
  const limits = {
    maxFixRounds: limitFromDraft("maxFixRounds", draft.limits.maxFixRounds, rounds, errors),
    maxReviewRounds: limitFromDraft(
      "maxReviewRounds",
      draft.limits.maxReviewRounds,
      rounds,
      errors,
    ),
    verifyTimeoutMinutes: limitFromDraft(
      "verifyTimeoutMinutes",
      draft.limits.verifyTimeoutMinutes,
      verifyTimeoutMinutes,
      errors,
    ),
  };
  if (Object.keys(errors).length > 0) return { _tag: "Invalid", errors };
  return {
    _tag: "Valid",
    settings: {
      ...draft.base,
      verifyCommand,
      setupCommand,
      roles: draft.roles,
      limits,
      blockingSeverities,
      highRiskEffort,
    },
  };
};

const FACTORY_ROLE_NAMES = ["planner", "author", "reviewer"] as const;

const sameCommand = (left: FactoryCommandDraft, right: FactoryCommandDraft) =>
  left.executable === right.executable &&
  left.args.length === right.args.length &&
  left.args.every((arg, index) => arg === right.args[index]);

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null));

/** Whether saving the draft would change anything: it differs from its base in a field it edits. */
export const factorySettingsDraftChanged = (draft: FactorySettingsDraft): boolean => {
  const unedited = factorySettingsDraft(draft.base);
  return (
    !sameCommand(draft.verifyCommand, unedited.verifyCommand) ||
    !sameCommand(draft.setupCommand, unedited.setupCommand) ||
    draft.highRiskEffort !== unedited.highRiskEffort ||
    (["high", "medium", "low"] as const).some(
      (severity) =>
        draft.blockingSeverities.includes(severity) !==
        unedited.blockingSeverities.includes(severity),
    ) ||
    FACTORY_ROLE_NAMES.some((role) => !sameSelection(draft.roles[role], unedited.roles[role])) ||
    (["maxFixRounds", "maxReviewRounds", "verifyTimeoutMinutes"] as const).some(
      (limit) => draft.limits[limit] !== unedited.limits[limit],
    )
  );
};

/** Whether the draft holds anything of the owner's: a change to save or a choice they still owe. */
export const factorySettingsDraftEdited = (draft: FactorySettingsDraft): boolean =>
  factorySettingsDraftChanged(draft) || Object.keys(draft.pendingRoles).length > 0;

/**
 * A draft once the server's value moves, as when another client saves. An unedited draft shows
 * the new value; an edited one keeps every edit until it is saved or discarded, and takes the
 * new value only for the fields the form does not edit, so a save never reverts those. A role it
 * left alone follows the server too, so a save never takes back options another client chose.
 */
export const rebaseFactorySettingsDraft = (
  draft: FactorySettingsDraft,
  next: FactoryProjectSettings,
): FactorySettingsDraft => {
  const { customCommands } = draft;
  if (!factorySettingsDraftEdited(draft)) return { ...factorySettingsDraft(next), customCommands };
  const followed = (role: FactoryRoleName) =>
    sameSelection(draft.roles[role], draft.base.roles[role]) ? next.roles[role] : draft.roles[role];
  return {
    ...draft,
    base: next,
    roles: {
      planner: followed("planner"),
      author: followed("author"),
      reviewer: followed("reviewer"),
    },
  };
};

/** The draft a save leaves: the saved value, with what the save could not settle still owed. */
export const factorySettingsDraftAfterSave = (
  draft: FactorySettingsDraft,
  saved: FactoryProjectSettings,
): FactorySettingsDraft => ({
  ...factorySettingsDraft(saved),
  pendingRoles: draft.pendingRoles,
  customCommands: draft.customCommands,
});

const withoutPending = (draft: FactorySettingsDraft, role: FactoryRoleName) => {
  const { [role]: _settled, ...pendingRoles } = draft.pendingRoles;
  return pendingRoles;
};

const sameModel = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.instanceId === right.instanceId &&
    left.model === right.model);

/**
 * The owner picks a role's model. A role with saved options keeps them and its old model until the
 * owner says what of them goes with the new one (`settleFactoryRoleModel`): their pick says nothing
 * about options, and a notice after they were gone would be too late. Picking the current model
 * again takes the change back.
 */
export const chooseFactoryRoleModel = (
  draft: FactorySettingsDraft,
  role: FactoryRoleName,
  next: ModelSelection | null,
): FactorySettingsDraft => {
  const current = draft.roles[role];
  if (sameModel(current, next)) return { ...draft, pendingRoles: withoutPending(draft, role) };
  if ((current?.options ?? []).length === 0) {
    return {
      ...draft,
      roles: { ...draft.roles, [role]: next },
      pendingRoles: withoutPending(draft, role),
    };
  }
  return { ...draft, pendingRoles: { ...draft.pendingRoles, [role]: { selection: next } } };
};

/**
 * `keep_options` moves every saved option to the new model, where any it does not offer stays
 * flagged until it is resolved; `clear_options` takes the new model at its own defaults;
 * `keep_model` takes the change back. The default model carries no options, so nothing keeps them
 * there and the change stays pending rather than lose one.
 */
export type FactoryRoleModelDecision = "keep_options" | "clear_options" | "keep_model";

export const settleFactoryRoleModel = (
  draft: FactorySettingsDraft,
  role: FactoryRoleName,
  decision: FactoryRoleModelDecision,
): FactorySettingsDraft => {
  const pending = draft.pendingRoles[role];
  if (pending === undefined) return draft;
  const pendingRoles = withoutPending(draft, role);
  if (decision === "keep_model") return { ...draft, pendingRoles };
  const { selection: next } = pending;
  if (decision === "keep_options" && next === null) return draft;
  const options = draft.roles[role]?.options;
  const settled =
    next === null
      ? null
      : {
          instanceId: next.instanceId,
          model: next.model,
          ...(decision === "keep_options" && options !== undefined ? { options } : {}),
        };
  return { ...draft, roles: { ...draft.roles, [role]: settled }, pendingRoles };
};

/** One value a role option's control offers. */
export interface FactoryRoleOptionChoice {
  /** Stands for the value in the control: a value's JSON, or `FACTORY_OPTION_DEFAULT_VALUE`. */
  readonly value: string;
  readonly label: string;
  /** What choosing it saves; null removes the option, so the model's default applies. */
  readonly selection: ProviderOptionSelectionValue | null;
}

/** The control one option of a role gets. */
export interface FactoryRoleOptionControl {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  /** The choice now in effect. */
  readonly value: string;
  readonly choices: ReadonlyArray<FactoryRoleOptionChoice>;
  /** A saved value the model does not offer, which stays saved until the owner changes it. */
  readonly unsupported: boolean;
}

/** The choice that removes a saved option. No value's JSON can read the same. */
export const FACTORY_OPTION_DEFAULT_VALUE = "default";

const choiceOf = (value: ProviderOptionSelectionValue, label: string): FactoryRoleOptionChoice => ({
  value: JSON.stringify(value),
  label,
  selection: value,
});

const savedValueText = (value: ProviderOptionSelectionValue) =>
  typeof value === "string" ? value : value ? "On" : "Off";

/**
 * A role's option controls, generated only from what its model describes: one per descriptor, and
 * none where it describes none. A saved option that no descriptor offers, or whose value it does not
 * offer, is listed all the same and flagged, the way the server judges it for a reviewed delivery,
 * so nothing saved is ever out of sight. The default model has no descriptors to read.
 */
export const factoryRoleOptionControls = (
  selection: ModelSelection | null,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<FactoryRoleOptionControl> => {
  if (selection === null) return [];
  const saved = selection.options ?? [];
  const described = descriptors.map((descriptor): FactoryRoleOptionControl => {
    const stored = saved.find(({ id }) => id === descriptor.id)?.value;
    const offered: ReadonlyArray<FactoryRoleOptionChoice> =
      descriptor.type === "select"
        ? descriptor.options.map((option) => choiceOf(option.id, option.label))
        : [choiceOf(true, "On"), choiceOf(false, "Off")];
    const current = stored === undefined ? undefined : JSON.stringify(stored);
    const unsupported = current !== undefined && !offered.some(({ value }) => value === current);
    const fallback = getProviderOptionCurrentLabel(descriptor);
    return {
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      value: current ?? FACTORY_OPTION_DEFAULT_VALUE,
      choices: [
        {
          value: FACTORY_OPTION_DEFAULT_VALUE,
          label: fallback === undefined ? "Provider default" : `Provider default (${fallback})`,
          selection: null,
        },
        ...offered,
        ...(unsupported && stored !== undefined
          ? [choiceOf(stored, `${savedValueText(stored)} (not offered)`)]
          : []),
      ],
      unsupported,
    };
  });
  const undescribed = saved
    .filter(({ id }) => !descriptors.some((descriptor) => descriptor.id === id))
    .map(({ id, value }): FactoryRoleOptionControl => ({
      id,
      label: id,
      description: undefined,
      value: JSON.stringify(value),
      choices: [
        { value: FACTORY_OPTION_DEFAULT_VALUE, label: "Remove this option", selection: null },
        choiceOf(value, `${savedValueText(value)} (not offered)`),
      ],
      unsupported: true,
    }));
  return [...described, ...undescribed];
};

/** Sets or, with null, removes one saved option of a role, leaving every other as it was. */
export const setFactoryRoleOption = (
  draft: FactorySettingsDraft,
  role: FactoryRoleName,
  id: string,
  value: ProviderOptionSelectionValue | null,
): FactorySettingsDraft => {
  const selection = draft.roles[role];
  if (selection === null) return draft;
  const saved = selection.options ?? [];
  const options =
    value === null
      ? saved.filter((option) => option.id !== id)
      : saved.some((option) => option.id === id)
        ? saved.map((option) => (option.id === id ? { id, value } : option))
        : [...saved, { id, value }];
  const { options: _replaced, ...rest } = selection;
  return {
    ...draft,
    roles: { ...draft.roles, [role]: options.length === 0 ? rest : { ...rest, options } },
  };
};

/** The proposal a field's command is, if it is one exactly. */
export const matchingFactoryProposal = (
  command: FactoryCommandDraft,
  proposals: ReadonlyArray<FactoryCommandProposal>,
): FactoryCommandProposal | undefined =>
  proposals.find((proposal) => sameCommand(command, commandDraft(proposal.command)));

/**
 * Fills a field from a proposal, keeping what it held if the owner wrote it, so going back is one
 * choice away. A proposal is only ever a draft's value: nothing runs or saves by being chosen.
 */
export const chooseFactoryCommandProposal = (
  draft: FactorySettingsDraft,
  name: FactoryCommandName,
  proposal: FactoryCommandProposal,
  proposals: ReadonlyArray<FactoryCommandProposal>,
): FactorySettingsDraft => {
  const current = draft[name];
  const custom =
    current.executable.length === 0 || matchingFactoryProposal(current, proposals) !== undefined
      ? draft.customCommands
      : { ...draft.customCommands, [name]: current };
  return { ...draft, [name]: commandDraft(proposal.command), customCommands: custom };
};

/** Puts back the custom command a proposal replaced, exactly as it stood. */
export const restoreFactoryCustomCommand = (
  draft: FactorySettingsDraft,
  name: FactoryCommandName,
): FactorySettingsDraft => {
  const custom = draft.customCommands[name];
  if (custom === undefined) return draft;
  const { [name]: _restored, ...customCommands } = draft.customCommands;
  return { ...draft, [name]: custom, customCommands };
};

/** The command a validation would check, or null for a draft that holds none it could save. */
export const factoryCommandToCheck = (
  draft: FactoryCommandDraft,
  name: FactoryCommandName,
): FactoryCommand | null => {
  const errors: FactorySettingsErrors = {};
  const command = commandFromDraft(name, draft, errors);
  return Object.keys(errors).length > 0 ? null : command;
};
