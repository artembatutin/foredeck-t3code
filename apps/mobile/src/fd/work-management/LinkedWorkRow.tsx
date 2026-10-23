import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_LABELS } from "./shared";
import { useWorkReadable, workCommands, workEnvironment } from "./state";

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
  const canWrite = useAtomValue(workCommands.setLink.permissionAtom(props.environmentId));
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
            className="rounded-full bg-subtle-strong px-3 py-1 active:opacity-70"
            onPress={() =>
              navigation.navigate("WorkItem", {
                environmentId: props.environmentId,
                projectId: props.projectId,
                sourceId: link.ref.sourceId,
                itemId: link.ref.itemId,
              })
            }
          >
            <Text className="text-xs text-foreground" numberOfLines={1}>
              {link.snapshot.key} · {STATUS_LABELS[link.snapshot.status]}
            </Text>
          </Pressable>
        </ControlPillMenu>
      ))}
    </View>
  );
}
