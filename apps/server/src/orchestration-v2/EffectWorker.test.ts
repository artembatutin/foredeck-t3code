import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const replacementSessionId = ProviderSessionId.make(
  "provider-session:effect-worker-restart:replacement",
);
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly steer?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["steer"];
  readonly gate?: (typeof AutomaticTurnGate.AutomaticTurnGate)["Service"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: input.steer ?? (() => Effect.void),
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeed(Option.none()),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartService.ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({ execute: () => Effect.void }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({ respond: () => Effect.void }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  // Fresh, so a test running inside a whole runtime gets this executor rather than the
  // runtime's own, which layer memoization would otherwise hand back.
  return Layer.fresh(EffectWorker.layerExecutor).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
        input.gate === undefined
          ? Layer.empty
          : Layer.succeed(AutomaticTurnGate.AutomaticTurnGate, input.gate),
      ),
    ),
  );
}

it("does not retry pure interrupt races where the turn is already gone", () => {
  assert.isTrue(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ProviderAdapterInterruptError: ... ACP provider turn provider-turn:x is not active",
    ),
  );
  assert.isTrue(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "Provider session provider-session:x is not active.",
    ),
  );
  // Restart is compound (interrupt + detach + start). Do not swallow start failures.
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.restart",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.start",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ACP hard teardown failed unexpectedly; the session is poisoned",
    ),
  );
});

it.effect("settles a stopped run when its adapter has already lost the native turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          cause: "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), ["thread.background-work.settle"]);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          // Model a cancellation commit immediately after this durable read
          // took its snapshot. Its process-local signal is only delivered when
          // the worker registered the waiter before starting the read.
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("requeues a replay-safe claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-settlement-failure";
    const workerId = "worker-replay-safe-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated replay-safe settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retries), 1);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a process-bound executor failure retryable when retry settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-retry-settlement-failure";
    const workerId = "worker-process-bound-retry-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-retry-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-retry-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-retry-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retryAttempts = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      retry: () =>
        Ref.updateAndGet(retryAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutbox.EffectOutboxError({
                    operation: "retry",
                    effectId,
                    cause: "simulated retry settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new EffectWorker.OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated provider execution failure",
            }),
          ),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retryAttempts), 2);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a max-attempt replay-safe failure terminal when fail settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-terminal-settlement-failure";
    const workerId = "worker-replay-safe-terminal-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-terminal-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-terminal-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 5,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const failAttempts = yield* Ref.make(0);
    const retries = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () =>
        Ref.updateAndGet(failAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutbox.EffectOutboxError({
                    operation: "fail",
                    effectId,
                    cause: "simulated terminal settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new EffectWorker.OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated terminal cleanup failure",
            }),
          ),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId, maxAttempts: 5 }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(failAttempts), 2);
    assert.equal(yield* Ref.get(retries), 0);
  }),
);

it.effect("uses durable deadlines, notifications, and a slow liveness poll", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const available = yield* Queue.unbounded<void>();
    const now = yield* DateTime.now;
    const nextClaimableAt = yield* Ref.make<Option.Option<DateTime.Utc>>(
      Option.some(DateTime.add(now, { milliseconds: 100 })),
    );
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Queue.take(available),
      runRecoveryOnce: Effect.succeed(false),
      runOnce: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(attempts, (current) => current + 1);
        if (count === 2) {
          yield* Ref.set(nextClaimableAt, Option.some(DateTime.add(now, { milliseconds: 5_000 })));
        }
        if (count === 3) yield* Ref.set(nextClaimableAt, Option.none());
        return false;
      }),
      nextClaimableAt: Ref.get(nextClaimableAt),
      drain: () => Effect.succeed(0),
    });
    const awaitAttempts = Effect.fnUntraced(function* (expected: number) {
      while ((yield* Ref.get(attempts)) < expected) {
        yield* Effect.yieldNow;
      }
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    yield* awaitAttempts(1);
    yield* TestClock.adjust("99 millis");
    assert.equal(yield* Ref.get(attempts), 1);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(2);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 2);

    yield* Queue.offer(available, undefined);
    yield* awaitAttempts(3);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 3);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(4);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not hot-loop when a claim fails", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(
          new EffectWorker.OrchestrationEffectWorkerError({
            operation: "claim",
            cause: "simulated database failure",
          }),
        ),
      ),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("backs off briefly when a due deadline loses a claim race", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(Effect.as(false)),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("24 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("safely retries after replacement cleanup succeeds and start fails", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const failFirstStart = yield* Ref.make(true);
    const effect = restartEffect(now, {
      type: "replace",
      replacementProviderSessionId: replacementSessionId,
    });
    const layer = layerExecutorFor({ events, failFirstStart });

    const first = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(executor.execute(effect));
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.isFailure(first));

    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(events), [
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
    ]);
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      leaseExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);

