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
import { Pressable, Switch, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ListSection } from "../../components/ListSection";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { workCommandError } from "./shared";
import { workCommands, workEnvironment } from "./state";

const KIND_LABELS: Record<WorkSourceKind, string> = {
  markdown: "Markdown",
  github: "GitHub",
  jira: "Jira",
};

const INPUT_CLASS = "min-h-11 rounded-xl bg-card px-3 text-base text-foreground";

function Action({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        disabled
          ? "rounded-full bg-subtle-strong px-4 py-2 opacity-40"
          : "rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}

/** A project member's Work sources: view, test, disconnect, restore, remove token and add. */
export function WorkSources(props: {
  readonly project: EnvironmentProject;
  readonly serverConfig: ServerConfig | null;
  readonly environmentLabel: string;
}) {
  const support = workSupport(props.serverConfig);
  const readable = useEnvironmentScope(props.project.environmentId, WORK_READ_SCOPE);
  if (support === undefined) return null;
  return (
    <ListSection title={`Work sources · ${props.environmentLabel}`}>
      <View className="gap-3 p-4">
        {readable ? (
          <Editor project={props.project} kinds={[...support.sourceKinds]} />
        ) : (
          <Text className="text-sm text-foreground-muted">
            This device was paired before Work existed. Pair it again to manage Work sources.
          </Text>
        )}
      </View>
    </ListSection>
  );
}

function Editor({
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
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const sources = query.data?.sources ?? [];

  const report = (
    result:
      | { readonly _tag: "Success" }
      | ({ readonly _tag: "Failure" } & Parameters<typeof workCommandError>[0]),
    success: string,
  ) => setMessage(result._tag === "Success" ? success : workCommandError(result));

  const toggle = async (source: WorkSource) => {
    const input = { sourceId: source.sourceId, expectedVersion: source.version };
    report(
      source.state === "active"
        ? await disconnect({ environmentId, input })
        : await restore({ environmentId, input }),
      source.state === "active" ? "Disconnected." : "Restored.",
    );
  };

  return (
    <>
      {sources.map((source) => (
        <View key={source.sourceId} className="gap-2">
          <Text className="text-sm font-t3-medium text-foreground">
            {source.label} · {KIND_LABELS[source.kind]}
            {source.state === "disconnected" ? " · disconnected" : ""}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {source.identity}
            {source.state === "active" && source.health.status !== "ok"
              ? ` · ${source.health.message ?? source.health.status.replaceAll("_", " ")}`
              : ""}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {source.state === "active" ? (
              <Action
                label="Test"
                disabled={!permitted}
                onPress={async () => {
                  const result = await test({
                    environmentId,
                    input: {
                      projectId: project.id,
                      sourceId: source.sourceId,
                      config: source.config,
                    },
                  });
                  setMessage(
                    result._tag === "Success"
                      ? result.value.ok
                        ? "Connection works."
                        : (result.value.message ?? "The source could not be read.")
                      : workCommandError(result),
                  );
                }}
              />
            ) : null}
            {source.kind === "jira" && source.credential.configured && source.state === "active" ? (
              <Action
                label="Remove token"
                disabled={!permitted}
                onPress={async () =>
                  report(
                    await save({
                      environmentId,
                      input: {
                        sourceId: source.sourceId,
                        projectId: project.id,
                        label: source.label,
                        config: source.config,
                        credential: "clear",
                        expectedVersion: source.version,
                      },
                    }),
                    "Token removed for every source on this site and account.",
                  )
                }
              />
            ) : null}
            <Action
              label={source.state === "active" ? "Disconnect" : "Restore"}
              disabled={!permitted}
              onPress={() => void toggle(source)}
            />
          </View>
        </View>
      ))}
      {message ? <Text className="text-xs text-foreground-muted">{message}</Text> : null}
      {!permitted ? (
        <Text className="text-sm text-foreground-muted">
          This connection needs the settings permission to change Work sources.
        </Text>
      ) : adding ? (
        <AddSource project={project} kinds={kinds} onDone={() => setAdding(false)} />
      ) : (
        <Action label="Add source" onPress={() => setAdding(true)} />
      )}
    </>
  );
}

function AddSource({
  project,
  kinds,
  onDone,
}: {
  project: EnvironmentProject;
  kinds: ReadonlyArray<WorkSourceKind>;
  onDone: () => void;
}) {
  const save = useAtomCommand(workCommands.saveSource);
  const [kind, setKind] = useState<WorkSourceKind>(kinds[0] ?? "markdown");
  const [directory, setDirectory] = useState(".foredeck/work");
  const [autoStart, setAutoStart] = useState(true);
  const [owner, setOwner] = useState(project.repositoryIdentity?.owner ?? "");
  const [name, setName] = useState(project.repositoryIdentity?.name ?? "");
  const [siteUrl, setSiteUrl] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const config: WorkSourceConfig | null =
    kind === "markdown"
      ? directory.trim()
        ? { kind, directory: directory.trim().replace(/\/+$/, ""), autoStart }
        : null
      : kind === "github"
        ? owner.trim() && name.trim()
          ? { kind, host: "github.com", owner: owner.trim(), name: name.trim() }
          : null
        : siteUrl.trim() && projectKey.trim() && email.trim()
          ? {
              kind,
              siteUrl: siteUrl.trim(),
              projectKey: projectKey.trim().toUpperCase(),
              email: email.trim(),
            }
          : null;

  const submit = async () => {
    if (config === null) return;
    setPending(true);
    const label =
      config.kind === "markdown"
        ? "Tasks"
        : config.kind === "github"
          ? `${config.owner}/${config.name}`
          : config.projectKey;
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
    // The token is sent once and never kept on the device.
    setToken("");
    if (result._tag === "Success") onDone();
    else setError(workCommandError(result));
  };

  return (
    <View className="gap-2 rounded-xl bg-subtle p-3">
      {kinds.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {kinds.map((entry) => (
            <Action
              key={entry}
              label={entry === kind ? `• ${KIND_LABELS[entry]}` : KIND_LABELS[entry]}
              onPress={() => setKind(entry)}
            />
          ))}
        </View>
      ) : null}
      {kind === "markdown" ? (
        <>
          <AppTextInput
            accessibilityLabel="Task folder"
            className={INPUT_CLASS}
            value={directory}
            autoCapitalize="none"
            onChangeText={setDirectory}
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground">Mark as in progress on start</Text>
            <Switch value={autoStart} onValueChange={setAutoStart} />
          </View>
        </>
      ) : null}
      {kind === "github" ? (
        <>
          <AppTextInput
            accessibilityLabel="Owner"
            className={INPUT_CLASS}
            value={owner}
            autoCapitalize="none"
            placeholder="owner"
            onChangeText={setOwner}
          />
          <AppTextInput
            accessibilityLabel="Repository"
            className={INPUT_CLASS}
            value={name}
            autoCapitalize="none"
            placeholder="repository"
            onChangeText={setName}
          />
        </>
      ) : null}
      {kind === "jira" ? (
        <>
          <AppTextInput
            accessibilityLabel="Jira site"
            className={INPUT_CLASS}
            value={siteUrl}
            autoCapitalize="none"
            placeholder="https://your-site.atlassian.net"
            onChangeText={setSiteUrl}
          />
          <AppTextInput
            accessibilityLabel="Project key"
            className={INPUT_CLASS}
            value={projectKey}
            autoCapitalize="characters"
            placeholder="PROJ"
            onChangeText={setProjectKey}
          />
          <AppTextInput
            accessibilityLabel="Atlassian email"
            className={INPUT_CLASS}
            value={email}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@company.com"
            onChangeText={setEmail}
          />
          <AppTextInput
            accessibilityLabel="API token"
            className={INPUT_CLASS}
            value={token}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Unscoped API token"
            onChangeText={setToken}
          />
        </>
      ) : null}
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row gap-2">
        <Action
          label={pending ? "Adding…" : "Add"}
          disabled={pending || config === null}
          onPress={() => void submit()}
        />
        <Action label="Cancel" disabled={pending} onPress={onDone} />
      </View>
    </View>
  );
}
