import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { lastJsonBlock } from "../review/fencedJson.ts";
import { type FactoryPlanValidation, planProblem, validatePlan } from "./validate.ts";

const NO_FENCED_PLAN =
  "Your final message has no fenced ```json block holding the plan. End your final message with the plan as JSON in one fenced ```json block.";

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/**
 * Judges the plan in a planner's final message, for providers without t3 MCP tools: the last
 * ```json block is validated exactly as a `factory_submit_plan` submission is. A message without
 * one, or whose block is not JSON, is an invalid plan with that one problem; never throws.
 */
export const parseFencedPlan = (
  message: string,
  usedTaskIds: Iterable<string>,
): FactoryPlanValidation => {
  const block = lastJsonBlock(message);
  if (block === undefined) {
    return { status: "invalid", problems: [planProblem("no_json_block", NO_FENCED_PLAN)] };
  }
  const json = decodeJson(block);
  if (Result.isFailure(json)) {
    return {
      status: "invalid",
      problems: [
        planProblem(
          "invalid_json",
          `The last json block is not valid JSON: ${json.failure.message}`,
        ),
      ],
    };
  }
  return validatePlan(json.success, usedTaskIds);
};
