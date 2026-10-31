import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { FactoryStoreError } from "./errors.ts";

const Key = Schema.Struct({ threadId: ThreadId, messageId: MessageId });

const AutomaticTurnKind = Schema.Literals([
  "pull_request_wake",
  "restart_continuation",
  "usage_limit_resume",
  "delegated_question",
  "delegated_completion",
  "background_wake",
]);

/** A decision on one automatic turn, keyed by its thread and the message it starts from. */
const Decision = Schema.Struct({
  ...Key.fields,
  /** The root delivery whose family the thread belongs to. */
  root: FactoryDeliveryId,
  /** The delivery whose launch made the thread, or its nearest launched ancestor. */
  deliveryId: Schema.NullOr(FactoryDeliveryId),
  kind: AutomaticTurnKind,
  class: Schema.Literals(["factory", "explicit", "unknown"]),
  /** The run the turn carries on, when its kind names one. */
  sourceRunId: Schema.NullOr(RunId),
});
export type FactoryAutomaticTurnDecision = typeof Decision.Type;

const Stored = Schema.Struct({ ...Decision.fields, recordedAt: Schema.String });

/**
 * How Factory classified each automatic turn on a family thread of a managed root (see
 * `FactoryAutomaticTurns`). Only the first decision on a turn is kept: a producer presents one
 * turn under one message id however often it asks, and a decision that later reads would change
 * must not move a turn already routed.
 */
export class FactoryAutomaticTurnStore extends Context.Service<
  FactoryAutomaticTurnStore,
  {
    readonly get: (
      key: typeof Key.Type,
    ) => Effect.Effect<Option.Option<FactoryAutomaticTurnDecision>, FactoryStoreError>;
    /** Stores the decision unless the turn has one already, and returns the one stored. */
    readonly record: (
      decision: FactoryAutomaticTurnDecision,
    ) => Effect.Effect<FactoryAutomaticTurnDecision, FactoryStoreError>;
  }
>()("t3/fd/factory/persistence/FactoryAutomaticTurnStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Key,
    Result: Decision,
    execute: ({ threadId, messageId }) => sql`
      SELECT thread_id AS "threadId", message_id AS "messageId", root_delivery_id AS root,
        delivery_id AS "deliveryId", kind, class, source_run_id AS "sourceRunId"
      FROM fd_factory_automatic_turns
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `,
  });
  const insert = SqlSchema.void({
    Request: Stored,
    execute: (decision) => sql`
      INSERT INTO fd_factory_automatic_turns
        (thread_id, message_id, root_delivery_id, delivery_id, kind, class, source_run_id,
          recorded_at)
      VALUES (${decision.threadId}, ${decision.messageId}, ${decision.root},
        ${decision.deliveryId}, ${decision.kind}, ${decision.class}, ${decision.sourceRunId},
        ${decision.recordedAt})
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `,
  });

  const record: FactoryAutomaticTurnStore["Service"]["record"] = (decision) =>
    Effect.gen(function* () {
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* insert({ ...decision, recordedAt });
      // Rows are never deleted, so this is the insert or the decision it lost to.
      const stored = yield* select(decision);
      if (Option.isSome(stored)) return stored.value;
      return yield* new FactoryStoreError({
        operation: "automaticTurns.record",
        cause: "The decision was not stored.",
      });
    }).pipe(Effect.catchTags(FactoryStoreError.catchStorage("automaticTurns.record")));

  return FactoryAutomaticTurnStore.of({
    get: (key) =>
      select(key).pipe(Effect.catchTags(FactoryStoreError.catchStorage("automaticTurns.get"))),
    record,
  });
});

export const layer = Layer.effect(FactoryAutomaticTurnStore, make);
