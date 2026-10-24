import type { OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import type { FactoryThreadEvent } from "./pipeline/state.ts";

/**
 * Feeds what happens to Factory's threads into their deliveries: a terminal run becomes
 * `run.finished` and a deleted thread `thread.deleted` for the delivery whose active stage
 * attempt owns the thread; other threads pass by. The thread tail is live only, so a boot sweep
 * catches up the deliveries that were running when the previous server stopped.
 */
export class FactoryReactor extends Context.Service<
  FactoryReactor,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Resolves once the boot sweep and every event received so far have been handled, including
     * the steps they fed; the effects those steps queued are `FactoryWorker.drain`'s. Waits for
     * `start`'s tail to subscribe. Tests await this instead of sleeping.
     */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryReactor") {}

type Job = "boot" | FactoryThreadEvent;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const subscribed = yield* Deferred.make<void>();

  const logSkipped = (message: string) => (cause: unknown) =>
    Effect.logWarning(message, cause).pipe(Effect.asVoid);

  /** How the awaited run or its thread ended, as the projection has it; null while it runs. */
  const projectedEnd = (threadId: ThreadId, runId: RunId) =>
    projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map(({ thread, runs }): FactoryThreadEvent | null => {
        if (thread.deletedAt !== null) return { type: "thread.deleted", threadId };
        const status = runs.find((run) => run.id === runId)?.status;
        return status !== undefined && isTerminalRunStatus(status)
          ? { type: "run.finished", threadId, runId, status }
          : null;
      }),
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () =>
          Effect.succeed<FactoryThreadEvent>({ type: "thread.deleted", threadId }),
      }),
    );

  /**
   * Catches one delivery up with what happened while no server ran it. A delivery awaiting a run
   * gets the run's end or its thread's deletion; one awaiting an effect lost it with the previous
   * process and blocks. Deliveries that are not running wait for their owner.
   */
  const reconcile = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      const { awaiting } = state;
      if (state.status !== "running" || awaiting === null) return;
      if (awaiting.type === "effect") {
        yield* worker.failInterruptedEffect(deliveryId);
        return;
      }
      const ended = yield* projectedEnd(awaiting.threadId, awaiting.runId);
      if (ended !== null) yield* worker.step(deliveryId, ended);
    }).pipe(Effect.catchCause(logSkipped("factory delivery reconcile skipped")));

  const bootSweep = deliveries.listActive().pipe(
    Effect.flatMap((active) => Effect.forEach(active, reconcile, { discard: true })),
    Effect.catchCause(logSkipped("factory boot reconcile failed")),
  );

  const jobs = yield* makeDrainableWorker((job: Job) =>
    job === "boot"
      ? bootSweep
      : worker
          .stepThread(job)
          .pipe(Effect.asVoid, Effect.catchCause(logSkipped("factory thread event skipped"))),
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

  // The sweep is queued as the parked tail subscribes, ahead of every event it delivers, rather
  // than while the layer builds: restart recovery ends the runs that were active at shutdown
  // before the server activates, and those events precede the tail. Swept then, a run reads as
  // recovery left it, and whatever happens after the subscription arrives through the tail.
  const start: FactoryReactor["Service"]["start"] = forkParked(
    Stream.runForEach(
      engine.streamDomainEvents.pipe(
        Stream.onStart(
          jobs.enqueue("boot").pipe(Effect.andThen(Deferred.succeed(subscribed, undefined))),
        ),
      ),
      onDomainEvent,
    ).pipe(
      Effect.catchCause(logSkipped("factory thread event stream failed")),
      Effect.ensuring(Deferred.succeed(subscribed, undefined)),
    ),
  );

  return FactoryReactor.of({
    start,
    drain: Deferred.await(subscribed).pipe(Effect.andThen(jobs.drain)),
  });
});

export const layer = Layer.effect(FactoryReactor, make);
