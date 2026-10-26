import { OrchestratorMcpFailure, ProjectId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { FactoryMcpFailure, FactoryPlan, FactoryReview } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryService from "../FactoryService.ts";

/**
 * The `factory_*` MCP tools: how a Factory reviewer or planner hands its review or plan to the
 * server, how any agent reads where a delivery stands, and how an agent starts one. Every failure
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

/** Like the review: any value decodes, and the server judges it. */
const SubmittedPlan = Schema.Union([
  FactoryPlan,
  Schema.fromJsonString(Schema.Unknown).annotate({
    description: "Compatibility-only JSON encoding of the plan object.",
  }),
  Schema.Unknown,
]).annotate({
  description: "The whole plan: its tasks in delivery order, and an optional note.",
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
    "Project whose Work sources resolve the item, by default the calling thread's; with next, the project to start the next Ready item of, which next requires.",
});
const NextReady = Schema.Boolean.annotate({
  description:
    "true starts the next Ready item of projectId instead of a named item: the first todo item, in Work's list order, that is not blocked and has no open thread or delivery. Pass it instead of item.",
});
const ReadyLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "With next, only items with this label are considered.",
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
  Tool.make("factory_submit_plan", {
    description:
      "Submit your Factory plan for the Work item. Only the planner thread of an active Factory plan may call it, once per round. An invalid plan comes back with the problems to correct; a second invalid one blocks the delivery. An empty task list ends planning with your note.",
    parameters: Schema.Struct({ plan: SubmittedPlan }),
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
  Tool.make("factory_deliver", {
    description:
      "Start a Factory delivery of a Work item: an author thread on a new worktree and branch, server-run verification, review and repair rounds, then a pull request. As a parent, a planner thread first plans the item's tasks for the owner to approve. Its threads never run in a broader runtime mode than yours. An item can have one delivery that is not done or cancelled; follow it with factory_status. Pass exactly one of item and next: true. With next, Factory delivers the project's next Ready item as a single item, optionally only among items with label; when nothing is Ready it starts nothing and answers nothingReady, with incomplete true when a Work source could not be listed whole.",
    parameters: Schema.Struct({
      item: Schema.optionalKey(ItemReference),
      next: Schema.optionalKey(NextReady),
      label: Schema.optionalKey(ReadyLabel),
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      kind: Schema.optionalKey(
        Schema.Literals(["single", "parent"]).annotate({
          description:
            "single (the default) delivers the item itself. parent plans the item's tasks first, as child items once the owner approves; only an item in a Markdown Work source can be a parent.",
        }),
      ),
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
  }),
);
