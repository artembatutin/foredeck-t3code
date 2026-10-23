import type { FactoryStageHandler } from "./registry.ts";

/**
 * Command stages run the project's command for the stage (verify) in the delivery worktree.
 * Every run gets a new attempt number, so a late result of an earlier run is never mistaken
 * for the current one.
 */
export const commandStage: FactoryStageHandler<"command"> = {
  kind: "command",
  begin: (delivery, stage) => {
    const attempt = delivery.commandRuns + 1;
    return {
      delivery: {
        ...delivery,
        stage: stage.name,
        awaiting: { type: "command", attempt },
        commandRuns: attempt,
      },
      effects: [{ type: "run_command", stage: stage.name, attempt }],
    };
  },
};
