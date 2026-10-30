import {
  HandoffAdmission,
  HandoffBackend,
  ProjectAssistant,
  WorkCapture,
} from "../../../fd/assistant/index.ts";
import * as AssistantHandoff from "../../../fd/assistant-handoff/index.ts";
import { FactoryService } from "../../../fd/factory/index.ts";
import { WorkService, WorkThreads } from "../../../fd/work-management/index.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(ProjectAssistant.ProjectAssistant)({}),
  Layer.mock(WorkCapture.WorkCapture)({}),
  Layer.mock(WorkService.WorkService)({}),
  Layer.mock(WorkThreads.WorkThreads)({}),
  Layer.mock(FactoryService.FactoryService)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(layerStubServices),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers["mcp-session-id"];

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      const bodyText = yield* listResponse.text;
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");
      for (const name of [
        "assistant_portfolio",
        "assistant_revise_brief",
        "assistant_assign",
        "assistant_control",
        "assistant_answer",
        "assistant_verify",
        "assistant_capture_work",
        "assistant_abandon_capture",
        "work_list",
        "work_read",
        "work_create",
        "work_update",
        "work_set_status",
        "work_comment",
        "work_link_thread",
        "work_start_thread",
        "factory_submit_review",
        "factory_submit_plan",
        "factory_status",
        "factory_deliver",
      ])
        expect(toolNames).toContain(name);

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);
      const factoryStatus = tools.find((tool) => tool.name === "factory_status");
      expect(factoryStatus?.annotations?.readOnlyHint).toBe(true);
      const factoryDeliver = tools.find((tool) => tool.name === "factory_deliver");
      expect(factoryDeliver?.annotations?.readOnlyHint).toBe(false);

      // The caller policy classes every published tool by its exact name, so a governed thread
      // never reaches a new tool by falling through.
      expect(
        toolNames.filter((name) => !AssistantHandoff.CallerTools.isClassifiedTool(name)),
      ).toEqual([]);
      expect(AssistantHandoff.CallerTools.callerToolClass("delegate_task")).toBe("delegate");
      expect(AssistantHandoff.CallerTools.callerToolClass("t3_pending_request_respond")).toBe(
        "respond_live",
      );

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

const managedRoot = FactoryDeliveryId.make("delivery-managed");
const callerThread = ThreadId.make("factory-thread:delivery-managed:1");

/**
 * The production MCP layer with the caller policy the server provides, over stubs that make the
 * caller a managed delivery's thread whose root holds no slot.
 */
const layerGovernedServices = Layer.mergeAll(
  Layer.mock(FactoryService.FactoryService)({
    familyRoot: (threadId) => Effect.succeed(threadId === callerThread ? managedRoot : null),
  }),
  Layer.mock(HandoffAdmission.HandoffAdmission)({
    instanceId: "instance",
    management: () => Effect.succeed("active" as const),
    admitDelegation: () =>
      Effect.succeed({ type: "refused" as const, category: "not_holding" as const }),
  }),
  Layer.mock(HandoffBackend.HandoffBackend)({ fingerprint: () => "fingerprint" }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
  }),
);

const ToolCallPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.Boolean,
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    }),
  }),
);
const decodeToolCallPayload = Schema.decodeUnknownEffect(ToolCallPayload);

it.effect("production mcp layer screens and counts governed callers through the bridge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(
        Layer.provide(McpSessionRegistry.layer),
        Layer.provide(AssistantHandoff.layerCallerPolicy),
      );
      yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-governed" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        // The governed stubs replace the inert ones of the same services.
        Layer.provide(Layer.merge(layerStubServices, layerGovernedServices)),
        Layer.build,
      );
      const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: callerThread,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const auth = credential!.config.authorizationHeader;
      const httpClient = yield* HttpClient.HttpClient;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream", authorization: auth },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"governed","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initResponse.headers["mcp-session-id"];
      const callText = (id: number, name: string, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const response = yield* httpClient.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: auth,
              "mcp-protocol-version": "2025-06-18",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: HttpBody.text(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name, arguments: args },
              }),
              "application/json",
            ),
          });
          const payload = yield* decodeToolCallPayload((yield* response.text).match(/\{.*\}/s)![0]);
          expect(payload.result.isError).toBe(true);
          return payload.result.content.map(({ text }) => text).join("");
        });

      // The screen: a run-creating tool is refused before its handler.
      expect(
        yield* callText(2, "t3_thread_send", { threadId: callerThread, message: "Go on." }),
      ).toBe(AssistantHandoff.callerPolicyText.active);
      // The delegation bracket: delegate_task passes the screen, then the admission refuses it.
      expect(yield* callText(3, "delegate_task", { task: "Check the export." })).toContain(
        AssistantHandoff.callerPolicyText.notHolding,
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-governed-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
