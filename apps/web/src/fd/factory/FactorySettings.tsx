import { useAtomValue } from "@effect/atom-react";
import {
  type FactoryCommandDraft,
  type FactoryCommandName,
  type FactoryLimitName,
  type FactoryRoleName,
  type FactorySettingsDraft,
  type FactorySettingsErrors,
  factorySettingsDraft,
  factorySettingsDraftEdited,
  rebaseFactorySettingsDraft,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import type { ServerConfig } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
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
import { useAtomCommand } from "../../state/use-atom-command";
import { factoryErrorText } from "./deliver";
import {
  type FactorySettingsAccess,
  type FactorySettingsForm,
  type FactorySettingsTarget,
  factoryRoleChoice,
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
 * role models and limits. Renders nothing on a server without Factory, and shows the values
 * read-only without a live connection holding settings:write.
 */
export function FactorySettings({
  project,
  serverConfig,
  environmentLabel,
}: {
  project: EnvironmentProject;
  serverConfig: ServerConfig | null;
  environmentLabel: string;
}) {
  const target: FactorySettingsTarget = {
    environmentId: project.environmentId,
    projectId: project.id,
  };
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
        providers={serverConfig?.providers ?? []}
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
    else setDraft(factorySettingsDraft(result.value));
  };

  return (
    <div className="space-y-5 p-4">
      {query.error ? <p className="text-destructive text-sm">{query.error}</p> : null}
      <CommandEditor
        name="verifyCommand"
        title="Verify command"
        description="Runs in the delivery's worktree after each change. Required before delivering."
        command={draft.verifyCommand}
        errors={errors}
        disabled={disabled}
        onChange={(verifyCommand) => setDraft({ ...draft, verifyCommand })}
      />
      <CommandEditor
        name="setupCommand"
        title="Setup command"
        description="Optional. Runs in the delivery's worktree before each author starts."
        command={draft.setupCommand}
        errors={errors}
        disabled={disabled}
        onChange={(setupCommand) => setDraft({ ...draft, setupCommand })}
      />
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Role models</h4>
        <p className="text-muted-foreground text-xs">
          Models from this environment's providers. Default uses the project's model; the reviewer's
          default is the author's.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {ROLES.map(({ role, label }) => {
            const choice = factoryRoleChoice(providers, draft.roles[role]);
            const selected = choice.options.find((option) => option.value === choice.value);
            return (
              <label key={role} className="space-y-1 text-xs">
                <span className="text-muted-foreground">{label}</span>
                <Select
                  value={choice.value}
                  disabled={disabled}
                  onValueChange={(value) => {
                    const option = choice.options.find((entry) => entry.value === value);
                    if (option === undefined) return;
                    setDraft({ ...draft, roles: { ...draft.roles, [role]: option.selection } });
                  }}
                >
                  <SelectTrigger aria-label={`${label} model`} size="sm">
                    <SelectValue>{selected?.label ?? "Default"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choice.options.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={option.unavailable}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {selected?.unavailable ? (
                  <span className="block text-warning-foreground">
                    This environment no longer offers that model; it stays saved until you change
                    it.
                  </span>
                ) : null}
              </label>
            );
          })}
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
          A delivery keeps the limits it started with.
        </p>
      </div>
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

/** An executable and its arguments, each argument its own field so none is split or joined. */
function CommandEditor({
  name,
  title,
  description,
  command,
  errors,
  disabled,
  onChange,
}: {
  name: FactoryCommandName;
  title: string;
  description: string;
  command: FactoryCommandDraft;
  errors: FactorySettingsErrors;
  disabled: boolean;
  onChange: (command: FactoryCommandDraft) => void;
}) {
  const executableError = errors[`${name}.executable`];
  const argsError = errors[`${name}.args`];
  const setArg = (index: number, value: string) =>
    onChange({ ...command, args: command.args.map((arg, at) => (at === index ? value : arg)) });
  return (
    <div className="space-y-2">
      <div>
        <h4 className="font-medium text-sm">{title}</h4>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
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
    </div>
  );
}
