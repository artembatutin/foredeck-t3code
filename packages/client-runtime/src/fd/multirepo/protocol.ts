import {
  MULTIREPO_PROTOCOL_VERSION,
  type ExecutionEnvironmentCapabilities,
  type OrchestrationV2ShellSnapshot,
  type ThreadId,
  type ProjectId,
} from "@t3tools/contracts";

export const supportsRepositories = (capabilities: ExecutionEnvironmentCapabilities) =>
  capabilities.multiRepository === MULTIREPO_PROTOCOL_VERSION;

/** Detect explicit repository semantics before an older server can strip unknown fields. */
export function requiresRepositoryProtocol(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  return (
    ("repositoryTarget" in input && input.repositoryTarget !== undefined) ||
    ("repositoryId" in input && input.repositoryId !== undefined) ||
    ("resource" in input &&
      input.resource !== null &&
      typeof input.resource === "object" &&
      "repositoryTarget" in input.resource) ||
    ("repositories" in input && input.repositories !== undefined)
  );
}

/** Existing conversations use their saved set; only new conversations use current membership. */
export function requiresMultiRepositoryExecution(
  snapshot: OrchestrationV2ShellSnapshot | null,
  input: { readonly threadId: ThreadId; readonly projectId?: ProjectId | undefined },
) {
  const thread =
    snapshot?.threads.find((thread) => thread.id === input.threadId) ??
    snapshot?.archivedThreads.find((thread) => thread.id === input.threadId);
  return thread
    ? (thread.workspaceBinding?.repositories.length ?? 0) > 1
    : (snapshot?.projects.find((project) => project.id === input.projectId)?.repositories?.length ??
        0) > 1;
}

/** Keep the requirement sticky while queued messages are edited or membership changes. */
export function retainQueuedRepositoryRequirement<
  T extends {
    readonly threadId: ThreadId;
    readonly requiresRepositoryProtocol?: boolean;
    readonly creation?: { readonly projectId: ProjectId };
  },
>(message: T, snapshot: OrchestrationV2ShellSnapshot | null): T {
  return message.requiresRepositoryProtocol ||
    requiresMultiRepositoryExecution(snapshot, {
      threadId: message.threadId,
      projectId: message.creation?.projectId,
    })
    ? { ...message, requiresRepositoryProtocol: true }
    : message;
}
