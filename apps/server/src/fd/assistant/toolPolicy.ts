import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Schema from "effect/Schema";

// Raw worker mutations would bypass capacity, saved scope, or question ownership.
const managedOperations = new Set([
  "t3_thread_launch",
  "create_threads",
  "delegate_task",
  "schedule_task",
  "run_scheduled_task_now",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "t3_pending_request_respond",
  "t3_thread_interrupt",
  "work_start_thread",
]);
const ToolCall = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({ name: Schema.String }),
});

const isToolCall = Schema.is(ToolCall);

/** Applied after authentication, before MCP dispatch, regardless of which toolkit owns the tool. */
export function assistantToolRefusal(threadId: string | undefined, body: unknown) {
  if (
    !threadId ||
    !isAssistantThread(threadId) ||
    !isToolCall(body) ||
    !managedOperations.has(body.params.name)
  )
    return undefined;
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: "Use assistant_assign, assistant_control or assistant_answer. Project assistant work must pass through the durable queue and its permission checks. Work items are started by the owner from Work; read and update them with the work_* tools.",
        },
      ],
    },
  };
}
