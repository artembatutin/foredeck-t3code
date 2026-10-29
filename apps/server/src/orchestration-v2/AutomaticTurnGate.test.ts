import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";

const threadId = ThreadId.make("thread:automatic-turn-gate");
const continuation: AutomaticTurnGate.RestartContinuationTurn = {
  kind: "restart_continuation",
  threadId,
  messageId: MessageId.make("message:restart-continuation:run:gate"),
  key: "run:gate",
  sourceRunId: RunId.make("run:gate"),
  settled: false,
};
const wake: AutomaticTurnGate.BackgroundWakeTurn = {
  kind: "background_wake",
  threadId,
  messageId: MessageId.make("message:native-wake"),
  key: "message:native-wake",
  providerThreadId: ProviderThreadId.make("provider-thread:gate"),
  driver: ProviderDriverKind.make("claudeAgent"),
  clearable: true,
};

interface Consult {
  readonly turn: AutomaticTurnGate.AutomaticTurn;
  readonly drop: Effect.Effect<void> | undefined;
}

/** A gate implementation that records each consult and answers `answer`, dispatching nothing. */
const recordingGate = (answer: AutomaticTurnGate.AutomaticTurnOutcome<never>) =>
  Effect.gen(function* () {
    const consults = yield* Ref.make<ReadonlyArray<Consult>>([]);
    const record = (turn: AutomaticTurnGate.AutomaticTurn, drop?: Effect.Effect<void>) =>
      Ref.update(consults, (current) => [...current, { turn, drop }]).pipe(Effect.as(answer));
    const gate = AutomaticTurnGate.AutomaticTurnGate.of({
      admit: (turn) => record(turn),
      hand: (turn, _dispatch, options) => record(turn, options.drop),
    });
    return { gate, consults: Ref.get(consults) };
  });

/** Lets every runnable fiber run, so one still suspended is waiting on something. */
const settle = Effect.forEach(Array.from({ length: 5 }), () => Effect.yieldNow, { discard: true });

