import type { OrchestrationV2ServerCommand, ProjectId, ThreadId } from "@t3tools/contracts";

/** The shared dispatch gate covers direct RPC, MCP, schedules and delegated work. */
export function commandWorkspaceRestriction(command: OrchestrationV2ServerCommand):
  | {
      readonly operation: "worktree" | "rollback";
      readonly target: { readonly projectId: ProjectId } | { readonly threadId: ThreadId };
    }
  | undefined {
  switch (command.type) {
    case "thread.create":
      return command.worktreePath === null
        ? undefined
        : { operation: "worktree", target: { projectId: command.projectId } };
    case "thread.metadata.update":
      return command.worktreePath == null
        ? undefined
        : { operation: "worktree", target: { threadId: command.threadId } };
    case "message.dispatch":
      return command.dispatchMode.type === "defer_start" &&
        command.dispatchMode.workspaceStrategy !== undefined &&
        command.dispatchMode.workspaceStrategy.type !== "root"
        ? { operation: "worktree", target: { threadId: command.threadId } }
        : undefined;
    case "delegated_task.request":
      return command.workspaceStrategy !== undefined && command.workspaceStrategy.type !== "root"
        ? { operation: "worktree", target: { threadId: command.parentThreadId } }
        : undefined;
    case "checkpoint.rollback":
      return { operation: "rollback", target: { threadId: command.threadId } };
    default:
      return undefined;
  }
}
