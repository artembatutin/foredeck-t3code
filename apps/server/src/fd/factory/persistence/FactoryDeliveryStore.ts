import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryPlan,
  FactoryReviewDetails,
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

const StoredLaunch = Schema.Struct({
  id: PositiveInt,
  type: Schema.Literal("launch_thread"),
  role: FactoryRole,
  workspace: StoredWorkspace,
  // Added with resume: only a resume's replay of a launch names a checkpoint.
  resumeCheckpoint: Schema.optionalKey(FactoryStageName),
});

const StoredEffect = Schema.Union([
  StoredLaunch,
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_fix_commit_turn"),
    threadId: ThreadId,
    problems: Problems,
    // Added with resume: only a resume's turn names a checkpoint.
    checkpoint: Schema.optionalKey(FactoryStageName),
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("check_settle"),
    threadId: ThreadId,
    runId: RunId,
    checkpoint: Schema.optionalKey(FactoryStageName),
  }),
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("run_command"), stage: FactoryStageName }),
  // Added with planning.
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("read_fallback_plan"),
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_plan_retry_turn"),
    threadId: ThreadId,
    problems: Problems,
    checkpoint: Schema.optionalKey(FactoryStageName),
  }),
  // Added with the plan gate's replan.
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literal("send_replan_turn"),
    threadId: ThreadId,
    note: Schema.String,
  }),
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
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("open_pr") }),
  // Added with follow-through.
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("close_out") }),
  // Added with plan approval.
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("create_children") }),
  // Added with the per-child phase.
  Schema.Struct({ id: PositiveInt, type: Schema.Literal("start_child"), child: FactoryDeliveryId }),
]);

const StoredCommit = { headSha: Schema.String, tree: Schema.String };

const StoredAwaiting = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effect"), effect: StoredEffect }),
  Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
  // Added with the per-child phase.
  Schema.Struct({ type: Schema.Literal("child"), deliveryId: FactoryDeliveryId }),
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
  Schema.Struct({ reason: Schema.Literal("plan_empty"), note: Schema.NullOr(Schema.String) }),
  Schema.Struct({ reason: Schema.Literal("watch_ended") }),
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
  // Added with review details: reviews accepted before them have none, and none is made up.
  details: Schema.optionalKey(FactoryReviewDetails),
});

const StoredAcceptedPlan = Schema.Struct({
  ...FactoryPlan.fields,
  round: PositiveInt,
  source: Schema.Literals(["mcp", "fallback"]),
  evidencePath: Schema.String,
});

const StoredRoundLimit = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }));

