import { workItemOwningProject } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_LABELS, STATUS_SYMBOLS } from "./shared";
import { useWorkReadable, useWorkWritable, workCommands, workEnvironment } from "./state";

/** The Work items linked to a thread, above its feed; nothing without Work access. */
export function LinkedWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const readable = useWorkReadable(props.environmentId);
  if (!readable) return null;
  return <LinkedWorkItems {...props} />;
}

function LinkedWorkItems(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    workEnvironment.links({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const setLink = useAtomCommand(workCommands.setLink);
  const canWrite = useWorkWritable(props.environmentId, workCommands.setLink, "links");
  const links = query.data?.links ?? [];
  // Disconnected sources too: a link outlives its source's connection, and still names its project.
  const sourcesQuery = useEnvironmentQuery(
    links.length === 0
      ? null
      : workEnvironment.sources({
          environmentId: props.environmentId,
          input: { includeDisconnected: true },
        }),
  );
  const sources = sourcesQuery.data?.sources ?? [];
  const sourcesRead = sourcesQuery.data !== null || sourcesQuery.error !== null;
  if (links.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2 px-4 py-1">
      {links.map((link) => {
        const projectId = workItemOwningProject(sources, link.ref);
        const note =
          projectId === undefined && sourcesRead
            ? "Project unavailable"
            : STATUS_LABELS[link.snapshot.status];
        return (
          <Menu
            key={`${link.ref.sourceId}:${link.ref.itemId}`}
            accessibilityLabel={`Work item ${link.snapshot.key}`}
            shouldOpenOnLongPress
            actions={
              canWrite ? [{ id: "unlink", title: "Unlink", attributes: { destructive: true } }] : []
            }
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event !== "unlink") return;
              void setLink({
                environmentId: props.environmentId,
                input: { ref: link.ref, threadId: props.threadId, action: "unlink" },
              });
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Work item ${link.snapshot.key}, ${note}`}
              disabled={projectId === undefined}
              hitSlop={4}
              className="h-7 max-w-full flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 active:opacity-70"
              onPress={() => {
                if (projectId === undefined) return;
                navigation.navigate("WorkItem", {
                  environmentId: props.environmentId,
                  projectId,
                  sourceId: link.ref.sourceId,
                  itemId: link.ref.itemId,
                });
              }}
            >
              <SymbolView
                name={STATUS_SYMBOLS[link.snapshot.status].icon}
                size={13}
                tintColorClassName={STATUS_SYMBOLS[link.snapshot.status].tint}
              />
              <Text
                className="shrink text-xs font-t3-medium text-foreground-muted"
                numberOfLines={1}
              >
                {link.snapshot.key}
                <Text className="text-foreground-tertiary"> · {note}</Text>
              </Text>
            </Pressable>
          </Menu>
        );
      })}
    </View>
  );
}
