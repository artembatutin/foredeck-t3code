import type { EnvironmentId } from "@t3tools/contracts";
import type { WorkItemSummary, WorkSource } from "@t3tools/contracts/fd/work-management";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { workCommandError } from "./shared";
import { workCommands } from "./state";

const INPUT_CLASS = "rounded-xl bg-card px-3 py-2 text-base text-foreground";

/** Creates an item in one of the project's sources; cancel it later instead of deleting it. */
export function CreateWorkItemForm({
  environmentId,
  sources,
  onCancel,
  onCreated,
}: {
  environmentId: EnvironmentId;
  sources: ReadonlyArray<WorkSource>;
  onCancel: () => void;
  onCreated: (item: WorkItemSummary) => void;
}) {
  const create = useAtomCommand(workCommands.createItem);
  const [sourceId, setSourceId] = useState(sources[0]?.sourceId ?? null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reused on retry so a lost response cannot create the item twice.
  const requestId = useRef(uuidv4());
  const source = sources.find((entry) => entry.sourceId === sourceId) ?? sources[0];

  const submit = async () => {
    if (source === undefined || title.trim().length === 0 || pending) return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        sourceId: source.sourceId,
        title: title.trim(),
        ...(body.trim().length === 0 ? {} : { body }),
        clientRequestId: requestId.current,
      },
    });
    setPending(false);
    if (result._tag === "Success") onCreated(result.value);
    else setError(workCommandError(result));
  };

  return (
    <View className="mx-4 mb-2 gap-2 rounded-xl bg-subtle p-3">
      {sources.length > 1 ? (
        <ControlPillMenu
          accessibilityLabel="Choose a source"
          actions={sources.map((entry) => ({
            id: entry.sourceId,
            title: entry.label,
            state: entry.sourceId === source?.sourceId ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = sources.find((entry) => entry.sourceId === nativeEvent.event);
            if (next) setSourceId(next.sourceId);
          }}
        >
          <View className="self-start rounded-full bg-subtle-strong px-3 py-1.5">
            <Text className="text-sm font-t3-medium text-foreground">In {source?.label}</Text>
          </View>
        </ControlPillMenu>
      ) : null}
      <AppTextInput
        accessibilityLabel="Title"
        className={INPUT_CLASS}
        placeholder="Title"
        value={title}
        autoFocus
        onChangeText={setTitle}
      />
      <AppTextInput
        accessibilityLabel="Description"
        className={`${INPUT_CLASS} min-h-24`}
        placeholder="Description (Markdown)"
        multiline
        textAlignVertical="top"
        value={body}
        onChangeText={setBody}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={onCancel}
          className="rounded-full px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: pending || title.trim().length === 0 }}
          disabled={pending || title.trim().length === 0}
          onPress={() => void submit()}
          className="rounded-full bg-primary px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-primary-foreground">
            {pending ? "Creating…" : "Create"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
