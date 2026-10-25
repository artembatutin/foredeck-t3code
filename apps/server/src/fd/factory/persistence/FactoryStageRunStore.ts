import { IsoDateTime, PositiveInt, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryStageName,
  FactoryStageOutcome,
} from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { FactoryStoreError } from "./errors.ts";

/** One attempt of one stage of a delivery. It is active until it has an outcome. */
export const StoredFactoryStageRun = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  stage: FactoryStageName,
  /** 1-based, counted per stage of the delivery. */
  attempt: PositiveInt,
  /** The thread and run doing the attempt's work; null for stages that run no thread. */
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  outcome: Schema.NullOr(FactoryStageOutcome),
  /** The receipt or review evidence under the delivery's evidence folder. */
  evidencePath: Schema.NullOr(Schema.String),
  /** The failure fingerprint, compared with the next attempt's to stop a repeating loop. */
  fingerprint: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type StoredFactoryStageRun = typeof StoredFactoryStageRun.Type;

/**
 * Stage attempts per delivery. Rows are only appended and then finished once; a thread has at
 * most one active attempt, so a terminal run on it names the delivery it belongs to.
 */
export class FactoryStageRunStore extends Context.Service<
  FactoryStageRunStore,
  {
    /** Starts the stage's next attempt. */
    readonly append: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly stage: FactoryStageName;
      readonly threadId?: ThreadId;
      readonly runId?: RunId;
    }) => Effect.Effect<StoredFactoryStageRun, FactoryStoreError>;
    /**
     * Records the thread and run now doing an active attempt's work (an attempt starts before
     * its thread exists); none when no such attempt is active.
     */
    readonly assignRun: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly stage: FactoryStageName;
      readonly attempt: number;
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<Option.Option<StoredFactoryStageRun>, FactoryStoreError>;
    /** Records the outcome of an active attempt; none when no such attempt is active. */
    readonly finish: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly stage: FactoryStageName;
      readonly attempt: number;
      readonly outcome: FactoryStageOutcome;
      readonly evidencePath?: string;
      readonly fingerprint?: string;
    }) => Effect.Effect<Option.Option<StoredFactoryStageRun>, FactoryStoreError>;
    /** The active attempt whose thread this is. */
    readonly findActiveByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<StoredFactoryStageRun>, FactoryStoreError>;
    /** Every attempt of the delivery in the order they started. */
    readonly listByDelivery: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<ReadonlyArray<StoredFactoryStageRun>, FactoryStoreError>;
    /**
     * Every attempt of these deliveries in one read, each delivery's in the order they started;
     * a delivery without attempts has none.
     */
    readonly listByDeliveries: (
      deliveryIds: ReadonlyArray<FactoryDeliveryId>,
    ) => Effect.Effect<
      ReadonlyMap<FactoryDeliveryId, ReadonlyArray<StoredFactoryStageRun>>,
      FactoryStoreError
    >;
  }
