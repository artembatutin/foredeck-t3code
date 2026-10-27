import type { ModelSelection } from "@t3tools/contracts";
import type { FactoryCommand, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";

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

/** Whether the draft differs from its base in any field the form edits. */
export const factorySettingsDraftEdited = (draft: FactorySettingsDraft): boolean => {
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
    (["planner", "author", "reviewer"] as const).some(
      (role) => !sameSelection(draft.roles[role], unedited.roles[role]),
    ) ||
    (["maxFixRounds", "maxReviewRounds", "verifyTimeoutMinutes"] as const).some(
      (limit) => draft.limits[limit] !== unedited.limits[limit],
    )
  );
};

/**
 * A draft once the server's value moves, as when another client saves. An unedited draft shows
 * the new value; an edited one keeps every edit until it is saved or discarded, and takes the
 * new value only for the fields the form does not edit, so a save never reverts those.
 */
export const rebaseFactorySettingsDraft = (
  draft: FactorySettingsDraft,
  next: FactoryProjectSettings,
): FactorySettingsDraft =>
  factorySettingsDraftEdited(draft) ? { ...draft, base: next } : factorySettingsDraft(next);
