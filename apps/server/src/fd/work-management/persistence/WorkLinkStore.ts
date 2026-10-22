import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  WorkItemId,
  WorkSourceId,
  WorkThreadLink,
  WorkThreadLinkSource,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { WorkStoreError } from "./WorkSourceStore.ts";

const WorkThreadLinkSnapshot = WorkThreadLink.fields.snapshot;
const WorkThreadLinkRun = WorkThreadLink.fields.run.members[0];

/** A thread attached to an item, keyed by `(sourceId, itemId, threadId)`. */
export const StoredWorkLink = Schema.Struct({
  sourceId: WorkSourceId,
  itemId: WorkItemId,
  threadId: ThreadId,
  source: WorkThreadLinkSource,
  snapshot: WorkThreadLinkSnapshot,
  run: WorkThreadLink.fields.run,
  linkedAt: IsoDateTime,
});
export type StoredWorkLink = typeof StoredWorkLink.Type;

/** The row shape; `snapshot` and `run` travel as JSON columns, `run` NULL when absent. */
const LinkDbRow = Schema.Struct({
  ...StoredWorkLink.fields,
  snapshot: Schema.fromJsonString(WorkThreadLinkSnapshot),
  run: Schema.NullOr(Schema.fromJsonString(WorkThreadLinkRun)),
});

const LinkKey = Schema.Struct({ sourceId: WorkSourceId, itemId: WorkItemId, threadId: ThreadId });
type LinkKey = typeof LinkKey.Type;

/**
 * Links between Work items and threads. Rows reference `fd_work_sources`, so a link for an
 * unknown source is refused by the database. Every list comes back newest first.
 */
