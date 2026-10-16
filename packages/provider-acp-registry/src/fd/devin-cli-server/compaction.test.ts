import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Runtime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import { devinCompaction } from "./compaction.ts";

describe("native compaction completion", () => {
  it.effect.each(["completed", "failed"] as const)("waits for native %s notification", (outcome) =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      let notify:
        | ((notice: { sessionId: string; status: string }) => Effect.Effect<void>)
        | undefined;
      const lifecycle: Array<string> = [];
      const services = yield* Layer.build(
        Layer.mock(Runtime.AcpSessionRuntime)({
          processContainment: "none",
          handleExtNotification: (_method, _schema, handler) =>
            Effect.sync(() => {
              notify = (notice) => handler(notice as never).pipe(Effect.orDie);
            }),
          prompt: () =>
            Deferred.succeed(sent, undefined).pipe(Effect.as({ stopReason: "end_turn" as const })),
        }),
      );
      const runtime = yield* Effect.service(Runtime.AcpSessionRuntime).pipe(
        Effect.provide(services),
      );
      const context: AcpAdapterV2ExtensionContext = {
        reportUsage: () => Effect.die("unused"),
        runtime,
        reportCompaction: (notice) =>
          Effect.sync(() => {
            lifecycle.push(notice.status);
          }),
        reportProviderRetry: () => Effect.die("unused"),
        finishSubagent: () => Effect.die("unused"),
        applyBackgroundTaskMutation: () => Effect.die("unused"),
        requestUserInput: () => Effect.die("unused"),
        captureProposedPlan: () => Effect.die("unused"),
        lastProposedPlanMarkdown: Effect.die("unused"),
      };
      yield* devinCompaction.registerExtensions!(context);
      const fiber = yield* devinCompaction.runPrompt!(runtime, "s", [
        { type: "text", text: "/compact" },
      ]).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(sent);
      yield* notify!({ sessionId: "s", status: "started" });
      yield* notify!({ sessionId: "other", status: "completed" });
      yield* notify!({ sessionId: "s", status: outcome });
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe(outcome === "completed" ? "Success" : "Failure");
      expect(lifecycle).toEqual(["in_progress", outcome]);
    }).pipe(Effect.scoped),
  );
});
