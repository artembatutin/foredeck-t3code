// Loads before ThreadManagementService: the fork's assistant role, which CodexAdapterV2 imports,
// reaches the MCP services that import ThreadManagementService back. Entered there first, that
// cycle runs OrchestratorMcpService before ThreadManagementService has defined its errors.
import "./Adapters/CodexAdapterV2.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Notification,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-provider-continuation");
const providerThreadId = ProviderThreadId.make("provider-thread-continuation");
const driver = ProviderDriverKind.make("continuation-test");
const parentRunId = RunId.make("run-provider-continuation-parent");
const delegatedMessageId = MessageId.make("message-provider-continuation-delegated");
const projection = {
  thread: { archivedAt: null, deletedAt: null },
  messages: [],
} as unknown as OrchestrationV2ThreadProjection;

const request = (
  dispatchIfCurrent?: ProviderContinuationRequests.ProviderContinuationRequest["dispatchIfCurrent"],
  detail: string | null = null,
): ProviderContinuationRequests.ProviderContinuationRequest => ({
  threadId,
  providerThreadId,
  driver,
  detail,
  ...(dispatchIfCurrent === undefined ? {} : { dispatchIfCurrent }),
});

const delegatedProjection = (disposition: "open" | "stopped" | "disposed" = "open") =>
  ({
    ...projection,
    runs: [
      {
        id: parentRunId,
        delegatedCompletion: {
          disposition,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: delegatedMessageId,
            taskIds: ["node-provider-continuation-first", "node-provider-continuation-second"],
          },
        },
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

const makeGuard = Effect.fnUntraced(function* (completed?: Deferred.Deferred<void>) {
  const generation = yield* Ref.make(0);
  const permit = yield* Semaphore.make(1);
  const capture = Effect.gen(function* () {
    const captured = yield* Ref.updateAndGet(generation, (value) => value + 1);
    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit
        .withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(generation)) !== captured) return Option.none();
            return Option.some(yield* effect);
          }),
        )
        .pipe(
          completed === undefined
            ? (effect) => effect
            : Effect.ensuring(Deferred.succeed(completed, undefined)),
        );
  });
  return {
    capture,
    invalidate: permit.withPermit(Ref.update(generation, (value) => value + 1)),
  };
});

function layerTest(input: {
  readonly dispatched: Queue.Queue<unknown>;
  readonly getThreadRecords: () => Effect.Effect<OrchestrationV2ThreadProjection>;
  readonly dispatch?: ThreadManagementService.ThreadManagementService["Service"]["dispatch"];
  readonly gate?: (typeof AutomaticTurnGate.AutomaticTurnGate)["Service"];
  readonly beforeDispatch?: (threadId: ThreadId) => Effect.Effect<void>;
}) {
  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: input.getThreadRecords,
    dispatch:
      input.dispatch ??
      ((command) =>
        (
          ("threadId" in command ? input.beforeDispatch?.(command.threadId) : undefined) ??
          Effect.void
        ).pipe(Effect.andThen(Queue.offer(input.dispatched, command)), Effect.as({} as never))),
  });
  const layerWorker = ProviderContinuationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        ProviderContinuationRequests.layer,
        layerThreads,
        input.gate === undefined
          ? Layer.empty
          : Layer.succeed(AutomaticTurnGate.AutomaticTurnGate, input.gate),
      ),
    ),
  );
  return Layer.merge(ProviderContinuationRequests.layer, layerWorker);
}

/** Lets every runnable fiber run, so a retry has scheduled its backoff before time moves. */
const settle = Effect.forEach(Array.from({ length: 5 }), () => Effect.yieldNow, { discard: true });

type Step = "error" | "admit" | "deferred" | "declined";

/**
 * A gate that answers consults with `script` in order, its last step from then on, and offers
 * each consult on `consults`. An admitted turn's dispatch runs inline.
 */
