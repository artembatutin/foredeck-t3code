import { issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * Gate stages. `record` passes without the owner: the worker approves the task for the verified,
 * reviewed commit. `approve_plan` is the one that waits for the owner: the delivery is `waiting`
 * there, awaiting nothing, on the plan it recorded.
 */
export const gateStage: FactoryStageHandler<"gate"> = {
  kind: "gate",
  begin: (delivery, stage) =>
    stage.name === "record"
      ? issue({ ...delivery, stage: stage.name }, { type: "record_approval" })
      : {
          delivery: { ...delivery, status: "waiting", stage: stage.name, awaiting: null },
          effects: [],
        },
};
