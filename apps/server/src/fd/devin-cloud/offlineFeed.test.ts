import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_DEVIN_CLOUD_SETTINGS } from "@t3tools/provider-acp-registry/fd/devin-cloud";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "../../orchestration-v2/TurnItemPositionStore.ts";
import { makeDevinCloudAdapterV2 } from "./adapter.ts";

const testLayer = Layer.mergeAll(
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  TurnItemPositionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

it.effect(
  "restored Cloud output preserves its owning run and a stable visible position after its prompt",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("offline-cloud");
      const threadId = ThreadId.make("offline-thread");
      const driver = ProviderDriverKind.make("devinCloud");
      const modelSelection = { instanceId, model: "default" };
      const now = DateTime.makeUnsafe(10_000);
      const ids = yield* IdAllocator.IdAllocatorV2;
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const runId = ids.derive.run({ threadId, ordinal: 1 });
      const persisted: OrchestrationV2ProviderThread = {
        id: ids.derive.providerThread({
          driver,
          providerInstanceId: instanceId,
          nativeThreadId: "remote-one",
        }),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "remote-one", strength: "strong" },
        nativeConversationHeadRef: { driver, nativeId: "observed", strength: "strong" },
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const prompt: OrchestrationV2TurnItem = {
        id: ids.derive.userTurnItem({ messageId: MessageId.make("offline-prompt") }),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: persisted.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("offline-prompt"),
        text: "Continue remotely",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      };
      const normalizedPrompt = yield* positions.normalize(prompt, 1);
      const provider = yield* makeDevinCloudAdapterV2({
        instanceId,
        apiKey: "test-key",
        settings: { ...DEFAULT_DEVIN_CLOUD_SETTINGS, enabled: true, organizationId: "org-test" },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.includes("/messages")
                    ? {
                        items: [
                          {
                            event_id: "observed",
                            source: "devin",
                            message: "Already displayed",
                            created_at: 10,
                          },
                          {
                            event_id: "offline-answer",
                            source: "devin",
                            message: "Finished while disconnected",
                            created_at: 20,
                          },
                        ],
                      }
                    : {
                        session_id: "remote-one",
                        status: "running",
                        status_detail: "finished",
                        updated_at: 20,
                      },
                ),
              ),
            ),
          ),
        ),
      );
      const runtime = yield* provider.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("reconnected-cloud"),
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      });
      const restored = yield* runtime.resumeThread({ providerThread: persisted });
      if (!runtime.readThreadHistory)
        return yield* Effect.die("Cloud must expose restored history");
      const events = yield* runtime.readThreadHistory({ providerThread: restored });
      const messageEvent = events.find((event) => event.type === "message.updated");
      const itemEvent = events.find((event) => event.type === "turn_item.updated");
      if (messageEvent?.type !== "message.updated" || itemEvent?.type !== "turn_item.updated")
        return yield* Effect.die(
          "Restored output must emit both a conversation message and a visible item",
        );
      expect(messageEvent.message.runId).toBe(runId);
      expect(itemEvent.turnItem.runId).toBe(runId);
      expect(itemEvent.turnItem.providerTurnId).toBeNull();
      const replay = yield* positions.normalize(itemEvent.turnItem, 1);
      expect(replay.ordinal).toBeGreaterThan(normalizedPrompt.ordinal);
      const duplicate = yield* positions.normalize(itemEvent.turnItem, 1);
      expect(duplicate.ordinal).toBe(replay.ordinal);
      expect(replay.type === "assistant_message" && replay.messageId).toBe(messageEvent.message.id);
      expect(replay.id).toBe(
        ids.derive.turnItemFromProviderItem({
          driver,
          nativeItemId: `${instanceId}:remote-one:offline-answer`,
        }),
      );
    }).pipe(Effect.provide(testLayer)),
);
