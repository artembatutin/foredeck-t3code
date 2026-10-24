import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import { FactoryMcpFailure, FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryService from "../FactoryService.ts";

/**
 * The `factory_*` MCP tools: how a Factory reviewer hands its review to the server, and how any
 * agent reads where a delivery stands. Every failure
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

/** Strings, not the branded ids: a malformed one is a not-found answer, not a protocol error. */
const DeliveryReference = Schema.String.check(Schema.isBetweenLength(1, 256)).annotate({
  description: "A Factory delivery id.",
});
const ItemReference = Schema.String.check(Schema.isBetweenLength(1, 2048)).annotate({
  description:
    "The Work item, as work_read takes it: `<sourceId>:<itemId>`, a key such as `fd-7k3qa2`, `#123` or `PROJ-12`, or the item's URL.",
});
const SourceId = Schema.String.check(Schema.isBetweenLength(1, 256)).annotate({
  description: "Work source id, needed only when several sources could hold the item.",
});
const TargetProject = ProjectId.annotate({
  description:
    "Project whose Work sources resolve the item; defaults to the calling thread's project.",
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
  Tool.make("factory_status", {
    description:
      "Read where Factory deliveries stand: pass delivery for one delivery, or item for every delivery of that Work item, newest first. Each shows its status, stage, rounds, branch, threads by role, verify receipt and review summaries, and, when blocked, what needs the owner. Pass exactly one of delivery and item.",
    parameters: Schema.Struct({
      delivery: Schema.optionalKey(DeliveryReference),
      item: Schema.optionalKey(ItemReference),
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
    }),
    success: Schema.Unknown,
    failure: Schema.Union([FactoryMcpFailure, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      FactoryService.FactoryService,
      WorkService.WorkService,
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }).annotate(Tool.Readonly, true),
);
