import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_DEVIN_CLOUD_SETTINGS } from "@t3tools/provider-acp-registry/fd/devin-cloud";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeDevinCloudAdapterV2 } from "./adapter.ts";
import { makeDevinCloudClient } from "./api.ts";
import { DevinCloudDriver } from "./driver.ts";

const instanceId = ProviderInstanceId.make("cloud-test");
const threadId = ThreadId.make("thread-test");
const modelSelection = { instanceId, model: "default" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;
const settings = { ...DEFAULT_DEVIN_CLOUD_SETTINGS, enabled: true, organizationId: "org-test" };
const openInput = {
  threadId,
  providerSessionId: ProviderSessionId.make("session-test"),
  modelSelection,
  runtimePolicy,
};
const hostLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
);
const remote = (detail = "finished", time = 10) => ({
  session_id: "remote-one",
  status: "running",
  status_detail: detail,
  updated_at: time,
  url: "https://app.devin.ai/sessions/remote-one",
});
const reply = (id: string, text: string) => ({
  event_id: id,
  source: "devin",
  message: text,
  created_at: 10,
});
const response = (request: HttpClientRequest.HttpClientRequest, json: unknown, status = 200) =>
  HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status }));
const http = (handle: (request: HttpClientRequest.HttpClientRequest) => unknown) =>
  HttpClient.make((request) => Effect.sync(() => response(request, handle(request))));
const body = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
    : undefined;
const adapter = (client: HttpClient.HttpClient) =>
  makeDevinCloudAdapterV2({ instanceId, settings, apiKey: "test-key", pollIntervalMs: 0 }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );

