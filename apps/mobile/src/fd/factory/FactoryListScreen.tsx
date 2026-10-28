import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
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
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title={disconnected.length > 0 ? "Factory is offline" : "Factory isn't available"}
          detail={
            disconnected.length > 0
              ? `Reconnect to ${disconnected.join(", ")} to see its deliveries.`
              : "Connect to a server that offers Factory to follow its deliveries here."
          }
        />
      </View>
    );
  }

  const failed = fleet.failed.map(labelOf);
  return (
    <View className="flex-1 bg-screen">
      <LegendList
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 32 }}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        // One item line with a reason measures about 86pt, without one about 66pt.
        estimatedItemSize={72}
        keyExtractor={(row) => row.key}
        recycleItems
        itemsAreEqual={sameRow}
        ListHeaderComponent={
          failed.length > 0 || disconnected.length > 0 ? (
            <View className="gap-2 px-4 pt-2 pb-3">
              {failed.length > 0 ? (
                <ErrorBanner message={`Couldn't read deliveries on ${failed.join(", ")}.`} />
              ) : null}
              {disconnected.length > 0 ? (
                <Text className="px-1 text-sm text-foreground-muted">
                  Not connected to {disconnected.join(", ")}; its deliveries are not shown.
                </Text>
              ) : null}
            </View>
          ) : null
        }
        ListEmptyComponent={
          fleet.loading ? (
            <View className="items-center py-12">
              <ActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading deliveries"
              />
            </View>
          ) : (
            <EmptyState
              variant="plain"
              title="No active deliveries"
              detail="Deliver a Work item from its screen, and its progress shows here."
            />
          )
        }
        renderItem={({ item: row }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[row.item, row.project, row.status, row.stage, row.needsYou]
              .filter(Boolean)
              .join(", ")}
            className="flex-row gap-3 px-4 active:bg-row-hover"
            onPress={() => navigation.navigate(row.target.name, row.target.params)}
          >
            <View className="pt-2.5">
              <SymbolView
                name={row.needsYou === undefined ? "circle.inset.filled" : "exclamationmark.circle"}
                size={20}
                tintColorClassName={
                  row.needsYou === undefined ? "accent-primary-text" : "accent-warning-foreground"
                }
              />
            </View>
            <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
              <View className="flex-row items-center gap-1.5">
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  {row.project}
                  {row.stage !== undefined ? (
                    <Text className="text-foreground-tertiary"> · {row.stage}</Text>
                  ) : null}
                </Text>
                <Text
                  className={
                    row.needsYou === undefined
                      ? "text-2xs font-t3-medium text-foreground-muted"
                      : "text-2xs font-t3-medium text-warning"
                  }
                >
                  {row.status}
                </Text>
              </View>
              <Text
                className="text-base leading-5 font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {row.item}
              </Text>
              {row.needsYou !== undefined ? (
                <Text className="text-sm text-warning" numberOfLines={2}>
                  {row.needsYou}
                </Text>
              ) : null}
            </View>
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
