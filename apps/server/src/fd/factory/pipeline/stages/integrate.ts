import { issue } from "../state.ts";
import { launchWorkspace } from "./agent.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * Integrate stages launch a new thread for the stage's role, a reviewer of a parent's whole
 * branch, on the delivery's worktree, in a new review round: never a turn on a reviewer thread a
 * child or an earlier integrate ran, so the review starts from none of their accounts. The engine
 * verifies the branch afresh before it begins one.
 */
export const integrateStage: FactoryStageHandler<"integrate"> = {
  kind: "integrate",
  begin: (delivery, stage) =>
    issue(
      {
        ...delivery,
        stage: stage.name,
        reviewRound: delivery.reviewRound + 1,
        invalidSubmissions: 0,
      },
      { type: "launch_thread", role: stage.role, workspace: launchWorkspace(delivery) },
    ),
};