/** A gate that records each consult and answers `answer`, or fails undecided. */
type DispatchedCommand = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
>[0];

const answeringGate = (
  consults: Array<AutomaticTurnGate.AutomaticTurn>,
  answer: "admit" | "deferred" | "declined" | "error",
) =>
  AutomaticTurnGate.AutomaticTurnGate.of({
    admit: (turn, dispatch) =>
      Effect.gen(function* () {
        consults.push(turn);
        if (answer === "admit") return AutomaticTurnGate.ran(yield* dispatch);
        if (answer === "error") {
          return yield* new AutomaticTurnGate.AutomaticTurnDecisionError({
            kind: turn.kind,
            thread: turn.threadId,
            stage: "record",
            cause: new Error("the turn could not be recorded"),
          });
        }
        return AutomaticTurnGate.notNow(answer);
      }),
    hand: () => Effect.die("no native wake in these tests"),
  });

const outboxEffect = (
  now: string,
  request: EffectOutbox.OrchestrationEffectV2["request"],
  attemptCount = 1,
): EffectOutbox.OrchestrationEffectV2 => ({
  id: `effect:gated:${request.type}`,
  commandId: CommandId.make(`command:gated:${request.type}`),
  threadId,
  request,
  status: "running",
  attemptCount,
  availableAt: now,
  leaseOwner: "test-worker",
  leaseExpiresAt: now,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  lastError: null,
});

it.effect.each(["cut", "settled"] as const)(
  "retries an undecided continuation of a %s source, then declines it with recovery",
  (source) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const sessionId = ProviderSessionId.make("session:gated-restart");
      // A run the restart cut while its provider turn was still running, or one that had
      // completed waiting on a monitor the restart cancelled.
      const base = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("project:gated-restart"),
          providerInstanceId: instanceId,
          archivedAt: null,
          deletedAt: null,
        },
        runs: [
          {
            id: runId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "gpt-6" },
            providerThreadId,
            activeAttemptId: attemptId,
            status: "cancelled",
          },
        ],
        providerThreads: [
          {
            id: providerThreadId,
            appThreadId: threadId,
            ownerNodeId: null,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: sessionId,
            nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
            status: "active",
          },
        ],
        providerSessions: [
          { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
        ],
        providerTurns: [
          { id: providerTurnId, providerThreadId, runAttemptId: attemptId, status: "running" },
        ],
        runtimeRequests: [],
        attempts: [],
        messages: [],
        turnItems: [],
      };
      const projection = (source === "cut"
        ? base
        : {
            ...base,
            runs: [
              {
                ...base.runs[0]!,
                status: "completed",
                restartCancelledBackgroundWork: [{ kind: "monitor", label: "Watch CI run 42" }],
              },
            ],
            providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
          }) as unknown as OrchestrationV2ThreadProjection;
      const consults: Array<AutomaticTurnGate.AutomaticTurn> = [];
      const commands: Array<DispatchedCommand> = [];
      const recovered: Array<ThreadId> = [];
      const settlements: Array<string> = [];
      const layerExecutor = layerExecutorFor({
        events: yield* Ref.make<ReadonlyArray<string>>([]),
        continueAfterRestart: true,
        gate: answeringGate(consults, "error"),
        threads: {
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: (command) =>
            Effect.sync(() => commands.push(command)).pipe(Effect.as({} as never)),
          recoverDelegatedTask: (childThreadId) => Effect.sync(() => recovered.push(childThreadId)),
        },
      });
      const runAttempt = (attemptCount: number) => {
        const claimed = outboxEffect(
          now,
          { type: "provider-runtime.continue", sourceRunId: runId },
          attemptCount,
        );
        const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
          claimNext: () => Effect.succeed(Option.some(claimed)),
          get: () => Effect.succeed(Option.some(claimed)),
          awaitCancellation: () => Effect.never,
          clearCancellation: () => Effect.void,
          retry: () => Effect.sync(() => settlements.push("retry")).pipe(Effect.as(true)),
          fail: () => Effect.sync(() => settlements.push("fail")).pipe(Effect.as(true)),
          succeed: () => Effect.sync(() => settlements.push("succeed")).pipe(Effect.as(true)),
        });
        return EffectWorker.OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce),
          Effect.provide(
            EffectWorker.layerWithOptions({ workerId: "test-worker", maxAttempts: 5 }).pipe(
              Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
            ),
          ),
        );
      };

      yield* runAttempt(1);
      assert.deepEqual(settlements, ["retry"]);
      assert.deepEqual(recovered, []);
      yield* runAttempt(5);
      assert.deepEqual(settlements, ["retry", "fail"]);
      assert.deepEqual(recovered, [threadId]);
      assert.deepEqual(commands, []);
      assert.deepEqual(
        consults.map((turn) => (turn as AutomaticTurnGate.RestartContinuationTurn).settled),
        [source === "settled", source === "settled"],
      );
    }),
);

const replayModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };

/** A real orchestrator with its command receipts, whose provider turns never run. */
const layerReplayRuntime = ProviderReplayHarness.layerWithRegistry(
  { name: "effect-worker-steer-replay" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId: replayModelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("no provider process in these tests"),
    } as ProviderAdapter.ProviderAdapterV2["Service"],
  ]),
  { runEffectWorker: false },
);

describe("steer follow-ups", () => {
  const steerThreadId = threadId;
  const completedRunId = RunId.make("run:steer-target");
  const parentRunId = RunId.make("run:steer-parent");
  const driver = ProviderDriverKind.make("codex");
  const steerFailed = () =>
    new ProviderTurnControlService.ProviderTurnControlError({
      threadId: steerThreadId,
      operation: "steer",
      providerTurnId,
      turnCompleted: true,
    });
  const steerEffect = (now: string, messageId: MessageId) =>
    outboxEffect(now, {
      type: "provider-turn.steer",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      messageId,
    });
  const projectionWith = (message: Record<string, unknown>) =>
    ({
      thread: { id: steerThreadId, archivedAt: null, deletedAt: null },
      messages: [
        {
          text: "Look at the failing test too.",
          attachments: [],
          runId: completedRunId,
          ...message,
        },
      ],
      runs: [
        {
          id: completedRunId,
          status: "completed",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        },
      ],
      providerThreads: [{ id: providerThreadId, driver }],
    }) as unknown as OrchestrationV2ThreadProjection;

  it.effect.each(["deferred", "declined"] as const)(
    "a held-back completion steer (%s) leaves its mailbox steer undelivered",
    (reason) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const messageId = MessageId.make("message:completion-steer");
        const consults: Array<AutomaticTurnGate.AutomaticTurn> = [];
        const commands: Array<DispatchedCommand> = [];
        const layer = layerExecutorFor({
          events: yield* Ref.make<ReadonlyArray<string>>([]),
          gate: answeringGate(consults, reason),
          steer: () => steerFailed(),
          threads: {
            getThreadRecords: () =>
              Effect.succeed(
                projectionWith({
                  id: messageId,
                  createdBy: "agent",
                  creationSource: "server",
                  delegatedCompletion: { parentRunId, generation: 3, taskIds: [] },
                }),
              ),
            dispatch: (command) =>
              Effect.sync(() => commands.push(command)).pipe(Effect.as({} as never)),
          },
        });
        yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
          Effect.flatMap((executor) => executor.execute(steerEffect(now, messageId))),
          Effect.provide(layer),
        );
        assert.deepEqual(consults, [
          {
            kind: "delegated_completion",
            threadId: steerThreadId,
            messageId,
            key: `${parentRunId}:3:${messageId}`,
            parentRunId,
            generation: 3,
            providerThreadId,
            driver,
            origin: "steer",
          },
        ]);
        assert.deepEqual(commands, []);
      }),
  );

  it.effect("an admitted completion steer follows up pinned to its run", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const messageId = MessageId.make("message:completion-steer-admitted");
      const consults: Array<AutomaticTurnGate.AutomaticTurn> = [];
      const commands: Array<DispatchedCommand> = [];
      const layer = layerExecutorFor({
        events: yield* Ref.make<ReadonlyArray<string>>([]),
        gate: answeringGate(consults, "admit"),
        steer: () => steerFailed(),
        threads: {
          getThreadRecords: () =>
            Effect.succeed(
              projectionWith({
                id: messageId,
                createdBy: "agent",
                creationSource: "server",
                delegatedCompletion: { parentRunId, generation: 1, taskIds: [] },
              }),
            ),
          dispatch: (command) =>
            Effect.sync(() => commands.push(command)).pipe(Effect.as({} as never)),
        },
      });
      yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
        Effect.flatMap((executor) => executor.execute(steerEffect(now, messageId))),
        Effect.provide(layer),
      );
      assert.lengthOf(consults, 1);
      assert.lengthOf(commands, 1);
      const followUp = commands[0]!;
      assert.equal(followUp.type, "message.dispatch");
      if (followUp.type !== "message.dispatch") return;
      assert.equal(followUp.messageId, messageId);
      assert.deepEqual(followUp.dispatchMode, { type: "queue_after_active" });
      assert.deepEqual(followUp.delegatedCompletion, { parentRunId, generation: 1, taskIds: [] });
    }),
  );

  it.effect.each([
    ["an owner", { createdBy: "user", creationSource: "web" }],
    ["an agent", { createdBy: "agent", creationSource: "mcp", sender: true }],
  ] as const)(
    "%s steer follows up inline without asking the gate, and a replay creates nothing",
    ([_who, source]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const name = source.creationSource;
        const steeredThreadId = ThreadId.make(`thread:steer-replay-${name}`);
        const senderThreadId = ThreadId.make(`thread:steer-replay-sender-${name}`);
        for (const id of [steeredThreadId, senderThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: id,
            projectId: ProjectId.make("project:steer-replay"),
            title: "Steered",
            modelSelection: replayModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`start:${steeredThreadId}`),
          threadId: steeredThreadId,
          messageId: MessageId.make(`message:steer-replay-first-${name}`),
          text: "Fix the failing test.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const target = (yield* orchestrator.getThreadProjection(steeredThreadId)).runs[0]!;
        // The steer reached the run after its turn had completed.
        const messageId = MessageId.make(`message:steer-replay-${name}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`event:steer-replay-completed-${name}`),
              type: "run.updated",
              threadId: steeredThreadId,
              runId: target.id,
              occurredAt: now,
              payload: { ...target, status: "completed", startedAt: now, completedAt: now },
            },
            {
              id: EventId.make(`event:steer-replay-message-${name}`),
              type: "message.updated",
              threadId: steeredThreadId,
              runId: target.id,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId: steeredThreadId,
                runId: target.id,
                nodeId: target.rootNodeId,
                role: "user",
                text: "Look at the failing test too.",
                attachments: [],
                streaming: false,
                createdBy: source.createdBy,
                creationSource: source.creationSource,
                ...("sender" in source ? { senderThreadId } : {}),
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        const consults: Array<AutomaticTurnGate.AutomaticTurn> = [];
        const execute = EffectWorker.OrchestrationEffectExecutorV2.pipe(
          Effect.flatMap((executor) =>
            executor.execute({
              ...steerEffect(DateTime.formatIso(now), messageId),
              threadId: steeredThreadId,
            }),
          ),
          Effect.provide(
            layerExecutorFor({
              events: yield* Ref.make<ReadonlyArray<string>>([]),
              gate: answeringGate(consults, "declined"),
              steer: () => steerFailed(),
              threads: {
                getThreadRecords: orchestrator.getThreadRecords,
                dispatch: orchestrator.dispatch,
              },
            }),
          ),
        );
        const followUps = Effect.map(
          orchestrator.getThreadProjection(steeredThreadId),
          (projection) => ({
            runs: projection.runs.filter((run) => run.userMessageId === messageId).length,
            messages: projection.messages.filter((message) => message.role === "user").length,
            message: projection.messages.find((message) => message.id === messageId),
          }),
        );

        yield* execute;
        const first = yield* followUps;
        assert.equal(first.runs, 1);
        assert.equal(first.messages, 2);
        assert.equal(first.message?.createdBy, source.createdBy);
        assert.equal(first.message?.creationSource, source.creationSource);
        assert.equal(
          first.message?.senderThreadId,
          "sender" in source ? senderThreadId : undefined,
        );
        // A replay reuses the follow-up's command, whose receipt makes it create nothing.
        yield* execute;
        assert.deepEqual(yield* followUps, first);
        assert.deepEqual(consults, []);
      }).pipe(Effect.provide(layerReplayRuntime)),
  );
});