>()("t3/fd/factory/persistence/FactoryStageRunStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  // Rows are only appended, so rowid order is the order attempts started.
  const selectRuns = SqlSchema.findAll({
    Request: Schema.Struct({
      deliveryId: Schema.optional(FactoryDeliveryId),
      deliveryIds: Schema.optional(Schema.Array(FactoryDeliveryId)),
      stage: Schema.optional(FactoryStageName),
      attempt: Schema.optional(PositiveInt),
      threadId: Schema.optional(ThreadId),
      activeOnly: Schema.optional(Schema.Boolean),
    }),
    Result: StoredFactoryStageRun,
    execute: (request) => sql`
      SELECT
        delivery_id AS "deliveryId",
        stage,
        attempt,
        thread_id AS "threadId",
        run_id AS "runId",
        outcome,
        evidence_path AS "evidencePath",
        fingerprint,
        started_at AS "startedAt",
        finished_at AS "finishedAt"
      FROM fd_factory_stage_runs
      WHERE ${sql.and([
        ...(request.deliveryId === undefined ? [] : [sql`delivery_id = ${request.deliveryId}`]),
        // One bound parameter however many deliveries, within SQLite's parameter limit.
        ...(request.deliveryIds === undefined
          ? []
          : [
              sql`delivery_id IN (SELECT value FROM json_each(${JSON.stringify(request.deliveryIds)}))`,
            ]),
        ...(request.stage === undefined ? [] : [sql`stage = ${request.stage}`]),
        ...(request.attempt === undefined ? [] : [sql`attempt = ${request.attempt}`]),
        ...(request.threadId === undefined ? [] : [sql`thread_id = ${request.threadId}`]),
        ...(request.activeOnly === true ? [sql`finished_at IS NULL`] : []),
      ])}
      ORDER BY rowid ASC
    `,
  });

  const selectNextAttempt = SqlSchema.findAll({
    Request: Schema.Struct({ deliveryId: FactoryDeliveryId, stage: FactoryStageName }),
    Result: Schema.Struct({ next: PositiveInt }),
    execute: ({ deliveryId, stage }) => sql`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM fd_factory_stage_runs
      WHERE delivery_id = ${deliveryId} AND stage = ${stage}
    `,
  });

  const insertRun = SqlSchema.void({
    Request: StoredFactoryStageRun,
    execute: (row) => sql`
      INSERT INTO fd_factory_stage_runs (
        delivery_id, stage, attempt, thread_id, run_id, outcome, evidence_path, fingerprint,
        started_at, finished_at
      )
      VALUES (
        ${row.deliveryId}, ${row.stage}, ${row.attempt}, ${row.threadId}, ${row.runId},
        ${row.outcome}, ${row.evidencePath}, ${row.fingerprint}, ${row.startedAt},
        ${row.finishedAt}
      )
    `,
  });

  // Both write the attempt read in the same transaction.
  const writeRun = SqlSchema.void({
    Request: StoredFactoryStageRun,
    execute: (row) => sql`
      UPDATE fd_factory_stage_runs SET
        thread_id = ${row.threadId},
        run_id = ${row.runId}
      WHERE delivery_id = ${row.deliveryId} AND stage = ${row.stage} AND attempt = ${row.attempt}
    `,
  });

  const writeOutcome = SqlSchema.void({
    Request: StoredFactoryStageRun,
    execute: (row) => sql`
      UPDATE fd_factory_stage_runs SET
        outcome = ${row.outcome},
        evidence_path = ${row.evidencePath},
        fingerprint = ${row.fingerprint},
        finished_at = ${row.finishedAt}
      WHERE delivery_id = ${row.deliveryId} AND stage = ${row.stage} AND attempt = ${row.attempt}
    `,
  });

  const append: FactoryStageRunStore["Service"]["append"] = (input) =>
    Effect.gen(function* () {
      const [next] = yield* selectNextAttempt({ deliveryId: input.deliveryId, stage: input.stage });
      const run: StoredFactoryStageRun = {
        deliveryId: input.deliveryId,
        stage: input.stage,
        attempt: next?.next ?? 1,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        outcome: null,
        evidencePath: null,
        fingerprint: null,
        startedAt: yield* now,
        finishedAt: null,
      };
      yield* insertRun(run);
      return run;
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.append")),
    );

  const selectActive = (input: {
    readonly deliveryId: FactoryDeliveryId;
    readonly stage: FactoryStageName;
    readonly attempt: number;
  }) =>
    selectRuns({
      deliveryId: input.deliveryId,
      stage: input.stage,
      attempt: input.attempt,
      activeOnly: true,
    }).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  const assignRun: FactoryStageRunStore["Service"]["assignRun"] = (input) =>
    Effect.gen(function* () {
      const active = yield* selectActive(input);
      if (Option.isNone(active)) return active;
      const assigned: StoredFactoryStageRun = {
        ...active.value,
        threadId: input.threadId,
        runId: input.runId,
      };
      yield* writeRun(assigned);
      return Option.some(assigned);
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.assignRun")),
    );

  const finish: FactoryStageRunStore["Service"]["finish"] = (input) =>
    Effect.gen(function* () {
      const active = yield* selectActive(input);
      if (Option.isNone(active)) return active;
      const finished: StoredFactoryStageRun = {
        ...active.value,
        outcome: input.outcome,
        evidencePath: input.evidencePath ?? null,
        fingerprint: input.fingerprint ?? null,
        finishedAt: yield* now,
      };
      yield* writeOutcome(finished);
      return Option.some(finished);
    }).pipe(
      sql.withTransaction,
      Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.finish")),
    );

  return FactoryStageRunStore.of({
    append,
    assignRun,
    finish,
    findActiveByThread: (threadId) =>
      selectRuns({ threadId, activeOnly: true }).pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.findActiveByThread")),
      ),
    listByDelivery: (deliveryId) =>
      selectRuns({ deliveryId }).pipe(
        Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.listByDelivery")),
      ),
    listByDeliveries: (deliveryIds) =>
      (deliveryIds.length === 0 ? Effect.succeed([]) : selectRuns({ deliveryIds })).pipe(
        Effect.map((rows) => {
          const byDelivery = new Map<FactoryDeliveryId, Array<StoredFactoryStageRun>>();
          for (const row of rows) {
            const runs = byDelivery.get(row.deliveryId);
            if (runs === undefined) byDelivery.set(row.deliveryId, [row]);
            else runs.push(row);
          }
          return byDelivery;
        }),
        Effect.catchTags(FactoryStoreError.catchStorage("stageRuns.listByDeliveries")),
      ),
  });
});

export const layer = Layer.effect(FactoryStageRunStore, make);
