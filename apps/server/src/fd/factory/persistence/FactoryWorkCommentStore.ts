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

/** A transition's Work comment, recorded with the transition. */
export const StoredFactoryWorkComment = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  /** 1-based, counted per delivery: which of its announced transitions this is. */
  transition: PositiveInt,
  status: Schema.Literals(COMMENTED_STATUSES),
  body: Schema.String,
  createdAt: IsoDateTime,
  /** When a process claimed it to post it; null until then. */
  attemptedAt: Schema.NullOr(IsoDateTime),
  /** When its post returned, or its item showed it posted; null until then. */
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type StoredFactoryWorkComment = typeof StoredFactoryWorkComment.Type;

/**
 * What a claim found: the comment is this caller's to post, a process claimed it and never
 * finished (it died mid-post, so the post may or may not have reached the item), or it is done.
 */
export type FactoryWorkCommentClaim = "claimed" | "unfinished" | "finished";

/**
 * The Work comments of deliveries' transitions. A comment is recorded in the transaction that
 * stores its transition, so a process that stops before posting it leaves it for the next one,
 * claimed before it is posted, so it is posted once however often it is queued, and finished when
 * its post returns.
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
     * Marks the comment attempted. `claimed` only for the one call that marked it; any later
     * call, in this process or another, finds it unfinished or finished.
     */
    readonly claim: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly transition: number;
    }) => Effect.Effect<FactoryWorkCommentClaim, FactoryStoreError>;
    /** Marks the comment finished. */
    readonly finish: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly transition: number;
    }) => Effect.Effect<void, FactoryStoreError>;
    /** Every comment not finished, attempted or not, oldest first. */
    readonly listUnfinished: () => Effect.Effect<
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
        delivery_id, transition, status, body, created_at, attempted_at, finished_at
      )
      VALUES (
        ${row.deliveryId}, ${row.transition}, ${row.status}, ${row.body}, ${row.createdAt},
        ${row.attemptedAt}, ${row.finishedAt}
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

  const selectFinished = SqlSchema.findAll({
    Request: Schema.Struct({ deliveryId: FactoryDeliveryId, transition: PositiveInt }),
    Result: Schema.Struct({ finishedAt: Schema.NullOr(IsoDateTime) }),
    execute: (request) => sql`
      SELECT finished_at AS "finishedAt" FROM fd_factory_work_comments
      WHERE delivery_id = ${request.deliveryId} AND transition = ${request.transition}
    `,
  });

  const markFinished = SqlSchema.void({
    Request: Schema.Struct({
      deliveryId: FactoryDeliveryId,
      transition: PositiveInt,
      finishedAt: IsoDateTime,
    }),
    execute: (request) => sql`
      UPDATE fd_factory_work_comments SET finished_at = ${request.finishedAt}
      WHERE delivery_id = ${request.deliveryId}
        AND transition = ${request.transition}
        AND finished_at IS NULL
    `,
  });

  // Rows are only appended, so rowid order is the order they were recorded.
  const selectUnfinished = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StoredFactoryWorkComment,
    execute: () => sql`
      SELECT
        delivery_id AS "deliveryId",
        transition,
        status,
        body,
        created_at AS "createdAt",
        attempted_at AS "attemptedAt",
        finished_at AS "finishedAt"
      FROM fd_factory_work_comments
      WHERE finished_at IS NULL
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
        finishedAt: null,
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
      if (marked.length > 0) return "claimed" as const;
      // Rows are never deleted, so the comment is stored; one claimed already has run or runs.
      const [row] = yield* selectFinished({ deliveryId, transition });
      return row?.finishedAt === null ? ("unfinished" as const) : ("finished" as const);
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("workComments.claim")),
    );

  const finish: FactoryWorkCommentStore["Service"]["finish"] = ({ deliveryId, transition }) =>
    Effect.gen(function* () {
      yield* markFinished({ deliveryId, transition, finishedAt: yield* now });
    }).pipe(Effect.catchTags(FactoryStoreError.catchStorage("workComments.finish")));

  return FactoryWorkCommentStore.of({
    record,
    claim,
    finish,
    listUnfinished: () =>
      selectUnfinished(undefined).pipe(
        Effect.catchTags(FactoryStoreError.catchStorage("workComments.listUnfinished")),
      ),
  });
});

export const layer = Layer.effect(FactoryWorkCommentStore, make);
