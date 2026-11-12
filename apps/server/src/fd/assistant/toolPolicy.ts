import { isAssistantThread } from "@t3tools/shared/fd/assistant";

import { callerToolClass } from "./callerTools.ts";
import { AssistantToolkit } from "./tools.ts";

/**
 * Calls the caller classes allow that still control a worker directly: on an assistant thread
 * they would bypass the durable queue's capacity, saved scope or question ownership.
 */
const controlsWorker = (name: string, args: unknown) => {
  const input = args as { readonly action?: unknown; readonly modelSelection?: unknown } | null;
  switch (name) {
    case "t3_thread_interrupt":
    case "t3_workflow_stop":
      return true;
    // Reading a thread's configuration controls nothing; setting its model does.
    case "t3_thread_configure":
      return input?.modelSelection !== undefined;
    case "t3_queue":
      return input?.action === "cancel" || input?.action === "reorder";
    default:
      return false;
  }
};

const ownTools: ReadonlySet<string> = new Set(Object.keys(AssistantToolkit.tools));

/**
 * Whether an assistant thread may call `name` with `args`: its own toolkit, or a call the caller
 * classes allow that controls no worker. Anything else, including a tool published later and not
 * yet classified, is refused.
 */
const assistantMayCall = (name: string, args?: unknown) =>
  ownTools.has(name) || (callerToolClass(name, args) === "allow" && !controlsWorker(name, args));

const assistantRefusalText =
  "Use assistant_assign, assistant_control or assistant_answer. Project assistant work must pass through the durable queue and its permission checks. Work items are started by the owner from Work; record an agreed idea as one with assistant_capture_work, and read and update items with the work_* tools.";

/**
 * The refusal for a thread's `tools/call` requests (a batch whole), applied after
 * authentication and before MCP dispatch, regardless of which toolkit owns the tool.
 */
export function assistantToolRefusal(
  threadId: string | undefined,
  calls: ReadonlyArray<{ readonly tool: string; readonly arguments?: unknown }>,
) {
  if (!threadId || !isAssistantThread(threadId)) return undefined;
  return calls.every((call) => assistantMayCall(call.tool, call.arguments))
    ? undefined
    : assistantRefusalText;
}
