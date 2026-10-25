import type { OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { type FactoryThreadEvent, isTerminalRunStatus } from "./pipeline/state.ts";

/**
 * Feeds what happens to Factory's threads into their deliveries: a terminal run becomes
 * `run.finished` and a deleted thread `thread.deleted` for the delivery whose active stage
 * attempt owns the thread (any delivery recording it, for a deletion); other threads pass by.
 * A boot sweep catches up the deliveries that awaited something when the previous server stopped,
 * and posts the Work comments it recorded and never finished. The tail starts at the event log
 * position read before the sweep, so no event falls between the two.
 */
export class FactoryReactor extends Context.Service<
  FactoryReactor,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Resolves once the boot sweep and every thread event committed before the call have been
     * handled, including the steps they fed; the effects those steps queued are
     * `FactoryWorker.drain`'s. Waits for `start` to read its log position. Tests await this
     * instead of sleeping.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryReactor") {}

type Job = "boot" | FactoryThreadEvent;

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const ready = yield* Deferred.make<void>();
  // The sequence of the last event the tail has read; jobs for events up to it are queued.
  const handled = yield* TxRef.make(0);

  const logSkipped = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, cause).pipe(Effect.asVoid);

  /** How the awaited run or its thread ended, as the projection has it; null while it runs. */
  const projectedEnd = (threadId: ThreadId, runId: RunId) =>
    projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map(({ thread, runs }): FactoryThreadEvent | null => {
        if (thread.deletedAt !== null) return { type: "thread.deleted", threadId };
        const status = runs.find((run) => run.id === runId)?.status;
        return isTerminalRunStatus(status)
          ? { type: "run.finished", threadId, runId, status }
          : null;
      }),
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () =>
          Effect.succeed<FactoryThreadEvent>({ type: "thread.deleted", threadId }),
      }),
    );

  /**
   * Catches one delivery up with what happened while no server ran it, whatever its status. First
   * a cancellation the restart cut short between a parent and its children is completed. A
   * delivery awaiting a run gets the run's end or its thread's deletion, as the tail would have
   * handed them on, so a stopping one stops where the run's end leads it. One awaiting an effect
   * lost it with the previous process and blocks, unless what it did is stored (see
   * `failInterruptedEffect`). A parent awaiting its child takes the child's approval stored
   * before the restart, and otherwise waits for that child. A delivery awaiting nothing (queued,
   * stopped, blocked, its pull request open) waits for its owner. Each step reads the delivery
   * again, so one cancelled here takes nothing more.
   */
  const reconcile = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      yield* worker.finishCancellation(deliveryId);
      const { awaiting } = state;
      if (awaiting === null) return;
      if (awaiting.type === "child") {
        yield* worker.takeChildApproval(deliveryId);
        return;
      }
      if (awaiting.type === "effect") {
        yield* worker.failInterruptedEffect(deliveryId);
        return;
      }
      const ended = yield* projectedEnd(awaiting.threadId, awaiting.runId);
      if (ended !== null) yield* worker.step(deliveryId, ended);
    }).pipe(Effect.catchCause(logSkipped("factory delivery reconcile skipped")));

  // Comments a previous process recorded and never finished go first, in their order.
  const bootSweep = worker.postUnfinishedComments.pipe(
    Effect.catchCause(logSkipped("factory comment recovery failed")),
    Effect.andThen(deliveries.listActive()),
    Effect.flatMap((active) => Effect.forEach(active, reconcile, { discard: true })),
    Effect.catchCause(logSkipped("factory boot reconcile failed")),
  );

  const jobs = yield* makeDrainableWorker((job: Job) =>
    job === "boot"
      ? bootSweep
      : worker.stepThread(job).pipe(Effect.catchCause(logSkipped("factory thread event skipped"))),
  );

  /** Run ends and thread deletions; everything else passes by. */
  const onDomainEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "run.updated": {
        const { id: runId, threadId, status } = event.payload;
        return isTerminalRunStatus(status)
          ? jobs.enqueue({ type: "run.finished", threadId, runId, status })
          : Effect.void;
      }
      case "thread.deleted":
        return jobs.enqueue({ type: "thread.deleted", threadId: event.payload.id });
      default:
        return Effect.void;
    }
  };

  // The log position is read before the sweep, so the sweep reads every event up to it in the
  // projections and the tail replays every later one from the log, however long the sweep takes.
  // Their jobs queue behind the sweep. All of it waits for activation, so no Factory work runs
  // in a server that never takes over.
  const start: FactoryReactor["Service"]["start"] = forkParked(
    Effect.gen(function* () {
      const position = yield* eventSink.latestSequence();
      yield* TxRef.set(handled, position);
      yield* jobs.enqueue("boot");
      yield* Deferred.succeed(ready, undefined);
      yield* Stream.runForEach(eventSink.stream({ afterSequence: position }), (stored) =>
        onDomainEvent(stored.event).pipe(Effect.andThen(TxRef.set(handled, stored.sequence))),
      );
    }).pipe(
      Effect.catchCause(logSkipped("factory thread event stream failed")),
      // A tail that stopped hands on nothing more; drain must not wait for it.
      Effect.ensuring(
        TxRef.set(handled, Number.POSITIVE_INFINITY).pipe(
          Effect.andThen(Deferred.succeed(ready, undefined)),
        ),
      ),
    ),
  );

  const drain = Effect.gen(function* () {
    yield* Deferred.await(ready);
    const target = yield* eventSink
      .latestSequence()
      .pipe(Effect.catchCause(() => Effect.succeed(0)));
    yield* TxRef.get(handled).pipe(
      Effect.flatMap((sequence) => (sequence >= target ? Effect.void : Effect.txRetry)),
      Effect.tx,
    );
    yield* jobs.drain;
  });

  return FactoryReactor.of({ start, drain });
});

export const layer = Layer.effect(FactoryReactor, make);
