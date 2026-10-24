import { FactoryMcpFailure } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";

import { requireThreadScope } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { loadCaller } from "../../../mcp/threadAccess.ts";
import * as FactoryService from "../FactoryService.ts";
import { FactoryToolkit } from "./tools.ts";

export const toolLayer = McpToolAccess.toLayer(FactoryToolkit, {
  // Acts as the calling thread, while its run is live, and submits only that thread's own review.
  // Factory's rule admits it in plan mode, where Work's read-only rule would refuse a write: the
  // submission changes no file or thread, and only the registered reviewer's is taken.
  factory_submit_review: McpToolAccess.actsAsCaller(({ review }) =>
    Effect.gen(function* () {
      const { thread } = yield* requireThreadScope((yield* loadCaller()).scope, "This tool");
      const service = yield* FactoryService.FactoryService;
      const accepted = yield* service.submitReview({ threadId: thread.threadId, review }).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "FactoryReviewRefusedError":
              return new FactoryMcpFailure({ code: error.reason, message: error.message });
            case "FactoryReviewInvalidError":
              return new FactoryMcpFailure({
                code: error.blocked ? "delivery_blocked" : "invalid_review",
                message: error.message,
              });
            case "FactoryReviewCodeChangedError":
              return new FactoryMcpFailure({ code: "delivery_blocked", message: error.message });
            default:
              // Judging or storage failed, so nothing was recorded; the cause stays server-side.
              return new FactoryMcpFailure({
                code: "unavailable",
                message: "Factory could not take the review; nothing was recorded.",
              });
          }
        }),
      );
      return {
        deliveryId: accepted.deliveryId,
        round: accepted.review.round,
        summary: accepted.review.summary,
      };
    }),
  ),
});
