import {
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { DevinCloudSettings } from "@t3tools/provider-acp-registry/fd/devin-cloud";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeDevinCloudClient, type CloudMessage, type CloudSession } from "./api.ts";

export const DEVIN_CLOUD_DRIVER_KIND = ProviderDriverKind.make("devinCloud");
const driver = DEVIN_CLOUD_DRIVER_KIND;
const nativeRef = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
const cloudSessionUrl = (remote: CloudSession): string | undefined => {
  const url = remote.url ? URL.parse(remote.url) : null;
  if (
    url?.protocol === "https:" &&
    url.hostname === "app.devin.ai" &&
    !url.username &&
    !url.password &&
    /^\/sessions\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  )
    return `${url.origin}${url.pathname}`;
  return /^[A-Za-z0-9_-]{1,256}$/.test(remote.session_id)
    ? `https://app.devin.ai/sessions/${remote.session_id.replace(/^devin-/, "")}`
    : undefined;
};

const capabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const limitReasons = new Set([
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
  "contract_expired",
]);
interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  nextOrdinal: number;
  readonly seen: Set<string>;
  progressed: boolean;
  stopping?: boolean;
  cursor: string | undefined;
  poll?: Fiber.Fiber<void>;
}
type RestoredHistoryEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "message.updated" | "turn_item.updated" }
>;

