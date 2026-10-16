import { readCommandOutput } from "./commandOutput.ts";
import { TextGenerationError } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Operations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { DevinSettings } from "../devin/index.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

/** The installed CLI's summarizer agent has no tools. Never fall back to its general print agent. */
export const makeDevinTextGeneration = Effect.fn("makeDevinTextGeneration")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const run: Operations.Runner = (request) =>
    Effect.gen(function* () {
      if (request.attachments?.length)
        return yield* new TextGenerationError({
          operation: request.operation,
          detail:
            "Devin text generation accepts text context only. Choose another model for attachments.",
        });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "foredeck-text-" });
      const output = yield* Ref.make("");
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: {
            command: settings.commandPath,
            args: ["acp", "--agent-type", "summarizer"],
            env: environment,
          },
          cwd,
          clientInfo: { name: "t3-code-text", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          authenticateOnAuthRequired: false,
          customModels: [request.modelSelection.model],
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Layer.succeed(Crypto.Crypto, crypto),
            ),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
          return Effect.void;
        const chunk = update.content.text;
        return Ref.update(output, (text) => text + chunk);
      });
      yield* runtime.start();
      if (request.modelSelection.model !== "default")
        yield* runtime.setModel(request.modelSelection.model);
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: request.prompt }] });
      if (result.stopReason !== "end_turn")
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: `Devin text generation stopped: ${result.stopReason}.`,
        });
      return yield* Operations.decodeJsonReply(request, "Devin CLI", yield* Ref.get(output));
    }).pipe(
      Effect.timeout("90 seconds"),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: request.operation,
              detail:
                "Devin tool-free text generation failed. This CLI must support acp --agent-type summarizer.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  return Operations.fromRunner(
    "DevinTextGeneration",
    Operations.withoutInvestigation("Devin CLI", run),
  );
});

/** Probe the installed command, since build numbers alone do not prove this agent exists. */
export const readDevinTextGenerationSupport = Effect.fn("DevinDriver.textGenerationSupport")(
  function* (settings: DevinSettings, environment: NodeJS.ProcessEnv) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* readCommandOutput(
      spawner,
      ChildProcess.make(settings.commandPath, ["acp", "--help"], { env: environment }),
    ).pipe(
      Effect.map(
        (help) =>
          /--agent-type/.test(help) && /summarizer:\s*A summarizer agent with no tools/.test(help),
      ),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => false),
    );
  },
);
