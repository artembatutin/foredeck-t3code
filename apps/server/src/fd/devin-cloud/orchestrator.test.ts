import { RepositorySet } from "../multirepo/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_DEVIN_CLOUD_SETTINGS } from "@t3tools/provider-acp-registry/fd/devin-cloud";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeDevinCloudAdapterV2 } from "./adapter.ts";
import { DevinCloudDriver } from "./driver.ts";

const registryFor = (client: HttpClient.HttpClient, instanceId: ProviderInstanceId) =>
  ProviderAdapterRegistry.layerFromAdaptersEffect(
    makeDevinCloudAdapterV2({
      instanceId,
      settings: { ...DEFAULT_DEVIN_CLOUD_SETTINGS, enabled: true, organizationId: "org-test" },
      apiKey: "test-key",
      pollIntervalMs: 0,
    }).pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        TestProviderHost.layer({ runBackgroundWork: false }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
  );

const runtimePolicyFor = (client: HttpClient.HttpClient, instanceId: ProviderInstanceId) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(Layer.mock(RepositorySet.RepositorySet)({})),
    Layer.provide(
      Layer.unwrap(
        DevinCloudDriver.create({
          instanceId,
          displayName: "Cloud policy fixture",
          enabled: true,
          environment: [{ name: "DEVIN_API_KEY", value: "test-key", sensitive: true }],
          config: { ...DEFAULT_DEVIN_CLOUD_SETTINGS, organizationId: "org-test" },
        }).pipe(
          Effect.orDie,
          Effect.map((instance) =>
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance),
            }),
          ),
        ),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            IdAllocator.layer,
            TestProviderHost.layer({ runBackgroundWork: false }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            Layer.succeed(HttpClient.HttpClient, client),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.die("The provisioned workspace should take priority"),
      }),
    ),
  );

