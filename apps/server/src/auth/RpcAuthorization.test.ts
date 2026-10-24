import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { AuthEnvironmentScope, clientRpcRequiredScopes } from "@t3tools/contracts";
import {
  FACTORY_CLIENT_GUARDED_RPC_SCOPES,
  FACTORY_RPC_READ_SCOPES,
  FACTORY_WS_METHODS,
  FactoryDeliveryId,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import {
  WORK_RPC_READ_SCOPES,
  WORK_WS_METHODS,
  WorkItemId,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it.effect.each([
    { scopes: [AuthSettingsWriteScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationOperateScope], missing: AuthSettingsWriteScope },
  ])("rejects membership changes without $missing before mutation", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...Array.from(WsRpcGroup.requests.keys()).filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.projectsSetRepositories
          > => tag !== WS_METHODS.projectsSetRepositories,
        ),
      );
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.projectsSetRepositories, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.projectsSetRepositories]({
          projectId: ProjectId.make("project"),
          repositories: [],
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: missing });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
  it("keeps Work reads behind work:read and Work writes behind their guarded scopes", () => {
    for (const method of Object.values(WORK_WS_METHODS)) {
      expect(Object.hasOwn(RPC_REQUIRED_SCOPES, method)).toBe(true);
    }
    for (const method of Object.keys(WORK_RPC_READ_SCOPES)) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthWorkReadScope);
    }
    expect(requiredScopeForRpcMethod(WORK_WS_METHODS.workItemsUpdate)).toBe(AuthWorkWriteScope);
    expect(requiredScopeForRpcMethod(WORK_WS_METHODS.workSourcesSave)).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(WORK_WS_METHODS.workThreadsStart)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("keeps Factory reads behind orchestration:read and guards exactly its five controls", () => {
    for (const method of Object.values(FACTORY_WS_METHODS)) {
      expect(Object.hasOwn(RPC_REQUIRED_SCOPES, method)).toBe(true);
    }
    for (const method of Object.keys(FACTORY_RPC_READ_SCOPES)) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([]);
    }
    expect(Object.keys(FACTORY_CLIENT_GUARDED_RPC_SCOPES).sort()).toEqual(
      [
        FACTORY_WS_METHODS.factorySettingsSet,
        FACTORY_WS_METHODS.factoryDeliveriesStart,
        FACTORY_WS_METHODS.factoryDeliveriesStop,
        FACTORY_WS_METHODS.factoryDeliveriesResume,
        FACTORY_WS_METHODS.factoryDeliveriesCancel,
      ].sort(),
    );
    expect(requiredScopeForRpcMethod(FACTORY_WS_METHODS.factorySettingsSet)).toBe(
      AuthSettingsWriteScope,
    );
    for (const method of [
      FACTORY_WS_METHODS.factoryDeliveriesStart,
      FACTORY_WS_METHODS.factoryDeliveriesStop,
      FACTORY_WS_METHODS.factoryDeliveriesResume,
      FACTORY_WS_METHODS.factoryDeliveriesCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("requires operate access to stop a workflow", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_V2_WS_METHODS.stopWorkflow)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthProvidersManageScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("requires source control writes to start, retry, or cancel project clones", () => {
    for (const method of [
      WS_METHODS.projectCloneStart,
      WS_METHODS.projectCloneRetry,
      WS_METHODS.projectCloneCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeProjectClones)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates viewing pull request file progress from writing it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsFilesViewed)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSetFilesViewed)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAdjust,
      WS_METHODS.previewClearProfile,
      WS_METHODS.previewReportProfiles,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

const defaultFactorySettings = Schema.decodeSync(FactoryProjectSettings)({});

describe("Factory RPC authorization", () => {
  type WsTag = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];
  type FactoryTag = (typeof FACTORY_WS_METHODS)[keyof typeof FACTORY_WS_METHODS];
  const factoryTags = new Set<string>(Object.values(FACTORY_WS_METHODS));
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsTag, FactoryTag> => !factoryTags.has(tag),
    ),
  );
  type FactoryClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof group>>;

  const deliveryId = FactoryDeliveryId.make("delivery-1");
  const projectId = ProjectId.make("project");
  const itemRef = {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-aaaaaa"),
  };

  /** Calls one method as a session holding every grant except `missing`. */
  const callWithout = (
    missing: AuthEnvironmentScope,
    call: (client: FactoryClient) => Effect.Effect<object, { readonly _tag: string }>,
  ) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const reached = (tag: string) => () =>
        Effect.sync(() => {
          handled.push(tag);
        }).pipe(Effect.andThen(Effect.never));
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer(
              group.of({
                [FACTORY_WS_METHODS.factorySettingsGet]: reached("settings.get"),
                [FACTORY_WS_METHODS.factorySettingsSet]: reached("settings.set"),
                [FACTORY_WS_METHODS.factoryDeliveriesStart]: reached("start"),
                [FACTORY_WS_METHODS.factoryDeliveriesStop]: reached("stop"),
                [FACTORY_WS_METHODS.factoryDeliveriesResume]: reached("resume"),
                [FACTORY_WS_METHODS.factoryDeliveriesCancel]: reached("cancel"),
                [FACTORY_WS_METHODS.factoryDeliveriesGet]: reached("get"),
                [FACTORY_WS_METHODS.factoryDeliveriesList]: reached("list"),
              }),
            ),
            RpcAuthorization.layer(
              AuthEnvironmentScope.literals.filter((scope) => scope !== missing),
            ),
          ),
        ),
      );
      const refusal = yield* Effect.flip(call(client));
      return { refusal, handled };
    }).pipe(Effect.scoped);

  it.effect.each([
    {
      name: "settings.set without settings:write",
      missing: AuthSettingsWriteScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factorySettingsSet]({
          projectId,
          settings: defaultFactorySettings,
        }),
    },
    {
      name: "start without orchestration:operate",
      missing: AuthOrchestrationOperateScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factoryDeliveriesStart]({ itemRef }),
    },
    {
      name: "stop without orchestration:operate",
      missing: AuthOrchestrationOperateScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factoryDeliveriesStop]({ deliveryId }),
    },
    {
      name: "resume without orchestration:operate",
      missing: AuthOrchestrationOperateScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factoryDeliveriesResume]({ deliveryId }),
    },
    {
      name: "cancel without orchestration:operate",
      missing: AuthOrchestrationOperateScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factoryDeliveriesCancel]({ deliveryId }),
    },
    {
      name: "settings.get without orchestration:read",
      missing: AuthOrchestrationReadScope,
      call: (client: FactoryClient) => client[FACTORY_WS_METHODS.factorySettingsGet]({ projectId }),
    },
    {
      name: "get without orchestration:read",
      missing: AuthOrchestrationReadScope,
      call: (client: FactoryClient) =>
        client[FACTORY_WS_METHODS.factoryDeliveriesGet]({ deliveryId }),
    },
    {
      name: "list without orchestration:read",
      missing: AuthOrchestrationReadScope,
      call: (client: FactoryClient) => client[FACTORY_WS_METHODS.factoryDeliveriesList]({}),
    },
  ])("refuses $name before the handler runs", ({ missing, call }) =>
    Effect.gen(function* () {
      const { refusal, handled } = yield* callWithout(missing, call);
      expect(refusal).toMatchObject({ requiredPermission: missing });
      expect(handled).toEqual([]);
    }),
  );
});
