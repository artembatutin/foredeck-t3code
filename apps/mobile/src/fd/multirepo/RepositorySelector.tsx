import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import type { useRepositoryWorkspace } from "./useRepositoryWorkspace";

export function RepositorySelector({
  workspace,
}: {
  workspace: ReturnType<typeof useRepositoryWorkspace>;
}) {
  if (!workspace.isMultiRepository) return null;
  return (
    <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
      {workspace.repositories.map((repository) => (
        <Pressable
          key={repository.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: workspace.selected?.id === repository.id }}
          accessibilityLabel={`${repository.name}, ${repository.rootPath}`}
          onPress={() => workspace.selectRepository(repository.id)}
          className={
            workspace.selected?.id === repository.id
              ? "rounded-full bg-subtle-strong px-3 py-2"
              : "rounded-full bg-card px-3 py-2"
          }
        >
          <Text className="text-sm text-foreground">{repository.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}
