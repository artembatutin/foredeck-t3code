import { useAtomValue } from "@effect/atom-react";
import {
  chooseFactoryCommandProposal,
  chooseFactoryRoleModel,
  type FactoryCommandDraft,
  type FactoryCommandName,
  factoryCommandToCheck,
  type FactoryLimitName,
  type FactoryRoleName,
  factoryRoleOptionControls,
  type FactorySettingsDraft,
  type FactorySettingsErrors,
  factorySettingsDraft,
  factorySettingsDraftAfterSave,
  factorySettingsDraftEdited,
  matchingFactoryProposal,
  rebaseFactorySettingsDraft,
  restoreFactoryCustomCommand,
  setFactoryRoleOption,
  settleFactoryRoleModel,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  FactoryCommandDiscovery,
  FactoryCommandProposal,
  FactoryCommandValidation,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import type { ServerConfig } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { factoryErrorText } from "./deliver";
import {
  type FactorySettingsAccess,
  type FactorySettingsForm,
  type FactorySettingsTarget,
  factoryDiscoveryNote,
  factoryFieldProposals,
  factoryPendingModelView,
  factoryRoleChoice,
  factoryRoleDescriptors,
  factorySettingsMode,
  factorySettingsSave,
} from "./settingsSection";
import { factoryEnvironment } from "./state";

const ROLES: ReadonlyArray<{ readonly role: FactoryRoleName; readonly label: string }> = [
  { role: "planner", label: "Planner" },
  { role: "author", label: "Author" },
  { role: "reviewer", label: "Reviewer" },
];

const LIMITS: ReadonlyArray<{ readonly limit: FactoryLimitName; readonly label: string }> = [
  { limit: "maxFixRounds", label: "Fix rounds" },
  { limit: "maxReviewRounds", label: "Review rounds" },
  { limit: "verifyTimeoutMinutes", label: "Verify timeout (minutes)" },
];

/**
 * Factory settings of one project member on its owning environment: verify and setup commands,
 * role models and their options, limits and review policy, all defaults for future deliveries.
 * Renders nothing on a server without Factory, and shows the values read-only without a live
 * connection holding settings:write.
 */
export function FactorySettings({
  project,
  environmentLabel,
}: {
  project: EnvironmentProject;
  environmentLabel: string;
}) {
  const target: FactorySettingsTarget = {
    environmentId: project.environmentId,
    projectId: project.id,
  };
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(target.environmentId));
  const access: FactorySettingsAccess = {
    supported: useAtomValue(factoryEnvironment.supported(target.environmentId)),
    connected: useConnectedEnvironmentIds().some((id) => id === target.environmentId),
    writePermitted: useAtomValue(
      factoryEnvironment.setSettings.permissionAtom(target.environmentId),
    ),
  };
  if (factorySettingsMode(access) === "hidden") return null;
  return (
    <SettingsSection id="factory" title={`Factory · ${environmentLabel}`}>
      {/* A draft belongs to one destination; another one starts from its own settings. */}
      <SettingsEditor
        key={JSON.stringify([target.environmentId, target.projectId])}
        target={target}
        access={access}
        providers={providers}
      />
    </SettingsSection>
  );
}

