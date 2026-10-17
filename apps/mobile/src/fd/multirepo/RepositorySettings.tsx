import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  createRepositoryCommands,
  repositoryDraft,
  repositoryMembershipHelp,
  supportsRepositories,
  validRepositoryDraft,
} from "@t3tools/client-runtime/fd/multirepo";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectRepositoryInputs, ServerConfig } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ListSection } from "../../components/ListSection";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
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

export function RepositorySettings({
  project,
  serverConfig,
  environmentLabel,
}: {
  project: EnvironmentProject;
  serverConfig: ServerConfig | null;
  environmentLabel: string;
}) {
  const commands = useMemo(
    () => createRepositoryCommands(connectionAtomRuntime, createEnvironmentRpcCommand),
    [],
  );
  const permitted = useAtomValue(commands.setRepositories.permissionAtom(project.environmentId));
  const supported =
    serverConfig !== null && supportsRepositories(serverConfig.environment.capabilities);
  const [draft, setDraft] = useState<ProjectRepositoryInputs | null>(null);
  const [saving, setSaving] = useState(false);
  const repositories = draft ?? repositoryDraft(project);
  const disabled = !permitted || !supported || saving;
  const save = useAtomCommand(commands.setRepositories);
  const update = (index: number, patch: { name?: string; rootPath?: string }) =>
    setDraft(
      repositories.map((repository, i) => (i === index ? { ...repository, ...patch } : repository)),
    );
  const saveRepositories = async () => {
    if (disabled || !validRepositoryDraft(repositories)) return;
    setSaving(true);
    try {
      const result = await save({
        environmentId: project.environmentId,
        input: { projectId: project.id, repositories },
      });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <ListSection title={`Repositories · ${environmentLabel}`} footer={repositoryMembershipHelp}>
      <View className="gap-4 p-4">
        {!supported ? (
          <Text className="text-sm text-foreground-muted">
            Connect to an updated server to configure repositories.
          </Text>
        ) : null}
        {!permitted ? (
          <Text className="text-sm text-foreground-muted">
            This connection needs settings and conversation permissions to change repositories.
          </Text>
        ) : null}
        {repositories.map((repository, index) => (
          <View key={repository.id ?? index} className="gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-sm font-t3-medium text-foreground">
                {index === 0 ? "Primary repository" : `Repository ${index + 1}`}
              </Text>
              {index > 1 ? (
                <Action
                  label="Move up"
                  disabled={disabled}
                  onPress={() =>
                    setDraft(
                      repositories.map((entry, i) =>
                        i === index - 1
                          ? repositories[index]!
                          : i === index
                            ? repositories[index - 1]!
                            : entry,
                      ),
                    )
                  }
                />
              ) : null}
              {index > 0 ? (
                <Action
                  label="Remove"
                  disabled={disabled}
                  onPress={() => setDraft(repositories.filter((_, i) => i !== index))}
                />
              ) : null}
            </View>
            <AppTextInput
              accessibilityLabel={`Repository ${index + 1} name`}
              className="min-h-11 rounded-xl bg-card px-3 text-base text-foreground"
              value={repository.name}
              editable={!disabled}
              placeholder="Repository name"
              onChangeText={(name) => update(index, { name })}
            />
            <AppTextInput
              accessibilityLabel={`Repository ${index + 1} path on ${environmentLabel}`}
              className="min-h-11 rounded-xl bg-card px-3 text-base text-foreground"
              value={repository.rootPath}
              editable={!disabled && index !== 0 && repository.id === undefined}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Absolute path on this environment"
              onChangeText={(rootPath) => update(index, { rootPath })}
            />
          </View>
        ))}
        <View className="flex-row flex-wrap gap-2">
          <Action
            label="Add repository"
            disabled={disabled || repositories.length >= 16}
            onPress={() => setDraft([...repositories, { name: "", rootPath: "" }])}
          />
          <Action
            label={saving ? "Saving…" : "Save repositories"}
            disabled={disabled || draft === null || !validRepositoryDraft(repositories)}
            onPress={() => void saveRepositories()}
          />
          {draft !== null ? (
            <Action label="Cancel" disabled={saving} onPress={() => setDraft(null)} />
          ) : null}
        </View>
      </View>
    </ListSection>
  );
}
