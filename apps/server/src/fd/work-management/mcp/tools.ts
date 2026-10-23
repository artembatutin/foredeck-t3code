import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  WorkMcpFailure,
  WorkNativeStatus,
  WorkPriority,
  WorkThreadMode,
} from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkService from "../WorkService.ts";
import * as WorkThreads from "../WorkThreads.ts";

/**
 * The `work_*` MCP tools: how agents (and scheduled-task threads) read and update the owner's
 * Work items. Every failure is either a Work failure or a refusal the access layer raises
 * before the handler runs, so both are declared.
 */

const ItemReference = Schema.String.check(Schema.isBetweenLength(1, 2048)).annotate({
  description:
    "The item: `<sourceId>:<itemId>` from work_list or a prompt, a key such as `fd-7k3qa2`, `#123` or `PROJ-12`, or the item's URL.",
});
const SourceId = Schema.String.annotate({
  description: "Work source id, needed only when several sources could hold the item.",
});
const TargetProject = ProjectId.annotate({
  description: "Project whose Work sources to use; defaults to the calling thread's project.",
});
const ClientRequestId = Schema.String.check(Schema.isBetweenLength(1, 256)).annotate({
  description: "Stable idempotency key to reuse when retrying this call.",
});
const ExpectedRevision = Schema.String.annotate({
  description: "The item's revision from work_read; required to change the title or body.",
});

const LabelsPatch = Schema.Struct({
  add: Schema.Array(Schema.String),
  remove: Schema.Array(Schema.String),
});
/** OpenCode has been seen serializing nested objects as JSON strings; accept and decode both. */
const LabelsPatchInput = Schema.Union([
  LabelsPatch,
  Schema.fromJsonString(LabelsPatch).annotate({
    description: "Compatibility-only JSON encoding of the labels object.",
  }),
]).annotate({ description: "Labels to add and remove: {add: [...], remove: [...]}." });

const common = {
  success: Schema.Unknown,
  failure: Schema.Union([WorkMcpFailure, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    WorkService.WorkService,
    WorkThreads.WorkThreads,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};

export const WorkToolkit = Toolkit.make(
  Tool.make("work_list", {
    ...common,
    description:
      "List the owner's Work items (Markdown tasks, GitHub issues, Jira issues) of a project, newest first, without bodies. Omit sourceId when the project has one source.",
    parameters: Schema.Struct({
      projectId: Schema.optionalKey(TargetProject),
      sourceId: Schema.optionalKey(SourceId),
      statuses: Schema.optionalKey(Schema.Array(WorkNativeStatus)),
      assignee: Schema.optionalKey(Schema.Literal("me")),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
      cursor: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("work_read", {
    ...common,
    description:
      "Read one Work item with its description, recent comments, linked threads and available status transitions. The revision it returns guards title and body edits.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("work_create", {
    ...common,
    description: "Create a Work item in a project's source.",
    parameters: Schema.Struct({
      projectId: Schema.optionalKey(TargetProject),
      sourceId: Schema.optionalKey(SourceId),
      title: Schema.String.check(Schema.isBetweenLength(1, 512)),
      body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
      priority: Schema.optionalKey(WorkPriority),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      assignee: Schema.optionalKey(Schema.String),
      parent: Schema.optionalKey(Schema.String),
      clientRequestId: Schema.optionalKey(ClientRequestId),
    }),
  }),
  Tool.make("work_update", {
    ...common,
    description:
      "Change a Work item's title, body, priority, labels, assignee, parent or blockers. Title and body edits need expectedRevision; a stale one fails with the current item.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      expectedRevision: Schema.optionalKey(ExpectedRevision),
      title: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 512))),
      body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
      priority: Schema.optionalKey(Schema.NullOr(WorkPriority)),
      labels: Schema.optionalKey(LabelsPatchInput),
      assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
      parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
      blockedBy: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  }).annotate(Tool.Idempotent, true),
  Tool.make("work_set_status", {
    ...common,
    description:
      "Set a Work item's status (todo, in_progress, done, cancelled), or apply a Jira transition by id. When a status maps to several transitions the candidates are returned to choose from.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      status: Schema.optionalKey(WorkNativeStatus),
      transitionId: Schema.optionalKey(Schema.String),
      expectedRevision: Schema.optionalKey(ExpectedRevision),
    }),
  }).annotate(Tool.Idempotent, true),
  Tool.make("work_comment", {
    ...common,
    description:
      "Add a comment to a Work item (a Notes entry for Markdown tasks). Comments are signed as posted by you via Foredeck.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      body: Schema.String.check(Schema.isBetweenLength(1, 4_000)),
      clientRequestId: Schema.optionalKey(ClientRequestId),
    }),
  }),
  Tool.make("work_link_thread", {
    ...common,
    description:
      "Link a thread to a Work item, or unlink it. Omit threadId for your own thread. Linking is idempotent.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      threadId: Schema.optionalKey(ThreadId),
      action: Schema.Literals(["link", "unlink"]),
    }),
  }).annotate(Tool.Idempotent, true),
  Tool.make("work_start_thread", {
    ...common,
    description:
      "Start an agent thread from a Work item, in your own runtime and interaction modes. An open linked thread is returned instead of a second one unless force is true.",
    parameters: Schema.Struct({
      item: ItemReference,
      sourceId: Schema.optionalKey(SourceId),
      projectId: Schema.optionalKey(TargetProject),
      mode: Schema.optionalKey(WorkThreadMode),
      workspace: Schema.optionalKey(Schema.Literals(["root", "worktree"])),
      branch: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 200))),
      prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
      force: Schema.optionalKey(Schema.Boolean),
    }),
  }),
);
