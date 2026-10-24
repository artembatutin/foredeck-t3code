import { blocked, issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * Gate stages. `record` is the one this server runs, and it passes without the owner: the worker
 * approves the task for the verified, reviewed commit. Plan approval waits for the owner and is
 * not built yet, so a pipeline reaching it blocks there.
 */
export const gateStage: FactoryStageHandler<"gate"> = {
  kind: "gate",
  begin: (delivery, stage) =>
    stage.name === "record"
      ? issue({ ...delivery, stage: stage.name }, { type: "record_approval" })
      : blocked(
          { ...delivery, stage: stage.name },
          { reason: "unsupported_stage", stage: stage.name },
        ),
};
