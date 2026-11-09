import { WORK_READ_SCOPE, workSupport } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig } from "@t3tools/contracts";
import type {
  WorkSource,
  WorkSourceConfig,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import { CircleAlertIcon, CircleCheckIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SOURCE_KIND_LABELS, WorkRepairNotice, workCommandError } from "./shared";
import { useWorkWritable, workCommands, workEnvironment } from "./state";

const DEFAULT_DIRECTORY = ".foredeck/work";

/** Work sources of one project member on one environment: add, test, disconnect and restore. */
export function WorkSourcesSettings({
  project,
  serverConfig,
  environmentLabel,
}: {
  project: EnvironmentProject;
  serverConfig: ServerConfig | null;
  environmentLabel: string;
}) {
  const support = workSupport(serverConfig);
  const readable = useEnvironmentScope(project.environmentId, WORK_READ_SCOPE);
  if (support === undefined) return null;
  return (
    <SettingsSection id="work-sources" title={`Work sources · ${environmentLabel}`}>
      {readable ? (
        <SourcesEditor project={project} kinds={[...support.sourceKinds]} />
      ) : (
        <div className="px-3 py-3 sm:px-4">
          <WorkRepairNotice />
        </div>
      )}
    </SettingsSection>
  );
}

function SourcesEditor({
  project,
  kinds,
}: {
  project: EnvironmentProject;
  kinds: ReadonlyArray<WorkSourceKind>;
}) {
  const environmentId = project.environmentId;
  const query = useEnvironmentQuery(
    workEnvironment.sources({
      environmentId,
      input: { projectId: project.id, includeDisconnected: true },
    }),
  );
  const permitted = useWorkWritable(environmentId, workCommands.saveSource, "sources");
  const disconnect = useAtomCommand(workCommands.disconnectSource);
  const restore = useAtomCommand(workCommands.restoreSource);
  const save = useAtomCommand(workCommands.saveSource);
  const test = useAtomCommand(workCommands.testSource);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, SourceMessage>>({});
  const sources = query.data?.sources ?? [];
  const note = (sourceId: string, text: string, ok = false) =>
    setMessages((previous) => ({ ...previous, [sourceId]: { text, ok } }));

  const testSource = async (source: WorkSource) => {
    const result = await test({
      environmentId,
      input: { projectId: project.id, sourceId: source.sourceId, config: source.config },
    });
    if (result._tag === "Success" && result.value.ok)
      note(source.sourceId, "Connection works.", true);
    else
      note(
        source.sourceId,
        result._tag === "Success"
          ? (result.value.message ?? "The source could not be read.")
          : workCommandError(result),
      );
  };

  const toggle = async (source: WorkSource) => {
    const input = { sourceId: source.sourceId, expectedVersion: source.version };
    const result =
      source.state === "active"
        ? await disconnect({ environmentId, input })
        : await restore({ environmentId, input });
    if (result._tag === "Failure") note(source.sourceId, workCommandError(result));
  };

  const clearToken = async (source: WorkSource) => {
    const result = await save({
      environmentId,
      input: {
        sourceId: source.sourceId,
        projectId: project.id,
        label: source.label,
        config: source.config,
        credential: "clear",
        expectedVersion: source.version,
      },
    });
    if (result._tag === "Success") {
      note(source.sourceId, "Token removed for every source on this site and account.", true);
    } else note(source.sourceId, workCommandError(result));
  };

  return (
    <>
      {query.error ? (
        <div className="px-3 py-3 sm:px-4">
          <SourceNotice message={{ text: query.error, ok: false }} />
        </div>
      ) : null}
      {sources.length === 0 && !query.isPending && !permitted ? (
        <div className="px-3 py-3 text-muted-foreground text-sm sm:px-4">No Work sources yet.</div>
      ) : null}
      {sources.map((source) => {
        const active = source.state === "active";
        const jira = source.kind === "jira" && active;
        return (
          <SettingsRow
            key={source.sourceId}
            title={
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate">{source.label}</span>
                <Badge size="sm" variant="outline">
                  {SOURCE_KIND_LABELS[source.kind]}
                </Badge>
                {source.state === "disconnected" ? (
                  <Badge size="sm" variant="secondary">
                    Disconnected
                  </Badge>
                ) : null}
                {active && source.health.status !== "ok" ? (
                  <Badge size="sm" variant="warning">
                    {source.health.status.replaceAll("_", " ")}
                  </Badge>
                ) : null}
              </span>
            }
            description={<span className="font-mono">{source.identity}</span>}
            status={
              active && (source.health.message || source.config.kind === "jira") ? (
                <span className="block max-w-xl space-y-0.5">
                  {source.health.message ? (
                    <span className="block">{source.health.message}</span>
                  ) : null}
                  {source.config.kind === "jira" ? (
                    <span className="block">
                      The token is shared by every Jira source for {source.config.email} on{" "}
                      {source.config.siteUrl}; replacing or removing it applies to all of them.
                    </span>
                  ) : null}
                </span>
              ) : undefined
            }
            control={
              <>
                {active ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!permitted}
                    onClick={() => void testSource(source)}
                  >
                    Test
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!permitted}
                  onClick={() => void toggle(source)}
                >
                  {active ? "Disconnect" : "Restore"}
                </Button>
                {jira ? (
                  <Menu>
                    <MenuTrigger
                      disabled={!permitted}
                      aria-label={`More actions for ${source.label}`}
                      render={<Button size="icon-xs" variant="ghost" />}
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        onClick={() =>
                          setReplacing((current) =>
                            current === source.sourceId ? null : source.sourceId,
                          )
                        }
                      >
                        {source.credential.configured ? "Replace token" : "Set token"}
                      </MenuItem>
                      {source.credential.configured ? (
                        <MenuItem onClick={() => void clearToken(source)}>Remove token</MenuItem>
                      ) : null}
                    </MenuPopup>
                  </Menu>
                ) : null}
              </>
            }
          >
            {(replacing === source.sourceId && permitted) || messages[source.sourceId] ? (
              <div className="mt-3 max-w-2xl space-y-3 pb-3.5">
                {replacing === source.sourceId && permitted ? (
                  <ReplaceTokenForm
                    project={project}
                    source={source}
                    onDone={(message) => {
                      setReplacing(null);
                      if (message !== null) note(source.sourceId, message, true);
                    }}
                  />
                ) : null}
                {messages[source.sourceId] ? (
                  <SourceNotice message={messages[source.sourceId]!} />
                ) : null}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
      {!permitted ? (
        <div className="px-3 py-3 text-muted-foreground text-xs sm:px-4">
          Changing Work sources needs a live connection with the settings permission.
        </div>
      ) : (
        <SettingsRow
          title="Add a source"
          description={`Track a folder of Markdown tasks${kinds.includes("github") ? ", a GitHub repository" : ""}${kinds.includes("jira") ? " or a Jira project" : ""}.`}
          control={
            adding ? undefined : (
              <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon />
                Add source
              </Button>
            )
          }
        >
          {adding ? (
            <AddSourceForm project={project} kinds={kinds} onDone={() => setAdding(false)} />
          ) : null}
        </SettingsRow>
      )}
    </>
  );
}

interface SourceMessage {
  readonly text: string;
  readonly ok: boolean;
}

/** A source's last result: a test, a token change or a refusal. */
function SourceNotice({ message }: { readonly message: SourceMessage }) {
  return (
    <Alert variant={message.ok ? "success" : "error"}>
      {message.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

/** A form control under its visible name, with the help that explains it. */
function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <label className="block space-y-1">
        <span className="block text-muted-foreground text-xs">{label}</span>
        {children}
      </label>
      {hint ? <p className="text-muted-foreground/80 text-xs">{hint}</p> : null}
    </div>
  );
}

function AddSourceForm({
  project,
  kinds,
  onDone,
}: {
  project: EnvironmentProject;
  kinds: ReadonlyArray<WorkSourceKind>;
  onDone: () => void;
}) {
  const save = useAtomCommand(workCommands.saveSource);
  const identity = project.repositoryIdentity;
  const [kind, setKind] = useState<WorkSourceKind>(kinds[0] ?? "markdown");
  const [directory, setDirectory] = useState(DEFAULT_DIRECTORY);
  const [autoStart, setAutoStart] = useState(true);
  const [owner, setOwner] = useState(identity?.owner ?? "");
  const [name, setName] = useState(identity?.name ?? "");
  const [host, setHost] = useState("github.com");
  const [siteUrl, setSiteUrl] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config: WorkSourceConfig | null =
    kind === "markdown"
      ? directory.trim().length === 0
        ? null
        : { kind, directory: directory.trim().replace(/\/+$/, ""), autoStart }
      : kind === "github"
        ? owner.trim() && name.trim() && host.trim()
          ? { kind, host: host.trim(), owner: owner.trim(), name: name.trim() }
          : null
        : siteUrl.trim() && projectKey.trim() && email.trim()
          ? {
              kind,
              siteUrl: siteUrl.trim(),
              projectKey: projectKey.trim().toUpperCase(),
              email: email.trim(),
            }
          : null;
  const label =
    config === null
      ? ""
      : config.kind === "markdown"
        ? "Tasks"
        : config.kind === "github"
          ? `${config.owner}/${config.name}`
          : config.projectKey;

  const submit = async () => {
    if (config === null) return;
    setPending(true);
    const result = await save({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        label,
        config,
        ...(config.kind === "jira" && token.length > 0 ? { apiToken: token } : {}),
      },
    });
    setPending(false);
    setToken("");
    if (result._tag === "Success") onDone();
    else setError(workCommandError(result));
  };

  return (
    <div className="mt-3 max-w-2xl space-y-3 pb-3.5">
      {kinds.length > 1 ? (
        <Field label="Kind">
          <Select value={kind} onValueChange={(value) => setKind(value as WorkSourceKind)}>
            <SelectTrigger aria-label="Source kind" className="w-44" size="sm">
              <SelectValue>{SOURCE_KIND_LABELS[kind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {kinds.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {SOURCE_KIND_LABELS[entry]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      ) : null}
      {kind === "markdown" ? (
        <>
          <Field
            label="Task folder"
            hint="A folder of the project's main checkout. It is created if missing; commit task files like any other change."
          >
            <Input
              size="sm"
              font="mono"
              placeholder={DEFAULT_DIRECTORY}
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            Mark as in progress on start
          </label>
        </>
      ) : null}
      {kind === "github" ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Field label="Owner">
              <Input
                size="sm"
                placeholder="owner"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              />
            </Field>
            <Field label="Repository">
              <Input
                size="sm"
                placeholder="repository"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="GitHub host"
            hint="Uses the GitHub token from Source Control settings; it needs Issues read and write."
          >
            <Input
              size="sm"
              placeholder="github.com"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>
        </>
      ) : null}
      {kind === "jira" ? (
        <>
          <Field label="Jira site">
            <Input
              size="sm"
              type="url"
              placeholder="https://your-site.atlassian.net"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Project key">
              <Input
                size="sm"
                placeholder="PROJ"
                value={projectKey}
                onChange={(event) => setProjectKey(event.target.value)}
              />
            </Field>
            <Field label="Atlassian email">
              <Input
                size="sm"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="API token"
            hint="An unscoped Atlassian API token. It stays on the server and is shared by every source on this site and account."
          >
            <SecretInput
              placeholder="API token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        </>
      ) : null}
      {error ? <SourceNotice message={{ text: error, ok: false }} /> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={pending || config === null} onClick={() => void submit()}>
          {pending ? "Adding..." : "Add source"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Repairs an expired or cleared Jira token in place. The server tests the token before storing
 * it and applies it to every source sharing the site and account, so nothing is disconnected.
 */
function ReplaceTokenForm({
  project,
  source,
  onDone,
}: {
  project: EnvironmentProject;
  source: WorkSource;
  onDone: (message: string | null) => void;
}) {
  const save = useAtomCommand(workCommands.saveSource);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const apiToken = token.trim();
    if (apiToken.length === 0) return;
    setPending(true);
    const result = await save({
      environmentId: project.environmentId,
      input: {
        sourceId: source.sourceId,
        projectId: project.id,
        label: source.label,
        config: source.config,
        apiToken,
        expectedVersion: source.version,
      },
    });
    setPending(false);
    // The token is sent once and never kept here.
    setToken("");
    if (result._tag === "Success") {
      onDone("Token replaced for every source on this site and account.");
    } else setError(workCommandError(result));
  };
  return (
    <div className="space-y-3">
      <Field label="New API token">
        <SecretInput
          placeholder="New API token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {error ? <SourceNotice message={{ text: error, ok: false }} /> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pending || token.trim().length === 0}
          onClick={() => void submit()}
        >
          {pending ? "Testing..." : "Save token"}
        </Button>
      </div>
    </div>
  );
}