it.live(
  "completes Cloud runs and sends queued follow-ups to the same remote session without local checkpoints",
  () =>
    Effect.gen(function* () {
      const firstPollStarted = yield* Deferred.make<void>();
      const finishFirstTurn = yield* Deferred.make<void>();
      const fs = yield* FileSystem.FileSystem;
      // A local checkpoint cannot succeed here: Cloud work has no local Git repository.
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-orchestrator-workspace-" });
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      let sent = 0;
      const remote = () => ({
        session_id: "remote-one",
        status: "running",
        status_detail: "finished",
        updated_at: sent * 10,
        url: "https://app.devin.ai/sessions/remote-one",
      });
      const reply = (ordinal: number) => ({
        event_id: `answer-${ordinal}`,
        source: "devin",
        message: ordinal === 1 ? "First answer" : "Second answer",
        created_at: ordinal * 10,
      });
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request);
          let payload: unknown;
          if (request.method === "POST") {
            sent++;
            payload = remote();
          } else if (request.url.includes("/messages")) {
            payload = { items: sent === 1 ? [reply(1)] : [reply(1), reply(2)] };
          } else {
            if (sent === 1) {
              yield* Deferred.succeed(firstPollStarted, undefined);
              yield* Deferred.await(finishFirstTurn);
            }
            payload = remote();
          }
          return HttpClientResponse.fromWeb(request, Response.json(payload));
        }),
      );
      const instanceId = ProviderInstanceId.make("cloud-orchestrator-test");
      const modelSelection = { instanceId, model: "default" };
      const registry = registryFor(client, instanceId);

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("cloud-orchestrator-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cloud-thread-create"),
          threadId,
          projectId: ProjectId.make("cloud-project"),
          title: "Cloud integration",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cloud-first-message"),
          threadId,
          messageId: MessageId.make("cloud-user-1"),
          text: "First prompt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        expect((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status).toBe("running");
        yield* Deferred.await(firstPollStarted);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cloud-second-message"),
          threadId,
          messageId: MessageId.make("cloud-user-2"),
          text: "Second prompt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });
        const queued = yield* orchestrator.getThreadProjection(threadId);
        expect(queued.runs.map((run) => run.status)).toEqual(["running", "queued"]);
        const awaitSettled = (runId: (typeof queued.runs)[number]["id"]) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.runId === runId &&
                ["waiting", "completed", "failed", "interrupted"].includes(event.payload.status),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
        const firstSettled = yield* awaitSettled(queued.runs[0]!.id);
        const secondSettled = yield* awaitSettled(queued.runs[1]!.id);
        const secondStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.runId === queued.runs[1]!.id &&
              event.payload.status === "starting",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(finishFirstTurn, undefined);
        yield* Fiber.join(firstSettled);
        yield* Fiber.join(secondStarting);
        yield* worker.drain();
        yield* Fiber.join(secondSettled);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        expect(projection.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
        expect(projection.thread.runtimeMode).toBe("approval-required");
        expect(projection.providerTurns.map((turn) => turn.status)).toEqual([
          "completed",
          "completed",
        ]);
        expect(projection.checkpoints).toEqual([]);
        expect(projection.providerThreads).toHaveLength(1);
        expect(projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("remote-one");
        expect(
          projection.messages
            .filter((message) => message.text.endsWith("answer"))
            .map((message) => message.text),
        ).toEqual(["First answer", "Second answer"]);
        expect(
          projection.turnItems
            .filter((item) => item.type === "assistant_message" && item.text.endsWith("answer"))
            .map((item) => item.runId),
        ).toEqual(projection.runs.map((run) => run.id));
        expect(
          requests.filter(
            (request) => request.method === "POST" && !request.url.includes("/messages"),
          ),
        ).toHaveLength(1);
        expect(
          requests.filter(
            (request) =>
              request.method === "POST" && request.url.endsWith("/devin-remote-one/messages"),
          ),
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "cloud-native-queued-followup",
              runtimePolicyOverride: { cwd },
            },
            registry,
            {
              runEffectWorker: false,
              runtimePolicyLayer: runtimePolicyFor(client, instanceId),
            },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live(
  "Stop during an in-flight Cloud creation waits for admission and terminates the accepted session",
  () =>
    Effect.gen(function* () {
      const createReceived = yield* Deferred.make<void>();
      const releaseCreation = yield* Deferred.make<void>();
      const deleted = yield* Deferred.make<void>();
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-early-stop-workspace-" });
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const remote = {
        session_id: "accepted-remote",
        status: "running",
        status_detail: "working",
        updated_at: 10,
        url: "https://app.devin.ai/sessions/accepted-remote",
      };
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request);
          if (request.method === "POST") {
            yield* Deferred.succeed(createReceived, undefined);
            yield* Deferred.await(releaseCreation);
          }
          if (request.method === "DELETE") yield* Deferred.succeed(deleted, undefined);
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.includes("/messages")
                ? { items: [] }
                : request.method === "DELETE"
                  ? { ...remote, status: "suspended", status_detail: "user_request" }
                  : remote,
            ),
          );
        }),
      );
      const instanceId = ProviderInstanceId.make("cloud-early-stop-test");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("cloud-early-stop-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cloud-early-stop-create"),
          threadId,
          projectId: ProjectId.make("cloud-early-stop-project"),
          title: "Cloud early Stop",
          modelSelection: { instanceId, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cloud-early-stop-send"),
          threadId,
          messageId: MessageId.make("cloud-early-stop-message"),
          text: "Begin remote work",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* Deferred.await(createReceived);
        const admitting = yield* orchestrator.getThreadProjection(threadId);
        const run = admitting.runs[0]!;
        expect(run.status).toBe("running");
        expect(admitting.providerTurns).toHaveLength(0);
        const interrupted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.runId === run.id &&
              event.payload.status === "interrupted",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("cloud-early-stop-request"),
          threadId,
          runId: run.id,
          holdQueue: true,
        });
        const stopping = yield* orchestrator.getThreadProjection(threadId);
        expect(stopping.runs[0]?.status).toBe("running");
        expect(stopping.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(true);
        expect(stopping.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(false);
        yield* Deferred.succeed(releaseCreation, undefined);
        yield* Deferred.await(deleted);
        yield* Fiber.join(interrupted);
        yield* worker.drain();
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        expect(stopped.runs[0]?.status).toBe("interrupted");
        expect(stopped.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("accepted-remote");
        expect(stopped.providerTurns[0]?.status).toBe("interrupted");
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(
          requests.filter((request) => request.method === "DELETE").map((request) => request.url),
        ).toEqual([
          "https://api.devin.ai/v3/organizations/org-test/sessions/devin-accepted-remote?archive=false",
        ]);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "cloud-stop-before-admission",
              runtimePolicyOverride: { cwd },
            },
            registryFor(client, instanceId),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
