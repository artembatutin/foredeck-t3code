import { useAtomValue } from "@effect/atom-react";
import {
  linkPrompts,
  parseWorkItemRouteRef,
  RUN_STATE_LABELS,
  runStateOf,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isWorkNativeStatus,
  type WorkItemDetail,
  type WorkNativeStatus,
  type WorkThreadMode,
} from "@t3tools/contracts/fd/work-management";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useLayoutEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { STATUS_LABELS, workCommandError } from "./shared";
import { workCommands, workEnvironment } from "./state";
import { useOpenWorkThread } from "./useOpenWorkThread";

export type WorkItemParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sourceId: string;
  readonly itemId: string;
};

const MODES: ReadonlyArray<{ readonly value: WorkThreadMode; readonly label: string }> = [
  { value: "implement", label: "Implement" },
  { value: "plan", label: "Plan" },
  { value: "scope", label: "Scope" },
];

/** One Work item: status, description, comments, linked threads and starting a thread. */
export function WorkItemScreen({ route }: StaticScreenProps<WorkItemParams>) {
  const navigation = useNavigation();
  const ref = parseWorkItemRouteRef(route.params);
  const environmentId = route.params.environmentId;
  const query = useEnvironmentQuery(
    ref === undefined ? null : workEnvironment.detail({ environmentId, input: { ref } }),
  );
  const item = query.data;

  useLayoutEffect(() => {
    navigation.setOptions({ title: item?.key ?? "Work item" });
  }, [item?.key, navigation]);

  if (ref === undefined) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-6">
        <Text className="text-foreground-muted">This link does not name a Work item.</Text>
      </View>
    );
  }
  if (item === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-6">
        <Text className="text-foreground-muted">{query.error ?? "Loading…"}</Text>
      </View>
    );
  }
  return (
    <LoadedItem environmentId={environmentId} projectId={route.params.projectId} item={item} />
  );
}

