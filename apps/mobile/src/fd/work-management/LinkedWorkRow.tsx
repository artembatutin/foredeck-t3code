import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_LABELS, STATUS_SYMBOLS } from "./shared";
import { useWorkReadable, useWorkWritable, workCommands, workEnvironment } from "./state";

/** The Work items linked to a thread, above its feed; nothing without Work access. */
export function LinkedWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const readable = useWorkReadable(props.environmentId);
  if (!readable) return null;
  return <LinkedWorkItems {...props} />;
}

function LinkedWorkItems(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
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
  if (links.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2 px-4 py-1">
      {links.map((link) => (
        <ControlPillMenu
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
            accessibilityLabel={`Work item ${link.snapshot.key}, ${STATUS_LABELS[link.snapshot.status]}`}
            hitSlop={4}
            className="h-7 max-w-full flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 active:opacity-70"
            onPress={() =>
              navigation.navigate("WorkItem", {
                environmentId: props.environmentId,
                projectId: props.projectId,
                sourceId: link.ref.sourceId,
                itemId: link.ref.itemId,
              })
            }
          >
            <SymbolView
              name={STATUS_SYMBOLS[link.snapshot.status].icon}
              size={13}
              tintColorClassName={STATUS_SYMBOLS[link.snapshot.status].tint}
            />
            <Text className="shrink text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
              {link.snapshot.key}
              <Text className="text-foreground-tertiary">
                {" "}
                · {STATUS_LABELS[link.snapshot.status]}
              </Text>
            </Text>
          </Pressable>
        </ControlPillMenu>
      ))}
    </View>
  );
}
