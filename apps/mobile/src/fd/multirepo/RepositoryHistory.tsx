import { ScrollView, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { repositoryHistoryGroups } from "@t3tools/client-runtime/fd/multirepo";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";

export function RepositoryHistory({
  projection,
  runId,
  selectedId,
  onSelect,
}: {
  projection: OrchestrationV2ThreadProjection;
  runId: RunId | null;
  selectedId: string | undefined;
  onSelect: (repositoryId: string) => void;
}) {
  const history = repositoryHistoryGroups(projection, runId);
  if (history.groups.length < 2) return null;
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      <Text className="text-xs text-muted">
        {runId === null ? "Conversation snapshots" : `Turn ${history.toTurnCount} snapshots`} ·
        select a repository to read its diff
      </Text>
      <ScrollView horizontal>
        <View className="flex-row gap-3" accessibilityRole="tablist">
          {history.groups.map(({ repository, message }) => (
            <Pressable
              key={repository.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: repository.id === selectedId }}
              onPress={() => onSelect(repository.id)}
              className={
                repository.id === selectedId
                  ? "max-w-64 gap-1 rounded-lg bg-subtle-strong p-3"
                  : "max-w-64 gap-1 rounded-lg bg-card p-3"
              }
            >
              <Text className="text-sm text-foreground">{repository.name}</Text>
              <Text className="text-xs text-muted">{message}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
