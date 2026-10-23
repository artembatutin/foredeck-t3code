import {
  AuthOrchestrationOperateScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
} from "@t3tools/contracts";

import type { Caller } from "../../../mcp/threadAccess.ts";
import type { WorkActor } from "../authority.ts";

/**
 * The Work actor for an MCP caller. Grants follow what the caller may change: a client approved
 * read-only, or a thread in plan mode, only reads; any caller that may change files may also
 * write items and start threads (within its own modes, which `startsThreads` enforces). Source
 * configuration is never an agent's to change.
 */
export const actorFromCaller = (caller: Caller): WorkActor => {
  const readOnly =
    caller.scope.client?.access === "read-only" || caller.limits.interactionMode === "plan";
  const id =
    caller.scope.thread !== undefined
      ? `thread:${caller.scope.thread.threadId}`
      : `client:${caller.scope.client?.sessionId ?? caller.scope.requestNamespace}`;
  return {
    id,
    grants: readOnly
      ? [AuthWorkReadScope]
      : [AuthWorkReadScope, AuthWorkWriteScope, AuthOrchestrationOperateScope],
    label: caller.scope.client?.label ?? caller.caller?.providerInstanceId ?? "an agent",
  };
};
