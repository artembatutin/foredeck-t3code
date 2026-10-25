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
 * How long one post or item read may take: longer than the 30-second deadline Work's sources give
 * a request, so a source's own timeout is reported first. It bounds how long a stopping server
 * waits.
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
     * Claims the comment and posts it when this call claimed it; its delivery, status and
     * transition number make its `clientRequestId`, and its posted text ends with its reference.
     * A comment another process claimed and never finished (it died mid-post) is looked for on
     * the item by that reference instead: finished when the item shows it, posted when the item
     * shows it missing, and kept unfinished, for the next boot to look again, when the read cannot
     * tell. Nothing interrupts it from the claim to the finish, so a stopping server finishes a
     * post it began. A finished comment is never posted again.
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

/**
 * The sentence that ends a posted comment and tells it apart from every other Factory comment on
 * the item, including an identical one of an earlier transition: a later process finds it there.
 * It holds only the delivery's id, a UUID, and a number, so it names no tool and mentions no one.
 */
const reference = ({ deliveryId, transition }: FactoryWorkCommentStore.StoredFactoryWorkComment) =>
  `Factory delivery ${deliveryId}, update ${transition}.`;

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const store = yield* FactoryWorkCommentStore.FactoryWorkCommentStore;

  const send = (itemRef: WorkItemRef, comment: FactoryWorkCommentStore.StoredFactoryWorkComment) =>
    Effect.suspend(() =>
      work.addComment(poster(comment.deliveryId), {
        ref: itemRef,
        body: `${comment.body} ${reference(comment)}`,
        clientRequestId: `factory:${comment.deliveryId}:${comment.status}:${comment.transition}`,
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

  /**
   * Whether the item holds the comment of a process that died mid-post: `unknown` when it does not
   * show it but Work bounded its comments, so the comment may be among those left out.
   */
  const lookUp = (
    itemRef: WorkItemRef,
    comment: FactoryWorkCommentStore.StoredFactoryWorkComment,
  ) =>
    Effect.suspend(() => work.getItem(poster(comment.deliveryId), { ref: itemRef })).pipe(
      Effect.timeout(POST_DEADLINE),
      Effect.map((item) => {
        const marker = reference(comment);
        if (item.comments.some(({ body }) => body.includes(marker))) return "posted" as const;
        return item.commentsTruncated ? ("unknown" as const) : ("missing" as const);
      }),
    );

  /**
   * Finishes the unfinished comment if its item shows it, and posts it if its item shows it
   * missing. A read that fails or cannot tell leaves it unfinished: neither posted on a guess,
   * which could post it twice, nor dropped.
   */
  const reconcile = (
    itemRef: WorkItemRef,
    comment: FactoryWorkCommentStore.StoredFactoryWorkComment,
  ) =>
    lookUp(itemRef, comment).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              "factory could not read its delivery's item to finish a comment",
              cause,
            ).pipe(Effect.as("unread" as const)),
      ),
      Effect.flatMap((found) => {
        switch (found) {
          case "posted":
            return store.finish(comment);
          case "missing":
            return send(itemRef, comment).pipe(Effect.andThen(store.finish(comment)));
          case "unknown":
            return Effect.logWarning(
              "factory cannot tell whether an unfinished Work comment reached its item; it stays unfinished",
            );
          case "unread":
            return Effect.void;
        }
      }),
    );

  const post: FactoryWorkComments["Service"]["post"] = ({ itemRef, comment }) =>
    store.claim(comment).pipe(
      Effect.flatMap((claim) => {
        switch (claim) {
          case "claimed":
            return send(itemRef, comment).pipe(Effect.andThen(store.finish(comment)));
          case "unfinished":
            return reconcile(itemRef, comment);
          case "finished":
            return Effect.void;
        }
      }),
      Effect.catchTags({
        FactoryStoreError: (error) =>
          Effect.logWarning("factory could not record a Work comment's progress", error),
      }),
      Effect.uninterruptible,
      Effect.annotateLogs({
        deliveryId: comment.deliveryId,
        status: comment.status,
        transition: comment.transition,
      }),
    );

  return FactoryWorkComments.of({ post });
});

export const layer = Layer.effect(FactoryWorkComments, make);
