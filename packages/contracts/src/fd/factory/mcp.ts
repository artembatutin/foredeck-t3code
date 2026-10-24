import * as Schema from "effect/Schema";

/**
 * How a `factory_*` MCP tool reports a Factory failure. Refusals the MCP access layer raises
 * before a handler runs (a client outside a thread, a thread without a live run) stay
 * `OrchestratorMcpFailure`. Messages are Factory's fixed text and the bounded problems an agent
 * can correct, never a storage cause.
 */
export class FactoryMcpFailure extends Schema.TaggedError<FactoryMcpFailure>()(
  "FactoryMcpFailure",
  {
    /**
     * `invalid_review` is the reviewer's to correct and submit again. `delivery_blocked`: the
     * delivery blocked on this submission (a second invalid review in the round, or code that
     * changed during review) and takes no further one. `invalid_request` and `not_found` answer
     * a status read that names nothing, or names a delivery or item Factory cannot find.
     */
    code: Schema.Literals([
      "not_reviewer",
      "review_not_active",
      "already_accepted",
      "invalid_review",
      "delivery_blocked",
      "invalid_request",
      "not_found",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
