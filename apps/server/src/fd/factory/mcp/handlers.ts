import { AuthWorkReadScope, type ProjectId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryMcpFailure } from "@t3tools/contracts/fd/factory";
import { WorkSourceId, workItemRefString } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { requireThreadScope } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { loadCaller, resolveProjectId } from "../../../mcp/threadAccess.ts";
import {
  parseWorkItemReference,
  resolveWorkTarget,
  type WorkActor,
  WorkService,
} from "../../work-management/index.ts";
import * as FactoryService from "../FactoryService.ts";
import { toFactoryDelivery } from "../snapshot.ts";
import { FactoryToolkit } from "./tools.ts";

const decodeDeliveryId = Schema.decodeUnknownOption(FactoryDeliveryId);
const decodeSourceId = Schema.decodeUnknownOption(WorkSourceId);

/** A status read lists the project's sources to resolve an item and changes nothing in Work. */
const sourceReader: WorkActor = { id: "factory", grants: [AuthWorkReadScope], label: "Factory" };

const invalidRequest = (message: string) =>
  new FactoryMcpFailure({ code: "invalid_request", message });

/** Status failures carry fixed text; what Work or the store reported stays server-side. */
const workUnavailable = () =>
  new FactoryMcpFailure({
    code: "unavailable",
    message: "Factory could not read the project's Work sources. Try again.",
  });
const storeUnavailable = () =>
  new FactoryMcpFailure({
    code: "unavailable",
    message: "Factory could not read its deliveries. Try again.",
  });

/** The item a status read names, resolved among its project's sources as `work_read` does. */
const resolveItem = (params: {
  readonly item: string;
  readonly sourceId?: string;
  readonly projectId?: ProjectId;
}) =>
  Effect.gen(function* () {
    const reference = parseWorkItemReference(params.item);
    if (reference === undefined) {
      return yield* invalidRequest(
        "Name the item as <sourceId>:<itemId>, a key such as fd-7k3qa2, #123 or PROJ-12, or its URL.",
      );
    }
    if (reference.type === "ref") return reference.ref;
    const sourceId =
      params.sourceId === undefined ? Option.none() : decodeSourceId(params.sourceId);
    if (params.sourceId !== undefined && Option.isNone(sourceId)) {
      return yield* invalidRequest("sourceId is not a Work source id.");
    }
    const projectId = yield* resolveProjectId(yield* loadCaller(), params.projectId);
    const work = yield* WorkService.WorkService;
    const { sources } = yield* work
      .listSources(sourceReader, { projectId, includeDisconnected: false })
      .pipe(Effect.mapError(workUnavailable));
    const resolved = resolveWorkTarget({
      reference,
      sources,
      sourceId: Option.getOrUndefined(sourceId),
    });
    if (resolved.ok) return resolved.ref;
    return yield* new FactoryMcpFailure({
      code: "not_found",
      message:
        "No single active Work source of the project holds that item. Pass sourceId, or name the item as <sourceId>:<itemId>.",
    });
  });

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
  // Snapshots only, never a log or evidence path, so a read-only client or a plan-mode thread
  // may read any delivery, as `work_read` reads any item.
  factory_status: McpToolAccess.reads(({ delivery, item, sourceId, projectId }) =>
    Effect.gen(function* () {
      const service = yield* FactoryService.FactoryService;
      if (delivery !== undefined && item === undefined) {
        const deliveryId = decodeDeliveryId(delivery);
        const found = Option.isNone(deliveryId)
          ? Option.none()
          : yield* service.get(deliveryId.value).pipe(Effect.mapError(storeUnavailable));
        if (Option.isNone(found)) {
          return yield* new FactoryMcpFailure({
            code: "not_found",
            message: "No Factory delivery has that id.",
          });
        }
        return { delivery: toFactoryDelivery(found.value) };
      }
      if (item !== undefined && delivery === undefined) {
        const ref = yield* resolveItem({
          item,
          ...(sourceId === undefined ? {} : { sourceId }),
          ...(projectId === undefined ? {} : { projectId }),
        });
        const listed = yield* service
          .listByItem(ref)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "FactoryStoreError" ? storeUnavailable() : workUnavailable(),
            ),
          );
        return {
          item: workItemRefString(listed.itemRef),
          deliveries: listed.deliveries.map(toFactoryDelivery),
        };
      }
      return yield* invalidRequest("Pass exactly one of delivery and item.");
    }),
  ),
});
