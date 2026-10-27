import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ModelSelection, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { PiAdapterV2Driver } from "@t3tools/provider-pi/server";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const piEffortLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

/** Real Pi adapter with an in-memory RPC peer; no CLI, credentials, or live provider. */
export const makePiEffort = Effect.fnUntraced(function* (
  threadId: ThreadId,
  selection: ModelSelection,
  options: { readonly loaded: boolean; readonly providerSessionId: ProviderSessionId },
) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests: Array<Record<string, unknown>> = [];
  const state: { thinking: string | undefined; nativeId: string; failRead: boolean } = {
    thinking: "high",
    nativeId: `native:${threadId}`,
    failRead: false,
  };
  let buffer = "";
  const json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
  const emit = (record: Record<string, unknown>) =>
    Schema.encodeEffect(json)(record).pipe(
      Effect.flatMap((line) => Queue.offer(stdout, new TextEncoder().encode(`${line}\n`))),
      Effect.orDie,
    );
  const decode = Schema.decodeEffect(json);
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        // Outside the PID range, as in the adapter's own tests. Nothing is spawned or killed.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(chunk);
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const record = yield* decode(buffer.slice(0, newline)).pipe(Effect.orDie);
              buffer = buffer.slice(newline + 1);
              requests.push(record);
              if (record["type"] === "set_thinking_level") state.thinking = String(record["level"]);
              if (typeof record["id"] !== "string") continue;
              const data =
                record["type"] === "get_state"
                  ? {
                      sessionFile: state.nativeId,
                      thinkingLevel: state.thinking,
                      model: { provider: "test", id: "reasoning", reasoning: true },
                      isStreaming: false,
                    }
                  : record["type"] === "get_available_models"
                    ? { models: [] }
                    : record["type"] === "get_entries"
                      ? { entries: [], leafId: null }
                      : record["type"] === "get_messages"
                        ? { messages: [] }
                        : {};
              yield* emit({
                type: "response",
                id: record["id"],
                command: record["type"],
                success: !(state.failRead && record["type"] === "get_state"),
                data,
              });
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const adapter = yield* PiAdapterV2Driver.create({
    instanceId: selection.instanceId,
    displayName: undefined,
    enabled: true,
    environment: [],
    config: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Environment, {}),
  );
  const runtimePolicy = {
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
  } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: options.providerSessionId,
    modelSelection: selection,
    runtimePolicy,
  });
  if (options.loaded)
    yield* runtime.ensureThread({ threadId, modelSelection: selection, runtimePolicy });
  const terminals = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.filter((event) => event.type === "turn.terminal"),
    Stream.runForEach((event) => Queue.offer(terminals, event)),
    Effect.forkScoped,
  );
  return {
    runtime,
    state,
    requests,
    thinking: () => state.thinking,
    levels: () =>
      requests
        .filter((record) => record["type"] === "set_thinking_level")
        .map((record) => record["level"]),
    run: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        yield* runtime.startTurn({ ...input, runtimePolicy });
        yield* emit({ type: "agent_start" });
        yield* emit({ type: "agent_end", messages: [], willRetry: false });
        yield* emit({ type: "agent_settled" });
        yield* Queue.take(terminals);
      }),
  };
});
