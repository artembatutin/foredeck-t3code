import { isAssistantThread } from "@t3tools/shared/fd/assistant";

import { callerToolClass } from "./callerTools.ts";
import { AssistantToolkit } from "./tools.ts";

/**
 * Tools the caller classes allow that still control a worker directly: on an assistant thread
 * they would bypass the durable queue's capacity, saved scope or question ownership.
 */
const workerControls: ReadonlySet<string> = new Set([
  "t3_thread_interrupt",
  "t3_thread_configure",
  "t3_queue_cancel",
  "t3_queue_reorder",
  "t3_workflow_stop",
]);

const ownTools: ReadonlySet<string> = new Set(Object.keys(AssistantToolkit.tools));

/**
 * Whether an assistant thread may call `name`: its own toolkit, or a tool the caller classes
 * allow that controls no worker. Anything else, including a tool published later and not yet
 * classified, is refused.
 */
export const assistantMayCall = (name: string) =>
  ownTools.has(name) || (callerToolClass(name) === "allow" && !workerControls.has(name));

export const assistantRefusalText =
  "Use assistant_assign, assistant_control or assistant_answer. Project assistant work must pass through the durable queue and its permission checks. Work items are started by the owner from Work; record an agreed idea as one with assistant_capture_work, and read and update items with the work_* tools.";

/**
 * The refusal for a thread's `tools/call` requests (a batch whole), applied after
 * authentication and before MCP dispatch, regardless of which toolkit owns the tool.
 */
export function assistantToolRefusal(
  threadId: string | undefined,
  calls: ReadonlyArray<{ readonly tool: string }>,
) {
  if (!threadId || !isAssistantThread(threadId)) return undefined;
  return calls.every((call) => assistantMayCall(call.tool)) ? undefined : assistantRefusalText;
}
