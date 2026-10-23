import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { Platform } from "react-native";

import { useAndroidWorkspaceSelection } from "../../features/workspace/useAndroidWorkspaceSelection";

/** Opens a thread from Work; Android resets its split view so the thread fills the detail slot. */
export function useOpenWorkThread() {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      const params = { environmentId, threadId };
      if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params });
      else navigation.navigate("Thread", params);
    },
    [navigation, selectAndroidWorkspace],
  );
}
