import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { type EnvironmentId } from "@t3tools/contracts";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import type { useRepositoryWorkspace } from "./useRepositoryWorkspace";

export function RepositoryStatus({
  environmentId,
  workspace,
  enabled,
}: {
  environmentId: EnvironmentId;
  workspace: ReturnType<typeof useRepositoryWorkspace>;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useEnvironmentQuery(
    open && enabled && workspace.isMultiRepository && workspace.repositoryTarget
      ? vcsEnvironment.repositoryStatus({
          environmentId,
          input: { repositories: workspace.repositories, target: workspace.repositoryTarget },
        })
      : null,
  );
  if (!workspace.isMultiRepository || !enabled) return null;
  return (
    <View className="mt-2 gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="py-2"
      >
        <Text className="text-sm text-foreground">
          {open ? "Hide repository status" : "Repository status"}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 240 }}>
          <View className="gap-3 pb-3">
            <Pressable
              accessibilityRole="button"
              disabled={query.isPending}
              onPress={query.refresh}
              className="py-2"
            >
              <Text className="text-sm text-muted">Refresh checkout snapshot</Text>
            </Pressable>
            {query.isPending ? (
              <Text className="text-xs text-muted">Reading repositories…</Text>
            ) : null}
            {query.error ? (
              <Text accessibilityRole="alert" className="text-xs text-destructive">
                {query.error}
              </Text>
            ) : null}
            {query.data?.map(({ repository, status, error }) => (
              <Pressable
                key={repository.id}
                accessibilityRole="button"
                onPress={() => {
                  workspace.selectRepository(repository.id);
                  setOpen(false);
                }}
                className="gap-1 rounded-lg bg-card p-3"
              >
                <Text className="text-sm text-foreground">{repository.name}</Text>
                <Text className="text-xs text-muted">
                  {status
                    ? `${status.branch ?? "Detached HEAD"} · ${status.files} changed ${status.files === 1 ? "file" : "files"} · +${status.insertions} −${status.deletions}`
                    : error}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}
