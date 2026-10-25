import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import type { FactoryTransitionComment } from "./pipeline/comments.ts";

/**
 * Posts a delivery transition's comment on its item through Work, so GitHub, Jira and Markdown
 * sources show it. The worker calls it once per stored transition, never from a status it reads
 * back. A post that fails is logged; the delivery never depends on it.
 */
export class FactoryWorkComments extends Context.Service<
  FactoryWorkComments,
  {
    readonly post: (input: {
      readonly delivery: StoredFactoryDelivery;
      readonly comment: FactoryTransitionComment;
      /**
       * Tells the transition apart from the delivery's other transitions into the same status;
       * with the delivery and status, it is the post's `clientRequestId`.
       */
      readonly transition: number;
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

  const post: FactoryWorkComments["Service"]["post"] = ({ delivery, comment, transition }) => {
    const { deliveryId } = delivery;
    return Effect.suspend(() =>
      work.addComment(poster(deliveryId), {
        ref: delivery.itemRef,
        body: comment.body,
        clientRequestId: `factory:${deliveryId}:${comment.status}:${transition}`,
      }),
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not comment on its delivery's item", cause),
      ),
      Effect.annotateLogs({ deliveryId, status: comment.status }),
    );
  };

  return FactoryWorkComments.of({ post });
});

export const layer = Layer.effect(FactoryWorkComments, make);
