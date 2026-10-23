import * as Schema from "effect/Schema";

import { WorkErrorReason } from "./schemas.ts";

/**
 * How a `work_*` MCP tool reports a Work failure. Refusals the MCP access layer raises before a
 * handler runs (read-only client, dead caller, missing target) stay `OrchestratorMcpFailure`.
 * Messages are fixed text plus at most a bounded host message, never a storage cause.
 */
export class WorkMcpFailure extends Schema.TaggedError<WorkMcpFailure>()("WorkMcpFailure", {
  code: WorkErrorReason,
  message: Schema.String,
}) {}
