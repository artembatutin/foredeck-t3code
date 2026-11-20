import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { AssetSigner } from "../../assets/AssetSigner.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { DeviceService } from "../../device/DeviceService.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../../peer/PeerLinks.ts";
import { RemoteDelegation } from "../../peer/RemoteDelegation.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { DocumentText } from "../../provider/DocumentText.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { PullRequestReviewGuideService } from "../../pullRequest/PullRequestReviewGuideService.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { EnvironmentThemeService } from "../../environmentTheme.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SourceControlRepositoryService } from "../../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { GitManager } from "../../git/GitManager.ts";
import { IssueService } from "../../issue/IssueService.ts";
import { ThreadIssueService } from "../../orchestration-v2/ThreadIssueService.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { ProjectAssistant, WorkCapture } from "../assistant/index.ts";
import { FactoryService } from "../factory/index.ts";
import { WorkService, WorkThreads } from "../work-management/index.ts";
import * as AssistantHandoff from "./index.ts";

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(ProjectAssistant.ProjectAssistant)({}),
  Layer.mock(WorkCapture.WorkCapture)({}),
  Layer.mock(WorkService.WorkService)({}),
  Layer.mock(WorkThreads.WorkThreads)({}),
  Layer.mock(FactoryService.FactoryService)({}),
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(GitManager)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService)({}),
  Layer.mock(EnvironmentThemeService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(IssueService)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-fd-tool-registration-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadIssueService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerAdvertisedTools = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

const fdTools = [
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
];

it.effect("the production MCP tool set publishes every fd tool, each with a caller class", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const tools = mcp.tools.map(({ tool }) => tool);
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([...fdTools, "delegate_task"]));

    const factoryStatus = tools.find((tool) => tool.name === "factory_status");
    expect(factoryStatus?.annotations?.readOnlyHint).toBe(true);
    const factoryDeliver = tools.find((tool) => tool.name === "factory_deliver");
    expect(factoryDeliver?.annotations?.readOnlyHint).toBe(false);

    // MCP requires every tool input schema to be a top-level object schema.
    for (const tool of tools.filter(({ name }) => fdTools.includes(name))) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }

    // The caller policy classes every published tool by its exact name, so a governed thread
    // never reaches a new tool by falling through.
    expect(
      toolNames.filter((name) => !AssistantHandoff.CallerTools.isClassifiedTool(name)),
    ).toEqual([]);
    expect(AssistantHandoff.CallerTools.callerToolClass("delegate_task")).toBe("delegate");
    expect(
      AssistantHandoff.CallerTools.callerToolClass("t3_pending_request", { action: "respond" }),
    ).toBe("respond_live");
  }).pipe(Effect.provide(layerAdvertisedTools)),
);