function LoadedItem({
  environmentId,
  projectId,
  item,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  item: WorkItemDetail;
}) {
  const navigation = useNavigation();
  const openThread = useOpenWorkThread();
  const shells = useThreadShells();
  const setStatus = useAtomCommand(workCommands.setStatus);
  const setLink = useAtomCommand(workCommands.setLink);
  const start = useAtomCommand(workCommands.startThread);
  const canWrite = useAtomValue(workCommands.updateItem.permissionAtom(environmentId));
  const canStart = useAtomValue(workCommands.startThread.permissionAtom(environmentId));
  const [error, setError] = useState<string | null>(null);
  const writable = canWrite && item.invalid === null;
  const shellById = useMemo(
    () =>
      new Map(
        shells
          .filter((shell) => shell.environmentId === environmentId)
          .map((shell) => [shell.id, shell] as const),
      ),
    [environmentId, shells],
  );
  const openLink = item.links.find((link) => {
    const state = runStateOf(shellById.get(link.threadId));
    return state === "working" || state === "needs-input" || state === "idle";
  });

  const changeStatus = async (input: { status?: WorkNativeStatus; transitionId?: string }) => {
    setError(null);
    const result = await setStatus({
      environmentId,
      input: { ref: item.ref, ...input, expectedRevision: item.revision },
    });
    if (result._tag === "Success") return true;
    const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
    // An ambiguous Jira status answers with the transitions that reach it.
    if (failure?._tag === "WorkError" && failure.candidates !== undefined) {
      Alert.alert("Choose a transition", undefined, [
        ...failure.candidates
          .filter((candidate) => !candidate.requiresFields)
          .map((candidate) => ({
            text: candidate.name,
            onPress: () => void changeStatus({ transitionId: candidate.id }),
          })),
        { text: "Cancel", style: "cancel" as const },
      ]);
      return false;
    }
    setError(workCommandError(result));
    return false;
  };

  const confirmStatus = (status: WorkNativeStatus) => {
    if (status !== "cancelled") return void changeStatus({ status });
    Alert.alert(`Cancel ${item.key}?`, "It stays in the source as cancelled.", [
      { text: "Keep", style: "cancel" },
      { text: "Cancel item", style: "destructive", onPress: () => void changeStatus({ status }) },
    ]);
  };

  const startThread = async (mode: WorkThreadMode, force: boolean) => {
    setError(null);
    const result = await start({
      environmentId,
      input: { ref: item.ref, creationSource: "mobile", mode, force },
    });
    if (result._tag === "Success") openThread(environmentId, result.value.threadId);
    else setError(workCommandError(result));
  };

  const unlink = async (threadId: ThreadId) => {
    const result = await setLink({
      environmentId,
      input: { ref: item.ref, threadId, action: "unlink" },
    });
    if (result._tag === "Failure") setError(workCommandError(result));
  };

  const statusActions =
    item.capabilities.transitions && item.transitions.length > 0
      ? item.transitions.map((transition) => ({
          id: `transition:${transition.id}`,
          title: `${transition.name} → ${transition.toName}`,
          attributes: { disabled: transition.requiresFields },
        }))
      : item.capabilities.statuses.map((status) => ({
          id: `status:${status}`,
          title: STATUS_LABELS[status],
          state: status === item.status ? ("on" as const) : ("off" as const),
        }));

  return (
    <ScrollView className="flex-1 bg-screen" contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View className="gap-1">
        <Text className="text-xs text-foreground-muted">{item.key}</Text>
        <Text selectable className="text-lg font-t3-bold text-foreground">
          {item.title}
        </Text>
        {item.invalid ? (
          <Text className="text-sm text-warning">Read-only: {item.invalid.message}</Text>
        ) : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        <ControlPillMenu
          accessibilityLabel="Change status"
          actions={statusActions}
          onPressAction={({ nativeEvent }) => {
            const [kind, value] = nativeEvent.event.split(":");
            if (!writable || value === undefined) return;
            if (kind === "transition") void changeStatus({ transitionId: value });
            else if (isWorkNativeStatus(value)) confirmStatus(value);
          }}
        >
          <Chip label={item.nativeStatus?.name ?? STATUS_LABELS[item.status]} />
        </ControlPillMenu>
        {item.blocked ? <Chip label="Blocked" /> : null}
        {item.priority ? <Chip label={`${item.priority} priority`} /> : null}
        {item.assignee ? <Chip label={item.assignee.label} /> : null}
      </View>

      <View className="flex-row flex-wrap gap-2">
        {openLink ? (
          <Action
            label="Continue thread"
            onPress={() => openThread(environmentId, openLink.threadId)}
          />
        ) : null}
        {canStart ? (
          <ControlPillMenu
            accessibilityLabel="Start a thread"
            actions={MODES.map((mode) => ({ id: mode.value, title: mode.label }))}
            onPressAction={({ nativeEvent }) => {
              const mode = MODES.find((entry) => entry.value === nativeEvent.event);
              if (mode) void startThread(mode.value, openLink !== undefined);
            }}
          >
            <Chip label={openLink ? "Start another" : "Start thread"} />
          </ControlPillMenu>
        ) : null}
        {writable && item.capabilities.comments === "add" ? (
          <Action
            label="Comment"
            onPress={() =>
              navigation.navigate("WorkComment", {
                environmentId,
                projectId,
                sourceId: item.ref.sourceId,
                itemId: item.ref.itemId,
              })
            }
          />
        ) : null}
        {item.url ? <Action label="Open" onPress={() => void Linking.openURL(item.url!)} /> : null}
      </View>

      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}

      {item.links.length > 0 ? (
        <View className="gap-2">
          <Text className="text-sm font-t3-medium text-foreground">Linked threads</Text>
          {item.links.map((link) => {
            const shell = shellById.get(link.threadId);
            const prompts = linkPrompts(link, item);
            return (
              <View key={link.threadId} className="gap-1 rounded-xl bg-card p-3">
                <Pressable onPress={() => openThread(environmentId, link.threadId)}>
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {shell?.title ?? link.threadId}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {RUN_STATE_LABELS[runStateOf(shell)]}
                    {link.run ? ` · last run ${link.run.status}` : ""}
                  </Text>
                </Pressable>
                <View className="flex-row flex-wrap gap-2">
                  {writable ? (
                    <Action label="Unlink" onPress={() => void unlink(link.threadId)} />
                  ) : null}
                  {writable && prompts.backToTodo ? (
                    <Action
                      label="Back to todo?"
                      onPress={() => void changeStatus({ status: "todo" })}
                    />
                  ) : null}
                  {writable && prompts.markDone && item.capabilities.statuses.includes("done") ? (
                    <Action
                      label={`Mark ${item.key} done?`}
                      onPress={() => void changeStatus({ status: "done" })}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Description</Text>
        {item.bodyFidelity === "lossy" ? (
          <Text className="text-xs text-foreground-muted">
            Some content is only shown in the source.
          </Text>
        ) : null}
        <Text selectable className="text-sm text-foreground">
          {item.body.trim().length === 0 ? "No description." : item.body}
        </Text>
      </View>

      {item.labels.length > 0 ? (
        <Text className="text-xs text-foreground-muted">Labels: {item.labels.join(", ")}</Text>
      ) : null}
      {item.parent || item.blockedBy.length > 0 || item.children.length > 0 ? (
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">Relationships</Text>
          {item.parent ? (
            <Text className="text-sm text-foreground">Parent: {item.parent}</Text>
          ) : null}
          {item.blockedBy.length > 0 ? (
            <Text className="text-sm text-foreground">Blocked by: {item.blockedBy.join(", ")}</Text>
          ) : null}
          {item.children.map((child) => (
            <Text key={child.itemId} className="text-sm text-foreground">
              {child.key} {child.title} · {STATUS_LABELS[child.status]}
            </Text>
          ))}
        </View>
      ) : null}

      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Comments</Text>
        {item.comments.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No comments yet.</Text>
        ) : (
          item.comments.map((comment) => (
            <View key={comment.id} className="gap-0.5">
              <Text className="text-xs text-foreground-muted">
                {comment.author?.label ?? "Unknown"}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {comment.body}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View className="rounded-full bg-subtle-strong px-3 py-1.5">
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </View>
  );
}

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}