const scriptedGate = (
  consults: Queue.Queue<AutomaticTurnGate.AutomaticTurn>,
  script: ReadonlyArray<Step>,
) => {
  let index = 0;
  const decide = <A, E, R>(
    turn: AutomaticTurnGate.AutomaticTurn,
    dispatch: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      yield* Queue.offer(consults, turn);
      if (step === "admit") return AutomaticTurnGate.ran(yield* dispatch);
      if (step === "error") {
        return yield* new AutomaticTurnGate.AutomaticTurnDecisionError({
          kind: turn.kind,
          thread: turn.threadId,
          stage: "record",
          cause: new Error("the turn could not be recorded"),
        });
      }
      return AutomaticTurnGate.notNow(step);
    });
  return AutomaticTurnGate.AutomaticTurnGate.of({
    admit: (turn, dispatch) => decide(turn, dispatch),
    hand: (turn, dispatch) => decide(turn, dispatch),
  });
};

interface Kept {
  readonly turn: AutomaticTurnGate.BackgroundWakeTurn;
  readonly dispatch: Effect.Effect<void>;
  readonly drop: Effect.Effect<void> | undefined;
}

/** A gate that keeps every native wake's dispatch and drop for the test to run. */
const keepingGate = (kept: Queue.Queue<Kept>) =>
  AutomaticTurnGate.AutomaticTurnGate.of({
    admit: () => Effect.die("only native wakes are kept"),
    hand: (turn, dispatch, options) =>
      Queue.offer(kept, {
        turn,
        dispatch: Effect.asVoid(Effect.orDie(dispatch)),
        drop: options.drop,
      }).pipe(Effect.as(AutomaticTurnGate.notNow("deferred"))),
  });

/** An adapter's sticky offer: current until cleared, counting each callback. */
const makeOffer = Effect.fnUntraced(function* () {
  const current = yield* Ref.make(true);
  const dispatchCalls = yield* Ref.make(0);
  const clearCalls = yield* Ref.make(0);
  const dispatchIfCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Ref.update(dispatchCalls, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(current)),
      Effect.flatMap((isCurrent) =>
        isCurrent ? Effect.asSome(effect) : Effect.succeed(Option.none<A>()),
      ),
    );
  const clearIfCurrent = () =>
    Ref.update(clearCalls, (count) => count + 1).pipe(Effect.andThen(Ref.set(current, false)));
  return {
    dispatchIfCurrent,
    clearIfCurrent,
    /** Makes the offer current again, as an adapter's next buffered wake does. */
    rearm: Ref.set(current, true),
    calls: Effect.all({ dispatch: Ref.get(dispatchCalls), clear: Ref.get(clearCalls) }),
  };
});

