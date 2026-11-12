import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useOpenWorkspaceDetail } from "../../features/layout/useOpenWorkspaceDetail";

/** Opens a thread from Work: Android selects it as the detail page, iOS pushes it so Back returns. */
export function useOpenWorkThread() {
  const openDetail = useOpenWorkspaceDetail();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    openDetail({ name: "Thread", params: { environmentId, threadId } });
}
