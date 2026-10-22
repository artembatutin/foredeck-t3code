import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  EnvironmentAuthorizationError,
} from "../../auth.ts";
import { NonNegativeInt } from "../../baseSchemas.ts";
import {
  WorkCommentInput,
  WorkCommentResult,
  WorkError,
  WorkItemCreateInput,
  WorkItemDetail,
  WorkItemGetInput,
  WorkItemPatch,
  WorkItemSummary,
  WorkLinkSetInput,
  WorkLinkSetResult,
  WorkLinksQuery,
  WorkLinksResult,
  WorkListQuery,
  WorkListResult,
  WorkPeopleQuery,
  WorkPeopleResult,
  WorkRefreshInput,
  WorkSetStatusInput,
  WorkSource,
  WorkSourceList,
  WorkSourceRefInput,
  WorkSourceSaveInput,
  WorkSourcesListInput,
  WorkSourceTestInput,
  WorkSourceTestResult,
  WorkStartThreadInput,
  WorkStartThreadResult,
} from "./schemas.ts";

/**
 * The Work WebSocket methods. Core `rpc.ts` spreads these into `WS_METHODS` and `WorkRpcs`
 * into the RPC group; the scope and instrumentation tables below are spread into their core
 * maps the same way, so each core edit stays one line.
 */
export const WORK_WS_METHODS = {
  workSourcesList: "work.sources.list",
  workSourcesSave: "work.sources.save",
  workSourcesDisconnect: "work.sources.disconnect",
  workSourcesRestore: "work.sources.restore",
  workSourcesTest: "work.sources.test",
  workItemsList: "work.items.list",
  workItemsGet: "work.items.get",
  workItemsPeople: "work.items.people",
  workItemsCreate: "work.items.create",
  workItemsUpdate: "work.items.update",
  workItemsSetStatus: "work.items.setStatus",
  workItemsComment: "work.items.comment",
  workLinksList: "work.links.list",
  workLinksSet: "work.links.set",
  workRefresh: "work.refresh",
  workSubscribeRefreshes: "work.subscribeRefreshes",
  workThreadsStart: "work.threads.start",
} as const;

const WorkRpcError = Schema.Union([WorkError, EnvironmentAuthorizationError]);

const WsWorkSourcesListRpc = Rpc.make(WORK_WS_METHODS.workSourcesList, {
  payload: WorkSourcesListInput,
  success: WorkSourceList,
  error: WorkRpcError,
});
const WsWorkSourcesSaveRpc = Rpc.make(WORK_WS_METHODS.workSourcesSave, {
  payload: WorkSourceSaveInput,
  success: WorkSource,
  error: WorkRpcError,
});
const WsWorkSourcesDisconnectRpc = Rpc.make(WORK_WS_METHODS.workSourcesDisconnect, {
  payload: WorkSourceRefInput,
  success: WorkSource,
  error: WorkRpcError,
});
const WsWorkSourcesRestoreRpc = Rpc.make(WORK_WS_METHODS.workSourcesRestore, {
  payload: WorkSourceRefInput,
  success: WorkSource,
  error: WorkRpcError,
});
const WsWorkSourcesTestRpc = Rpc.make(WORK_WS_METHODS.workSourcesTest, {
  payload: WorkSourceTestInput,
  success: WorkSourceTestResult,
  error: WorkRpcError,
});
const WsWorkItemsListRpc = Rpc.make(WORK_WS_METHODS.workItemsList, {
  payload: WorkListQuery,
  success: WorkListResult,
  error: WorkRpcError,
});
const WsWorkItemsGetRpc = Rpc.make(WORK_WS_METHODS.workItemsGet, {
  payload: WorkItemGetInput,
  success: WorkItemDetail,
  error: WorkRpcError,
});
const WsWorkItemsPeopleRpc = Rpc.make(WORK_WS_METHODS.workItemsPeople, {
  payload: WorkPeopleQuery,
  success: WorkPeopleResult,
  error: WorkRpcError,
});
const WsWorkItemsCreateRpc = Rpc.make(WORK_WS_METHODS.workItemsCreate, {
  payload: WorkItemCreateInput,
  success: WorkItemSummary,
  error: WorkRpcError,
});
const WsWorkItemsUpdateRpc = Rpc.make(WORK_WS_METHODS.workItemsUpdate, {
  payload: WorkItemPatch,
  success: WorkItemSummary,
  error: WorkRpcError,
});
const WsWorkItemsSetStatusRpc = Rpc.make(WORK_WS_METHODS.workItemsSetStatus, {
  payload: WorkSetStatusInput,
  success: WorkItemSummary,
  error: WorkRpcError,
});
const WsWorkItemsCommentRpc = Rpc.make(WORK_WS_METHODS.workItemsComment, {
  payload: WorkCommentInput,
  success: WorkCommentResult,
  error: WorkRpcError,
});
const WsWorkLinksListRpc = Rpc.make(WORK_WS_METHODS.workLinksList, {
  payload: WorkLinksQuery,
  success: WorkLinksResult,
  error: WorkRpcError,
});
const WsWorkLinksSetRpc = Rpc.make(WORK_WS_METHODS.workLinksSet, {
  payload: WorkLinkSetInput,
  success: WorkLinkSetResult,
  error: WorkRpcError,
});
const WsWorkRefreshRpc = Rpc.make(WORK_WS_METHODS.workRefresh, {
  payload: WorkRefreshInput,
  success: Schema.Void,
  error: WorkRpcError,
});
/** An epoch that moves whenever Work data changed; clients refetch what they show. */
const WsWorkSubscribeRefreshesRpc = Rpc.make(WORK_WS_METHODS.workSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});
const WsWorkThreadsStartRpc = Rpc.make(WORK_WS_METHODS.workThreadsStart, {
  payload: WorkStartThreadInput,
  success: WorkStartThreadResult,
  error: WorkRpcError,
});

