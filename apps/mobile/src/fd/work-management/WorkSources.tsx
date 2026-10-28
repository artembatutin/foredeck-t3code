import { WORK_READ_SCOPE, workSupport } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig } from "@t3tools/contracts";
import type {
  WorkSource,
  WorkSourceConfig,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ListSection } from "../../components/ListSection";
import { RowPressable } from "../../components/RowPressable";
import { SegmentedControl } from "../../components/SegmentedControl";
import { StatusPill } from "../../components/StatusPill";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Action, workCommandError } from "./shared";
import { useWorkWritable, workCommands, workEnvironment } from "./state";

const KIND_LABELS: Record<WorkSourceKind, string> = {
  markdown: "Markdown",
  github: "GitHub",
  jira: "Jira",
};

/** A labelled form field, as the settings forms show them. */
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="px-1 text-sm font-t3-medium text-foreground-muted">{label}</Text>
      {children}
    </View>
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
      {readable ? (
        <Editor project={props.project} kinds={[...support.sourceKinds]} />
      ) : (
        <ListRowLayout
          label="Can't manage Work sources"
          description="This device was paired before Work existed. Pair it again to manage Work sources."
        />
      )}
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
  const permitted = useWorkWritable(environmentId, workCommands.saveSource, "sources");
  const disconnect = useAtomCommand(workCommands.disconnectSource);
  const restore = useAtomCommand(workCommands.restoreSource);
  const save = useAtomCommand(workCommands.saveSource);
  const test = useAtomCommand(workCommands.testSource);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
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
      {query.error !== null && query.data === null ? (
        <View className="p-4">
          <ErrorBanner message={query.error} />
        </View>
      ) : sources.length === 0 && query.data !== null ? (
        <ListRowLayout
          label="No Work sources"
          description="Add a Markdown folder, GitHub repository or Jira project to read its items."
        />
      ) : null}
      {sources.map((source, index) => {
        const unhealthy = source.state === "active" && source.health.status !== "ok";
        return (
          <View
            key={source.sourceId}
            className={index === 0 ? undefined : "border-t border-border-subtle"}
          >
            <ListRowLayout
              label={source.label}
              description={`${KIND_LABELS[source.kind]} · ${source.identity}${unhealthy ? ` · ${source.health.message ?? source.health.status.replaceAll("_", " ")}` : ""}`}
              disabled={source.state === "disconnected"}
              accessory={
                source.state === "disconnected" ? (
                  <StatusPill
                    label="Disconnected"
                    pillClassName="bg-subtle"
                    textClassName="text-foreground-secondary"
                    size="compact"
                  />
                ) : unhealthy ? (
                  <StatusPill
                    label="Needs attention"
                    pillClassName="bg-warning"
                    textClassName="text-warning-foreground"
                    size="compact"
                  />
                ) : null
              }
            />
            <View className="gap-2 px-4 pb-3">
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
                {source.kind === "jira" && source.state === "active" ? (
                  <Action
                    label={source.credential.configured ? "Replace token" : "Set token"}
                    disabled={!permitted}
                    onPress={() =>
                      setReplacing((current) =>
                        current === source.sourceId ? null : source.sourceId,
                      )
                    }
                  />
                ) : null}
                {source.kind === "jira" &&
                source.credential.configured &&
                source.state === "active" ? (
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
              {source.config.kind === "jira" && source.state === "active" ? (
                <Text className="text-xs text-foreground-muted">
                  The token is shared by every Jira source for {source.config.email} on{" "}
                  {source.config.siteUrl}; replacing or removing it applies to all of them.
                </Text>
              ) : null}
              {replacing === source.sourceId && permitted ? (
                <ReplaceToken
                  project={project}
                  source={source}
                  onDone={(result) => {
                    setReplacing(null);
                    if (result !== null) setMessage(result);
                  }}
                />
              ) : null}
            </View>
          </View>
        );
      })}
      {message ? (
        <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
          {message}
        </Text>
      ) : null}
      {!permitted ? (
        <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
          Changing Work sources needs a live connection with the settings permission.
        </Text>
      ) : adding ? (
        <View className="border-t border-border-subtle">
          <AddSource project={project} kinds={kinds} onDone={() => setAdding(false)} />
        </View>
      ) : (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel="Add source"
          className="border-t border-border-subtle bg-grouped-card"
          onPress={() => setAdding(true)}
        >
          <ListRowLayout icon="plus" label="Add source" />
        </RowPressable>
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
    <View className="gap-3 p-4">
      {kinds.length > 1 ? (
        <SegmentedControl
          options={kinds.map((entry) => ({ value: entry, label: KIND_LABELS[entry] }))}
          selected={kind}
          onSelect={setKind}
        />
      ) : null}
      {kind === "markdown" ? (
        <>
          <Field label="Task folder">
            <AppTextInput
              accessibilityLabel="Task folder"
              value={directory}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setDirectory}
            />
          </Field>
          <View className="flex-row items-center gap-3 px-1">
            <Text className="flex-1 text-base text-foreground">Mark as in progress on start</Text>
            <ThemedSwitch
              accessibilityLabel="Mark as in progress on start"
              value={autoStart}
              onValueChange={setAutoStart}
            />
          </View>
        </>
      ) : null}
      {kind === "github" ? (
        <>
          <Field label="Owner">
            <AppTextInput
              accessibilityLabel="Owner"
              value={owner}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="owner"
              onChangeText={setOwner}
            />
          </Field>
          <Field label="Repository">
            <AppTextInput
              accessibilityLabel="Repository"
              value={name}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="repository"
              onChangeText={setName}
            />
          </Field>
        </>
      ) : null}
      {kind === "jira" ? (
        <>
          <Field label="Jira site">
            <AppTextInput
              accessibilityLabel="Jira site"
              value={siteUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://your-site.atlassian.net"
              onChangeText={setSiteUrl}
            />
          </Field>
          <Field label="Project key">
            <AppTextInput
              accessibilityLabel="Project key"
              value={projectKey}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="PROJ"
              onChangeText={setProjectKey}
            />
          </Field>
          <Field label="Atlassian email">
            <AppTextInput
              accessibilityLabel="Atlassian email"
              value={email}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="you@company.com"
              onChangeText={setEmail}
            />
          </Field>
          <Field label="API token">
            <AppTextInput
              accessibilityLabel="API token"
              value={token}
              secureTextEntry
              autoCapitalize="none"
              placeholder="Unscoped API token"
              onChangeText={setToken}
            />
          </Field>
        </>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      <View className="flex-row justify-end gap-2">
        <Action label="Cancel" disabled={pending} onPress={onDone} />
        <Action
          label={pending ? "Adding…" : "Add source"}
          primary
          disabled={pending || config === null}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/**
 * Repairs an expired or cleared Jira token in place. The server tests the token before storing
 * it and applies it to every source sharing the site and account.
 */
function ReplaceToken({
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
    if (apiToken.length === 0 || pending) return;
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
    // The token is sent once and never kept on the device.
    setToken("");
    if (result._tag === "Success")
      onDone("Token replaced for every source on this site and account.");
    else setError(workCommandError(result));
  };
  return (
    <View className="gap-3 pt-1">
      <Field label="New API token">
        <AppTextInput
          accessibilityLabel="New API token"
          value={token}
          secureTextEntry
          autoCapitalize="none"
          placeholder="Unscoped API token"
          onChangeText={setToken}
        />
      </Field>
      {error ? <ErrorBanner message={error} /> : null}
      <View className="flex-row justify-end gap-2">
        <Action label="Cancel" disabled={pending} onPress={() => onDone(null)} />
        <Action
          label={pending ? "Testing…" : "Save token"}
          primary
          disabled={pending || token.trim().length === 0}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
