import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { FactoryMcpFailure, FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as FactoryService from "../FactoryService.ts";

/**
 * The `factory_*` MCP tools: how a Factory reviewer hands its review to the server. Every failure
 * is either a Factory failure or a refusal the access layer raises before the handler runs, so
 * both are declared.
 */

/**
 * The schema shows the review's shape, but any value decodes: the server judges it, so a
 * malformed review comes back as a failure the reviewer can correct, counted toward the round's
 * one retry, instead of a protocol error. A review sent as a JSON string is parsed first.
 */
const SubmittedReview = Schema.Union([
  FactoryReview,
  Schema.fromJsonString(Schema.Unknown).annotate({
    description: "Compatibility-only JSON encoding of the review object.",
  }),
  Schema.Unknown,
]).annotate({
  description: "The whole review: verdict, findings, acceptance and missing_evidence.",
});

export const FactoryToolkit = Toolkit.make(
  Tool.make("factory_submit_review", {
    description:
      "Submit your Factory review of the verified commit. Only the reviewer thread of an active Factory review may call it, once per round. An invalid review comes back with the problems to correct; a second invalid one blocks the delivery.",
    parameters: Schema.Struct({ review: SubmittedReview }),
    success: Schema.Unknown,
    failure: Schema.Union([FactoryMcpFailure, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      FactoryService.FactoryService,
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
);