function turnInput(
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
): ProviderAdapter.ProviderAdapterV2TurnInput {
  const time = DateTime.makeUnsafe(0);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Cloud test",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: time,
      updatedAt: time,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${ordinal}`),
      text: `Prompt ${ordinal}`,
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  };
}

const terminal = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter((event) => event.type === "turn.terminal"),
    Stream.take(1),
    Stream.runCollect,
  );

it.layer(hostLayer)("Devin Cloud provider", (it) => {
  it.effect(
    "creates only on first turn, publishes messages before terminal, and follows up without creating another VM",
    () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = [];
        let sent = 0;
        let messageReads = 0;
        const client = http((request) => {
          requests.push(request);
          if (request.method === "POST") {
            sent++;
            return {
              ...remote(),
              url: "https://app.devin.ai/sessions/remote-one?token=test-only#private",
            };
          }
          if (request.url.includes("/messages")) {
            messageReads++;
            return {
              items:
                sent === 1
                  ? [reply("answer-1", "First answer")]
                  : [reply("answer-1", "First answer"), reply("answer-2", "Second answer")],
            };
          }
          return remote();
        });
        const provider = yield* adapter(client);
        const runtime = yield* provider.openSession(openInput);
        const thread = yield* runtime.ensureThread(openInput);
        expect(requests).toHaveLength(0);
        const result = yield* Deferred.make<void>();
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const consumer = yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turn.terminal") yield* Deferred.succeed(result, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        yield* Deferred.await(result);
        yield* Fiber.interrupt(consumer);
        const updated = events.findLast((event) => event.type === "provider_thread.updated");
        expect(
          updated?.type === "provider_thread.updated" &&
            updated.providerThread.nativeThreadRef?.nativeId,
        ).toBe("remote-one");
        const link = events.find(
          (event) =>
            event.type === "message.updated" && event.message.text.includes("[Open the session]"),
        );
        expect(link?.type === "message.updated" && link.message.text).toContain(
          "[Open the session](https://app.devin.ai/sessions/remote-one)",
        );
        expect(link?.type === "message.updated" && link.message.text).not.toContain("test-only");
        expect(
          updated?.type === "provider_thread.updated" &&
            updated.providerThread.nativeConversationHeadRef?.nativeId,
        ).toBe("answer-1");
        const answerItemIndex = events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "First answer",
        );
        const answerHeadIndex = events.findIndex(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.nativeConversationHeadRef?.nativeId === "answer-1",
        );
        expect(answerHeadIndex).toBeGreaterThan(answerItemIndex);
        const firstTerminal = events.findIndex((event) => event.type === "turn.terminal");
        expect(
          events
            .slice(0, firstTerminal)
            .some(
              (event) => event.type === "message.updated" && event.message.text === "First answer",
            ),
        ).toBe(true);
        expect(body(requests.find((request) => request.method === "POST")!)).toMatchObject({
          prompt: "Prompt 1",
          repos: [],
          max_acu_limit: 10,
          resumable: true,
        });
        const finished = yield* terminal(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread, 2));
        yield* Fiber.join(finished);
        expect(
          requests.filter(
            (request) => request.method === "POST" && !request.url.endsWith("/messages"),
          ),
        ).toHaveLength(1);
        expect(
          requests.some(
            (request) =>
              request.method === "POST" && request.url.endsWith("/devin-remote-one/messages"),
          ),
        ).toBe(true);
        expect(messageReads).toBeGreaterThanOrEqual(3);
      }),
  );

  it.effect(
    "resumes a persisted native session and ignores stale finished status after follow-up",
    () =>
      Effect.gen(function* () {
        let postCount = 0;
        let readsAfterSend = 0;
        let messagesAfterSend = 0;
        const client = http((request) => {
          if (request.method === "POST") {
            postCount++;
            return remote("finished", 20);
          }
          if (request.url.includes("/messages")) {
            if (postCount) messagesAfterSend++;
            return {
              items: postCount && readsAfterSend >= 2 ? [reply("new-answer", "New result")] : [],
            };
          }
          if (postCount) readsAfterSend++;
          return remote("finished", postCount ? 20 : 10);
        });
        const provider = yield* adapter(client);
        const first = yield* provider.openSession(openInput);
        const empty = yield* first.ensureThread(openInput);
        const persisted = {
          ...empty,
          nativeThreadRef: {
            driver: empty.driver,
            nativeId: "remote-one",
            strength: "strong" as const,
          },
        };
        const runtime = yield* provider.openSession(openInput);
        const thread = yield* runtime.resumeThread({ providerThread: persisted });
        const completion = yield* terminal(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        const events = yield* Fiber.join(completion);
        expect(events[0]?.status).toBe("completed");
        expect(readsAfterSend).toBe(2);
        expect(messagesAfterSend).toBe(2);
        expect(postCount).toBe(1);
      }),
  );

  it.effect("reports explicit Stop as interrupted and preserves the resumable session", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const client = HttpClient.make((request) => {
        requests.push(request);
        if (request.method === "DELETE")
          return Effect.succeed(
            response(request, { ...remote("user_request"), status: "suspended" }),
          );
        if (request.method === "POST") return Effect.succeed(response(request, remote("working")));
        return Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never));
      });
      const provider = yield* adapter(client);
      const runtime = yield* provider.openSession(openInput);
      const thread = yield* runtime.ensureThread(openInput);
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      const turnId = IdAllocator.derive.providerTurn({
        driver: thread.driver,
        nativeTurnId: `${instanceId}:remote-one:run-1:attempt-1`,
      });
      yield* runtime.interruptTurn({ providerThread: thread, providerTurnId: turnId });
      const events = yield* terminal(runtime);
      expect(events[0]?.status).toBe("interrupted");
      expect(
        requests.filter((request) => request.method === "DELETE").map((request) => request.url),
      ).toEqual([
        "https://api.devin.ai/v3/organizations/org-test/sessions/devin-remote-one?archive=false",
      ]);
    }),
  );

  it.effect(
    "fails quota and approval states without claiming completion or local checkpoint support",
    () =>
      Effect.gen(function* () {
        for (const detail of ["usage_limit_exceeded", "waiting_for_approval"]) {
          const provider = yield* adapter(
            http((request) => (request.url.includes("/messages") ? { items: [] } : remote(detail))),
          );
          const caps = yield* provider.getCapabilities();
          expect(caps.checkpointing.appCanCheckpointFilesystem).toBe(false);
          expect(caps.approvals.supportsCommandApproval).toBe(false);
          const runtime = yield* provider.openSession(openInput);
          const thread = yield* runtime.ensureThread(openInput);
          yield* runtime.startTurn(turnInput(thread));
          const events = yield* terminal(runtime);
          expect(events[0]?.status).toBe("failed");
          expect(events[0]?.failure?.class).toBe(
            detail === "waiting_for_approval" ? "permission_error" : "usage_limit",
          );
        }
      }),
  );

  it.effect(
    "disabled and unconfigured instances make no network requests and ignore ambient credentials",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        for (const input of [
          {
            enabled: false,
            organizationId: "org-test",
            environment: [{ name: "DEVIN_API_KEY", value: "test-key", sensitive: true }],
          },
          {
            enabled: true,
            organizationId: "",
            environment: [{ name: "DEVIN_API_KEY", value: "test-key", sensitive: true }],
          },
          { enabled: true, organizationId: "org-test", environment: [] },
        ]) {
          const instance = yield* DevinCloudDriver.create({
            instanceId,
            displayName: undefined,
            enabled: input.enabled,
            config: { ...settings, organizationId: input.organizationId },
            environment: input.environment,
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              http(() => {
                calls++;
                return {};
              }),
            ),
            Effect.provideService(HostProcess.Environment, { DEVIN_API_KEY: "ambient-key" }),
          );
          const snapshot = yield* instance.snapshot.refresh;
          expect(snapshot.status).toBe(input.enabled ? "warning" : "disabled");
          expect(snapshot.auth.status).toBe("unknown");
        }
        expect(calls).toBe(0);
      }),
  );

  it.effect("checks authentication with a read-only endpoint and exposes safe errors", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const instance = yield* DevinCloudDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        config: settings,
        environment: [{ name: "DEVIN_API_KEY", value: "test-key", sensitive: true }],
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push(`${request.method} ${request.url}`);
            return Effect.succeed(response(request, { detail: "secret payload" }, 401));
          }),
        ),
      );
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).not.toContain("secret payload");
      expect(requests.every((request) => request === "GET https://api.devin.ai/v3/self")).toBe(
        true,
      );
    }),
  );

  it.effect("paginates history and rejects repeated cursors instead of dropping messages", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const api = yield* makeDevinCloudClient({
        apiKey: "test-key",
        organizationId: "org-test",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          http((request) => {
            requests.push(request.url);
            return request.url.includes("after=")
              ? { items: [reply("b", "Second")], has_next_page: false }
              : { items: [reply("a", "First")], has_next_page: true, end_cursor: "page/2" };
          }),
        ),
      );
      const history = yield* api.messages("remote-one");
      expect(history.items.map((item) => item.event_id)).toEqual(["a", "b"]);
      expect(history.tailCursor).toBe("page/2");
      expect(requests[1]).toContain("after=page%2F2");
      const invalid = yield* makeDevinCloudClient({
        apiKey: "test-key",
        organizationId: "org-test",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          http(() => ({ items: [], has_next_page: true, end_cursor: "same" })),
        ),
      );
      const failure = yield* invalid.messages("remote-one").pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
    }),
  );

  it.effect("times out and cancels an in-flight request with a typed transport failure", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const api = yield* makeDevinCloudClient({
        apiKey: "test-key",
        organizationId: "org-test",
        requestTimeoutMs: 1000,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
          ),
        ),
      );
      const request = yield* api.authenticate().pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(1000);
      const result = yield* Fiber.join(request);
      yield* Deferred.await(cancelled);
      expect(result._tag === "Failure" && result.failure.category).toBe("transport");
    }),
  );

  it.effect(
    "replays only messages beyond the durable Cloud head after a detached observer reconnects",
    () =>
      Effect.gen(function* () {
        const provider = yield* adapter(
          http((request) =>
            request.url.includes("/messages")
              ? {
                  items: [
                    reply("observed", "Already shown"),
                    reply("missed", "Finished while detached"),
                  ],
                }
              : remote(),
          ),
        );
        const runtime = yield* provider.openSession(openInput);
        const empty = yield* runtime.ensureThread(openInput);
        const resumed = yield* provider.openSession(openInput);
        const thread = yield* resumed.resumeThread({
          providerThread: {
            ...empty,
            nativeThreadRef: { driver: empty.driver, nativeId: "remote-one", strength: "strong" },
            nativeConversationHeadRef: {
              driver: empty.driver,
              nativeId: "observed",
              strength: "strong",
            },
          },
        });
        if (!resumed.readThreadHistory)
          return yield* Effect.die("Cloud must expose restored history");
        const batch = yield* resumed.readThreadHistory({ providerThread: thread });
        const messages = batch.filter((event) => event.type === "message.updated");
        expect(messages.map((event) => event.message.text)).toEqual(["Finished while detached"]);
        expect(messages[0]?.message.runId).toBeNull();
        expect(thread.nativeConversationHeadRef?.nativeId).toBe("missed");
        expect(yield* resumed.readThreadHistory({ providerThread: thread })).toBe(batch);
      }),
  );

  it.effect("closing the local observer cancels polling without stopping remote work", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      let deletes = 0;
      const client = HttpClient.make((request) => {
        if (request.method === "POST") return Effect.succeed(response(request, remote("working")));
        if (request.method === "DELETE") deletes++;
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
        );
      });
      const provider = yield* adapter(client);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* provider.openSession(openInput);
          const thread = yield* runtime.ensureThread(openInput);
          yield* runtime.startTurn(turnInput(thread));
          yield* Deferred.await(started);
        }),
      );
      yield* Deferred.await(cancelled);
      expect(deletes).toBe(0);
    }),
  );

  it.effect(
    "bounds transient poll failures and reconnects for a later follow-up without creating another session",
    () =>
      Effect.gen(function* () {
        let creates = 0;
        let sends = 0;
        let reads = 0;
        const client = HttpClient.make((request) => {
          if (request.method === "POST") {
            if (request.url.endsWith("/messages")) sends++;
            else creates++;
            return Effect.succeed(response(request, remote("working")));
          }
          if (request.url.includes("/messages"))
            return Effect.succeed(
              response(request, { items: sends ? [reply("recovered", "Recovered result")] : [] }),
            );
          reads++;
          return Effect.succeed(sends ? response(request, remote()) : response(request, {}, 503));
        });
        const provider = yield* adapter(client);
        const runtime = yield* provider.openSession(openInput);
        const thread = yield* runtime.ensureThread(openInput);
        yield* runtime.startTurn(turnInput(thread));
        const failed = yield* terminal(runtime);
        expect(failed[0]?.status).toBe("failed");
        expect(failed[0]?.failure?.class).toBe("transport_error");
        expect(reads).toBe(3);
        yield* runtime.startTurn(turnInput(thread, 2));
        const completed = yield* terminal(runtime);
        expect(completed[0]?.status).toBe("completed");
        expect(creates).toBe(1);
        expect(sends).toBe(1);
      }),
  );

  it.effect("validates organization access before marking a PAT ready", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const instance = yield* DevinCloudDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        config: settings,
        environment: [{ name: "DEVIN_API_KEY", value: "test-key", sensitive: true }],
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push(request.url);
            return Effect.succeed(
              request.url.endsWith("/self")
                ? response(request, { principal_type: "pat_user", org_id: "org-other" })
                : response(request, {}, 403),
            );
          }),
        ),
      );
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("denied access");
      expect(requests.some((url) => url.endsWith("organizations/org-test/sessions?first=1"))).toBe(
        true,
      );
    }),
  );

  it.effect("stops a persisted Cloud session without opening a runtime after restart", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const provider = yield* adapter(
        http((request) => {
          requests.push(`${request.method} ${request.url}`);
          return { ...remote("user_request"), status: "suspended" };
        }),
      );
      const runtime = yield* provider.openSession(openInput);
      const empty = yield* runtime.ensureThread(openInput);
      const current = {
        ...empty,
        nativeThreadRef: {
          driver: empty.driver,
          nativeId: "remote-one",
          strength: "strong" as const,
        },
      };
      const stop = provider.interruptDetachedTurn;
      if (!stop) return yield* Effect.die("Cloud must support detached interruption");
      const providerTurnId = IdAllocator.derive.providerTurn({
        driver: current.driver,
        nativeTurnId: "persisted-turn",
      });
      yield* stop({ providerThread: current, providerTurnId });
      expect(requests).toEqual([
        "DELETE https://api.devin.ai/v3/organizations/org-test/sessions/devin-remote-one?archive=false",
      ]);
      const wrongInstance = yield* stop({
        providerThread: {
          ...current,
          providerInstanceId: ProviderInstanceId.make("different-instance"),
        },
        providerTurnId,
      }).pipe(Effect.result);
      expect(wrongInstance._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect(
    "observes accepted remote work during restart continuation without resending its prompt",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const provider = yield* adapter(
          http((request) => {
            requests.push(`${request.method} ${request.url}`);
            return request.url.includes("/messages")
              ? { items: [reply("finished-offline", "Remote result")] }
              : remote();
          }),
        );
        const runtime = yield* provider.openSession(openInput);
        const empty = yield* runtime.ensureThread(openInput);
        const resumed = yield* provider.openSession(openInput);
        const current = yield* resumed.resumeThread({
          providerThread: {
            ...empty,
            nativeThreadRef: { driver: empty.driver, nativeId: "remote-one", strength: "strong" },
          },
        });
        yield* resumed.startTurn({
          ...turnInput(current),
          restartContinuationOfRunId: RunId.make("accepted-run"),
        });
        const ended = yield* terminal(resumed);
        expect(ended[0]?.status).toBe("completed");
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
      }),
  );

  it.effect(
    "does not retry creation after a timeout or malformed success response and preserves uncertainty guidance",
    () =>
      Effect.gen(function* () {
        for (const outcome of ["timeout", "malformed"]) {
          const started = yield* Deferred.make<void>();
          let posts = 0;
          const client = HttpClient.make((request) => {
            if (request.method === "POST") posts++;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(
                outcome === "timeout" ? Effect.never : Effect.succeed(response(request, {})),
              ),
            );
          });
          const provider = yield* makeDevinCloudAdapterV2({
            instanceId,
            settings,
            apiKey: "test-key",
            pollIntervalMs: 0,
            requestTimeoutMs: 1000,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          const runtime = yield* provider.openSession(openInput);
          const thread = yield* runtime.ensureThread(openInput);
          const starting = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          if (outcome === "timeout") yield* TestClock.adjust(1000);
          yield* Fiber.join(starting);
          const ended = yield* terminal(runtime);
          expect(ended[0]?.status).toBe("failed");
          expect(ended[0]?.failure?.code).toBe("cloud_session_creation_unconfirmed");
          expect(ended[0]?.failure?.retryable).toBe(false);
          expect(ended[0]?.failure?.message).toContain(
            "Check Devin for an existing session before retrying",
          );
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread: thread });
          expect(snapshot.providerThread.nativeThreadRef).toBeNull();
          expect(posts).toBe(1);
        }
      }),
  );

  it.effect("retries an unsuccessful history attach without losing its retained replay batch", () =>
    Effect.gen(function* () {
      let messageReads = 0;
      const client = HttpClient.make((request) => {
        if (request.url.includes("/messages")) {
          messageReads++;
          return Effect.succeed(
            messageReads === 1
              ? response(request, {}, 503)
              : response(request, {
                  items: [reply("observed", "Already shown"), reply("missed", "Restored answer")],
                }),
          );
        }
        return Effect.succeed(response(request, remote()));
      });
      const provider = yield* adapter(client);
      const emptyRuntime = yield* provider.openSession(openInput);
      const empty = yield* emptyRuntime.ensureThread(openInput);
      const runtime = yield* provider.openSession(openInput);
      const persisted = {
        ...empty,
        nativeThreadRef: {
          driver: empty.driver,
          nativeId: "remote-one",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: {
          driver: empty.driver,
          nativeId: "observed",
          strength: "strong" as const,
        },
      };
      const failed = yield* runtime.resumeThread({ providerThread: persisted }).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      const thread = yield* runtime.resumeThread({ providerThread: persisted });
      if (!runtime.readThreadHistory)
        return yield* Effect.die("Cloud must expose restored history");
      const batch = yield* runtime.readThreadHistory({ providerThread: thread });
      expect(
        batch
          .filter((event) => event.type === "message.updated")
          .map((event) => event.message.text),
      ).toEqual(["Restored answer"]);
      expect(yield* runtime.readThreadHistory({ providerThread: thread })).toBe(batch);
      expect(messageReads).toBe(2);
    }),
  );

  it.effect(
    "preserves a reply arriving between attach and submission without mistaking it for progress of the new prompt",
    () =>
      Effect.gen(function* () {
        let messages = 0;
        let sent = false;
        let readsAfterSend = 0;
        const provider = yield* adapter(
          http((request) => {
            if (request.method === "POST") {
              sent = true;
              return remote("finished", 20);
            }
            if (request.url.includes("/messages")) {
              messages++;
              return {
                items: [
                  reply("observed", "Already shown"),
                  ...(messages >= 2 ? [reply("late", "Late offline reply")] : []),
                  ...(readsAfterSend >= 2 ? [reply("current", "Current prompt reply")] : []),
                ],
              };
            }
            if (sent) readsAfterSend++;
            return remote("finished", 20);
          }),
        );
        const emptyRuntime = yield* provider.openSession(openInput);
        const empty = yield* emptyRuntime.ensureThread(openInput);
        const runtime = yield* provider.openSession(openInput);
        const current = yield* runtime.resumeThread({
          providerThread: {
            ...empty,
            nativeThreadRef: { driver: empty.driver, nativeId: "remote-one", strength: "strong" },
            nativeConversationHeadRef: {
              driver: empty.driver,
              nativeId: "observed",
              strength: "strong",
            },
          },
        });
        yield* runtime.startTurn(turnInput(current));
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(
          events
            .filter((event) => event.type === "message.updated")
            .map((event) => event.message.text),
        ).toEqual(["Late offline reply", "Current prompt reply"]);
        expect(readsAfterSend).toBe(2);
      }),
  );

  it.effect(
    "rejects a missing synchronized head without reassigning old history or sending another prompt",
    () =>
      Effect.gen(function* () {
        let available = false;
        let posts = 0;
        const provider = yield* adapter(
          http((request) => {
            if (request.method === "POST") posts++;
            if (request.url.includes("/messages"))
              return {
                items: available
                  ? [reply("observed", "Already shown"), reply("restored", "Offline result")]
                  : [reply("old", "Earlier run result")],
              };
            return remote();
          }),
        );
        const emptyRuntime = yield* provider.openSession(openInput);
        const empty = yield* emptyRuntime.ensureThread(openInput);
        const runtime = yield* provider.openSession(openInput);
        const persisted = {
          ...empty,
          nativeThreadRef: {
            driver: empty.driver,
            nativeId: "remote-one",
            strength: "strong" as const,
          },
          nativeConversationHeadRef: {
            driver: empty.driver,
            nativeId: "observed",
            strength: "strong" as const,
          },
        };
        const missing = yield* runtime
          .resumeThread({ providerThread: persisted })
          .pipe(Effect.result);
        expect(missing._tag).toBe("Failure");
        available = true;
        const current = yield* runtime.resumeThread({ providerThread: persisted });
        if (!runtime.readThreadHistory)
          return yield* Effect.die("Cloud must expose restored history");
        const history = yield* runtime.readThreadHistory({ providerThread: current });
        expect(
          history
            .filter((event) => event.type === "message.updated")
            .map((event) => event.message.text),
        ).toEqual(["Offline result"]);
        available = false;
        const send = yield* runtime.startTurn(turnInput(current)).pipe(Effect.result);
        expect(send._tag).toBe("Failure");
        expect(posts).toBe(0);
        expect(yield* runtime.readThreadHistory({ providerThread: current })).toBe(history);
      }),
  );
});
