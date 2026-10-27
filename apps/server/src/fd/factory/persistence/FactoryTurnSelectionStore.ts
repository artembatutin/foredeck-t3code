import {
  CommandId,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { FactoryStoreError } from "./errors.ts";

const Key = Schema.Struct({ deliveryId: FactoryDeliveryId, effectId: PositiveInt });
const Selection = Schema.Struct({
  ...Key.fields,
  threadId: ThreadId,
  before: Schema.fromJsonString(ModelSelection),
  mechanical: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
});
const HistoryKey = Schema.Struct({ threadId: ThreadId, throughSequence: NonNegativeInt });
const SelectionChange = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  selection: Schema.fromJsonString(ModelSelection),
});

/** A fix-commit's selection is decided before dispatch and survives an uncertain send/restart. */
export class FactoryTurnSelectionStore extends Context.Service<
  FactoryTurnSelectionStore,
  {
    readonly get: (
      key: typeof Key.Type,
    ) => Effect.Effect<Option.Option<typeof Selection.Type>, FactoryStoreError>;
    /** A thread can be shared by a child and its parent's follow-through. */
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<typeof Selection.Type>, FactoryStoreError>;
    readonly record: (selection: typeof Selection.Type) => Effect.Effect<void, FactoryStoreError>;
    /** Selection provenance includes the rows core event compaction has removed. */
    readonly history: (
      key: typeof HistoryKey.Type,
    ) => Effect.Effect<ReadonlyArray<typeof SelectionChange.Type>, FactoryStoreError>;
  }
>()("t3/fd/factory/persistence/FactoryTurnSelectionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Key,
    Result: Selection,
    execute: (key) => sql`
      SELECT delivery_id AS "deliveryId", effect_id AS "effectId", thread_id AS "threadId",
        before_json AS before, mechanical_json AS mechanical
      FROM fd_factory_turn_selections
      WHERE delivery_id = ${key.deliveryId} AND effect_id = ${key.effectId}
    `,
  });
  const list = SqlSchema.findAll({
    Request: ThreadId,
    Result: Selection,
    execute: (threadId) => sql`
      SELECT delivery_id AS "deliveryId", effect_id AS "effectId", thread_id AS "threadId",
        before_json AS before, mechanical_json AS mechanical
      FROM fd_factory_turn_selections WHERE thread_id = ${threadId} ORDER BY position DESC
    `,
  });
  const record = SqlSchema.void({
    Request: Selection,
    execute: (selection) => sql`
      INSERT INTO fd_factory_turn_selections
        (delivery_id, effect_id, thread_id, before_json, mechanical_json)
      VALUES (${selection.deliveryId}, ${selection.effectId}, ${selection.threadId},
        ${selection.before}, ${selection.mechanical})
      ON CONFLICT (delivery_id, effect_id) DO NOTHING
    `,
  });
  const history = SqlSchema.findAll({
    Request: HistoryKey,
    Result: SelectionChange,
    execute: ({ threadId, throughSequence }) => sql`
      SELECT sequence, command_id AS "commandId",
        json_extract(payload_json, '$.modelSelection') AS selection
      FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id = ${threadId} AND sequence <= ${throughSequence}
        AND event_type IN ('thread.created', 'thread.model-selection-updated', 'thread.provider-switched')
      UNION ALL
      SELECT sequence, command_id AS "commandId", selection_json AS selection
      FROM fd_factory_selection_history
      WHERE thread_id = ${threadId} AND sequence <= ${throughSequence}
      ORDER BY sequence
    `,
  });
  return FactoryTurnSelectionStore.of({
    get: (key) => select(key).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.get"))),
    list: (threadId) =>
      list(threadId).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.list"))),
    record: (selection) =>
      record(selection).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.record"))),
    history: (key) =>
      history(key).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.history"))),
  });
});

export const layer = Layer.effect(FactoryTurnSelectionStore, make);