describe("ProviderContinuationService", () => {
  it.effect("recovers an unaccepted persisted steer using the same delivery identity", () =>
    Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const original = delegatedProjection();
      const interruptedRunId = RunId.make("interrupted-mailbox-run");
      const recovered = {
        ...original,
        runs: [
          ...original.runs,
          {
            id: interruptedRunId,
            status: "interrupted",
            userMessageId: MessageId.make("original-user-input"),
          },
        ],
        messages: [
          {
            id: delegatedMessageId,
            runId: interruptedRunId,
            delegatedCompletion: { parentRunId, generation: 1, taskIds: [] },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: { parentRunId, generation: 1, messageId: delegatedMessageId },
        });
        const command = (yield* Queue.take(dispatched)) as {
          messageId: MessageId;
          delegatedCompletion: { generation: number; taskIds: readonly string[] };
        };
        assert.equal(command.messageId, delegatedMessageId);
        assert.equal(command.delegatedCompletion.generation, 1);
        assert.equal(command.delegatedCompletion.taskIds.length, 2);
      }).pipe(
        Effect.provide(
          layerTest({ dispatched, getThreadRecords: () => Effect.succeed(recovered) }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("delivers a message_text wake as a real prompt, not a buffered wake", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: "Delegated task completed.",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor updated",
          },
          delivery: "message_text",
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly creationSource: string;
          readonly text: string;
          readonly notification: OrchestrationV2Notification;
        };
        assert.notEqual(command.creationSource, "provider");
        assert.equal(command.creationSource, "server");
        assert.equal(command.text, "Delegated task completed.");
        assert.deepEqual(command.notification, {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: "Monitor updated",
        });
      }).pipe(
        Effect.provide(
          layerTest({ dispatched, getThreadRecords: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("dispatches a current delegated completion as one server-owned queued message", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly createdBy: string;
          readonly creationSource: string;
          readonly delegatedCompletion: {
            readonly generation: number;
            readonly parentRunId: RunId;
            readonly taskIds: ReadonlyArray<string>;
          };
          readonly dispatchMode: { readonly type: string };
          readonly messageId: MessageId;
          readonly text: string;
        };
        assert.equal(command.createdBy, "agent");
        assert.equal(command.creationSource, "server");
        assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
        assert.equal(command.messageId, delegatedMessageId);
        assert.equal(command.delegatedCompletion.parentRunId, parentRunId);
        assert.equal(command.delegatedCompletion.generation, 1);
        assert.deepEqual(command.delegatedCompletion.taskIds, [
          "node-provider-continuation-first",
          "node-provider-continuation-second",
        ]);
        assert.include(command.text, "task_status");
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () => Effect.succeed(delegatedProjection()),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect(
    "a project-disabled instance refuses a delegated-completion wake exactly once, disposes it, and never retries",
    () => {
      return Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const cleared = yield* Ref.make(false);
        const disposed = yield* Queue.unbounded<unknown>();
        const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(delegatedProjection()),
          dispatch: (command) => {
            if ((command as { type: string }).type === "message.dispatch") {
              return Ref.update(attempts, (count) => count + 1).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                      projectId: ProjectId.make("project-provider-continuation-disabled"),
                      instanceId: ProviderInstanceId.make(
                        "instance-provider-continuation-disabled",
                      ),
                    }) as never,
                  ),
                ),
              );
            }
            return Queue.offer(disposed, command).pipe(Effect.as({} as never));
          },
        });
        const layerWorker = ProviderContinuationService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer, layerThreads),
          ),
        );

        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer({
            threadId,
            providerThreadId,
            driver,
            detail: null,
            delivery: "message_text",
            clearIfCurrent: () => Ref.set(cleared, true),
            delegatedCompletion: {
              parentRunId,
              generation: 1,
              messageId: delegatedMessageId,
            },
          });
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 1);
          assert.isTrue(yield* Ref.get(cleared));

          const dispositions = (yield* Queue.takeAll(disposed)) as ReadonlyArray<{
            type: string;
            taskId: string;
          }>;
          assert.deepEqual(
            dispositions.map((command) => command.taskId),
            ["node-provider-continuation-first", "node-provider-continuation-second"],
          );
          for (const command of dispositions) {
            assert.equal(command.type, "delegated_task.completion-delivery.dispose");
          }

          yield* TestClock.adjust("1 hour");
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 1);
          assert.equal(yield* Queue.size(disposed), 0);
        }).pipe(
          Effect.provide(Layer.merge(ProviderContinuationRequests.layer, layerWorker)),
          Effect.scoped,
        );
      });
    },
  );

  it.effect(
    "clears the adapter's sticky continuation flag when a non-delegated wake is refused",
    () => {
      return Effect.gen(function* () {
        const requested = yield* Ref.make(true);
        const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId: ProjectId.make("project-provider-continuation-disabled"),
                instanceId: ProviderInstanceId.make("instance-provider-continuation-disabled"),
              }) as never,
            ),
        });
        const layerWorker = ProviderContinuationService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer, layerThreads),
          ),
        );

        // ACP clears its sticky continuation flag on raw dispatch failure; pre-recovery would prevent that cleanup.
        const dispatchIfCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(effect);
            if (Exit.isFailure(exit)) {
              yield* Ref.set(requested, false);
              return yield* Effect.failCause(exit.cause);
            }
            return Option.some(exit.value);
          });

        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer(request(dispatchIfCurrent));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.isFalse(
            yield* Ref.get(requested),
            "a disabled instance must still clear the adapter's sticky offer flag",
          );
        }).pipe(
          Effect.provide(Layer.merge(ProviderContinuationRequests.layer, layerWorker)),
          Effect.scoped,
        );
      });
    },
  );

  it.effect(
    "clears a sticky continuation offer for an adapter whose dispatchIfCurrent does not self-clear on failure",
    () => {
      return Effect.gen(function* () {
        const wakeHeld = yield* Ref.make(true);
        const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId: ProjectId.make("project-provider-continuation-disabled"),
                instanceId: ProviderInstanceId.make("instance-provider-continuation-disabled"),
              }) as never,
            ),
        });
        const layerWorker = ProviderContinuationService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer, layerThreads),
          ),
        );

        // Muse forwards dispatch failures unchanged; clearIfCurrent must release its sticky wake flag.
        const dispatchIfCurrent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.asSome(effect);

        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer({
            ...request(dispatchIfCurrent),
            clearIfCurrent: () => Ref.set(wakeHeld, false),
          });
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.isFalse(
            yield* Ref.get(wakeHeld),
            "a disabled instance must clear the offer via the explicit callback " +
              "when the adapter itself does not clear on dispatch failure",
          );
        }).pipe(
          Effect.provide(Layer.merge(ProviderContinuationRequests.layer, layerWorker)),
          Effect.scoped,
        );
      });
    },
  );

  it.effect(
    "clears a sticky continuation offer when a non-delegated wake dispatch fails generically",
    () => {
      return Effect.gen(function* () {
        const cleared = yield* Deferred.make<void>();
        const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: (command) =>
            Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: CommandId.make(String(command.commandId)),
                commandType: command.type,
                cause: new Error("SQLITE_FULL: database or disk is full"),
              }),
            ),
        });
        const layerWorker = ProviderContinuationService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer, layerThreads),
          ),
        );

        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer({
            ...request(),
            clearIfCurrent: () => Deferred.succeed(cleared, undefined),
          });
          yield* Deferred.await(cleared);
        }).pipe(
          Effect.provide(Layer.merge(ProviderContinuationRequests.layer, layerWorker)),
          Effect.scoped,
        );
      });
    },
  );

  it.effect(
    "drops stopped and disposed delegated completions instead of reviving them after recovery",
    () => {
      return Effect.gen(function* () {
        for (const disposition of ["stopped", "disposed"] as const) {
          const dispatched = yield* Queue.unbounded<unknown>();
          yield* Effect.gen(function* () {
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            yield* requests.offer({
              threadId,
              providerThreadId,
              driver,
              detail: null,
              delivery: "message_text",
              delegatedCompletion: {
                parentRunId,
                generation: 1,
                messageId: delegatedMessageId,
              },
            });
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
          }).pipe(
            Effect.provide(
              layerTest({
                dispatched,
                getThreadRecords: () => Effect.succeed(delegatedProjection(disposition)),
              }),
            ),
            Effect.scoped,
          );
        }
      });
    },
  );

  it.effect("does not redispatch a persisted delegated completion message during recovery", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () =>
              Effect.succeed({
                ...delegatedProjection(),
                messages: [{ id: delegatedMessageId }],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("dispatches a current request exactly once", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer(request());
        yield* Queue.take(dispatched);
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          layerTest({ dispatched, getThreadRecords: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("drops a request invalidated while projection is blocked", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const projectionEntered = yield* Deferred.make<void>();
      const releaseProjection = yield* Deferred.make<void>();
      const guardCompleted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const guard = yield* makeGuard(guardCompleted);
        const dispatchIfCurrent = yield* guard.capture;
        yield* requests.offer(request(dispatchIfCurrent));
        yield* Deferred.await(projectionEntered);
        yield* guard.invalidate;
        yield* Deferred.succeed(releaseProjection, undefined);
        yield* Deferred.await(guardCompleted);
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () =>
              Deferred.succeed(projectionEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProjection)),
                Effect.as(projection),
              ),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("does not revive an old request when a later generation is current", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const firstProjectionEntered = yield* Deferred.make<void>();
      const releaseFirstProjection = yield* Deferred.make<void>();
      let projectionCalls = 0;
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const guard = yield* makeGuard();
        const first = yield* guard.capture;
        yield* requests.offer(request(first, "A"));
        yield* Deferred.await(firstProjectionEntered);
        const second = yield* guard.capture;
        yield* requests.offer(request(second, "B"));
        yield* Deferred.succeed(releaseFirstProjection, undefined);
        const command = yield* Queue.take(dispatched);
        assert.equal((command as { readonly text?: unknown }).text, "B");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () => {
              projectionCalls += 1;
              return projectionCalls === 1
                ? Deferred.succeed(firstProjectionEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstProjection)),
                    Effect.as(projection),
                  )
                : Effect.succeed(projection);
            },
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("a held-back completion leaves its cohort open and forgets its retry backoff", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const consults = yield* Queue.unbounded<AutomaticTurnGate.AutomaticTurn>();
      const completion = {
        threadId,
        providerThreadId,
        driver,
        detail: null,
        delivery: "message_text" as const,
        delegatedCompletion: { parentRunId, generation: 1, messageId: delegatedMessageId },
      };
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        // Undecided, then held back: the retry ends there, dispatching nothing.
        yield* requests.offer(completion);
        const turn = yield* Queue.take(consults);
        assert.deepEqual(turn, {
          kind: "delegated_completion",
          threadId,
          messageId: delegatedMessageId,
          key: `${parentRunId}:1:${delegatedMessageId}`,
          parentRunId,
          generation: 1,
          providerThreadId,
          driver,
          origin: "offer",
        });
        yield* settle;
        yield* TestClock.adjust("100 millis");
        assert.equal((yield* Queue.take(consults)).kind, "delegated_completion");
        yield* settle;
        yield* TestClock.adjust("1 hour");
        yield* settle;
        assert.isTrue(Option.isNone(yield* Queue.poll(consults)));
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));

        // A later offer starts the backoff over: its retry comes after the first step again.
        yield* requests.offer(completion);
        yield* Queue.take(consults);
        yield* settle;
        yield* TestClock.adjust("100 millis");
        yield* Queue.take(consults);
        yield* settle;
        const command = (yield* Queue.take(dispatched)) as { readonly messageId: MessageId };
        assert.equal(command.messageId, delegatedMessageId);
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () => Effect.succeed(delegatedProjection()),
            gate: scriptedGate(consults, ["error", "deferred", "error", "admit"]),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("retries an undecided completion with backoff and dispatches it once", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const consults = yield* Queue.unbounded<AutomaticTurnGate.AutomaticTurn>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: { parentRunId, generation: 1, messageId: delegatedMessageId },
        });
        for (const delay of [100, 200]) {
          yield* Queue.take(consults);
          yield* settle;
          assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
          yield* TestClock.adjust(`${delay - 1} millis`);
          yield* settle;
          assert.isTrue(Option.isNone(yield* Queue.poll(consults)));
          yield* TestClock.adjust("1 millis");
        }
        yield* Queue.take(consults);
        const command = (yield* Queue.take(dispatched)) as { readonly messageId: MessageId };
        assert.equal(command.messageId, delegatedMessageId);
        yield* settle;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () => Effect.succeed(delegatedProjection()),
            gate: scriptedGate(consults, ["error", "error", "admit"]),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect.each([
    ["callback-free", false],
    ["callback-bearing", true],
  ] as const)("keeps a %s native wake until the gate runs or drops it", ([_shape, callbacks]) => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const kept = yield* Queue.unbounded<Kept>();
      const thread = yield* Ref.make<"live" | "archived" | "deleted">("live");
      const offer = yield* makeOffer();
      const wake = callbacks
        ? {
            ...request(offer.dispatchIfCurrent),
            clearIfCurrent: offer.clearIfCurrent,
          }
        : request();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer(wake);
        const first = yield* Queue.take(kept);
        assert.deepEqual(first.turn, {
          kind: "background_wake",
          threadId,
          messageId: first.turn.messageId,
          key: first.turn.messageId,
          providerThreadId,
          driver,
          clearable: callbacks,
        });
        assert.equal(first.drop === undefined, !callbacks);
        // Kept: no run, and the adapter's offer stays as it was.
        yield* settle;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
        assert.deepEqual(yield* offer.calls, { dispatch: 0, clear: 0 });

        // Run later while the offer is current, it dispatches once under the kept id.
        yield* first.dispatch;
        const command = (yield* Queue.take(dispatched)) as { readonly messageId: MessageId };
        assert.equal(command.messageId, first.turn.messageId);

        // Archived or deleted meanwhile, a kept wake starts nothing and lets the offer go.
        for (const barrier of ["archived", "deleted"] as const) {
          yield* offer.rearm;
          yield* requests.offer(wake);
          const later = yield* Queue.take(kept);
          const clearsBefore = (yield* offer.calls).clear;
          yield* Ref.set(thread, barrier);
          yield* later.dispatch;
          yield* Ref.set(thread, "live");
          assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
          assert.equal((yield* offer.calls).clear, clearsBefore + (callbacks ? 1 : 0));
        }

        if (callbacks) {
          // Dropping clears the adapter's offer, after which a kept dispatch starts nothing.
          yield* offer.rearm;
          yield* requests.offer(wake);
          const third = yield* Queue.take(kept);
          const clearsBefore = (yield* offer.calls).clear;
          yield* third.drop!;
          assert.equal((yield* offer.calls).clear, clearsBefore + 1);
          yield* third.dispatch;
          assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
        }
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () =>
              Ref.get(thread).pipe(
                Effect.map((state) =>
                  state === "live"
                    ? projection
                    : ({
                        ...projection,
                        thread: {
                          ...projection.thread,
                          [state === "archived" ? "archivedAt" : "deletedAt"]: DateTime.makeUnsafe(
                            "2026-10-29T00:00:00.000Z",
                          ),
                        },
                      } as OrchestrationV2ThreadProjection),
                ),
              ),
            gate: keepingGate(kept),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect.each(
    (["callback-free", "callback-bearing"] as const).flatMap((shape) =>
      (["admit", "deferred"] as const).map((decided) => [shape, decided] as const),
    ),
  )(
    "re-offers an undecided %s native wake under its id until it is decided (%s)",
    ([shape, decided]) => {
      return Effect.gen(function* () {
        const dispatched = yield* Queue.unbounded<unknown>();
        const consults = yield* Queue.unbounded<AutomaticTurnGate.AutomaticTurn>();
        const offer = yield* makeOffer();
        const wake =
          shape === "callback-bearing"
            ? { ...request(offer.dispatchIfCurrent), clearIfCurrent: offer.clearIfCurrent }
            : request();
        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer(wake);
          const first = yield* Queue.take(consults);
          for (const delay of [100, 200, 400]) {
            yield* settle;
            assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
            assert.deepEqual(yield* offer.calls, { dispatch: 0, clear: 0 });
            yield* TestClock.adjust(`${delay - 1} millis`);
            yield* settle;
            assert.isTrue(Option.isNone(yield* Queue.poll(consults)));
            yield* TestClock.adjust("1 millis");
            assert.equal((yield* Queue.take(consults)).messageId, first.messageId);
          }
          yield* settle;
          if (decided === "admit") {
            const command = (yield* Queue.take(dispatched)) as { readonly messageId: MessageId };
            assert.equal(command.messageId, first.messageId);
            assert.deepEqual(yield* offer.calls, {
              dispatch: shape === "callback-bearing" ? 1 : 0,
              clear: 0,
            });
          } else {
            assert.deepEqual(yield* offer.calls, { dispatch: 0, clear: 0 });
          }
          assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));

          // Decided, the wake's backoff is forgotten: undecided again, it retries after one step.
          yield* requests.offer({ ...wake, messageId: first.messageId });
          yield* Queue.take(consults);
          yield* settle;
          yield* TestClock.adjust("100 millis");
          assert.equal((yield* Queue.take(consults)).messageId, first.messageId);
        }).pipe(
          Effect.provide(
            layerTest({
              dispatched,
              getThreadRecords: () => Effect.succeed(projection),
              gate: scriptedGate(consults, ["error", "error", "error", decided, "error"]),
            }),
          ),
          Effect.scoped,
        );
      });
    },
  );

  it.effect("keeps instance-disabled and retry handling on admitted turns", () => {
    return Effect.gen(function* () {
      const consults = yield* Queue.unbounded<AutomaticTurnGate.AutomaticTurn>();
      const dispatched = yield* Queue.unbounded<unknown>();
      const offer = yield* makeOffer();
      const attempts = yield* Ref.make(0);
      const disabled = new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
        projectId: ProjectId.make("project-provider-continuation-disabled"),
        instanceId: ProviderInstanceId.make("instance-provider-continuation-disabled"),
      });
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        // An admitted native wake on a disabled instance clears the adapter's offer.
        yield* requests.offer({
          ...request(offer.dispatchIfCurrent),
          clearIfCurrent: offer.clearIfCurrent,
        });
        yield* Queue.take(consults);
        yield* settle;
        assert.deepEqual(yield* offer.calls, { dispatch: 1, clear: 1 });

        // An admitted completion whose dispatch fails is retried and lands once.
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: { parentRunId, generation: 1, messageId: delegatedMessageId },
        });
        yield* Queue.take(consults);
        yield* settle;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
        yield* TestClock.adjust("100 millis");
        yield* Queue.take(consults);
        const command = (yield* Queue.take(dispatched)) as { readonly messageId: MessageId };
        assert.equal(command.messageId, delegatedMessageId);
      }).pipe(
        Effect.provide(
          layerTest({
            dispatched,
            getThreadRecords: () => Effect.succeed(delegatedProjection()),
            dispatch: (command) =>
              command.type === "message.dispatch" && command.delegatedCompletion === undefined
                ? Effect.fail(disabled)
                : Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
                    Effect.flatMap((attempt) =>
                      attempt === 0
                        ? Effect.fail(new Error("simulated transient dispatch failure") as never)
                        : Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
                    ),
                  ),
            gate: scriptedGate(consults, ["admit"]),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect(
    "a wake held by another thread's parent lock does not delay other threads' wakes",
    () => {
      return Effect.gen(function* () {
        const dispatched = yield* Queue.unbounded<unknown>();
        const blockedChildId = ThreadId.make("thread-provider-continuation-blocked-child");
        const dispatchedAt = new Map<ThreadId, number>();
        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          yield* requests.offer({ ...request(), threadId: blockedChildId });
          yield* requests.offer(request());
          yield* TestClock.adjust("10 minutes");
          yield* Queue.take(dispatched);
          yield* Queue.take(dispatched);
          assert.equal(dispatchedAt.get(blockedChildId), 10 * 60 * 1000);
          assert.equal(dispatchedAt.get(threadId), 0);
        }).pipe(
          Effect.provide(
            layerTest({
              dispatched,
              getThreadRecords: () => Effect.succeed(projection),
              // Models the child's message intake waiting on its coordinator's dispatch lock.
              beforeDispatch: (dispatchThreadId) =>
                (dispatchThreadId === blockedChildId
                  ? Effect.sleep("10 minutes")
                  : Effect.void
                ).pipe(
                  Effect.andThen(Clock.currentTimeMillis),
                  Effect.map((now) => void dispatchedAt.set(dispatchThreadId, now)),
                ),
            }),
          ),
          Effect.scoped,
        );
      });
    },
  );
});
