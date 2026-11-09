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

/** Opt-in live PNG test: a synthetic image and one short prompt in a temporary workspace. */
it.live.skipIf(process.env.DEVIN_CLI_IMAGE_LIVE !== "1")(
  "starts and completes a PNG turn through the installed CLI",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "foredeck-image-live-" });
      const instanceId = ProviderInstanceId.make("image-live-test");
      const threadId = ThreadId.make("image-live-thread");
      const adapter = yield* DevinAdapterV2Driver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: { ...DEFAULT_DEVIN_SETTINGS, commandPath: process.env.DEVIN_CLI_BIN ?? "devin" },
      });
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("image-live-session"),
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
        id: ChatAttachmentId.make("image-live-png"),
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
      yield* fs.writeFile(host.resolveAttachmentPath(attachment)!, bytes);
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("image-live-project"),
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
        runId: RunId.make("image-live-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("image-live-attempt"),
        rootNodeId: NodeId.make("image-live-node"),
        providerThread,
        modelSelection,
        runtimePolicy,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("image-live-message"),
          text: "This is an attachment transport check. Reply only PNG received. Do not use tools or inspect files.",
          attachments: [attachment],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      expect(terminal).toMatchObject({ status: "completed" });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  { timeout: 60_000 },
);