function SettingsEditor({
  target,
  access,
  providers,
}: {
  target: FactorySettingsTarget;
  access: FactorySettingsAccess;
  providers: ServerConfig["providers"];
}) {
  const query = useEnvironmentQuery(
    factoryEnvironment.settings({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
  );
  const save = useAtomCommand(factoryEnvironment.setSettings);
  // A read as the form opens, which the form reports itself rather than as a failed action.
  const discover = useAtomCommand(factoryEnvironment.discoverCommands, { reportFailure: false });
  const commandSetupPermitted = useAtomValue(
    factoryEnvironment.discoverCommands.permissionAtom(target.environmentId),
  );
  const [discovery, setDiscovery] = useState<FactoryCommandDiscovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const commandSetup = commandSetupPermitted && factorySettingsMode(access) === "editable";
  const { environmentId, projectId } = target;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the permission-guarded discovery RPC for the open target and drops a reply that lands after the target changes or the editor unmounts
  useEffect(() => {
    if (!commandSetup) return;
    let current = true;
    void discover({ environmentId, input: { projectId } }).then((result) => {
      if (!current) return;
      if (result._tag === "Failure") {
        setDiscoveryError(factoryErrorText(result.cause));
      } else {
        setDiscoveryError(null);
        setDiscovery(result.value);
      }
    });
    return () => {
      current = false;
    };
  }, [commandSetup, discover, environmentId, projectId]);
  const server = query.data;
  // The server value the draft last followed: the change epoch refetches it after any client's
  // save, and an unedited draft then shows the new value.
  const [followed, setFollowed] = useState<FactoryProjectSettings | null>(server);
  const [draft, setDraft] = useState<FactorySettingsDraft | null>(
    server === null ? null : factorySettingsDraft(server),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (server !== followed) {
    setFollowed(server);
    if (server !== null) {
      setDraft(
        draft === null ? factorySettingsDraft(server) : rebaseFactorySettingsDraft(draft, server),
      );
    }
  }

  if (draft === null) {
    return (
      <div className="p-4">
        {query.error ? (
          <p className="text-destructive text-sm">{query.error}</p>
        ) : (
          <p className="text-muted-foreground text-sm">Loading Factory settings…</p>
        )}
      </div>
    );
  }

  const editable = factorySettingsMode(access) === "editable";
  const form: FactorySettingsForm = { target, draft };
  const outcome = factorySettingsSave(target, access, form);
  const errors: FactorySettingsErrors = outcome._tag === "Invalid" ? outcome.errors : {};
  const edited = factorySettingsDraftEdited(draft);
  const disabled = !editable || pending;

  const submit = async () => {
    if (outcome._tag !== "Save") return;
    setPending(true);
    setError(null);
    const result = await save(outcome.request);
    setPending(false);
    if (result._tag === "Failure") setError(factoryErrorText(result.cause));
    else setDraft(factorySettingsDraftAfterSave(draft, result.value));
  };

  const commandEditor = (name: FactoryCommandName, title: string, description: string) => (
    <CommandEditor
      name={name}
      title={title}
      description={description}
      command={draft[name]}
      errors={errors}
      disabled={disabled}
      proposals={factoryFieldProposals(discovery, name)}
      customKept={draft.customCommands[name] !== undefined}
      commandSetup={commandSetup}
      target={target}
      onChange={(command) => setDraft({ ...draft, [name]: command })}
      onPropose={(proposal, proposals) =>
        setDraft(chooseFactoryCommandProposal(draft, name, proposal, proposals))
      }
      onRestoreCustom={() => setDraft(restoreFactoryCustomCommand(draft, name))}
    />
  );

  return (
    <div className="space-y-5 p-4">
      {query.error ? <p className="text-destructive text-sm">{query.error}</p> : null}
      <p className="text-muted-foreground text-xs">
        These are defaults for future deliveries. A delivery you reviewed keeps what you reviewed.
        Any other delivery reads them again as it runs, except its round limits.
      </p>
      {commandEditor(
        "verifyCommand",
        "Verify command",
        "Runs in the delivery's worktree after each change. Required before delivering.",
      )}
      {commandEditor(
        "setupCommand",
        "Setup command",
        "Optional. Runs in the delivery's worktree before each author starts.",
      )}
      {discoveryError !== null ? (
        <p className="text-destructive text-xs">{discoveryError}</p>
      ) : factoryDiscoveryNote(discovery) !== undefined ? (
        <p className="text-muted-foreground text-xs">{factoryDiscoveryNote(discovery)}</p>
      ) : null}
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Role models</h4>
        <p className="text-muted-foreground text-xs">
          Models from this environment's providers, with the options each one describes. Default
          uses the project's model; the planner's and reviewer's default is the author's. An option
          is a request: the provider decides what it runs and how it bills.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {ROLES.map(({ role, label }) => (
            <RoleEditor
              key={role}
              role={role}
              label={label}
              draft={draft}
              providers={providers}
              disabled={disabled}
              onDraft={setDraft}
            />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Limits</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          {LIMITS.map(({ limit, label }) => (
            <label key={limit} className="space-y-1 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <Input
                type="number"
                inputMode="numeric"
                size="sm"
                aria-label={label}
                aria-invalid={errors[`limits.${limit}`] !== undefined}
                disabled={disabled}
                value={draft.limits[limit]}
                onChange={(event) =>
                  setDraft({ ...draft, limits: { ...draft.limits, [limit]: event.target.value } })
                }
              />
              {errors[`limits.${limit}`] ? (
                <span className="block text-destructive">{errors[`limits.${limit}`]}</span>
              ) : null}
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          A delivery keeps the round limits it started with.
        </p>
      </div>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="font-medium text-sm">Blocking severities</legend>
        <p className="text-muted-foreground text-xs">
          Findings at these severities require a fix even when the review verdict passes.
        </p>
        <div className="flex gap-4">
          {(["high", "medium", "low"] as const).map((severity) => (
            <label key={severity} className="flex items-center gap-2 text-xs">
              <Checkbox
                aria-label={`${severity} blocks review`}
                disabled={disabled}
                checked={draft.blockingSeverities.includes(severity)}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    blockingSeverities: checked
                      ? [...draft.blockingSeverities, severity]
                      : draft.blockingSeverities.filter((value) => value !== severity),
                  })
                }
              />
              {severity === "high" ? "High" : severity === "medium" ? "Medium" : "Low"}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">High-risk effort</span>
        <Input
          size="sm"
          aria-label="High-risk effort"
          aria-invalid={errors.highRiskEffort !== undefined}
          disabled={disabled}
          value={draft.highRiskEffort}
          onChange={(event) => setDraft({ ...draft, highRiskEffort: event.target.value })}
        />
        <span className="block text-muted-foreground">
          Used for high-risk tasks and later rounds when the model offers it; never lowers effort.
        </span>
        {errors.highRiskEffort ? (
          <span className="block text-destructive">{errors.highRiskEffort}</span>
        ) : null}
      </label>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      {editable ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending || outcome._tag !== "Save"}
            onClick={() => void submit()}
          >
            {pending ? "Saving..." : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !edited || server === null}
            onClick={() => {
              if (server !== null) setDraft(factorySettingsDraft(server));
              setError(null);
            }}
          >
            Discard
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Changing Factory settings needs a live connection with the settings permission.
        </p>
      )}
    </div>
  );
}

/**
 * One role's model and the options that model describes. A value the model does not offer stays
 * listed and flagged until the owner changes it, and a model change on a role with saved options
 * waits here for their choice, so nothing saved disappears.
 */
function RoleEditor({
  role,
  label,
  draft,
  providers,
  disabled,
  onDraft,
}: {
  role: FactoryRoleName;
  label: string;
  draft: FactorySettingsDraft;
  providers: ServerConfig["providers"];
  disabled: boolean;
  onDraft: (draft: FactorySettingsDraft) => void;
}) {
  const stored = draft.roles[role];
  const choice = factoryRoleChoice(providers, stored, draft.pendingRoles[role]);
  const selected = choice.options.find((option) => option.value === choice.value);
  const pending = factoryPendingModelView(providers, draft, role);
  const controls = factoryRoleOptionControls(stored, factoryRoleDescriptors(providers, stored));
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <Select
          value={choice.value}
          disabled={disabled}
          onValueChange={(value) => {
            const option = choice.options.find((entry) => entry.value === value);
            if (option !== undefined)
              onDraft(chooseFactoryRoleModel(draft, role, option.selection));
          }}
        >
          <SelectTrigger aria-label={`${label} model`} size="sm">
            <SelectValue>{selected?.label ?? "Default"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {choice.options.map((option) => (
              <SelectItem key={option.value} value={option.value} disabled={option.unavailable}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {selected?.unavailable ? (
          <span className="block text-warning-foreground">
            This environment no longer offers that model; it stays saved until you change it.
          </span>
        ) : null}
      </label>
      {pending !== null ? (
        <div
          className="space-y-1 rounded-md border p-2 text-xs"
          aria-label={`${label} saved options`}
        >
          <p>
            {pending.nextLabel} is not applied yet. {pending.currentLabel} stays until you choose
            what happens to its saved options:
          </p>
          <ul className="ps-3">
            {pending.options.map((option) => (
              <li key={option.id}>
                {option.id}: {option.value}
                {option.offered ? "" : " (the new model does not offer this)"}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-1">
            {pending.canKeepOptions ? (
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onDraft(settleFactoryRoleModel(draft, role, "keep_options"))}
              >
                Keep these options
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onDraft(settleFactoryRoleModel(draft, role, "clear_options"))}
            >
              Remove them
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onDraft(settleFactoryRoleModel(draft, role, "keep_model"))}
            >
              Keep the old model
            </Button>
          </div>
        </div>
      ) : null}
      {controls.map((control) => (
        <label key={control.id} className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{control.label}</span>
          <Select
            value={control.value}
            disabled={disabled}
            onValueChange={(value) => {
              const next = control.choices.find((entry) => entry.value === value);
              if (next !== undefined) {
                onDraft(setFactoryRoleOption(draft, role, control.id, next.selection));
              }
            }}
          >
            <SelectTrigger aria-label={`${label} ${control.label}`} size="sm">
              <SelectValue>
                {control.choices.find((entry) => entry.value === control.value)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {control.choices.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {control.description !== undefined ? (
            <span className="block text-muted-foreground">{control.description}</span>
          ) : null}
          {control.unsupported ? (
            <span className="block text-warning-foreground">
              This model does not offer that value. It stays saved until you change it, and a
              reviewed delivery will not start with it.
            </span>
          ) : null}
        </label>
      ))}
    </div>
  );
}

/** The choice that stands for a command no proposal matches. */
const CUSTOM_COMMAND_VALUE = "custom";

/**
 * A command field: what the project's checkout offers, then the executable and arguments it fills,
 * each argument its own field so none is split or joined. Any value can be entered by hand, and one
 * replaced by a proposal is one choice away. Checking asks the server what it would resolve; nothing
 * runs or saves until a delivery runs the saved command.
 */
function CommandEditor({
  name,
  title,
  description,
  command,
  errors,
  disabled,
  proposals,
  customKept,
  commandSetup,
  target,
  onChange,
  onPropose,
  onRestoreCustom,
}: {
  name: FactoryCommandName;
  title: string;
  description: string;
  command: FactoryCommandDraft;
  errors: FactorySettingsErrors;
  disabled: boolean;
  proposals: ReadonlyArray<FactoryCommandProposal>;
  customKept: boolean;
  commandSetup: boolean;
  target: FactorySettingsTarget;
  onChange: (command: FactoryCommandDraft) => void;
  onPropose: (
    proposal: FactoryCommandProposal,
    proposals: ReadonlyArray<FactoryCommandProposal>,
  ) => void;
  onRestoreCustom: () => void;
}) {
  const validate = useAtomCommand(factoryEnvironment.validateCommand, { reportFailure: false });
  // What the last check said, with what it checked: an edit makes it say nothing of this command.
  const [check, setCheck] = useState<{
    readonly key: string;
    readonly text: string;
    readonly status: FactoryCommandValidation["status"] | "failed";
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const executableError = errors[`${name}.executable`];
  const argsError = errors[`${name}.args`];
  const setArg = (index: number, value: string) =>
    onChange({ ...command, args: command.args.map((arg, at) => (at === index ? value : arg)) });
  const toCheck = factoryCommandToCheck(command, name);
  const checkKey = JSON.stringify(command);
  const shownCheck = check?.key === checkKey ? check : null;
  const matched = matchingFactoryProposal(command, proposals);
  const runCheck = async () => {
    if (toCheck === null) return;
    setChecking(true);
    const result = await validate({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, command: toCheck },
    });
    setChecking(false);
    setCheck(
      result._tag === "Failure"
        ? { key: checkKey, status: "failed", text: factoryErrorText(result.cause) }
        : { key: checkKey, status: result.value.status, text: result.value.message },
    );
  };
  return (
    <div className="space-y-2">
      <div>
        <h4 className="font-medium text-sm">{title}</h4>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {proposals.length > 0 ? (
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">From this project</span>
          <Select
            value={matched?.id ?? CUSTOM_COMMAND_VALUE}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === CUSTOM_COMMAND_VALUE) {
                onRestoreCustom();
                return;
              }
              const proposal = proposals.find((entry) => entry.id === value);
              if (proposal !== undefined) onPropose(proposal, proposals);
            }}
          >
            <SelectTrigger aria-label={`${title} suggestion`} size="sm">
              <SelectValue>{matched?.label ?? "Custom command"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {proposals.map((proposal) => (
                <SelectItem key={proposal.id} value={proposal.id}>
                  {proposal.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_COMMAND_VALUE}>
                {customKept ? "Custom command (the one you had)" : "Custom command"}
              </SelectItem>
            </SelectPopup>
          </Select>
        </label>
      ) : null}
      <Input
        size="sm"
        font="mono"
        aria-label={`${title} executable`}
        aria-invalid={executableError !== undefined}
        placeholder="Executable, for example node"
        disabled={disabled}
        value={command.executable}
        onChange={(event) => onChange({ ...command, executable: event.target.value })}
      />
      {executableError ? (
        <p className="text-destructive text-xs">{executableError}</p>
      ) : command.executable.length === 0 && command.args.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Without an executable, saving removes this command and its arguments.
        </p>
      ) : null}
      {command.args.map((arg, index) => (
        // Arguments have no identity of their own: their position is what the command runs.
        // oxlint-disable-next-line react/no-array-index-key -- an argument is its position
        <div key={index} className="flex items-center gap-2">
          <Input
            size="sm"
            font="mono"
            aria-label={`${title} argument ${index + 1}`}
            disabled={disabled}
            value={arg}
            onChange={(event) => setArg(index, event.target.value)}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove argument ${index + 1}`}
            disabled={disabled}
            onClick={() =>
              onChange({ ...command, args: command.args.filter((_, at) => at !== index) })
            }
          >
            <XIcon />
          </Button>
        </div>
      ))}
      {argsError ? <p className="text-destructive text-xs">{argsError}</p> : null}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange({ ...command, args: [...command.args, ""] })}
        >
          Add argument
        </Button>
        {commandSetup ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || checking || toCheck === null}
            onClick={() => void runCheck()}
          >
            {checking ? "Checking..." : "Check command"}
          </Button>
        ) : null}
        {command.executable.length > 0 || command.args.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ executable: "", args: [] })}
          >
            Remove command
          </Button>
        ) : null}
      </div>
      {shownCheck !== null ? (
        <p
          className={
            shownCheck.status === "found"
              ? "text-muted-foreground text-xs"
              : "text-destructive text-xs"
          }
        >
          {shownCheck.text}
        </p>
      ) : null}
    </div>
  );
}
