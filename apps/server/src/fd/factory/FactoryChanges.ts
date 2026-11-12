import type { ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** The deliveries a refused automatic turn is listed under: its root, and whose launch made it. */
export interface RefusedAutomaticTurn {
  readonly root: FactoryDeliveryId;
  readonly launchedBy: FactoryDeliveryId;
}

/**
 * The change epoch of Factory's deliveries and settings, which clients follow as they follow
 * Work's refresh epoch: a counter that moves after every committed Factory write, so a client
 * refetches what it shows on each value. It starts over at 0 with each server process, and a
 * client refetches on the first value of every subscription.
 */
export class FactoryChanges extends Context.Service<
  FactoryChanges,
  {
    /** The current epoch on subscribe, then every move. */
    readonly changes: Stream.Stream<number>;
    /**
     * Runs a write in its own transaction and moves the epoch once committed (only when `stored`
     * says it wrote). A failed or interrupted write rolls back; commit-and-move is uninterruptible,
     * so no committed write goes unannounced. Never call it inside another transaction, which
     * would commit only later.
     */
    readonly transact: <A, E, R>(
      write: Effect.Effect<A, E, R>,
      stored?: (result: A) => boolean,
    ) => Effect.Effect<A, E | SqlError.SqlError, R>;
    /**
     * Moves the epoch for something a listing shows that Factory did not write: a request opening or
     * closing on one of its threads, which core has committed by the time the reactor hears of it.
     */
    readonly announce: Effect.Effect<void>;
    /**
     * Automatic turns on Factory's threads the provider's host refused, by thread. Each stays until
     * a consult of that thread passes. It is process memory, and that is enough: a refused turn's
     * producer asks again, restarts included, and a listing judges each entry again as it reads it.
     */
    readonly refusedTurns: Effect.Effect<ReadonlyMap<ThreadId, RefusedAutomaticTurn>>;
    /** Records a refusal, moving the epoch only for one a listing does not show yet. */
    readonly noteRefusedTurn: (
      threadId: ThreadId,
      turn: RefusedAutomaticTurn,
    ) => Effect.Effect<void>;
    /** Forgets a refusal, moving the epoch only for one a listing was showing. */
    readonly clearRefusedTurn: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryChanges") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const epoch = yield* SubscriptionRef.make(0);
  const move = SubscriptionRef.update(epoch, (value) => value + 1);
  const refused = yield* Ref.make<ReadonlyMap<ThreadId, RefusedAutomaticTurn>>(new Map());
  return FactoryChanges.of({
    changes: SubscriptionRef.changes(epoch),
    announce: move,
    refusedTurns: Ref.get(refused),
    noteRefusedTurn: Effect.fn("FactoryChanges.noteRefusedTurn")((threadId, turn) =>
      Ref.modify(refused, (current) =>
        current.has(threadId)
          ? ([false, current] as const)
          : ([true, new Map(current).set(threadId, turn)] as const),
      ).pipe(Effect.flatMap((added) => (added ? move : Effect.void))),
    ),
    clearRefusedTurn: Effect.fn("FactoryChanges.clearRefusedTurn")((threadId) =>
      Ref.modify(refused, (current) => {
        if (!current.has(threadId)) return [false, current] as const;
        const next = new Map(current);
        next.delete(threadId);
        return [true, next] as const;
      }).pipe(Effect.flatMap((removed) => (removed ? move : Effect.void))),
    ),
    // The transaction's own mask ends by raising an interrupt its commit held off, so the
    // transaction would exit interrupted though it committed. Inside this mask its own leaves
    // interruptibility alone: the exit seen here says whether it committed, and the interrupt is
    // raised once the epoch has moved.
    transact: Effect.fn("FactoryChanges.transact")((write, stored = () => true) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.onExit(sql.withTransaction(restore(write)), (exit) =>
          Exit.isSuccess(exit) && stored(exit.value) ? move : Effect.void,
        ),
      ),
    ),
  });
});

/**
 * One value, so the layers that merge it (the worker's and the settings') share one epoch in a
 * build.
 */
export const layer = Layer.effect(FactoryChanges, make);
