import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { WorkStatus } from "@t3tools/contracts/fd/work-management";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export const STATUS_LABELS: Record<WorkStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** The message a failed Work command shows: the server's own text. */
export function workCommandError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Work request failed.";
}

/** Shown where this device was paired before Work; passive surfaces show nothing instead. */
export function WorkRepairNotice() {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-screen p-6">
      <Text className="text-center text-base font-t3-medium text-foreground">
        This connection cannot read Work
      </Text>
      <Text className="text-center text-sm text-foreground-muted">
        It was paired before Work existed. Pair this device again from a session that has Work
        access.
      </Text>
    </View>
  );
}
