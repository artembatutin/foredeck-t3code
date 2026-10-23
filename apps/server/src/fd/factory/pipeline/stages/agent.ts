import { issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * Agent stages launch a new thread for the stage's role. The delivery's first thread creates
 * its worktree; once a worktree path is recorded, every later thread works in it.
 */
export const agentStage: FactoryStageHandler<"agent"> = {
  kind: "agent",
  begin: (delivery, stage) =>
    issue(
      { ...delivery, stage: stage.name },
      {
        type: "launch_thread",
        role: stage.role,
        workspace:
          delivery.worktreePath === null
            ? { type: "worktree", branch: delivery.branch, baseRef: delivery.baseRef }
            : { type: "existing_worktree", worktreePath: delivery.worktreePath },
      },
    ),
};
