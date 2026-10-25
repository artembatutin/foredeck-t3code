import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

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
     * Runs a write in a transaction of its own and moves the epoch once that has committed, so a
     * client refetching on the new value reads what it stored; `stored` tells a result that wrote
     * from one that did not. The write stays interruptible, and one that fails or is interrupted
     * rolls back and moves nothing. Committing and moving are not: an interrupt that arrives
     * meanwhile takes effect once the epoch has moved, so no committed write goes unannounced.
     * Never call it inside another transaction, which would commit only later.
     */
    readonly transact: <A, E, R>(
      write: Effect.Effect<A, E, R>,
      stored?: (result: A) => boolean,
    ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  }
>()("t3/fd/factory/FactoryChanges") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const epoch = yield* SubscriptionRef.make(0);
  const move = SubscriptionRef.update(epoch, (value) => value + 1);
  return FactoryChanges.of({
    changes: SubscriptionRef.changes(epoch),
    // The transaction's own mask ends by raising an interrupt its commit held off, so the
    // transaction would exit interrupted though it committed. Inside this mask its own leaves
    // interruptibility alone: the exit seen here says whether it committed, and the interrupt is
    // raised once the epoch has moved.
    transact: (write, stored = () => true) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.onExit(sql.withTransaction(restore(write)), (exit) =>
          Exit.isSuccess(exit) && stored(exit.value) ? move : Effect.void,
        ),
      ),
  });
});

/**
 * One value, so the layers that merge it (the worker's and the settings') share one epoch in a
 * build.
 */
export const layer = Layer.effect(FactoryChanges, make);
