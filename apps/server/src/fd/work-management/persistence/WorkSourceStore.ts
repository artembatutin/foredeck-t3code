import { IsoDateTime, NonNegativeInt, ProjectId } from "@t3tools/contracts";
import {
  WorkSourceConfig,
  WorkSourceId,
  WorkSourceKind,
  WorkSourceState,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { WorkConflict, WorkSourceNotFound, WorkSourceStale } from "../errors.ts";

/** A configured source as stored. The token behind `secretName` lives in the secret store. */
export const StoredWorkSource = Schema.Struct({
  sourceId: WorkSourceId,
  projectId: ProjectId,
  kind: WorkSourceKind,
  /** `<directory>`, `host/owner/name` or `host/PROJECTKEY`: unique among a project's live sources. */
  identity: Schema.String,
  label: Schema.String,
  config: WorkSourceConfig,
  secretName: Schema.NullOr(Schema.String),
  state: WorkSourceState,
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  disconnectedAt: Schema.NullOr(IsoDateTime),
});
export type StoredWorkSource = typeof StoredWorkSource.Type;

/** Shared by every Work store: any SQL or row-decoding failure, with the operation that hit it. */
export class WorkStoreError extends Schema.TaggedError<WorkStoreError>()("WorkStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Work storage operation '${this.operation}' failed.`;
  }
}

/** The row shape; `config` travels as a JSON column. */
const SourceDbRow = Schema.Struct({
  ...StoredWorkSource.fields,
  config: Schema.fromJsonString(WorkSourceConfig),
});

interface SourceKey {
  readonly projectId: ProjectId;
  readonly kind: WorkSourceKind;
  readonly identity: string;
}

/**
 * Configured Work sources per project. A disconnected source keeps its row and id, so its
 * thread links survive and a later setup of the same identity revives it instead of
 * creating a second source. Every write is one short immediate transaction; version checks
 * compare-and-swap on the version the caller last read.
 */
export class WorkSourceStore extends Context.Service<
  WorkSourceStore,
  {
    /** Active sources only unless `includeDisconnected`; in creation order. */
    readonly list: (options?: {
      readonly projectId?: ProjectId;
      readonly includeDisconnected?: boolean;
    }) => Effect.Effect<ReadonlyArray<StoredWorkSource>, WorkStoreError>;
    readonly get: (
      sourceId: WorkSourceId,
    ) => Effect.Effect<Option.Option<StoredWorkSource>, WorkStoreError>;
    /**
     * Create a source, or revive the disconnected one with the same `(project, kind,
     * identity)`. A revived source keeps its own id (`input.sourceId` is ignored) and takes
     * the new label, config and secret. A live source with that identity is a conflict.
     */
    readonly insertOrRevive: (input: {
      readonly sourceId: WorkSourceId;
      readonly projectId: ProjectId;
      readonly kind: WorkSourceKind;
      readonly identity: string;
      readonly label: string;
      readonly config: WorkSourceConfig;
      readonly secretName: string | null;
    }) => Effect.Effect<StoredWorkSource, WorkStoreError | WorkConflict>;
    /**
     * Replace the given fields. A new identity must not collide with another live source, and a
     * source keeps its kind: its adapter, identity rules and credential all hang off it.
     */
    readonly update: (input: {
      readonly sourceId: WorkSourceId;
      readonly expectedVersion?: number;
      readonly label?: string;
      readonly config?: WorkSourceConfig;
      readonly identity?: string;
      readonly secretName?: string | null;
    }) => Effect.Effect<
      StoredWorkSource,
      WorkStoreError | WorkSourceNotFound | WorkSourceStale | WorkConflict
    >;
    /** Tombstone the source. An already disconnected source is returned unchanged. */
    readonly disconnect: (
      sourceId: WorkSourceId,
      expectedVersion?: number,
    ) => Effect.Effect<StoredWorkSource, WorkStoreError | WorkSourceNotFound | WorkSourceStale>;
    /** Reactivate a tombstone, unless another source went live with its identity meanwhile. */
    readonly restore: (
      sourceId: WorkSourceId,
      expectedVersion?: number,
    ) => Effect.Effect<
      StoredWorkSource,
      WorkStoreError | WorkSourceNotFound | WorkSourceStale | WorkConflict
    >;
    /** How many active sources still use a stored token, before it is cleared. */
    readonly countActiveBySecret: (secretName: string) => Effect.Effect<number, WorkStoreError>;
    /** Distinct projects with at least one active source. */
    readonly listProjectIds: () => Effect.Effect<ReadonlyArray<ProjectId>, WorkStoreError>;
  }
>()("t3/fd/work-management/persistence/WorkSourceStore") {}

const conflictDetail = (identity: string) => `A source for ${identity} already exists.`;

