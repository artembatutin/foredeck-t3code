import { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Who is calling a Work service method, derived by the transport (the WebSocket session, the
 * MCP invocation scope or the scheduler), never from a client-declared permission. Grants are
 * fixed for the call: connection scopes do not change within a WebSocket session and MCP
 * derives them once per tool call.
 */
export interface WorkActor {
  /** Audit label recorded on changes, such as `session:<id>` or `thread:<id>`. */
  readonly id: string;
  readonly grants: ReadonlyArray<AuthEnvironmentScope>;
  /** Shown on remote comments an agent posts under the owner's credential. */
  readonly label: string;
}

export class WorkPermissionDenied extends Schema.TaggedError<WorkPermissionDenied>()(
  "WorkPermissionDenied",
  { requiredPermission: AuthEnvironmentScope },
) {
  override get message(): string {
    return `This Work action requires the ${this.requiredPermission} permission.`;
  }
}

/** Fails with the first grant in `required` the actor does not hold. */
export const requireGrants = (
  actor: WorkActor,
  required: ReadonlyArray<AuthEnvironmentScope>,
): Effect.Effect<void, WorkPermissionDenied> => {
  const missing = required.find((scope) => !actor.grants.includes(scope));
  return missing === undefined
    ? Effect.void
    : Effect.fail(new WorkPermissionDenied({ requiredPermission: missing }));
};

/** Whether the actor is an agent (thread or MCP client) rather than the owner's own session. */
export const isAgentActor = (actor: WorkActor): boolean =>
  actor.id.startsWith("thread:") || actor.id.startsWith("client:");
