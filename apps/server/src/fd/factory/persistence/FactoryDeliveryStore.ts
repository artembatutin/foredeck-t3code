import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryReviewSummary,
  FactoryRole,
  FactoryStageName,
  FactoryTaskRisk,
  FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkItemRef, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { defaultRoundLimits, type FactoryDeliveryState } from "../pipeline/state.ts";
import { FactoryStoreError } from "./errors.ts";

/** The Work item already has a delivery that is not done or cancelled. */
export class FactoryDeliveryActive extends Schema.TaggedError<FactoryDeliveryActive>()(
  "FactoryDeliveryActive",
  { itemRef: WorkItemRef, deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Work item ${this.itemRef.itemId} already has an active Factory delivery (${this.deliveryId}).`;
  }
}

// The engine's state as stored. `fromRow` and `toRow` type it as `FactoryDeliveryState` both ways,
// so a field or variant changed on one side alone stops compiling. An optional field added to the
// engine's state still has to be added here by hand. A field added after rows were stored decodes
// with a default, so those rows keep loading.
const Problems = Schema.Array(Schema.String);
const ReceiptRefusals = Schema.Array(Schema.Literals(["head_changed", "tree_dirty"]));

const StoredWorkspace = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: Schema.String,
    baseRef: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("existing_worktree"), worktreePath: Schema.String }),
]);

const StoredEffect = Schema.Union([
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("launch_thread"),
    role: FactoryRole,
    workspace: StoredWorkspace,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_fix_commit_turn"),
    threadId: ThreadId,
    problems: Problems,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("check_settle"),
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("run_command"), stage: FactoryStageName }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("read_fallback_review"),
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_review_retry_turn"),
    threadId: ThreadId,
    problems: Problems,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_repair_turn"),
    kind: Schema.Literals(["fix-verify", "fix-review"]),
    threadId: ThreadId,
    round: PositiveInt,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_review_follow_up_turn"),
    threadId: ThreadId,
    round: PositiveInt,
  }),
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("record_approval") }),
]);

const StoredCommit = { headSha: Schema.String, tree: Schema.String };

const StoredAwaiting = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effect"), effect: StoredEffect }),
  Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
]);

const StoredBlock = Schema.Union([
  Schema.Struct({
    reason: Schema.Literal("run_ended"),
    threadId: ThreadId,
    runId: RunId,
    runStatus: Schema.Literals(["failed", "cancelled", "interrupted", "rolled_back"]),
  }),
  Schema.Struct({ reason: Schema.Literal("thread_deleted"), threadId: ThreadId }),
  Schema.Struct({
    reason: Schema.Literal("effect_failed"),
    effect: StoredEffect,
    detail: Schema.String,
  }),
  Schema.Struct({ reason: Schema.Literal("unsettled"), problems: Problems }),
  Schema.Struct({ reason: Schema.Literal("verify_failed") }),
  Schema.Struct({
    reason: Schema.Literal("repeated_failure"),
    stage: Schema.Literals(["verify", "review"]),
  }),
  Schema.Struct({ reason: Schema.Literal("receipt_refused"), refusals: ReceiptRefusals }),
  Schema.Struct({ reason: Schema.Literal("unsupported_stage"), stage: FactoryStageName }),
  Schema.Struct({
    reason: Schema.Literal("review_changes_required"),
    summary: FactoryReviewSummary,
  }),
  Schema.Struct({ reason: Schema.Literal("code_changed"), changes: ReceiptRefusals }),
  Schema.Struct({ reason: Schema.Literal("invalid_submission"), problems: Problems }),
  Schema.Struct({
    reason: Schema.Literal("record_mismatch"),
    expected: Schema.Struct(StoredCommit),
    actual: Schema.Struct({ ...StoredCommit, clean: Schema.Boolean }),
    differences: Schema.Array(
      Schema.Literals(["head_changed", "tree_changed", "not_reviewed", "tree_dirty"]),
    ),
  }),
]);

const StoredAcceptedReview = Schema.Struct({
  round: PositiveInt,
  source: Schema.Literals(["mcp", "fallback"]),
  summary: FactoryReviewSummary,
  evidencePath: Schema.String,
  fingerprint: Schema.optionalKey(Schema.String),
});

const StoredRoundLimit = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }));

const StoredDeliveryState = Schema.Struct({
  status: FactoryDeliveryStatus,
  stage: Schema.NullOr(FactoryStageName),
  branch: Schema.String,
  baseRef: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  baseline: Schema.NullOr(Schema.String),
  threads: Schema.Struct({
    planner: Schema.optionalKey(ThreadId),
    author: Schema.optionalKey(ThreadId),
    reviewer: Schema.optionalKey(ThreadId),
  }),
  awaiting: Schema.NullOr(StoredAwaiting),
  fixCommitTurns: NonNegativeInt,
  effectsIssued: NonNegativeInt,
  receipts: Schema.Array(FactoryVerifyReceipt),
  // Added with review: rows stored before it have none.
  reviewRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  invalidSubmissions: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  reviews: Schema.Array(StoredAcceptedReview).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // Added with repair rounds: rows stored before them have spent none, under the default limits.
  limits: Schema.Struct({
    maxFixRounds: StoredRoundLimit,
    maxReviewRounds: StoredRoundLimit,
  }).pipe(Schema.withDecodingDefault(Effect.succeed(defaultRoundLimits))),
  risk: FactoryTaskRisk.pipe(Schema.withDecodingDefault(Effect.succeed("normal" as const))),
  rounds: Schema.Struct({ fix: NonNegativeInt, review: NonNegativeInt }).pipe(
    Schema.withDecodingDefault(Effect.succeed({ fix: 0, review: 0 })),
  ),
  fingerprints: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  reviewResponse: Schema.NullOr(Schema.Struct({ threadId: ThreadId, runId: RunId })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  block: Schema.NullOr(StoredBlock),
});

/** A delivery: its identity beside the engine's state. */
export interface StoredFactoryDelivery {
  readonly deliveryId: FactoryDeliveryId;
  readonly projectId: ProjectId;
  readonly itemRef: WorkItemRef;
  /** Set on a planned child. */
  readonly parentId: FactoryDeliveryId | null;
  readonly state: FactoryDeliveryState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The row shape; the state travels as a JSON column. */
const DeliveryDbRow = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  projectId: ProjectId,
  sourceId: WorkSourceId,
  itemId: WorkItemId,
  parentId: Schema.NullOr(FactoryDeliveryId),
  state: Schema.fromJsonString(StoredDeliveryState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

/** Written beside the state, so the active-item index can see it. */
const DeliveryWriteRow = Schema.Struct({ ...DeliveryDbRow.fields, status: FactoryDeliveryStatus });

const fromRow = (row: typeof DeliveryDbRow.Type): StoredFactoryDelivery => ({
  deliveryId: row.deliveryId,
  projectId: row.projectId,
  itemRef: { sourceId: row.sourceId, itemId: row.itemId },
  parentId: row.parentId,
  state: row.state,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRow = (delivery: StoredFactoryDelivery): typeof DeliveryWriteRow.Type => ({
  deliveryId: delivery.deliveryId,
  projectId: delivery.projectId,
  sourceId: delivery.itemRef.sourceId,
  itemId: delivery.itemRef.itemId,
  parentId: delivery.parentId,
  status: delivery.state.status,
  state: delivery.state,
  createdAt: delivery.createdAt,
  updatedAt: delivery.updatedAt,
});

/** The statuses a delivery never leaves; the migration's active-item index lists the same. */
const isTerminal = (status: FactoryDeliveryStatus) => status === "done" || status === "cancelled";

/**
 * Factory deliveries and their engine state. A Work item has at most one delivery that is not
 * done or cancelled. Callers pass item ids in Work's canonical spelling, or one item could hold
 * two active deliveries under two spellings.
 */
export class FactoryDeliveryStore extends Context.Service<
  FactoryDeliveryStore,
  {
    readonly insert: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly projectId: ProjectId;
      readonly itemRef: WorkItemRef;
      readonly parentId?: FactoryDeliveryId;
      readonly state: FactoryDeliveryState;
    }) => Effect.Effect<StoredFactoryDelivery, FactoryStoreError | FactoryDeliveryActive>;
    readonly get: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<Option.Option<StoredFactoryDelivery>, FactoryStoreError>;
    /** Replaces the delivery's engine state; none when the delivery does not exist. */
    readonly update: (
      deliveryId: FactoryDeliveryId,
      state: FactoryDeliveryState,
    ) => Effect.Effect<Option.Option<StoredFactoryDelivery>, FactoryStoreError>;
    /** Deliveries that are not done or cancelled, oldest first, for the boot reconcile. */
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<StoredFactoryDelivery>,
      FactoryStoreError
    >;
  }
>()("t3/fd/factory/persistence/FactoryDeliveryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const selectDeliveries = SqlSchema.findAll({
    Request: Schema.Struct({
      deliveryId: Schema.optional(FactoryDeliveryId),
      itemRef: Schema.optional(WorkItemRef),
      activeOnly: Schema.optional(Schema.Boolean),
    }),
    Result: DeliveryDbRow,
    // The status literals match the active-item index's, so SQLite can use it.
    execute: (request) => sql`
      SELECT
        delivery_id AS "deliveryId",
        project_id AS "projectId",
        source_id AS "sourceId",
        item_id AS "itemId",
        parent_id AS "parentId",
        state_json AS state,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fd_factory_deliveries
      WHERE ${sql.and([
        ...(request.deliveryId === undefined ? [] : [sql`delivery_id = ${request.deliveryId}`]),
        ...(request.itemRef === undefined
          ? []
          : [sql`source_id = ${request.itemRef.sourceId} AND item_id = ${request.itemRef.itemId}`]),
        ...(request.activeOnly === true ? [sql`status NOT IN ('done', 'cancelled')`] : []),
      ])}
      ORDER BY created_at ASC, delivery_id ASC
    `,
  });

  const insertDelivery = SqlSchema.void({
    Request: DeliveryWriteRow,
    execute: (row) => sql`
      INSERT INTO fd_factory_deliveries (
        delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
        created_at, updated_at
      )
      VALUES (
        ${row.deliveryId}, ${row.projectId}, ${row.sourceId}, ${row.itemId}, ${row.parentId},
        ${row.status}, ${row.state}, ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const writeState = SqlSchema.void({
    Request: DeliveryWriteRow,
    execute: (row) => sql`
      UPDATE fd_factory_deliveries SET
        status = ${row.status},
        state_json = ${row.state},
        updated_at = ${row.updatedAt}
      WHERE delivery_id = ${row.deliveryId}
    `,
  });

  const readDelivery = (deliveryId: FactoryDeliveryId) =>
    selectDeliveries({ deliveryId }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), fromRow)),
    );

  const insert: FactoryDeliveryStore["Service"]["insert"] = (input) =>
    Effect.gen(function* () {
      if (!isTerminal(input.state.status)) {
        const [active] = yield* selectDeliveries({ itemRef: input.itemRef, activeOnly: true });
        if (active !== undefined) {
          return yield* new FactoryDeliveryActive({
            itemRef: input.itemRef,
            deliveryId: active.deliveryId,
          });
        }
      }
      const at = yield* now;
      const created: StoredFactoryDelivery = {
        deliveryId: input.deliveryId,
        projectId: input.projectId,
        itemRef: input.itemRef,
        parentId: input.parentId ?? null,
        state: input.state,
        createdAt: at,
        updatedAt: at,
      };
      yield* insertDelivery(toRow(created));
      return created;
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("deliveries.insert")),
    );

  const update: FactoryDeliveryStore["Service"]["update"] = (deliveryId, state) =>
    Effect.gen(function* () {
      const current = yield* readDelivery(deliveryId);
      if (Option.isNone(current)) return current;
      const updated: StoredFactoryDelivery = { ...current.value, state, updatedAt: yield* now };
      yield* writeState(toRow(updated));
      return Option.some(updated);
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("deliveries.update")),
    );

  return FactoryDeliveryStore.of({
    insert,
    get: (deliveryId) =>
      readDelivery(deliveryId).pipe(
        Effect.catchTags(FactoryStoreError.catchStorage("deliveries.get")),
      ),
    update,
    listActive: () =>
      selectDeliveries({ activeOnly: true }).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.catchTags(FactoryStoreError.catchStorage("deliveries.listActive")),
      ),
  });
});

export const layer = Layer.effect(FactoryDeliveryStore, make);