export const WorkRpcs = [
  WsWorkSourcesListRpc,
  WsWorkSourcesSaveRpc,
  WsWorkSourcesDisconnectRpc,
  WsWorkSourcesRestoreRpc,
  WsWorkSourcesTestRpc,
  WsWorkItemsListRpc,
  WsWorkItemsGetRpc,
  WsWorkItemsPeopleRpc,
  WsWorkItemsCreateRpc,
  WsWorkItemsUpdateRpc,
  WsWorkItemsSetStatusRpc,
  WsWorkItemsCommentRpc,
  WsWorkLinksListRpc,
  WsWorkLinksSetRpc,
  WsWorkRefreshRpc,
  WsWorkSubscribeRefreshesRpc,
  WsWorkThreadsStartRpc,
] as const;

/**
 * Reads and the refresh request, authorized server-side only; the client never guards them. A
 * read-only client asking to look again must not be told it may not look.
 */
export const WORK_RPC_READ_SCOPES = {
  [WORK_WS_METHODS.workSourcesList]: AuthWorkReadScope,
  [WORK_WS_METHODS.workItemsList]: AuthWorkReadScope,
  [WORK_WS_METHODS.workItemsGet]: AuthWorkReadScope,
  [WORK_WS_METHODS.workItemsPeople]: AuthWorkReadScope,
  [WORK_WS_METHODS.workLinksList]: AuthWorkReadScope,
  [WORK_WS_METHODS.workSubscribeRefreshes]: AuthWorkReadScope,
  [WORK_WS_METHODS.workRefresh]: AuthWorkReadScope,
} as const;

/** Writes, guarded on the client through `permissionAtom` and again on the server. */
export const WORK_CLIENT_GUARDED_RPC_SCOPES = {
  [WORK_WS_METHODS.workSourcesSave]: AuthSettingsWriteScope,
  [WORK_WS_METHODS.workSourcesDisconnect]: AuthSettingsWriteScope,
  [WORK_WS_METHODS.workSourcesRestore]: AuthSettingsWriteScope,
  [WORK_WS_METHODS.workSourcesTest]: AuthSettingsWriteScope,
  [WORK_WS_METHODS.workItemsCreate]: AuthWorkWriteScope,
  [WORK_WS_METHODS.workItemsUpdate]: AuthWorkWriteScope,
  [WORK_WS_METHODS.workItemsSetStatus]: AuthWorkWriteScope,
  [WORK_WS_METHODS.workItemsComment]: AuthWorkWriteScope,
  [WORK_WS_METHODS.workLinksSet]: AuthWorkWriteScope,
  [WORK_WS_METHODS.workThreadsStart]: AuthOrchestrationOperateScope,
} as const;

/** Every Work method under one instrumentation class. */
export const WORK_RPC_INSTRUMENTATION = Object.fromEntries(
  Object.values(WORK_WS_METHODS).map((method) => [method, "work"] as const),
) as { readonly [Method in (typeof WORK_WS_METHODS)[keyof typeof WORK_WS_METHODS]]: "work" };