/** A runtime owns polling only. Closing its scope leaves the resumable Cloud VM intact. */
export const makeDevinCloudAdapterV2 = Effect.fn("makeDevinCloudAdapterV2")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DevinCloudSettings;
  readonly apiKey: string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const api = yield* makeDevinCloudClient({
    ...options,
    organizationId: options.settings.organizationId,
  });
  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const validatePolicy = (policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
    policy.runtimeMode !== "full-access" || policy.interactionMode !== "default"
      ? Effect.fail(
          protocolError(
            "Devin Cloud uses its remote organization security settings and supports Full access mode only",
          ),
        )
      : Effect.void;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    interruptDetachedTurn: (input) =>
      Effect.gen(function* () {
        const current = input.providerThread;
        const id = current.nativeThreadRef?.nativeId;
        if (
          !options.settings.enabled ||
          !options.apiKey ||
          !options.settings.organizationId ||
          current.driver !== driver ||
          current.providerInstanceId !== options.instanceId ||
          current.nativeThreadRef?.driver !== driver ||
          !id
        )
          return yield* protocolError(
            "Configure and enable the owning Cloud instance to stop this remote session",
          );
        yield* api.stop(id).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver,
                providerThreadId: current.id,
                providerTurnId: input.providerTurnId,
                cause,
              }),
          ),
        );
      }),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.model === target.model && (target.options?.length ?? 0) === 0
          ? turnScopedSelectionTransition()
          : {
              type: "reject" as const,
              reason:
                "Devin Cloud agent mode is fixed for each remote session. Start a new thread to change it.",
            },
      ),
    openSession: Effect.fn("DevinCloudAdapter.openSession")(function* (input) {
      if (!options.settings.enabled || !options.apiKey || !options.settings.organizationId)
        return yield* protocolError(
          "Enable Devin Cloud and configure its organization and DEVIN_API_KEY",
        );
      yield* validatePolicy(input.runtimePolicy);
      if (
        input.modelSelection.instanceId !== options.instanceId ||
        input.modelSelection.model !== "default" ||
        (input.modelSelection.options?.length ?? 0) > 0
      )
        return yield* protocolError("Devin Cloud supports the default model selection only");
      const scope = yield* Effect.scope;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
        model: input.modelSelection.model,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Effect.acquireRelease(
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
        Queue.shutdown,
      );
      const commands = yield* Semaphore.make(1);
      let thread: OrchestrationV2ProviderThread | undefined;
      let restoredHistory: ReadonlyArray<RestoredHistoryEvent> = [];
      let active: ActiveTurn | undefined;
      const providerTurns: Array<OrchestrationV2ProviderTurn> = [];
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
      });
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });
      const nativeId = () => thread?.nativeThreadRef?.nativeId;
      const validateThread = (value: OrchestrationV2ProviderThread) =>
        thread?.id === value.id &&
        value.driver === driver &&
        value.providerInstanceId === options.instanceId;
      const message = (
        value: CloudMessage,
        current: OrchestrationV2ProviderThread,
        turn?: ActiveTurn,
      ): OrchestrationV2ConversationMessage => {
        const time = DateTime.makeUnsafe(value.created_at * 1000);
        return {
          id: ids.derive.messageFromProviderItem({
            driver,
            nativeItemId: `${options.instanceId}:${current.nativeThreadRef?.nativeId}:${value.event_id}`,
          }),
          threadId: current.appThreadId ?? input.threadId,
          runId: turn?.input.runId ?? null,
          nodeId: turn?.input.rootNodeId ?? null,
          role: value.source === "devin" ? "assistant" : "user",
          text: value.message,
          attachments: [],
          streaming: false,
          createdBy: value.source === "devin" ? "agent" : "user",
          creationSource: "provider",
          createdAt: time,
          updatedAt: time,
        };
      };
      const publishMessage = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        value: CloudMessage,
        native = true,
      ) {
        if (!thread || value.source !== "devin" || turn.seen.has(value.event_id)) return;
        turn.seen.add(value.event_id);
        turn.progressed = true;
        const entry = message(value, thread, turn);
        yield* emit({ type: "message.updated", driver, message: entry });
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: ids.derive.turnItemFromProviderItem({
              driver,
              nativeItemId: `${options.instanceId}:${nativeId()}:${value.event_id}`,
            }),
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: thread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: native ? nativeRef(value.event_id) : null,
            parentItemId: null,
            ordinal: turn.nextOrdinal++,
            status: "completed",
            title: null,
            startedAt: entry.createdAt,
            completedAt: entry.updatedAt,
            updatedAt: entry.updatedAt,
            type: "assistant_message",
            messageId: entry.id,
            text: entry.text,
            streaming: false,
          },
        });
        if (native) yield* updateThread({ nativeConversationHeadRef: nativeRef(value.event_id) });
      });
      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "interrupted" | "failed",
        failure?: ReturnType<typeof makeProviderFailure>,
      ) {
        if (active !== turn || !thread || (turn.stopping && status !== "interrupted")) return;
        const completedAt = yield* DateTime.now;
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        providerTurns.push(turn.providerTurn);
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: "idle" });
        yield* updateSession("ready", failure?.message ?? null);
        active = undefined;
        const base = {
          type: "turn.terminal" as const,
          driver,
          providerThreadId: thread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          threadDisposition: "reusable" as const,
        };
        if (status === "failed")
          yield* emit({
            ...base,
            status,
            failure: failure ?? makeProviderFailure({ message: "Devin Cloud session failed." }),
            failureItemOrdinal: turn.nextOrdinal++,
          });
        else yield* emit({ ...base, status, failure: null });
      });
      const inspect = Effect.fnUntraced(function* (turn: ActiveTurn, remote: CloudSession) {
        if (active !== turn) return;
        const detail = remote.status_detail;
        if (remote.status === "error" || detail === "error")
          return yield* finish(
            turn,
            "failed",
            makeProviderFailure({
              class: "provider_error",
              message: "Devin Cloud reported a session error. Open the remote session for details.",
              retryable: true,
            }),
          );
        if (detail && limitReasons.has(detail))
          return yield* finish(
            turn,
            "failed",
            makeProviderFailure({
              class: "usage_limit",
              code: detail,
              message: "Devin Cloud stopped because a usage, quota, or billing limit was reached.",
              retryable: false,
            }),
          );
        if (
          remote.status === "new" ||
          remote.status === "claimed" ||
          remote.status === "resuming" ||
          detail === "working"
        )
          turn.progressed = true;
        const finished =
          detail === "finished" ||
          detail === "waiting_for_user" ||
          detail === "waiting_for_approval" ||
          remote.status === "exit" ||
          remote.status === "suspended";
        if (finished && turn.progressed) {
          if (detail === "user_request") return yield* finish(turn, "interrupted");
          if (detail === "waiting_for_approval") {
            const url = cloudSessionUrl(remote);
            const link = url ? `[the remote Devin session](${url})` : "the remote Devin session";
            yield* publishMessage(
              turn,
              {
                event_id: `approval:${turn.providerTurn.id}`,
                source: "devin",
                message: `Devin Cloud needs approval in ${link}. Approve the action there, then send a follow-up here.`,
                created_at: remote.updated_at,
              },
              false,
            );
            return yield* finish(
              turn,
              "failed",
              makeProviderFailure({
                class: "permission_error",
                message: "Devin Cloud is waiting for approval in its remote session.",
                retryable: true,
              }),
            );
          }
          yield* finish(turn, "completed");
        }
      });
      const poll = (turn: ActiveTurn): Effect.Effect<void> =>
        Effect.gen(function* () {
          let consecutiveFailures = 0;
          while (true) {
            if (active !== turn) return;
            const id = nativeId();
            if (!id) return;
            const result = yield* Effect.gen(function* () {
              // Read status first, then drain messages so the final answer precedes its terminal.
              const remote = yield* api.read(id);
              const messages = yield* api.messages(id, turn.cursor);
              if (active !== turn) return;
              turn.cursor = messages.tailCursor;
              for (const entry of messages.items) yield* publishMessage(turn, entry);
              yield* inspect(turn, remote);
            }).pipe(Effect.result);
            if (result._tag === "Failure") {
              consecutiveFailures++;
              const error = result.failure;
              const transient = error.category === "transport" || error.category === "rate_limit";
              if (!transient || consecutiveFailures >= 3) {
                yield* finish(
                  turn,
                  "failed",
                  makeProviderFailure({
                    class:
                      error.category === "authentication" || error.category === "permission"
                        ? "permission_error"
                        : "transport_error",
                    message: error.message,
                    retryable: transient,
                  }),
                );
                return;
              }
            } else consecutiveFailures = 0;
            if (active !== turn) return;
            if (options.pollIntervalMs === 0) yield* Effect.yieldNow;
            else yield* Effect.sleep(options.pollIntervalMs ?? 2_000);
          }
        });
      const attach = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (thread) {
          if (thread.appThreadId !== args.threadId)
            return yield* protocolError("This Cloud runtime is already attached to another thread");
          return thread;
        }
        yield* validatePolicy(args.runtimePolicy);
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== driver || existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Cloud thread belongs to another provider instance");
        const id = existing?.nativeThreadRef?.nativeId ?? input.initialNativeThreadId;
        if (id)
          yield* api.read(id).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId:
                    existing?.id ??
                    ids.derive.providerThread({
                      driver,
                      providerInstanceId: options.instanceId,
                      nativeThreadId: id,
                    }),
                  cause,
                }),
            ),
          );
        const history = id
          ? yield* api
              .messages(id)
              .pipe(Effect.mapError((cause) => protocolError(cause.message, cause)))
          : undefined;
        const head = existing?.nativeConversationHeadRef?.nativeId;
        const lastObserved =
          head && history ? history.items.findIndex((entry) => entry.event_id === head) : -1;
        if (head && history && lastObserved === -1)
          return yield* protocolError(
            "Cloud history does not contain the last synchronized message. Retry after checking the remote session",
          );
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              ...(id ? { nativeThreadRef: nativeRef(id) } : {}),
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: ids.derive.providerThread({
                driver,
                providerInstanceId: options.instanceId,
                nativeThreadId: id ?? `pending:${args.threadId}`,
              }),
              driver,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: id ? nativeRef(id) : null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        if (history) {
          const replayRunId = existing?.lastRunOrdinal
            ? ids.derive.run({ threadId: args.threadId, ordinal: existing.lastRunOrdinal })
            : null;
          let replayOrdinal = 1;
          const batch: Array<RestoredHistoryEvent> = [];
          // Resume only messages beyond the persisted head; existing messages retain their run association.
          for (const entry of history.items.slice(lastObserved + 1)) {
            if (entry.source !== "devin") continue;
            const replay = { ...message(entry, thread), runId: replayRunId };
            batch.push({ type: "message.updated", driver, message: replay });
            batch.push({
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: ids.derive.turnItemFromProviderItem({
                  driver,
                  nativeItemId: `${options.instanceId}:${nativeId()}:${entry.event_id}`,
                }),
                threadId: args.threadId,
                runId: replayRunId,
                nodeId: null,
                providerThreadId: thread.id,
                providerTurnId: null,
                nativeItemRef: nativeRef(entry.event_id),
                parentItemId: null,
                ordinal: replayOrdinal++,
                status: "completed",
                title: null,
                startedAt: replay.createdAt,
                completedAt: replay.updatedAt,
                updatedAt: replay.updatedAt,
                type: "assistant_message",
                messageId: replay.id,
                text: replay.text,
                streaming: false,
              },
            });
            thread = { ...thread, nativeConversationHeadRef: nativeRef(entry.event_id) };
          }
          restoredHistory = batch;
        }
        return thread;
      });
      return {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) => commands.withPermits(1)(attach(args)),
        resumeThread: (args) =>
          commands.withPermits(1)(
            attach({
              threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
              modelSelection: args.modelSelection ?? input.modelSelection,
              runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: args.providerThread,
            }),
          ),
        readThreadHistory: (args) =>
          validateThread(args.providerThread)
            ? Effect.succeed(restoredHistory)
            : Effect.fail(protocolError("Cloud thread is not attached to this runtime")),
        startTurn: (args) =>
          commands.withPermits(1)(
            Effect.gen(function* () {
              if (!validateThread(args.providerThread) || !thread)
                return yield* protocolError("Cloud thread is not attached to this runtime");
              if (active)
                return yield* protocolError(
                  "Queue Cloud messages through the orchestrator while a turn is active",
                );
              yield* validatePolicy(args.runtimePolicy);
              if (
                args.modelSelection.instanceId !== options.instanceId ||
                args.modelSelection.model !== input.modelSelection.model ||
                (args.modelSelection.options?.length ?? 0) > 0
              )
                return yield* protocolError(
                  "Cloud model selection cannot change inside a remote session",
                );
              if (args.message.attachments.length)
                return yield* protocolError(
                  "Cloud sessions cannot access local attachments. Include an accessible URL in the message instead",
                );
              if (!args.message.text.trim())
                return yield* protocolError("Devin Cloud requires a text prompt");
              const id = nativeId();
              const observingAcceptedWork = Boolean(id && args.restartContinuationOfRunId);
              // Snapshot the existing history before sending so a resumed thread does not replay it into a new run.
              const history = id
                ? yield* api
                    .messages(id)
                    .pipe(Effect.mapError((cause) => protocolError(cause.message, cause)))
                : { items: [], tailCursor: undefined };
              const observedHead = thread.nativeConversationHeadRef?.nativeId;
              const observedIndex = observedHead
                ? history.items.findIndex((entry) => entry.event_id === observedHead)
                : -1;
              if (id && observedHead && observedIndex === -1)
                return yield* protocolError(
                  "Cloud history does not contain the last synchronized message. Retry after checking the remote session",
                );
              const unreadBeforeSend = history.items.slice(observedIndex + 1);
              const requestResult = yield* (
                id
                  ? observingAcceptedWork
                    ? api.read(id)
                    : api.send(id, args.message.text)
                  : api.create({
                      prompt: args.message.text,
                      title: args.appThread.title,
                      repos: options.settings.repos,
                      max_acu_limit: options.settings.maxAcuLimit,
                      devin_mode: options.settings.devinMode,
                    })
              ).pipe(Effect.result);
              const requestFailure =
                requestResult._tag === "Failure" ? requestResult.failure : undefined;
              const outcomeUncertain =
                !observingAcceptedWork &&
                requestFailure &&
                (requestFailure.category === "transport" ||
                  (requestFailure.category === "response" && requestFailure.status === undefined));
              if (requestFailure && !outcomeUncertain)
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause: requestFailure,
                });
              const remote = requestResult._tag === "Success" ? requestResult.success : undefined;
              yield* updateThread({
                ...(remote ? { nativeThreadRef: nativeRef(remote.session_id) } : {}),
                status: "active",
                firstRunOrdinal: thread.firstRunOrdinal ?? args.runOrdinal,
                lastRunOrdinal: args.runOrdinal,
              });
              const startedAt = yield* DateTime.now;
              const turn: ActiveTurn = {
                input: args,
                providerTurn: {
                  id: ids.derive.providerTurn({
                    driver,
                    nativeTurnId: `${options.instanceId}:${remote?.session_id ?? id ?? args.providerThread.id}:${args.runId}:${args.attemptId}`,
                  }),
                  providerThreadId: thread.id,
                  nodeId: args.rootNodeId,
                  runAttemptId: args.attemptId,
                  nativeTurnRef: { driver, nativeId: null, strength: "none" },
                  ordinal: args.providerTurnOrdinal,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
                nextOrdinal: 1,
                seen: new Set(
                  history.items.slice(0, observedIndex + 1).map((entry) => entry.event_id),
                ),
                cursor: history.tailCursor,
                progressed: !id || observingAcceptedWork,
              };
              active = turn;
              yield* emit({
                type: "provider_turn.updated",
                driver,
                threadId: args.threadId,
                providerTurn: turn.providerTurn,
              });
              yield* updateSession("running");
              // Messages can arrive between the committed attach history and this submission.
              const submittedWorkProgress = turn.progressed;
              for (const entry of unreadBeforeSend) yield* publishMessage(turn, entry);
              turn.progressed = submittedWorkProgress;
              // The manager commits attached history before allowing a turn to start.
              restoredHistory = [];
              if (!remote)
                return yield* finish(
                  turn,
                  "failed",
                  makeProviderFailure({
                    class: "provider_error",
                    code: id
                      ? "cloud_message_delivery_unconfirmed"
                      : "cloud_session_creation_unconfirmed",
                    retryable: false,
                    message: id
                      ? "Devin Cloud did not confirm message delivery. Check the existing Cloud session before resending; the message may already have been delivered."
                      : "Devin Cloud did not confirm session creation. Check Devin for an existing session before retrying; the request may already have created one.",
                  }),
                );
              const url = cloudSessionUrl(remote);
              if (!id && url)
                yield* publishMessage(
                  turn,
                  {
                    event_id: `session:${remote.session_id}`,
                    source: "devin",
                    message: `Devin Cloud is working in a remote workspace. [Open the session](${url}) to inspect or manage it. Remote work can continue after Foredeck disconnects.`,
                    created_at: DateTime.toEpochMillis(startedAt) / 1000,
                  },
                  false,
                );
              turn.poll = yield* poll(turn).pipe(Effect.forkIn(scope));
            }),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: (args) =>
          commands.withPermits(1)(
            Effect.gen(function* () {
              if (!validateThread(args.providerThread))
                return yield* protocolError("Cloud thread is not attached to this runtime");
              const turn = active;
              if (!turn || turn.providerTurn.id !== args.providerTurnId) return;
              const id = nativeId();
              if (!id) return;
              turn.stopping = true;
              if (turn.poll) yield* Fiber.interrupt(turn.poll);
              yield* api.stop(id).pipe(
                Effect.onError(() =>
                  Effect.gen(function* () {
                    turn.stopping = false;
                    turn.poll = yield* poll(turn).pipe(Effect.forkIn(scope));
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: args.providerThread.id,
                      providerTurnId: args.providerTurnId,
                      cause,
                    }),
                ),
              );
              yield* finish(turn, "interrupted");
            }),
          ),
        respondToRuntimeRequest: () =>
          Effect.fail(
            protocolError(
              "Cloud approvals and structured questions are handled in the remote Devin session",
            ),
          ),
        readThreadSnapshot: (args) =>
          Effect.gen(function* () {
            if (!validateThread(args.providerThread) || !thread)
              return yield* protocolError("Cloud thread is not attached to this runtime");
            const id = nativeId();
            const history = id
              ? yield* api.messages(id).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                        driver,
                        providerThreadId: args.providerThread.id,
                        cause,
                      }),
                  ),
                )
              : { items: [] };
            const current = thread;
            return {
              providerThread: thread,
              providerTurns,
              messages: history.items.map((entry) => message(entry, current)),
              runtimeRequests: [],
            };
          }),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver,
              providerThreadId: args.providerThread.id,
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver,
              providerThreadId: args.sourceProviderThread.id,
            }),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
