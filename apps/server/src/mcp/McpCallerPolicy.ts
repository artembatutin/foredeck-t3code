import type { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

/** One `tools/call` of a request body: the tool's name and its arguments as they arrived. */
export interface McpToolCall {
  readonly tool: string;
  readonly arguments: unknown;
}

/** What a screen decided for a request's calls: all may run, or none, with the text the caller sees. */
export type McpCallerScreen =
  | { readonly type: "allow" }
  | { readonly type: "refuse"; readonly text: string };

const allow: McpCallerScreen = { type: "allow" };

/**
 * Which tools a thread caller may run, beyond what each tool's own declaration checks (see
 * `McpToolAccess`). `screen` judges a thread caller's `tools/call` request after authentication,
 * before any handler runs: a refusal answers every call of the request with its text, and nothing
 * is resolved or dispatched. `delegation` runs around `delegate_task`'s handler once its
 * declaration's checks passed, so whoever screens a caller can also count what it delegates.
 * The default allows everything and runs the handler as it is; the server provides the policy
 * its features need.
 */
export class McpCallerPolicy extends Context.Reference<{
  readonly screen: (input: {
    readonly caller: McpInvocationContext.McpThreadCaller;
    readonly calls: ReadonlyArray<McpToolCall>;
  }) => Effect.Effect<McpCallerScreen>;
  readonly delegation: <A, E, R>(
    scope: McpInvocationContext.McpInvocationScope,
    handler: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OrchestratorMcpFailure, R>;
}>("t3/mcp/McpCallerPolicy", {
  defaultValue: () => ({
    screen: () => Effect.succeed(allow),
    delegation: (_scope, handler) => handler,
  }),
}) {}
