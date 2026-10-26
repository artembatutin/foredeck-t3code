import { blocked, issue } from "../state.ts";
import type { FactoryStageHandler } from "./registry.ts";

/**
 * PR stages. `pr` opens the delivery's one pull request for its approved commit; the delivery
 * enters it approved and stays so until the worker reports the pull request. Follow-through is
 * entered only by that pull request's merge or close (see `advance`), never begun after `pr`, so a
 * pipeline beginning it blocks there.
 */
export const prStage: FactoryStageHandler<"pr"> = {
  kind: "pr",
  begin: (delivery, stage) =>
    stage.name === "pr"
      ? issue({ ...delivery, stage: stage.name }, { type: "open_pr" })
      : blocked(
          { ...delivery, stage: stage.name },
          { reason: "unsupported_stage", stage: stage.name },
        ),
};