export class WorkLinkStore extends Context.Service<
  WorkLinkStore,
  {
    /** Insert the link, or return the stored one unchanged when the key already exists. */
    readonly link: (input: {
      readonly sourceId: WorkSourceId;
      readonly itemId: WorkItemId;
      readonly threadId: ThreadId;
      readonly source: WorkThreadLinkSource;
      readonly snapshot: StoredWorkLink["snapshot"];
    }) => Effect.Effect<
      { readonly link: StoredWorkLink; readonly inserted: boolean },
      WorkStoreError
    >;
    /** Whether a row was removed. */
    readonly unlink: (
      sourceId: WorkSourceId,
      itemId: WorkItemId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, WorkStoreError>;
    /** Remove every link of a thread; returns how many there were. */
    readonly unlinkThread: (threadId: ThreadId) => Effect.Effect<number, WorkStoreError>;
    /** Remove every link of a source; returns how many there were. */
    readonly deleteBySource: (sourceId: WorkSourceId) => Effect.Effect<number, WorkStoreError>;
    readonly listByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<StoredWorkLink>, WorkStoreError>;
    readonly listByItem: (
      sourceId: WorkSourceId,
      itemId: WorkItemId,
    ) => Effect.Effect<ReadonlyArray<StoredWorkLink>, WorkStoreError>;
    /** Links of every source in the project, live or disconnected. */
    readonly listByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredWorkLink>, WorkStoreError>;
    /** At most `limit` links; `truncated` when more exist. */
    readonly listAll: (
      limit: number,
    ) => Effect.Effect<
      { readonly links: ReadonlyArray<StoredWorkLink>; readonly truncated: boolean },
      WorkStoreError
    >;
    readonly updateSnapshot: (
      sourceId: WorkSourceId,
      itemId: WorkItemId,
      threadId: ThreadId,
      snapshot: StoredWorkLink["snapshot"],
    ) => Effect.Effect<void, WorkStoreError>;
    readonly updateRun: (
      sourceId: WorkSourceId,
      itemId: WorkItemId,
      threadId: ThreadId,
      run: StoredWorkLink["run"],
    ) => Effect.Effect<void, WorkStoreError>;
  }
>()("t3/fd/work-management/persistence/WorkLinkStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  // `Effect.catchTags` handlers wrapping lower-level failures.
  const storageFailure = (operation: string) => ({
    SqlError: (cause: SqlError.SqlError) => Effect.fail(new WorkStoreError({ operation, cause })),
    SchemaError: (cause: Schema.SchemaError) =>
      Effect.fail(new WorkStoreError({ operation, cause })),
  });

  const selectLinks = SqlSchema.findAll({
    Request: Schema.Struct({
      sourceId: Schema.optional(WorkSourceId),
      itemId: Schema.optional(WorkItemId),
      threadId: Schema.optional(ThreadId),
      projectId: Schema.optional(ProjectId),
      limit: Schema.optional(Schema.Int),
    }),
    Result: LinkDbRow,
    execute: (request) => sql`
      SELECT
        source_id AS "sourceId",
        item_id AS "itemId",
        thread_id AS "threadId",
        link_source AS source,
        snapshot_json AS snapshot,
        run_json AS run,
        linked_at AS "linkedAt"
      FROM fd_work_thread_links
      WHERE ${sql.and([
        ...(request.sourceId === undefined ? [] : [sql`source_id = ${request.sourceId}`]),
        ...(request.itemId === undefined ? [] : [sql`item_id = ${request.itemId}`]),
        ...(request.threadId === undefined ? [] : [sql`thread_id = ${request.threadId}`]),
        ...(request.projectId === undefined
          ? []
          : [
              sql`source_id IN (
                SELECT source_id FROM fd_work_sources WHERE project_id = ${request.projectId}
              )`,
            ]),
      ])}
      ORDER BY linked_at DESC, source_id ASC, item_id ASC, thread_id ASC
      LIMIT ${request.limit ?? -1}
    `,
  });

  const insertLink = SqlSchema.void({
    Request: LinkDbRow,
    execute: (row) => sql`
      INSERT INTO fd_work_thread_links (
        source_id, item_id, thread_id, link_source, snapshot_json, run_json, linked_at
      )
      VALUES (
        ${row.sourceId}, ${row.itemId}, ${row.threadId}, ${row.source}, ${row.snapshot},
        ${row.run}, ${row.linkedAt}
      )
    `,
  });

  const DeletedRows = Schema.Struct({ threadId: ThreadId });

  const deleteLink = SqlSchema.findAll({
    Request: LinkKey,
    Result: DeletedRows,
    execute: ({ sourceId, itemId, threadId }) => sql`
      DELETE FROM fd_work_thread_links
      WHERE source_id = ${sourceId} AND item_id = ${itemId} AND thread_id = ${threadId}
      RETURNING thread_id AS "threadId"
    `,
  });

  const deleteByThread = SqlSchema.findAll({
    Request: ThreadId,
    Result: DeletedRows,
    execute: (threadId) => sql`
      DELETE FROM fd_work_thread_links WHERE thread_id = ${threadId}
      RETURNING thread_id AS "threadId"
    `,
  });

  const deleteBySourceId = SqlSchema.findAll({
    Request: WorkSourceId,
    Result: DeletedRows,
    execute: (sourceId) => sql`
      DELETE FROM fd_work_thread_links WHERE source_id = ${sourceId}
      RETURNING thread_id AS "threadId"
    `,
  });

  const writeSnapshot = SqlSchema.void({
    Request: Schema.Struct({ ...LinkKey.fields, snapshot: LinkDbRow.fields.snapshot }),
    execute: ({ sourceId, itemId, threadId, snapshot }) => sql`
      UPDATE fd_work_thread_links SET snapshot_json = ${snapshot}
      WHERE source_id = ${sourceId} AND item_id = ${itemId} AND thread_id = ${threadId}
    `,
  });

  const writeRun = SqlSchema.void({
    Request: Schema.Struct({ ...LinkKey.fields, run: LinkDbRow.fields.run }),
    execute: ({ sourceId, itemId, threadId, run }) => sql`
      UPDATE fd_work_thread_links SET run_json = ${run}
      WHERE source_id = ${sourceId} AND item_id = ${itemId} AND thread_id = ${threadId}
    `,
  });

  const link: WorkLinkStore["Service"]["link"] = (input) =>
    Effect.gen(function* () {
      const key: LinkKey = {
        sourceId: input.sourceId,
        itemId: input.itemId,
        threadId: input.threadId,
      };
      const [existing] = yield* selectLinks(key);
      if (existing !== undefined) return { link: existing, inserted: false };
      const created: StoredWorkLink = {
        ...key,
        source: input.source,
        snapshot: input.snapshot,
        run: null,
        linkedAt: yield* now,
      };
      yield* insertLink(created);
      return { link: created, inserted: true };
    }).pipe(sql.withTransaction, Effect.catchTags(storageFailure("link")));

  const list = (operation: string, request: Parameters<typeof selectLinks>[0]) =>
    selectLinks(request).pipe(Effect.catchTags(storageFailure(operation)));

  return WorkLinkStore.of({
    link,
    unlink: (sourceId, itemId, threadId) =>
      deleteLink({ sourceId, itemId, threadId }).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.catchTags(storageFailure("unlink")),
      ),
    unlinkThread: (threadId) =>
      deleteByThread(threadId).pipe(
        Effect.map((rows) => rows.length),
        Effect.catchTags(storageFailure("unlinkThread")),
      ),
    deleteBySource: (sourceId) =>
      deleteBySourceId(sourceId).pipe(
        Effect.map((rows) => rows.length),
        Effect.catchTags(storageFailure("deleteBySource")),
      ),
    listByThread: (threadId) => list("listByThread", { threadId }),
    listByItem: (sourceId, itemId) => list("listByItem", { sourceId, itemId }),
    listByProject: (projectId) => list("listByProject", { projectId }),
    listAll: (limit) =>
      list("listAll", { limit: limit + 1 }).pipe(
        Effect.map((rows) => ({ links: rows.slice(0, limit), truncated: rows.length > limit })),
      ),
    updateSnapshot: (sourceId, itemId, threadId, snapshot) =>
      writeSnapshot({ sourceId, itemId, threadId, snapshot }).pipe(
        Effect.catchTags(storageFailure("updateSnapshot")),
      ),
    updateRun: (sourceId, itemId, threadId, run) =>
      writeRun({ sourceId, itemId, threadId, run }).pipe(
        Effect.catchTags(storageFailure("updateRun")),
      ),
  });
});

export const layer = Layer.effect(WorkLinkStore, make);
