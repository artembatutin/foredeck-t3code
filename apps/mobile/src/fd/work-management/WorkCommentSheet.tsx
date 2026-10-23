import { parseWorkItemRouteRef } from "@t3tools/client-runtime/fd/work-management";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { workCommandError } from "./shared";
import { workCommands } from "./state";
import type { WorkItemParams } from "./WorkItemScreen";

/** Adds a comment to a Work item. Comments are add-only; a retry reuses its request id. */
export function WorkCommentSheet({ route }: StaticScreenProps<WorkItemParams>) {
  const navigation = useNavigation();
  const ref = parseWorkItemRouteRef(route.params);
  const comment = useAtomCommand(workCommands.comment);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(uuidv4());

  const submit = async () => {
    if (ref === undefined || body.trim().length === 0 || pending) return;
    setPending(true);
    setError(null);
    const result = await comment({
      environmentId: route.params.environmentId,
      input: { ref, body, clientRequestId: requestId.current },
    });
    setPending(false);
    if (result._tag === "Success") navigation.goBack();
    else setError(workCommandError(result));
  };

  return (
    <View className="flex-1 gap-3 bg-sheet p-4">
      <Text className="text-lg font-t3-bold text-foreground">Add a comment</Text>
      <AppTextInput
        accessibilityLabel="Comment"
        className="min-h-32 rounded-xl bg-card p-3 text-base text-foreground"
        multiline
        autoFocus
        value={body}
        onChangeText={setBody}
        placeholder="Write a comment"
        textAlignVertical="top"
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          className="rounded-full px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: pending || body.trim().length === 0 }}
          disabled={pending || body.trim().length === 0}
          onPress={() => void submit()}
          className="rounded-full bg-primary px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-primary-foreground">
            {pending ? "Posting…" : "Comment"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
