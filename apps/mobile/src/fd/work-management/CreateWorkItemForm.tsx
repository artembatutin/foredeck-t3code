import type { EnvironmentId } from "@t3tools/contracts";
import type { WorkItemSummary, WorkSource } from "@t3tools/contracts/fd/work-management";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListFilterMenu } from "../../features/workspace/ListFilterMenu";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { Action, workCommandError } from "./shared";
import { workCommands } from "./state";

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
    <View className="mx-4 mb-3 gap-3 rounded-[24px] bg-grouped-card p-4 android:rounded-[28px]">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-base font-t3-semibold text-foreground">New item</Text>
        {sources.length > 1 ? (
          <ListFilterMenu
            label={`In ${source?.label ?? "source"}`}
            accessibilityLabel="Choose a source"
            actions={sources.map((entry) => ({
              id: entry.sourceId,
              title: entry.label,
              state: entry.sourceId === source?.sourceId ? ("on" as const) : ("off" as const),
            }))}
            onSelect={(event) => {
              const next = sources.find((entry) => entry.sourceId === event);
              if (next) setSourceId(next.sourceId);
            }}
          />
        ) : null}
      </View>
      <View className="gap-1.5">
        <Text className="px-1 text-sm font-t3-medium text-foreground-muted">Title</Text>
        <AppTextInput
          accessibilityLabel="Title"
          placeholder="What needs doing?"
          value={title}
          autoFocus
          onChangeText={setTitle}
        />
      </View>
      <View className="gap-1.5">
        <Text className="px-1 text-sm font-t3-medium text-foreground-muted">Description</Text>
        <AppTextInput
          accessibilityLabel="Description"
          className="min-h-24"
          placeholder="Optional, in Markdown"
          multiline
          textAlignVertical="top"
          value={body}
          onChangeText={setBody}
        />
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <View className="flex-row justify-end gap-2">
        <Action label="Cancel" disabled={pending} onPress={onCancel} />
        <Action
          label={pending ? "Creating…" : "Create"}
          primary
          disabled={pending || title.trim().length === 0}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