describe("AutomaticTurnGate", () => {
  it.effect("runs every turn inline by default", () =>
    Effect.gen(function* () {
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const dispatched = yield* Ref.make(0);
      const dropped = yield* Ref.make(0);
      const dispatch = Ref.updateAndGet(dispatched, (count) => count + 1);
      assert.deepEqual(yield* gate.admit(continuation, dispatch), AutomaticTurnGate.ran(1));
      assert.deepEqual(
        yield* gate.hand(wake, dispatch, { drop: Ref.update(dropped, (count) => count + 1) }),
        AutomaticTurnGate.ran(2),
      );
      assert.equal(yield* Ref.get(dropped), 0);
      // A failing dispatch fails the consult unchanged, as the producer's own dispatch did.
      const failure = yield* gate
        .admit(continuation, Effect.fail("refused" as const))
        .pipe(Effect.flip);
      assert.equal(failure, "refused");
    }),
  );

  it.effect("holds consults until a gate is installed, and again once it is uninstalled", () =>
    Effect.gen(function* () {
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const installer = yield* AutomaticTurnGate.AutomaticTurnGateInstaller;
      const dispatched = yield* Deferred.make<void>();

      // Before any install a consult waits, deciding and dispatching nothing.
      const waiting = yield* gate
        .admit(continuation, Deferred.succeed(dispatched, undefined))
        .pipe(Effect.forkChild);
      yield* settle;
      assert.isUndefined(waiting.pollUnsafe());

      const first = yield* recordingGate(AutomaticTurnGate.notNow("deferred"));
      const installed = yield* Scope.make();
      yield* installer.install(first.gate).pipe(Scope.provide(installed));
      assert.deepEqual(yield* Fiber.join(waiting), AutomaticTurnGate.notNow("deferred"));
      assert.isFalse(yield* Deferred.isDone(dispatched));
      // Each turn reaches the implementation as presented, a native wake with its drop.
      const drop = Effect.void;
      yield* gate.hand(wake, Effect.void, { drop });
      assert.deepEqual(yield* first.consults, [
        { turn: continuation, drop: undefined },
        { turn: wake, drop },
      ]);

      // Uninstalled, the gate holds consults again; the old implementation never sees them.
      yield* Scope.close(installed, Exit.void);
      const held = yield* gate.admit(continuation, Effect.void).pipe(Effect.forkChild);
      yield* settle;
      assert.isUndefined(held.pollUnsafe());

      const second = yield* recordingGate(AutomaticTurnGate.notNow("declined"));
      yield* installer.install(second.gate).pipe(Scope.provide(yield* Scope.make()));
      assert.deepEqual(yield* Fiber.join(held), AutomaticTurnGate.notNow("declined"));
      assert.lengthOf(yield* first.consults, 2);
      assert.deepEqual(yield* second.consults, [{ turn: continuation, drop: undefined }]);
    }).pipe(Effect.provide(AutomaticTurnGate.layerInstallable)),
  );

  it.effect("routes consults to the latest install until it is uninstalled", () =>
    Effect.gen(function* () {
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const installer = yield* AutomaticTurnGate.AutomaticTurnGateInstaller;
      const earlier = yield* recordingGate(AutomaticTurnGate.notNow("deferred"));
      const later = yield* recordingGate(AutomaticTurnGate.notNow("declined"));
      const earlierScope = yield* Scope.make();
      const laterScope = yield* Scope.make();
      yield* installer.install(earlier.gate).pipe(Scope.provide(earlierScope));
      yield* installer.install(later.gate).pipe(Scope.provide(laterScope));

      // Uninstalling the replaced implementation leaves the later one in place.
      yield* Scope.close(earlierScope, Exit.void);
      assert.deepEqual(
        yield* gate.admit(continuation, Effect.void),
        AutomaticTurnGate.notNow("declined"),
      );
      assert.lengthOf(yield* earlier.consults, 0);

      yield* Scope.close(laterScope, Exit.void);
      const held = yield* gate.admit(continuation, Effect.void).pipe(Effect.forkChild);
      yield* settle;
      assert.isUndefined(held.pollUnsafe());
      yield* Fiber.interrupt(held);
      assert.lengthOf(yield* later.consults, 1);
    }).pipe(Effect.provide(AutomaticTurnGate.layerInstallable)),
  );

  it.effect("fails an undecided consult with only the turn's kind, thread, stage and cause", () =>
    Effect.gen(function* () {
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const installer = yield* AutomaticTurnGate.AutomaticTurnGateInstaller;
      const dispatched = yield* Ref.make(false);
      const cause = new Error("the manager's tables could not be read");
      yield* installer.install(
        AutomaticTurnGate.AutomaticTurnGate.of({
          admit: (turn) =>
            new AutomaticTurnGate.AutomaticTurnDecisionError({
              kind: turn.kind,
              thread: turn.threadId,
              stage: "read",
              cause,
            }),
          hand: () => Effect.die("no native wake in this test"),
        }),
      );
      const error = yield* gate.admit(continuation, Ref.set(dispatched, true)).pipe(Effect.flip);
      assert.isFalse(yield* Ref.get(dispatched));
      assert.deepEqual(
        Object.keys(AutomaticTurnGate.AutomaticTurnDecisionError.fields)
          .filter((field) => field !== "_tag")
          .toSorted(),
        ["cause", "kind", "stage", "thread"],
      );
      assert.equal(error._tag, "AutomaticTurnDecisionError");
      assert.equal(error.kind, "restart_continuation");
      assert.equal(error.thread, threadId);
      assert.equal(error.stage, "read");
      assert.strictEqual(error.cause, cause);
      // The message names the turn, never what the cause says.
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(AutomaticTurnGate.layerInstallable), Effect.scoped),
  );

  it.effect("hands each kind's turn to the installed gate with exactly its causal identity", () =>
    Effect.gen(function* () {
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const installer = yield* AutomaticTurnGate.AutomaticTurnGateInstaller;
      const recording = yield* recordingGate(AutomaticTurnGate.notNow("deferred"));
      yield* installer.install(recording.gate);
      const messageId = MessageId.make("message:automatic");
      const runId = RunId.make("run:automatic");
      const turns = {
        pull_request_wake: {
          kind: "pull_request_wake",
          threadId,
          messageId,
          key: "https://github.com/pingdotgg/t3code/pull/7",
          pullRequest: {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 7,
            url: "https://github.com/pingdotgg/t3code/pull/7",
          },
          watchStartedAt: "2026-10-29T00:00:00.000Z",
          ending: "closed",
        },
        restart_continuation: continuation,
        usage_limit_resume: {
          kind: "usage_limit_resume",
          threadId,
          messageId,
          key: "limit-resume:automatic",
          usageLimitContinuationOfRunId: runId,
        },
        delegated_question: {
          kind: "delegated_question",
          threadId,
          messageId,
          key: "thread:child:request:automatic",
          childThreadId: ThreadId.make("thread:child"),
          requestId: RuntimeRequestId.make("request:automatic"),
          taskId: NodeId.make("node:task"),
          delegatingRunId: runId,
        },
        delegated_completion: {
          kind: "delegated_completion",
          threadId,
          messageId,
          key: `${runId}:1:${messageId}`,
          parentRunId: runId,
          generation: 1,
          providerThreadId: wake.providerThreadId,
          driver: wake.driver,
          origin: "steer",
        },
        background_wake: wake,
      } satisfies {
        readonly [K in AutomaticTurnGate.AutomaticTurn["kind"]]: Extract<
          AutomaticTurnGate.AutomaticTurn,
          { readonly kind: K }
        >;
      };
      for (const turn of Object.values(turns)) {
        if (turn.kind === "background_wake") yield* gate.hand(turn, Effect.void, {});
        else yield* gate.admit(turn, Effect.void);
      }
      const received = (yield* recording.consults).map((consult) => consult.turn);
      assert.deepEqual(received, Object.values(turns));
      // A turn names its own source, never a neighbouring run or a work start time.
      assert.deepEqual(
        Object.fromEntries(received.map((turn) => [turn.kind, Object.keys(turn).toSorted()])),
        {
          pull_request_wake: [
            "ending",
            "key",
            "kind",
            "messageId",
            "pullRequest",
            "threadId",
            "watchStartedAt",
          ],
          restart_continuation: ["key", "kind", "messageId", "settled", "sourceRunId", "threadId"],
          usage_limit_resume: [
            "key",
            "kind",
            "messageId",
            "threadId",
            "usageLimitContinuationOfRunId",
          ],
          delegated_question: [
            "childThreadId",
            "delegatingRunId",
            "key",
            "kind",
            "messageId",
            "requestId",
            "taskId",
            "threadId",
          ],
          delegated_completion: [
            "driver",
            "generation",
            "key",
            "kind",
            "messageId",
            "origin",
            "parentRunId",
            "providerThreadId",
            "threadId",
          ],
          background_wake: [
            "clearable",
            "driver",
            "key",
            "kind",
            "messageId",
            "providerThreadId",
            "threadId",
          ],
        },
      );
    }).pipe(Effect.provide(AutomaticTurnGate.layerInstallable), Effect.scoped),
  );
});
