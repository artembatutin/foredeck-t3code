import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * The deliveries' change epoch, which clients follow as they follow Work's refresh epoch: a
 * counter that moves after every committed delivery write, so a client refetches what it shows on
 * each value. It starts over at 0 with each server process, and a client refetches on the first
 * value of every subscription.
 */
export class FactoryChanges extends Context.Service<
  FactoryChanges,
  {
    /** The current epoch on subscribe, then every move. */
    readonly changes: Stream.Stream<number>;
    /**
     * Runs a delivery write's transaction and moves the epoch once it has committed, so a client
     * refetching on the new value reads what it stored; `stored` tells a result that wrote from
     * one that did not. A transaction that fails moves nothing, and one that commits moves the
     * epoch even if the caller is interrupted right after. Pass the outermost transaction: a
     * nested one commits only with its parent.
     */
    readonly afterCommit: <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      stored?: (result: A) => boolean,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/fd/factory/FactoryChanges") {}

const make = Effect.gen(function* () {
  const epoch = yield* SubscriptionRef.make(0);
  const move = SubscriptionRef.update(epoch, (value) => value + 1);
  return FactoryChanges.of({
    changes: SubscriptionRef.changes(epoch),
    afterCommit: (transaction, stored = () => true) =>
      Effect.onExit(transaction, (exit) =>
        Exit.isSuccess(exit) && stored(exit.value) ? move : Effect.void,
      ),
  });
});

export const layer = Layer.effect(FactoryChanges, make);
