import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

class WorkCaptureStoreError extends Schema.TaggedError<WorkCaptureStoreError>()(
  "WorkCaptureStoreError",
  { operation: Schema.Literals(["get", "write", "abandon"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `The assistant's Work capture store failed to ${this.operation}.`;
  }
}

const CaptureRow = Schema.Struct({
  projectId: ProjectId,
  ideaId: Schema.String,
  captureId: Schema.String,
  sourceId: WorkSourceId,
  kind: Schema.Literals(["single", "parent"]),
  state: Schema.Literals(["pending", "uncertain", "captured"]),
  writerInstanceId: Schema.String,
  itemId: Schema.NullOr(WorkItemId),
  itemKey: Schema.NullOr(Schema.String),
  itemUrl: Schema.NullOr(Schema.String),
  itemFingerprint: Schema.NullOr(Schema.String),
  contentHash: Schema.String,
  scopeHash: Schema.String,
  briefRevision: Schema.Int,
  updatedAt: IsoDateTime,
  sequence: Schema.Int,
});

/**
 * The one Work item an idea was captured as. `pending` is claimed by the writer of
 * `writerInstanceId`, which may have created the item; `uncertain` may have an item nobody
 * recorded; `captured` names it. `itemFingerprint` is null until a read verified the item.
 * `sequence` is the capture's latest event: every write appends one, so it versions the row.
 */
export type StoredCapture = typeof CaptureRow.Type;
export type CaptureFields = Omit<StoredCapture, "updatedAt" | "sequence">;
export type CaptureEvent =
  | "claimed"
  | "created"
  | "create_uncertain"
  | "recovered"
  | "updated"
  | "update_uncertain";

/** The capture a write was decided on: its id and latest event. */
interface CaptureVersion {
  readonly captureId: string;
  readonly sequence: number;
}

/**
 * Captures and their history. Writes are compare-and-set on the capture's version, each in one
 * transaction (inside the caller's when there is one), so a decision made on a capture that has
 * moved since writes nothing. Events are never deleted: an abandoned capture keeps its history.
 */
export class WorkCaptureStore extends Context.Service<
  WorkCaptureStore,
  {
    readonly get: (
      projectId: ProjectId,
      ideaId: string,
    ) => Effect.Effect<Option.Option<StoredCapture>, WorkCaptureStoreError>;
    /**
     * Stores the idea's capture as `next` and appends `event`, only while the stored one is still
     * `expected` (null: none is stored). None when it moved, writing nothing.
     */
    readonly write: (input: {
      readonly expected: CaptureVersion | null;
      readonly next: CaptureFields;
      readonly event: CaptureEvent;
      /** A fixed category, never text from the source. */
      readonly detail?: string;
    }) => Effect.Effect<Option.Option<StoredCapture>, WorkCaptureStoreError>;
    /**
     * Removes the idea's capture and records that it was abandoned, unless it moved from
     * `expected` or a Factory assignment that has not completed or been cancelled uses it.
     */
    readonly abandon: (input: {
      readonly projectId: ProjectId;
      readonly ideaId: string;
      readonly expected: CaptureVersion;
    }) => Effect.Effect<"abandoned" | "moved" | "in_use", WorkCaptureStoreError>;
  }
>()("t3/fd/assistant/WorkCaptureStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const select = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, ideaId: Schema.String }),
    Result: CaptureRow,
    execute: ({ projectId, ideaId }) => sql`
      SELECT
        c.project_id AS "projectId",
        c.idea_id AS "ideaId",
        c.capture_id AS "captureId",
        c.source_id AS "sourceId",
        c.kind,
        c.state,
        c.writer_instance_id AS "writerInstanceId",
        c.item_id AS "itemId",
        c.item_key AS "itemKey",
        c.item_url AS "itemUrl",
        c.item_fingerprint AS "itemFingerprint",
        c.content_hash AS "contentHash",
        c.scope_hash AS "scopeHash",
        c.brief_revision AS "briefRevision",
        c.updated_at AS "updatedAt",
        COALESCE(
          (SELECT MAX(e.sequence) FROM fd_assistant_capture_events e WHERE e.capture_id = c.capture_id),
          0
        ) AS sequence
      FROM fd_assistant_work_captures c
      WHERE c.project_id = ${projectId} AND c.idea_id = ${ideaId}
    `,
  });
  const read = (projectId: ProjectId, ideaId: string) =>
    select({ projectId, ideaId }).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  const appendEvent = (input: {
    readonly captureId: string;
    readonly sequence: number;
    readonly event: CaptureEvent | "abandoned";
    readonly itemId: string | null;
    readonly detail: string | null;
    readonly at: string;
  }) => sql`
    INSERT INTO fd_assistant_capture_events (capture_id, sequence, event, item_id, detail, at)
    VALUES (${input.captureId}, ${input.sequence}, ${input.event}, ${input.itemId}, ${input.detail}, ${input.at})
  `;

  const moved = (current: Option.Option<StoredCapture>, expected: CaptureVersion | null) =>
    expected === null
      ? Option.isSome(current)
      : Option.isNone(current) ||
        current.value.captureId !== expected.captureId ||
        current.value.sequence !== expected.sequence;

  const write: WorkCaptureStore["Service"]["write"] = ({ expected, next, event, detail }) =>
    Effect.gen(function* () {
      const current = yield* read(next.projectId, next.ideaId);
      if (moved(current, expected)) return Option.none();
      const at = yield* now;
      if (Option.isNone(current)) {
        yield* sql`
          INSERT INTO fd_assistant_work_captures (
            project_id, idea_id, capture_id, source_id, kind, state, writer_instance_id, item_id,
            item_key, item_url, item_fingerprint, content_hash, scope_hash, brief_revision, updated_at
          ) VALUES (
            ${next.projectId}, ${next.ideaId}, ${next.captureId}, ${next.sourceId}, ${next.kind},
            ${next.state}, ${next.writerInstanceId}, ${next.itemId}, ${next.itemKey},
            ${next.itemUrl}, ${next.itemFingerprint}, ${next.contentHash}, ${next.scopeHash},
            ${next.briefRevision}, ${at}
          )
        `;
      } else {
        yield* sql`
          UPDATE fd_assistant_work_captures SET
            source_id = ${next.sourceId},
            kind = ${next.kind},
            state = ${next.state},
            writer_instance_id = ${next.writerInstanceId},
            item_id = ${next.itemId},
            item_key = ${next.itemKey},
            item_url = ${next.itemUrl},
            item_fingerprint = ${next.itemFingerprint},
            content_hash = ${next.contentHash},
            scope_hash = ${next.scopeHash},
            brief_revision = ${next.briefRevision},
            updated_at = ${at}
          WHERE project_id = ${next.projectId} AND idea_id = ${next.ideaId}
            AND capture_id = ${next.captureId}
        `;
      }
      const sequence =
        Option.match(current, { onNone: () => 0, onSome: (row) => row.sequence }) + 1;
      yield* appendEvent({
        captureId: next.captureId,
        sequence,
        event,
        itemId: next.itemId,
        detail: detail ?? null,
        at,
      });
      return Option.some({ ...next, updatedAt: at, sequence });
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) => new WorkCaptureStoreError({ operation: "write", cause })),
    );

  const abandon: WorkCaptureStore["Service"]["abandon"] = ({ projectId, ideaId, expected }) =>
    Effect.gen(function* () {
      const current = yield* read(projectId, ideaId);
      if (moved(current, expected) || Option.isNone(current)) return "moved" as const;
      const used = yield* sql<{ readonly used: number }>`
        SELECT 1 AS used
        FROM fd_assistant_factory_links l
        JOIN fd_assistant_assignments a ON a.assignment_id = l.assignment_id
        WHERE l.capture_id = ${expected.captureId} AND a.state NOT IN ('completed', 'cancelled')
        LIMIT 1
      `;
      if (used.length > 0) return "in_use" as const;
      const at = yield* now;
      yield* sql`
        DELETE FROM fd_assistant_work_captures
        WHERE project_id = ${projectId} AND idea_id = ${ideaId} AND capture_id = ${expected.captureId}
      `;
      yield* appendEvent({
        captureId: expected.captureId,
        sequence: expected.sequence + 1,
        event: "abandoned",
        itemId: current.value.itemId,
        detail: null,
        at,
      });
      return "abandoned" as const;
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) => new WorkCaptureStoreError({ operation: "abandon", cause })),
    );

  return WorkCaptureStore.of({
    get: (projectId, ideaId) =>
      read(projectId, ideaId).pipe(
        Effect.mapError((cause) => new WorkCaptureStoreError({ operation: "get", cause })),
      ),
    write,
    abandon,
  });
});

export const layer = Layer.effect(WorkCaptureStore, make);
