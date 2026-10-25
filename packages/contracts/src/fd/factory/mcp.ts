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
     * `factory_submit_review` and `factory_submit_plan` refuse a caller that is not the
     * delivery's reviewer or planner (`not_reviewer`, `not_planner`), a submission while no
     * review or plan run awaits one (`review_not_active`, `plan_not_active`) and one after the
     * round's is accepted (`already_accepted`), recording nothing. `invalid_review` and
     * `invalid_plan` are the agent's to correct and submit again. `delivery_blocked`: the
     * delivery blocked on this submission (a second invalid one in the round, or code that
     * changed during review) and takes no further one. `invalid_request` and `not_found` answer
     * a status read that names nothing, or names a delivery or item Factory cannot find.
     * `factory_deliver` refuses a caller that only reads with `forbidden`, and a start Factory
     * refused with one code per reason, from `not_configured` to `unsupported_source`; nothing is
     * written for any of them.
     */
    code: Schema.Literals([
      "not_reviewer",
      "review_not_active",
      "not_planner",
      "plan_not_active",
      "already_accepted",
      "invalid_review",
      "invalid_plan",
      "delivery_blocked",
      "invalid_request",
      "not_found",
      "unavailable",
      "forbidden",
      "not_configured",
      "delivery_active",
      "project_missing",
      "no_base_commit",
      "no_free_branch",
      "unsupported_source",
    ]),
    message: Schema.String,
  },
) {}
