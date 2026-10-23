import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryPlanTask, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { FactoryStoreError } from "./errors.ts";

/** A task of a delivery: an approved plan task, or the single item the delivery carries. */
export const StoredFactoryTask = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  taskId: FactoryTaskId,
  /** 1-based order within the delivery. */
  position: PositiveInt,
  /** Null for a single item, which is its own task. */
  plan: Schema.NullOr(FactoryPlanTask),
  /** The commit the task's last approval covered. */
  lastReviewedSha: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type StoredFactoryTask = typeof StoredFactoryTask.Type;

/** The row shape; the plan task travels as a JSON column. */
const TaskDbRow = Schema.Struct({
  ...StoredFactoryTask.fields,
  plan: Schema.NullOr(Schema.fromJsonString(FactoryPlanTask)),
});

/** Tasks per delivery, in order. Rows reference their delivery. */
export class FactoryTaskStore extends Context.Service<
  FactoryTaskStore,
  {
    /** Appends the task after the delivery's last one. A task id is unique within its delivery. */
    readonly insert: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly taskId: FactoryTaskId;
      readonly plan?: FactoryPlanTask;
    }) => Effect.Effect<StoredFactoryTask, FactoryStoreError>;
    readonly listByDelivery: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<ReadonlyArray<StoredFactoryTask>, FactoryStoreError>;
    /** None when the task does not exist. */
    readonly setLastReviewedSha: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly taskId: FactoryTaskId;
      readonly sha: string;
    }) => Effect.Effect<Option.Option<StoredFactoryTask>, FactoryStoreError>;
  }
>()("t3/fd/factory/persistence/FactoryTaskStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const selectTasks = SqlSchema.findAll({
    Request: Schema.Struct({
      deliveryId: FactoryDeliveryId,
      taskId: Schema.optional(FactoryTaskId),
    }),
    Result: TaskDbRow,
    execute: ({ deliveryId, taskId }) => sql`
      SELECT
        delivery_id AS "deliveryId",
        task_id AS "taskId",
        position,
        plan_json AS plan,
        last_reviewed_sha AS "lastReviewedSha",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fd_factory_tasks
      WHERE delivery_id = ${deliveryId}
        ${taskId === undefined ? sql`` : sql`AND task_id = ${taskId}`}
      ORDER BY position ASC
    `,
  });

  const selectNextPosition = SqlSchema.findAll({
    Request: FactoryDeliveryId,
    Result: Schema.Struct({ next: PositiveInt }),
    execute: (deliveryId) => sql`
      SELECT COALESCE(MAX(position), 0) + 1 AS next FROM fd_factory_tasks
      WHERE delivery_id = ${deliveryId}
    `,
  });

  const insertTask = SqlSchema.void({
    Request: TaskDbRow,
    execute: (row) => sql`
      INSERT INTO fd_factory_tasks (
        delivery_id, task_id, position, plan_json, last_reviewed_sha, created_at, updated_at
      )
      VALUES (
        ${row.deliveryId}, ${row.taskId}, ${row.position}, ${row.plan}, ${row.lastReviewedSha},
        ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const writeLastReviewedSha = SqlSchema.void({
    Request: Schema.Struct({
      deliveryId: FactoryDeliveryId,
      taskId: FactoryTaskId,
      sha: TrimmedNonEmptyString,
      updatedAt: IsoDateTime,
    }),
    execute: ({ deliveryId, taskId, sha, updatedAt }) => sql`
      UPDATE fd_factory_tasks SET last_reviewed_sha = ${sha}, updated_at = ${updatedAt}
      WHERE delivery_id = ${deliveryId} AND task_id = ${taskId}
    `,
  });

  const insert: FactoryTaskStore["Service"]["insert"] = (input) =>
    Effect.gen(function* () {
      const [next] = yield* selectNextPosition(input.deliveryId);
      const at = yield* now;
      const task: StoredFactoryTask = {
        deliveryId: input.deliveryId,
        taskId: input.taskId,
        position: next?.next ?? 1,
        plan: input.plan ?? null,
        lastReviewedSha: null,
        createdAt: at,
        updatedAt: at,
      };
      yield* insertTask(task);
      return task;
    }).pipe(sql.withTransaction, Effect.catchTags(FactoryStoreError.catchStorage("tasks.insert")));

  const setLastReviewedSha: FactoryTaskStore["Service"]["setLastReviewedSha"] = (input) =>
    Effect.gen(function* () {
      const updatedAt = yield* now;
      yield* writeLastReviewedSha({ ...input, updatedAt });
      const [task] = yield* selectTasks({ deliveryId: input.deliveryId, taskId: input.taskId });
      return Option.fromUndefinedOr(task);
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("tasks.setLastReviewedSha")),
    );

  return FactoryTaskStore.of({
    insert,
    listByDelivery: (deliveryId) =>
      selectTasks({ deliveryId }).pipe(
        Effect.catchTags(FactoryStoreError.catchStorage("tasks.listByDelivery")),
      ),
    setLastReviewedSha,
  });
});

export const layer = Layer.effect(FactoryTaskStore, make);
