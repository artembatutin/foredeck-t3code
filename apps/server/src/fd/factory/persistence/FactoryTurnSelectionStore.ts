import { ModelSelection, PositiveInt, ThreadId } from "@t3tools/contracts";
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

/** A fix-commit's selection is decided before dispatch and survives an uncertain send/restart. */
export class FactoryTurnSelectionStore extends Context.Service<
  FactoryTurnSelectionStore,
  {
    readonly get: (
      key: typeof Key.Type,
    ) => Effect.Effect<Option.Option<typeof Selection.Type>, FactoryStoreError>;
    /** A thread can be shared by a child and its parent's follow-through. */
    readonly latest: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<typeof Selection.Type>, FactoryStoreError>;
    readonly record: (selection: typeof Selection.Type) => Effect.Effect<void, FactoryStoreError>;
  }
>()("t3/fd/factory/persistence/FactoryTurnSelectionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Schema.Union([Key, Schema.Struct({ threadId: ThreadId })]),
    Result: Selection,
    execute: (key) => sql`
      SELECT delivery_id AS "deliveryId", effect_id AS "effectId", thread_id AS "threadId",
        before_json AS before, mechanical_json AS mechanical
      FROM fd_factory_turn_selections
      WHERE ${
        "threadId" in key
          ? sql`thread_id = ${key.threadId}`
          : sql`delivery_id = ${key.deliveryId} AND effect_id = ${key.effectId}`
      }
      ORDER BY position DESC LIMIT 1
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
  return FactoryTurnSelectionStore.of({
    get: (key) => select(key).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.get"))),
    latest: (threadId) =>
      select({ threadId }).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.latest"))),
    record: (selection) =>
      record(selection).pipe(Effect.catchTags(FactoryStoreError.catchStorage("turns.record"))),
  });
});

export const layer = Layer.effect(FactoryTurnSelectionStore, make);
