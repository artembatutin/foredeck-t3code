import { IsoDateTime, PositiveInt } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import type { FactoryCommentedStatus, FactoryTransitionComment } from "../pipeline/comments.ts";
import { FactoryStoreError } from "./errors.ts";

const COMMENTED_STATUSES = [
  "blocked",
  "waiting",
  "approved",
  "pr_open",
] as const satisfies ReadonlyArray<FactoryCommentedStatus>;

/** A transition's Work comment, recorded with the transition and attempted at most once. */
export const StoredFactoryWorkComment = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  /** 1-based, counted per delivery: which of its announced transitions this is. */
  transition: PositiveInt,
  status: Schema.Literals(COMMENTED_STATUSES),
  body: Schema.String,
  createdAt: IsoDateTime,
  /** When a process began posting it; null until then. */
  attemptedAt: Schema.NullOr(IsoDateTime),
});
export type StoredFactoryWorkComment = typeof StoredFactoryWorkComment.Type;

/**
 * The Work comments of deliveries' transitions. A comment is recorded in the transaction that
 * stores its transition, so a process that stops before posting it leaves it for the next one,
 * and claimed before it is posted, so no process posts it a second time.
 */
export class FactoryWorkCommentStore extends Context.Service<
  FactoryWorkCommentStore,
  {
    /** Records the comment as the delivery's next announced transition. */
    readonly record: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly comment: FactoryTransitionComment;
    }) => Effect.Effect<StoredFactoryWorkComment, FactoryStoreError>;
    /**
     * Marks the comment attempted. True only for the one call that marked it; any later call, in
     * this process or another, finds it attempted already.
     */
    readonly claim: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly transition: number;
    }) => Effect.Effect<boolean, FactoryStoreError>;
    /** Every comment no process has begun posting, oldest first. */
    readonly listUnattempted: () => Effect.Effect<
      ReadonlyArray<StoredFactoryWorkComment>,
      FactoryStoreError
    >;
  }
>()("t3/fd/factory/persistence/FactoryWorkCommentStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const selectNextTransition = SqlSchema.findAll({
    Request: Schema.Struct({ deliveryId: FactoryDeliveryId }),
    Result: Schema.Struct({ next: PositiveInt }),
    execute: ({ deliveryId }) => sql`
      SELECT COALESCE(MAX(transition), 0) + 1 AS next FROM fd_factory_work_comments
      WHERE delivery_id = ${deliveryId}
    `,
  });

  const insertComment = SqlSchema.void({
    Request: StoredFactoryWorkComment,
    execute: (row) => sql`
      INSERT INTO fd_factory_work_comments (
        delivery_id, transition, status, body, created_at, attempted_at
      )
      VALUES (
        ${row.deliveryId}, ${row.transition}, ${row.status}, ${row.body}, ${row.createdAt},
        ${row.attemptedAt}
      )
    `,
  });

  const markAttempted = SqlSchema.findAll({
    Request: Schema.Struct({
      deliveryId: FactoryDeliveryId,
      transition: PositiveInt,
      attemptedAt: IsoDateTime,
    }),
    Result: Schema.Struct({ transition: PositiveInt }),
    execute: (request) => sql`
      UPDATE fd_factory_work_comments SET attempted_at = ${request.attemptedAt}
      WHERE delivery_id = ${request.deliveryId}
        AND transition = ${request.transition}
        AND attempted_at IS NULL
      RETURNING transition
    `,
  });

  // Rows are only appended, so rowid order is the order they were recorded.
  const selectUnattempted = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StoredFactoryWorkComment,
    execute: () => sql`
      SELECT
        delivery_id AS "deliveryId",
        transition,
        status,
        body,
        created_at AS "createdAt",
        attempted_at AS "attemptedAt"
      FROM fd_factory_work_comments
      WHERE attempted_at IS NULL
      ORDER BY rowid ASC
    `,
  });

  const record: FactoryWorkCommentStore["Service"]["record"] = ({ deliveryId, comment }) =>
    Effect.gen(function* () {
      const [next] = yield* selectNextTransition({ deliveryId });
      const row: StoredFactoryWorkComment = {
        deliveryId,
        transition: next?.next ?? 1,
        status: comment.status,
        body: comment.body,
        createdAt: yield* now,
        attemptedAt: null,
      };
      yield* insertComment(row);
      return row;
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("workComments.record")),
    );

  const claim: FactoryWorkCommentStore["Service"]["claim"] = ({ deliveryId, transition }) =>
    Effect.gen(function* () {
      const marked = yield* markAttempted({
        deliveryId,
        transition,
        attemptedAt: yield* now,
      });
      return marked.length > 0;
    }).pipe(Effect.catchTags(FactoryStoreError.catchStorage("workComments.claim")));

  return FactoryWorkCommentStore.of({
    record,
    claim,
    listUnattempted: () =>
      selectUnattempted(undefined).pipe(
        Effect.catchTags(FactoryStoreError.catchStorage("workComments.listUnattempted")),
      ),
  });
});

export const layer = Layer.effect(FactoryWorkCommentStore, make);
