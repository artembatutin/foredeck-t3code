import { issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/** Command stages run the project's command for the stage (verify) in the delivery worktree. */
export const commandStage: FactoryStageHandler<"command"> = {
  kind: "command",
  begin: (delivery, stage) =>
    issue({ ...delivery, stage: stage.name }, { type: "run_command", stage: stage.name }),
};
