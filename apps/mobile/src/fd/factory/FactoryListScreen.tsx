import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { type MobileFleetRow, mobileFleetRows } from "./fleetList";
import { factoryFleetAtom } from "./state";

/**
 * Every active delivery across the connected environments that serve Factory, those that need
 * you first; a Factory environment that is not connected is named instead. Each row opens its
 * item's Work item screen, whose Factory section shows the timeline and controls. Registered by
 * the app's Stack.
 */
export function FactoryListScreen() {
  const navigation = useNavigation();
  const fleet = useAtomValue(factoryFleetAtom);
  const projects = useProjects();
  const environments = useWorkspaceEnvironments();
  const rows = useMemo(
    () => mobileFleetRows(fleet.environments, { projects, environments }),
    [environments, fleet.environments, projects],
  );

  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.environmentLabel ??
    environmentId;
  const disconnected = fleet.disconnected.map(labelOf);

  if (fleet.environments.length === 0) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-6">
        <Text className="text-center text-foreground-muted">
          {disconnected.length > 0
            ? `Not connected to ${disconnected.join(", ")}.`
            : "Connect to a server that offers Factory."}
        </Text>
      </View>
    );
  }

  const failed = fleet.failed.map(labelOf);
  return (
    <View className="flex-1 bg-screen">
      {failed.length > 0 ? (
        <Text className="px-4 pt-2 text-sm text-destructive">
          Could not read deliveries on {failed.join(", ")}.
        </Text>
      ) : null}
      {disconnected.length > 0 ? (
        <Text className="px-4 pt-2 text-sm text-foreground-muted">
          Not connected to {disconnected.join(", ")}; its deliveries are not shown.
        </Text>
      ) : null}
      <LegendList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16 }}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        estimatedItemSize={72}
        keyExtractor={(row) => row.key}
        recycleItems
        itemsAreEqual={sameRow}
        ListEmptyComponent={
          <Text className="py-8 text-center text-foreground-muted">
            {fleet.loading ? "Loading…" : "No active deliveries."}
          </Text>
        }
        renderItem={({ item: row }) => (
          <Pressable
            accessibilityRole="button"
            className="gap-1 border-b border-separator py-3 active:opacity-70"
            onPress={() => navigation.navigate(row.target.name, row.target.params)}
          >
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {row.project}
              </Text>
              {row.stage !== undefined ? (
                <Text className="text-xs text-foreground-muted">{row.stage}</Text>
              ) : null}
              <Text
                className={
                  row.needsYou === undefined
                    ? "text-xs font-t3-medium text-foreground"
                    : "text-xs font-t3-medium text-warning"
                }
              >
                {row.status}
              </Text>
            </View>
            <Text className="text-base text-foreground" numberOfLines={1}>
              {row.item}
            </Text>
            {row.needsYou !== undefined ? (
              <Text className="text-sm text-warning" numberOfLines={2}>
                {row.needsYou}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const sameRow = (left: MobileFleetRow, right: MobileFleetRow) =>
  left.key === right.key &&
  left.project === right.project &&
  left.status === right.status &&
  left.stage === right.stage &&
  left.needsYou === right.needsYou;
