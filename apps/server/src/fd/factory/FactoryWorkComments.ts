import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as FactoryWorkCommentStore from "./persistence/FactoryWorkCommentStore.ts";

/**
 * How long one post may take: longer than the 30-second deadline Work's sources give a request,
 * so a source's own timeout is reported first. It bounds how long a stopping server waits.
 */
const POST_DEADLINE = Duration.seconds(60);

/**
 * Posts a delivery transition's recorded comment on its item through Work, so GitHub, Jira and
 * Markdown sources show it. A post that fails is logged; the delivery never depends on it.
 */
export class FactoryWorkComments extends Context.Service<
  FactoryWorkComments,
  {
    /**
     * Claims the comment and, when this call claimed it, posts it; its delivery, status and
     * transition number make its `clientRequestId`. Nothing interrupts it from the claim to the
     * end of the post, so a stopping server finishes a post it began instead of leaving it
     * claimed and unsent. A comment claimed already, in this process or an earlier one, is never
     * posted again; one that could not be claimed stays unattempted, for the next boot.
     */
    readonly post: (input: {
      readonly itemRef: WorkItemRef;
      readonly comment: FactoryWorkCommentStore.StoredFactoryWorkComment;
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
  const store = yield* FactoryWorkCommentStore.FactoryWorkCommentStore;

  const send = (
    itemRef: WorkItemRef,
    { deliveryId, status, transition, body }: FactoryWorkCommentStore.StoredFactoryWorkComment,
  ) =>
    Effect.suspend(() =>
      work.addComment(poster(deliveryId), {
        ref: itemRef,
        body,
        clientRequestId: `factory:${deliveryId}:${status}:${transition}`,
      }),
    ).pipe(
      // The deadline's race runs the post in an interruptible fiber, so it ends the post even
      // inside the uninterruptible claim.
      Effect.timeout(POST_DEADLINE),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not comment on its delivery's item", cause),
      ),
    );

  const post: FactoryWorkComments["Service"]["post"] = ({ itemRef, comment }) =>
    store.claim(comment).pipe(
      Effect.flatMap((claimed) => (claimed ? send(itemRef, comment) : Effect.void)),
      Effect.catchTags({
        FactoryStoreError: (error) =>
          Effect.logWarning("factory could not claim a Work comment", error),
      }),
      Effect.uninterruptible,
      Effect.annotateLogs({ deliveryId: comment.deliveryId, status: comment.status }),
    );

  return FactoryWorkComments.of({ post });
});

export const layer = Layer.effect(FactoryWorkComments, make);