const StoredDeliveryState = Schema.Struct({
  // Added with planning, as were the planner launch, plan round and plan: rows stored before it
  // are single items that never planned. `child` was added with the per-child phase; see
  // `fromRow` for children stored before it.
  kind: Schema.Literals(["single", "parent", "child"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("single" as const)),
  ),
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
  // Added with resume: rows stored before it recorded no launch.
  authorLaunch: Schema.NullOr(StoredLaunch).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  plannerLaunch: Schema.NullOr(StoredLaunch).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
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
  // Added with runtime ceilings: absent from rows stored before them and from deliveries started
  // without one, which launch with the project's default as before.
  runtimeModeCeiling: Schema.optionalKey(RuntimeMode),
  rounds: Schema.Struct({ fix: NonNegativeInt, review: NonNegativeInt }).pipe(
    Schema.withDecodingDefault(Effect.succeed({ fix: 0, review: 0 })),
  ),
  fingerprints: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  reviewResponse: Schema.NullOr(Schema.Struct({ threadId: ThreadId, runId: RunId })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  planRound: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  plan: Schema.NullOr(StoredAcceptedPlan).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Added with plan approval: rows stored before it never had a plan approved.
  planApproved: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  children: Schema.Array(FactoryDeliveryId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // Added with the per-child phase: no child reported an approval before it.
  approvedChildren: Schema.Array(FactoryDeliveryId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  // Added with the PR stage: rows stored before it opened none. Its outcome was added with
  // follow-through: a pull request stored without one is open.
  pullRequest: Schema.NullOr(
    Schema.Struct({
      number: PositiveInt,
      url: Schema.String,
      headBranch: Schema.String,
      outcome: Schema.optionalKey(Schema.Literals(["merged", "closed"])),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Added with follow-through rounds: absent until a PR stage watches the pull request, and from
  // rows whose pull request opened before, whose feedback nothing adopts.
  followThrough: Schema.optionalKey(
    Schema.Struct({
      watchedAfter: NonNegativeInt,
      armedAt: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
      watchStartedAt: Schema.NullOr(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
      heldUntil: Schema.NullOr(NonNegativeInt).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
      runs: Schema.Array(RunId),
      pending: Schema.Array(RunId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
      watchEnded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }),
  ),
  // Set by a cancel while a watch Factory started may be on, until the worker ends it.
  releaseWatch: Schema.optionalKey(Schema.Literal(true)),
  block: Schema.NullOr(StoredBlock),
  // Added with stop after step: rows stored before it name no checkpoint, even when stopped. The
  // stop request is the `stopping` status, which every stored row could already hold. A blocked
  // row may name one too, when a resume blocked it before it moved on.
  checkpoint: Schema.NullOr(FactoryStageName).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
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

// Plan approval stored its children as single items before the child kind existed, and a single
// item ends in its own pull request. A delivery with a parent is always a child.
const fromRow = (row: typeof DeliveryDbRow.Type): StoredFactoryDelivery => ({
  deliveryId: row.deliveryId,
  projectId: row.projectId,
  itemRef: { sourceId: row.sourceId, itemId: row.itemId },
  parentId: row.parentId,
  state:
    row.parentId !== null && row.state.kind === "single"
      ? { ...row.state, kind: "child" }
      : row.state,
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
    /** Every delivery of the item, whatever its status, oldest first. */
    readonly listByItem: (
      itemRef: WorkItemRef,
    ) => Effect.Effect<ReadonlyArray<StoredFactoryDelivery>, FactoryStoreError>;
    /** Every delivery, or one project's or item's, whatever its status, newest first. */
    readonly list: (input: {
      readonly projectId?: ProjectId;
      readonly itemRef?: WorkItemRef;
    }) => Effect.Effect<ReadonlyArray<StoredFactoryDelivery>, FactoryStoreError>;
    /**
     * Deliveries, cancelled ones included, that must still end the pull request watch a Factory
     * command started (`releaseWatch`), oldest first, for the boot sweep.
     */
    readonly listReleasingWatch: () => Effect.Effect<
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
      projectId: Schema.optional(ProjectId),
      itemRef: Schema.optional(WorkItemRef),
      activeOnly: Schema.optional(Schema.Boolean),
      releasingWatch: Schema.optional(Schema.Boolean),
      newestFirst: Schema.optional(Schema.Boolean),
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
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
        ...(request.itemRef === undefined
          ? []
          : [sql`source_id = ${request.itemRef.sourceId} AND item_id = ${request.itemRef.itemId}`]),
        ...(request.activeOnly === true ? [sql`status NOT IN ('done', 'cancelled')`] : []),
        ...(request.releasingWatch === true
          ? [sql`json_extract(state_json, '$.releaseWatch') = 1`]
          : []),
      ])}
      ${
        request.newestFirst === true
          ? sql`ORDER BY created_at DESC, delivery_id DESC`
          : sql`ORDER BY created_at ASC, delivery_id ASC`
      }
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
    listByItem: (itemRef) =>
      selectDeliveries({ itemRef }).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.catchTags(FactoryStoreError.catchStorage("deliveries.listByItem")),
      ),
    list: ({ projectId, itemRef }) =>
      selectDeliveries({
        ...(projectId === undefined ? {} : { projectId }),
        ...(itemRef === undefined ? {} : { itemRef }),
        newestFirst: true,
      }).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.catchTags(FactoryStoreError.catchStorage("deliveries.list")),
      ),
    listReleasingWatch: () =>
      selectDeliveries({ releasingWatch: true }).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.catchTags(FactoryStoreError.catchStorage("deliveries.listReleasingWatch")),
      ),
  });
});

export const layer = Layer.effect(FactoryDeliveryStore, make);
