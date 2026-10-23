import { useAtomValue } from "@effect/atom-react";
import { WORK_READ_SCOPE, workSupport } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig } from "@t3tools/contracts";
import type {
  WorkSource,
  WorkSourceConfig,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import { useState } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
import { workCommands, workEnvironment } from "./state";

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
      <div className="space-y-4 p-4">
        {readable ? (
          <SourcesEditor project={project} kinds={[...support.sourceKinds]} />
        ) : (
          <WorkRepairNotice />
        )}
      </div>
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
  const permitted = useAtomValue(workCommands.saveSource.permissionAtom(environmentId));
  const disconnect = useAtomCommand(workCommands.disconnectSource);
  const restore = useAtomCommand(workCommands.restoreSource);
  const save = useAtomCommand(workCommands.saveSource);
  const test = useAtomCommand(workCommands.testSource);
  const [adding, setAdding] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const sources = query.data?.sources ?? [];
  const note = (sourceId: string, message: string) =>
    setMessages((previous) => ({ ...previous, [sourceId]: message }));

  const testSource = async (source: WorkSource) => {
    const result = await test({
      environmentId,
      input: { projectId: project.id, sourceId: source.sourceId, config: source.config },
    });
    note(
      source.sourceId,
      result._tag === "Success"
        ? result.value.ok
          ? "Connection works."
          : (result.value.message ?? "The source could not be read.")
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
    note(
      source.sourceId,
      result._tag === "Success"
        ? "Token removed for every source on this site and account."
        : workCommandError(result),
    );
  };

  return (
    <>
      {query.error ? <p className="text-destructive text-sm">{query.error}</p> : null}
      {sources.length === 0 && !query.isPending ? (
        <p className="text-muted-foreground text-sm">
          No Work sources yet. Add a folder of Markdown tasks
          {kinds.includes("github") ? ", a GitHub repository" : ""}
          {kinds.includes("jira") ? " or a Jira project" : ""}.
        </p>
      ) : null}
      {sources.map((source) => (
        <div key={source.sourceId} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{source.label}</span>
            <Badge variant="outline">{SOURCE_KIND_LABELS[source.kind]}</Badge>
            <span className="min-w-0 truncate text-muted-foreground text-xs">
              {source.identity}
            </span>
            {source.state === "disconnected" ? (
              <Badge variant="secondary">Disconnected</Badge>
            ) : null}
            {source.state === "active" && source.health.status !== "ok" ? (
              <Badge variant="warning">{source.health.status.replaceAll("_", " ")}</Badge>
            ) : null}
            <div className="flex-1" />
            {source.state === "active" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!permitted}
                onClick={() => void testSource(source)}
              >
                Test
              </Button>
            ) : null}
            {source.kind === "jira" && source.credential.configured && source.state === "active" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!permitted}
                onClick={() => void clearToken(source)}
              >
                Remove token
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={!permitted}
              onClick={() => void toggle(source)}
            >
              {source.state === "active" ? "Disconnect" : "Restore"}
            </Button>
          </div>
          {source.state === "active" && source.health.message ? (
            <p className="text-muted-foreground text-xs">{source.health.message}</p>
          ) : null}
          {messages[source.sourceId] ? (
            <p className="text-muted-foreground text-xs">{messages[source.sourceId]}</p>
          ) : null}
        </div>
      ))}
      {!permitted ? (
        <p className="text-muted-foreground text-sm">
          This connection needs the settings permission to change Work sources.
        </p>
      ) : adding ? (
        <AddSourceForm project={project} kinds={kinds} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          Add source
        </Button>
      )}
    </>
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
    <div className="space-y-3 rounded-md border p-3">
      {kinds.length > 1 ? (
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
      ) : null}
      {kind === "markdown" ? (
        <>
          <Input
            aria-label="Task folder"
            placeholder={DEFAULT_DIRECTORY}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            A folder of the project's main checkout. It is created if missing; commit task files
            like any other change.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            Mark as in progress on start
          </label>
        </>
      ) : null}
      {kind === "github" ? (
        <>
          <div className="flex gap-2">
            <Input
              aria-label="Owner"
              placeholder="owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
            />
            <Input
              aria-label="Repository"
              placeholder="repository"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Input
            aria-label="GitHub host"
            placeholder="github.com"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Uses the GitHub token from Source Control settings; it needs Issues read and write.
          </p>
        </>
      ) : null}
      {kind === "jira" ? (
        <>
          <Input
            aria-label="Jira site"
            placeholder="https://your-site.atlassian.net"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
          />
          <div className="flex gap-2">
            <Input
              aria-label="Project key"
              placeholder="PROJ"
              value={projectKey}
              onChange={(event) => setProjectKey(event.target.value)}
            />
            <Input
              aria-label="Atlassian email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <SecretInput
            aria-label="API token"
            placeholder="API token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            An unscoped Atlassian API token. It stays on the server and is shared by every source on
            this site and account.
          </p>
        </>
      ) : null}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || config === null} onClick={() => void submit()}>
          {pending ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
