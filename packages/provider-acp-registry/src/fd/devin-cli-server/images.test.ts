import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as AcpRegistrySupport from "../../server/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "../../server/AcpRegistryRuntimeCoordinator.ts";
import { DEFAULT_DEVIN_SETTINGS } from "../devin/index.ts";
import { DevinAdapterV2Driver } from "./index.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Exit from "effect/Exit";

const layerInfrastructure = Layer.mergeAll(
  NodeServices.layer,
  AcpRegistryRuntimeCoordinator.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Local CLI setup must not fetch the registry")),
  ),
);
const layerTest = AcpRegistrySupport.layerFromHost.pipe(Layer.provideMerge(layerInfrastructure));

/** Exercises actual ACP serialization and attachment preparation without a model request. */
it.live.each(["supported", "unsupported_session", "unsupported_model", "unreadable"] as const)(
  "handles PNG startup with %s input",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "foredeck-image-test-" });
      const commandPath = writeFakeCli({
        directory: cwd,
        name: "image-agent",
        source: `
      const scenario = ${JSON.stringify(scenario)};
      const configOptions = [{id: "model", category: "model", type: "select", name: "Model", currentValue: "test-model", options: [
        {value: "test-model", name: "Test Model", _meta: {"cognition.ai/supportsImages": scenario !== "unsupported_model"}}
      ]}];
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      (await import("node:readline")).createInterface({input: process.stdin}).on("line", (line) => {
        const request = JSON.parse(line);
        if (!Object.hasOwn(request, "id")) return;
        let result = {};
        switch (request.method) {
          case "initialize": result = {protocolVersion: 1, agentCapabilities: {promptCapabilities: {image: scenario !== "unsupported_session"}}, agentInfo: {name: "image-agent", version: "1"}}; break;
          case "session/new": result = {sessionId: "image-session", configOptions}; break;
          case "session/set_config_option": result = {configOptions}; break;
          case "session/prompt": {
            const images = request.params.prompt.filter((part) => part.type === "image");
            if (scenario !== "supported" || images.length !== 1 || images[0].mimeType !== "image/png" || images[0].data !== "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGksAAAAASUVORK5CYII=") {
              send({jsonrpc: "2.0", id: request.id, error: {code: -32602, message: "Expected the exact PNG bytes"}});
              return;
            }
            result = {stopReason: "end_turn"}; break;
          }
        }
        send({jsonrpc: "2.0", id: request.id, result});
      });
    `,
      });
      const instanceId = ProviderInstanceId.make("image-test-test");
      const threadId = ThreadId.make("image-test-thread");
      const adapter = yield* DevinAdapterV2Driver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: { ...DEFAULT_DEVIN_SETTINGS, commandPath },
      });
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("image-test-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGksAAAAASUVORK5CYII=",
        "base64",
      );
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make("image-test-png"),
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
      if (scenario !== "unreadable")
        yield* fs.writeFile(host.resolveAttachmentPath(attachment)!, bytes);
      const started = yield* runtime
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("image-test-project"),
            title: "PNG diagnostic",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("image-test-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("image-test-attempt"),
          rootNodeId: NodeId.make("image-test-node"),
          providerThread,
          modelSelection,
          runtimePolicy,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("image-test-message"),
            text: "This is an attachment transport check. Reply only PNG received. Do not use tools or inspect files.",
            attachments: [attachment],
          },
        })
        .pipe(Effect.exit);
      if (scenario !== "supported") {
        expect(Exit.isFailure(started)).toBe(true);
        if (Exit.isFailure(started)) {
          const message = makeProviderFailure({ cause: started.cause }).message;
          expect(message).toContain(
            {
              unsupported_session: "This provider session does not support images",
              unsupported_model: "The selected model does not support images",
              unreadable: "The attached image could not be read",
            }[scenario],
          );
        }
        return;
      }
      if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal).toMatchObject({ status: "completed" });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  { timeout: 15_000 },
);
