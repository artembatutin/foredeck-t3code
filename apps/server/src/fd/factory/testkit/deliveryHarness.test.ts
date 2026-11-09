import { assert, it } from "@effect/vitest";
import { ProviderSessionId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeFakeProvider, verifyCommands, withProject } from "./deliveryHarness.ts";

it.live("keeps each simulated session's turn events on its own stream", () =>
  withProject(verifyCommands.passes, (world) =>
    Effect.gen(function* () {
      const author = yield* world.start;
      const original = world.provider.started.find(({ runId }) => runId === author.runId);
      if (original === undefined) return assert.fail("The author never started.");
      const provider = yield* makeFakeProvider;
      const open = (id: string) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread-${id}`);
          const input = {
            threadId,
            modelSelection: original.modelSelection,
            runtimePolicy: original.runtimePolicy,
          };
          const session = yield* provider.adapter.openSession({
            ...input,
            providerSessionId: ProviderSessionId.make(`session-${id}`),
          });
          const turn = {
            ...original,
            threadId,
            runId: RunId.make(`run-${id}`),
            providerThread: yield* session.ensureThread(input),
          };
          return { session, turn };
        });
      const first = yield* open("first");
      const second = yield* open("second");

      // Publish the second session first, then consume the first session first. A shared queue
      // deterministically hands the wrong run's notifications to that subscriber.
      yield* second.session.startTurn(second.turn);
      yield* provider.say(second.turn, "Second session result");
      yield* provider.endTurn(second.turn, "completed");
      yield* first.session.startTurn(first.turn);
      yield* provider.say(first.turn, "First session result");
      yield* provider.endTurn(first.turn, "completed");
      for (const { session, turn } of [first, second]) {
        const events = yield* session.events.pipe(Stream.take(4), Stream.runCollect);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["provider_turn.updated", "message.updated", "provider_turn.updated", "turn.terminal"],
        );
        for (const event of events) {
          if (event.type === "message.updated") {
            assert.strictEqual(event.message.runId, turn.runId);
          } else if (event.type === "provider_turn.updated") {
            assert.strictEqual(event.providerTurn.providerThreadId, turn.providerThread.id);
          } else if (event.type === "turn.terminal") {
            assert.strictEqual(event.providerThreadId, turn.providerThread.id);
            assert.strictEqual(event.status, "completed");
          }
        }
      }
    }).pipe(Effect.scoped),
  ),
);
