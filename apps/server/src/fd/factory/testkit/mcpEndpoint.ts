import { NodeHttpServer } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import {
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpCallerPolicy from "../../../mcp/McpCallerPolicy.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../../mcp/PreviewAutomationBroker.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as AssistantHandoff from "../../assistant-handoff/index.ts";
import { WorkThreads } from "../../work-management/index.ts";
import { instanceId, type World } from "./deliveryHarness.ts";

/**
 * The server's authenticated MCP endpoint on the delivery harness: the production MCP layer with
 * the caller policy the server provides, over the world's services, served over HTTP. Each caller
 * gets a credential issued for its thread, as core issues one when a provider session opens.
 * Services the harness does not run are inert stubs: their tools are never what a test calls.
 */

type Policy = typeof McpCallerPolicy.McpCallerPolicy.Service;

/** The fake provider as the provider registry reports it: ready, with the harness's model. */
const providerSnapshot = (driver: ProviderDriverKind): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T12:00:00.000Z",
  models: [{ slug: "test-model", name: "test-model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const layerStubs = (driver: ProviderDriverKind) =>
  Layer.mergeAll(
    ProviderRegistryMock.layer([providerSnapshot(driver)]),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([instanceId]),
    }),
    Layer.mock(WorkThreads.WorkThreads)({}),
    Layer.mock(DeviceService.DeviceService)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(PreviewManager.PreviewManager)({}),
    Layer.mock(ServerSecretStore.ServerSecretStore)({}),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed("environment-factory-delivery" as never),
    }),
    PreviewAutomationBroker.layer,
    PreviewBrowser.layer,
  );

/** What a tool call answered: whether it is an error, and its text. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly text: string;
}

/** An agent on a thread, calling tools through the endpoint with its thread's credential. */
export interface McpCaller {
  readonly threadId: ThreadId;
  readonly call: (
    tool: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<ToolAnswer, never, never>;
}

export interface Endpoint {
  /** Issues the thread's credential and opens an MCP session with it. */
  readonly callerOn: (threadId: ThreadId) => Effect.Effect<McpCaller>;
  /** An outside MCP client the owner approved with full access, signed in through OAuth. */
  readonly outsideClient: Effect.Effect<Omit<McpCaller, "threadId">>;
}

const outsideToken = "outside-payload.outside-signature";
const outsideClients = Layer.succeed(McpHttpServer.McpClientAuthenticator, {
  authenticate: (request) =>
    Effect.succeed(
      request.headers.authorization === `Bearer ${outsideToken}`
        ? {
            environmentId: "environment-factory-delivery" as never,
            requestNamespace: "client:outside",
            thread: undefined,
            client: {
              sessionId: "outside",
              label: "Outside agent",
              access: "full-access" as const,
            },
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
          }
        : undefined,
    ),
});

const CallResponse = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
    }),
  }),
);
const decodeCallResponse = Schema.decodeUnknownEffect(CallResponse);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Runs `body` with the endpoint served. `policy` wraps the bridge's caller policy, so a test can
 * hold a call between the screen and its handler.
 */