// The partial unique index on live identities names its columns in the violation.
const isLiveIdentityViolation = (error: SqlError.SqlError) =>
  error.reason._tag === "UniqueViolation" &&
  error.reason.constraint.includes("fd_work_sources.identity");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  // `Effect.catchTags` handlers wrapping lower-level failures; domain errors pass through.
  const storageFailure = (operation: string) => ({
    SqlError: (cause: SqlError.SqlError) => Effect.fail(new WorkStoreError({ operation, cause })),
    SchemaError: (cause: Schema.SchemaError) =>
      Effect.fail(new WorkStoreError({ operation, cause })),
  });

  const selectSources = SqlSchema.findAll({
    Request: Schema.Struct({
      sourceId: Schema.optional(WorkSourceId),
      projectId: Schema.optional(ProjectId),
      kind: Schema.optional(WorkSourceKind),
      identity: Schema.optional(Schema.String),
      states: Schema.optional(Schema.Array(WorkSourceState)),
    }),
    Result: SourceDbRow,
    execute: (request) => sql`
      SELECT
        source_id AS "sourceId",
        project_id AS "projectId",
        kind,
        identity,
        label,
        config_json AS config,
        secret_name AS "secretName",
        state,
        version,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        disconnected_at AS "disconnectedAt"
      FROM fd_work_sources
      WHERE ${sql.and([
        ...(request.sourceId === undefined ? [] : [sql`source_id = ${request.sourceId}`]),
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
        ...(request.kind === undefined ? [] : [sql`kind = ${request.kind}`]),
        ...(request.identity === undefined ? [] : [sql`identity = ${request.identity}`]),
        ...(request.states === undefined ? [] : [sql.in("state", request.states)]),
      ])}
      ORDER BY created_at ASC, source_id ASC
    `,
  });

  const insertSource = SqlSchema.void({
    Request: SourceDbRow,
    execute: (row) => sql`
      INSERT INTO fd_work_sources (
        source_id, project_id, kind, identity, label, config_json, secret_name, state,
        version, created_at, updated_at, disconnected_at
      )
      VALUES (
        ${row.sourceId}, ${row.projectId}, ${row.kind}, ${row.identity}, ${row.label},
        ${row.config}, ${row.secretName}, ${row.state}, ${row.version}, ${row.createdAt},
        ${row.updatedAt}, ${row.disconnectedAt}
      )
    `,
  });

  // Writes every mutable column of a row read in the same transaction.
  const writeSource = SqlSchema.void({
    Request: SourceDbRow,
    execute: (row) => sql`
      UPDATE fd_work_sources SET
        identity = ${row.identity},
        label = ${row.label},
        config_json = ${row.config},
        secret_name = ${row.secretName},
        state = ${row.state},
        version = ${row.version},
        updated_at = ${row.updatedAt},
        disconnected_at = ${row.disconnectedAt}
      WHERE source_id = ${row.sourceId}
    `,
  });

  const selectSecretCount = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (secretName) => sql`
      SELECT COUNT(*) AS count FROM fd_work_sources
      WHERE state = 'active' AND secret_name = ${secretName}
    `,
  });

  const selectProjectIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ projectId: ProjectId }),
    execute: () => sql`
      SELECT DISTINCT project_id AS "projectId" FROM fd_work_sources
      WHERE state = 'active'
      ORDER BY project_id ASC
    `,
  });

  const readSource = (sourceId: WorkSourceId) =>
    selectSources({ sourceId }).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  const requireSource = Effect.fn(function* (sourceId: WorkSourceId) {
    const current = yield* readSource(sourceId);
    if (Option.isNone(current)) return yield* new WorkSourceNotFound({ sourceId });
    return current.value;
  });

  const requireVersion = (current: StoredWorkSource, expectedVersion: number | undefined) =>
    expectedVersion === undefined || current.version === expectedVersion
      ? Effect.void
      : Effect.fail(new WorkSourceStale({ sourceId: current.sourceId }));

  // Callers may pass a whole row; only the key reaches the query.
  const findLive = ({ projectId, kind, identity }: SourceKey) =>
    selectSources({ projectId, kind, identity, states: ["active"] }).pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
    );

  // Concurrent writers on other connections are serialized by the immediate transaction, so
  // the pre-checks above decide; the index violation only backs them up.
  const failOnLiveIdentity = (
    identity: string,
    write: Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>,
  ) =>
    write.pipe(
      Effect.catchTags({
        SqlError: (error) =>
          isLiveIdentityViolation(error)
            ? Effect.fail(new WorkConflict({ detail: conflictDetail(identity) }))
            : Effect.fail(error),
      }),
    );

  const insertOrRevive: WorkSourceStore["Service"]["insertOrRevive"] = (input) =>
    Effect.gen(function* () {
      const key: SourceKey = {
        projectId: input.projectId,
        kind: input.kind,
        identity: input.identity,
      };
      const existing = yield* selectSources(key);
      if (existing.some((row) => row.state === "active")) {
        return yield* new WorkConflict({ detail: conflictDetail(input.identity) });
      }
      const at = yield* now;
      // Identity edits can leave several tombstones on one key; the latest one comes back.
      const tombstone = existing.reduce<StoredWorkSource | undefined>(
        (latest, row) =>
          latest === undefined || (row.disconnectedAt ?? "") >= (latest.disconnectedAt ?? "")
            ? row
            : latest,
        undefined,
      );
      if (tombstone !== undefined) {
        const revived: StoredWorkSource = {
          ...tombstone,
          label: input.label,
          config: input.config,
          secretName: input.secretName,
          state: "active",
          version: tombstone.version + 1,
          updatedAt: at,
          disconnectedAt: null,
        };
        yield* failOnLiveIdentity(input.identity, writeSource(revived));
        return revived;
      }
      const created: StoredWorkSource = {
        ...key,
        sourceId: input.sourceId,
        label: input.label,
        config: input.config,
        secretName: input.secretName,
        state: "active",
        version: 1,
        createdAt: at,
        updatedAt: at,
        disconnectedAt: null,
      };
      yield* failOnLiveIdentity(input.identity, insertSource(created));
      return created;
    }).pipe(sql.withTransaction, Effect.catchTags(storageFailure("insertOrRevive")));

  const update: WorkSourceStore["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const current = yield* requireSource(input.sourceId);
      yield* requireVersion(current, input.expectedVersion);
      if (input.config !== undefined && input.config.kind !== current.kind) {
        return yield* new WorkConflict({
          detail: `A ${current.kind} source cannot become a ${input.config.kind} source; add a new source instead.`,
        });
      }
      const identity = input.identity ?? current.identity;
      if (identity !== current.identity && current.state === "active") {
        const live = yield* findLive({ ...current, identity });
        if (Option.isSome(live)) {
          return yield* new WorkConflict({ detail: conflictDetail(identity) });
        }
      }
      const updated: StoredWorkSource = {
        ...current,
        identity,
        label: input.label ?? current.label,
        config: input.config ?? current.config,
        secretName: input.secretName === undefined ? current.secretName : input.secretName,
        version: current.version + 1,
        updatedAt: yield* now,
      };
      yield* failOnLiveIdentity(identity, writeSource(updated));
      return updated;
    }).pipe(sql.withTransaction, Effect.catchTags(storageFailure("update")));

  const disconnect: WorkSourceStore["Service"]["disconnect"] = (sourceId, expectedVersion) =>
    Effect.gen(function* () {
      const current = yield* requireSource(sourceId);
      // A retried disconnect is satisfied whatever version it carries.
      if (current.state === "disconnected") return current;
      yield* requireVersion(current, expectedVersion);
      const at = yield* now;
      const updated: StoredWorkSource = {
        ...current,
        state: "disconnected",
        version: current.version + 1,
        updatedAt: at,
        disconnectedAt: at,
      };
      yield* writeSource(updated);
      return updated;
    }).pipe(sql.withTransaction, Effect.catchTags(storageFailure("disconnect")));

  const restore: WorkSourceStore["Service"]["restore"] = (sourceId, expectedVersion) =>
    Effect.gen(function* () {
      const current = yield* requireSource(sourceId);
      if (current.state === "active") return current;
      yield* requireVersion(current, expectedVersion);
      const live = yield* findLive(current);
      if (Option.isSome(live)) {
        return yield* new WorkConflict({
          detail: `Source ${live.value.sourceId} is already active for ${current.identity}.`,
        });
      }
      const updated: StoredWorkSource = {
        ...current,
        state: "active",
        version: current.version + 1,
        updatedAt: yield* now,
        disconnectedAt: null,
      };
      yield* failOnLiveIdentity(current.identity, writeSource(updated));
      return updated;
    }).pipe(sql.withTransaction, Effect.catchTags(storageFailure("restore")));

  return WorkSourceStore.of({
    list: (options) =>
      selectSources({
        ...(options?.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options?.includeDisconnected ? {} : { states: ["active"] }),
      }).pipe(Effect.catchTags(storageFailure("list"))),
    get: (sourceId) => readSource(sourceId).pipe(Effect.catchTags(storageFailure("get"))),
    insertOrRevive,
    update,
    disconnect,
    restore,
    countActiveBySecret: (secretName) =>
      selectSecretCount(secretName).pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.catchTags(storageFailure("countActiveBySecret")),
      ),
    listProjectIds: () =>
      selectProjectIds(undefined).pipe(
        Effect.map((rows) => rows.map((row) => row.projectId)),
        Effect.catchTags(storageFailure("listProjectIds")),
      ),
  });
});

export const layer = Layer.effect(WorkSourceStore, make);
