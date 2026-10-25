import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import type { StoredFactoryWorkComment } from "./persistence/FactoryWorkCommentStore.ts";

/**
 * Posts a delivery transition's recorded comment on its item through Work, so GitHub, Jira and
 * Markdown sources show it. The worker calls it once per comment, after claiming it. A post that
 * fails is logged; the delivery never depends on it.
 */
export class FactoryWorkComments extends Context.Service<
  FactoryWorkComments,
  {
    /** The comment's delivery, status and transition number make its `clientRequestId`. */
    readonly post: (input: {
      readonly itemRef: WorkItemRef;
      readonly comment: StoredFactoryWorkComment;
    }) => Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryWorkComments") {}

/**
 * Factory writes its comments under this actor. It is not an agent's, so Work adds no
 * attribution: the text is Factory's fixed template.
 */
const poster = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "Factory",
});

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;

  const post: FactoryWorkComments["Service"]["post"] = ({ itemRef, comment }) => {
    const { deliveryId, status, transition } = comment;
    return Effect.suspend(() =>
      work.addComment(poster(deliveryId), {
        ref: itemRef,
        body: comment.body,
        clientRequestId: `factory:${deliveryId}:${status}:${transition}`,
      }),
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not comment on its delivery's item", cause),
      ),
      Effect.annotateLogs({ deliveryId, status }),
    );
  };

  return FactoryWorkComments.of({ post });
});

export const layer = Layer.effect(FactoryWorkComments, make);