export const withEndpoint = <A, E, R>(
  driver: ProviderDriverKind,
  body: (endpoint: Endpoint) => Effect.Effect<A, E, R>,
  options: { readonly policy?: (policy: Policy) => Policy } = {},
) =>
  Effect.gen(function* () {
    const http = yield* Layer.build(NodeHttpServer.layerTest);
    const wrap = options.policy;
    const policy =
      wrap === undefined
        ? AssistantHandoff.layerCallerPolicy
        : Layer.effect(
            McpCallerPolicy.McpCallerPolicy,
            Effect.map(McpCallerPolicy.McpCallerPolicy, wrap),
          ).pipe(Layer.provide(AssistantHandoff.layerCallerPolicy));
    const stubs = layerStubs(driver);
    const registry = McpSessionRegistry.layer.pipe(Layer.provide(stubs));
    const served = yield* Layer.build(
      HttpRouter.serve(
        McpHttpServer.layer.pipe(Layer.provide(policy), Layer.provide(outsideClients)),
        {
          disableListenLog: true,
          disableLogger: true,
        },
      ).pipe(Layer.provideMerge(registry), Layer.provide(stubs)),
    ).pipe(Effect.provide(Layer.succeedContext(http)));
    const sessions = Context.get(served, McpSessionRegistry.McpSessionRegistry);
    const client = Context.get(http, HttpClient.HttpClient);
    let ids = 1;
    const session = (authorization: string) =>
      Effect.gen(function* () {
        const headers = { accept: "application/json, text/event-stream", authorization };
        const initialized = yield* client.post("/mcp", {
          headers,
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        assert.strictEqual(initialized.status, 200);
        const sessionId = initialized.headers["mcp-session-id"];
        const call: McpCaller["call"] = (tool, args) =>
          Effect.gen(function* () {
            ids += 1;
            const response = yield* client.post("/mcp", {
              headers: {
                ...headers,
                "mcp-protocol-version": "2025-06-18",
                ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
              },
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id: ids,
                  method: "tools/call",
                  params: { name: tool, arguments: args },
                }),
                "application/json",
              ),
            });
            const text = yield* response.text;
            const json =
              text.match(/\{.*\}/s)?.[0] ?? assert.fail(`No result for ${tool}: ${text}`);
            const { result } = yield* decodeCallResponse(json);
            return {
              isError: result.isError === true,
              text: result.content.map((part) => part.text ?? "").join(""),
            };
          }).pipe(Effect.orDie);
        return { call };
      }).pipe(Effect.orDie);
    const callerOn: Endpoint["callerOn"] = (threadId) =>
      sessions.issue({ threadId, providerInstanceId: ProviderInstanceId.make(instanceId) }).pipe(
        Effect.flatMap(({ config }) => session(config.authorizationHeader)),
        Effect.map(({ call }) => ({ threadId, call })),
      );
    return yield* body({ callerOn, outsideClient: session(`Bearer ${outsideToken}`) });
  }).pipe(Effect.scoped);

/** Every tool that starts, messages, schedules, hands off or watches work, as an agent calls it. */
export const runCreatingCalls = (
  world: World,
  targets: { readonly own: ThreadId; readonly family: ThreadId; readonly owner: ThreadId },
): ReadonlyArray<readonly [string, Record<string, unknown>]> => {
  const threads = [targets.own, targets.family, targets.owner];
  const item = `${world.itemRef.sourceId}:${world.itemRef.itemId}`;
  return [
    ...threads.flatMap((threadId) =>
      (["queue", "auto", "steer", "restart"] as const).map(
        (mode) => ["t3_thread_send", { threadId, message: "Check it once more.", mode }] as const,
      ),
    ),
    ...threads.map(
      (threadId) =>
        [
          "t3_thread_send_attachments",
          { threadId, message: "See the log.", attachmentIds: ["upload-1"] },
        ] as const,
    ),
    ["t3_thread_launch", { projectId: world.projectId, message: "Start a side task." }],
    ["create_threads", { threads: [{ title: "Side task", message: "Start a side task." }] }],
    ["schedule_task", { title: "Nightly", prompt: "Deliver the next item.", cron: "0 3 * * *" }],
    ["update_scheduled_task", { taskId: "task-1", prompt: "Deliver everything." }],
    ["run_scheduled_task_now", { taskId: "task-1" }],
    ["t3_worktree_handoff", { mode: "worktree" }],
    ["t3_thread_fork", { threadId: targets.own, sourcePoint: { type: "latest" } }],
    [
      "t3_thread_merge_back",
      {
        sourceThreadId: targets.own,
        targetThreadId: targets.owner,
        sourcePoint: { type: "latest" },
      },
    ],
    ["t3_queue_edit", { threadId: targets.family, queuedRunId: "run-1", text: "Changed." }],
    [
      "t3_queue_promote_to_steer",
      { threadId: targets.family, queuedRunId: "run-1", targetRunId: "run-2" },
    ],
    ["watch_pull_request", { threadId: targets.own, number: 7 }],
    ["work_start_thread", { item, mode: "implement" }],
    ["factory_deliver", { item }],
    ["voice_reply", { text: "Done." }],
    ["assistant_assign", { assignmentId: "side", projectId: world.projectId, ideaId: "side" }],
    ["assistant_capture_work", { projectId: world.projectId, ideaId: "side", kind: "single" }],
    ["assistant_portfolio", {}],
    ["a_tool_nobody_published", {}],
  ];
};

/** Calls each tool as `caller` and expects the policy's `refusal` for every one. */
export const refusesAll = (
  caller: McpCaller,
  calls: ReadonlyArray<readonly [string, Record<string, unknown>]>,
  refusal: string,
) =>
  Effect.forEach(
    calls,
    ([tool, args]) =>
      caller
        .call(tool, args)
        .pipe(
          Effect.map((answer) =>
            assert.deepStrictEqual(
              answer,
              { isError: true, text: refusal },
              `${tool} on ${caller.threadId}`,
            ),
          ),
        ),
    { discard: true },
  );
