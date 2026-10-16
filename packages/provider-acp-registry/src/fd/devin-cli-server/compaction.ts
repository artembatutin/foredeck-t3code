import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type * as Runtime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Errors from "effect-acp/errors";

const Notice = Schema.Struct({
  sessionId: Schema.String,
  status: Schema.String,
  summary: Schema.optional(Schema.String),
});
type Pending = { readonly id: string; readonly done: Deferred.Deferred<string> };
const pendingByRuntime = new WeakMap<Runtime.AcpSessionRuntime["Service"], Map<string, Pending>>();
let sequence = 0;

/** This CLI returns the slash-command RPC before its separate compaction notification settles. */
export const devinCompaction: Pick<AcpAdapterV2Flavor, "registerExtensions" | "runPrompt"> = {
  registerExtensions: (context) =>
    Effect.gen(function* () {
      const pending = new Map<string, Pending>();
      pendingByRuntime.set(context.runtime, pending);
      yield* context.runtime.handleExtNotification("_cognition.ai/compaction", Notice, (notice) =>
        Effect.gen(function* () {
          let operation = pending.get(notice.sessionId);
          if (!operation && notice.status === "started") {
            operation = {
              id: `native-compaction:${++sequence}`,
              done: yield* Deferred.make<string>(),
            };
            pending.set(notice.sessionId, operation);
          }
          if (!operation) return;
          const status =
            notice.status === "started"
              ? "in_progress"
              : notice.status === "completed"
                ? "completed"
                : notice.status === "failed"
                  ? "failed"
                  : undefined;
          if (status === undefined) return;
          yield* context.reportCompaction({
            sessionId: notice.sessionId,
            compactionId: operation.id,
            status,
            ...(notice.summary ? { summary: notice.summary } : {}),
          });
          if (status !== "in_progress") {
            yield* Deferred.succeed(operation.done, status);
            pending.delete(notice.sessionId);
          }
        }),
      );
    }),
  runPrompt: (runtime, sessionId, prompt) => {
    if (prompt[0]?.type !== "text" || !/^\/compact(?:\s|$)/.test(prompt[0].text))
      return runtime.prompt({ prompt });
    return Effect.gen(function* () {
      const pending = pendingByRuntime.get(runtime);
      if (!pending)
        return yield* new Errors.AcpTransportError({
          cause: undefined,
          detail: "Native compaction lifecycle is not connected.",
        });
      const operation = {
        id: `native-compaction:${++sequence}`,
        done: yield* Deferred.make<string>(),
      };
      pending.set(sessionId, operation);
      return yield* runtime.prompt({ prompt }).pipe(
        Effect.flatMap((result) =>
          result.stopReason === "cancelled"
            ? Effect.succeed(result)
            : Deferred.await(operation.done).pipe(
                Effect.flatMap((status) =>
                  status === "completed"
                    ? Effect.succeed(result)
                    : Effect.fail(
                        new Errors.AcpTransportError({
                          cause: undefined,
                          detail: "Devin reported that native compaction failed.",
                        }),
                      ),
                ),
              ),
        ),
        Effect.timeout("90 seconds"),
        Effect.mapError(
          (cause) =>
            new Errors.AcpTransportError({
              detail:
                "Native compaction did not complete successfully; the context was not confirmed compacted.",
              cause,
            }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (pending.get(sessionId) === operation) pending.delete(sessionId);
          }),
        ),
      );
    });
  },
};
