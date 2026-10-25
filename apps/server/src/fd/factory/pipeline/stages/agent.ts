import { issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * Agent stages launch a new thread for the stage's role. The delivery's first thread creates
 * its worktree; once a worktree path is recorded, every later thread works in it. An author or
 * planner launch is recorded on the delivery as it is issued, so a launch whose result is lost
 * can be found and replayed (see `unrecordedAuthorLaunch` and `unrecordedPlannerLaunch`).
 */
export const agentStage: FactoryStageHandler<"agent"> = {
  kind: "agent",
  begin: (delivery, stage) => {
    const next = issue(
      { ...delivery, stage: stage.name },
      {
        type: "launch_thread",
        role: stage.role,
        workspace:
          delivery.worktreePath === null
            ? { type: "worktree", branch: delivery.branch, baseRef: delivery.baseRef }
            : { type: "existing_worktree", worktreePath: delivery.worktreePath },
      },
    );
    const [launch] = next.effects;
    if (launch?.type !== "launch_thread") return next;
    switch (stage.role) {
      case "author":
        return { ...next, delivery: { ...next.delivery, authorLaunch: launch } };
      case "planner":
        return { ...next, delivery: { ...next.delivery, plannerLaunch: launch } };
      case "reviewer":
        return next;
    }
  },
};
