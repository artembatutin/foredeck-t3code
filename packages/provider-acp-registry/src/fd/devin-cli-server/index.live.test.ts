/** DEVIN_CLI_LIVE=1 vp test run <this file>. Uses native sign-in, creates empty sessions, sends no prompt. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
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
import { DEFAULT_DEVIN_SETTINGS } from "../devin/index.ts";
import { DevinDriver } from "./index.ts";

const layerInfrastructure = Layer.mergeAll(
  NodeServices.layer,
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

it.live.skipIf(process.env.DEVIN_CLI_LIVE !== "1")(
  "discovers the installed CLI and opens a dedicated empty session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "foredeck-local-agent-live-" });
      const instanceId = ProviderInstanceId.make("devin-live-test");
      const instance = yield* DevinDriver.create({
        instanceId,
        displayName: "CLI live test",
        enabled: true,
        environment: [],
        config: {
          ...DEFAULT_DEVIN_SETTINGS,
          commandPath: process.env.DEVIN_CLI_BIN ?? "devin",
        },
      });
      const initial = yield* instance.snapshot.getSnapshot;
      expect(initial).toMatchObject({
        driver: "devin",
        installed: true,
        showInteractionModeToggle: false,
      });
      expect(initial.message).toBe(
        "Refresh this provider to discover models, commands, and native sessions.",
      );

      const snapshot = yield* instance.snapshot.refresh;
      yield* Effect.logInfo("Local CLI discovery", {
        version: snapshot.version,
        status: snapshot.status,
        message: snapshot.message,
      });
      expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(snapshot.nativeSessions?.canList).toBe(true);
      expect(snapshot.models.some((model) => model.slug !== "default")).toBe(true);

      const adapter = instance.orchestrationAdapter;
      if (!adapter) return yield* Effect.die("Dedicated CLI adapter missing");
      const threadId = ThreadId.make("devin-live-thread");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-live-session"),
        modelSelection,
        runtimePolicy,
      });
      expect(runtime.providerSession).toMatchObject({
        driver: "devin",
        providerInstanceId: instanceId,
        status: "ready",
      });
      const nativeThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      expect(nativeThread.driver).toBe("devin");
      expect(nativeThread.nativeThreadRef).toBeTruthy();
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  { timeout: 60_000 },
);
