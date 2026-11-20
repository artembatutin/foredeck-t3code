import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { forkParked } from "../serverActivation.ts";
import * as AutomaticTurnGate from "./AutomaticTurnGate.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Wakes an app-owned delegated task's parent when the task asks a question, since users rarely
 * watch child threads. Only questions: approvals cannot be answered via pending request tools.
 * Wakes pass the automatic turn gate; held ones are delivered later through `redeliver`.
 */
export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /**
     * Wakes the parent for a held-back question, re-reading it as `handle` does. `moot` when no
     * longer needed (resolved, task gone/settled, parent archived/deleted, a blocking wait
     * delivering it, or no traceable run). The command id makes repeats idempotent.
     */
    readonly redeliver: (input: {
      readonly childThreadId: ThreadId;
      readonly requestId: RuntimeRequestId;
    }) => Effect.Effect<
      "dispatched" | "deferred" | "moot",
      | ProjectionStore.ProjectionStoreV2Error
      | Orchestrator.OrchestratorV2Error
      | AutomaticTurnGate.AutomaticTurnDecisionError
    >;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const gate = yield* AutomaticTurnGate.AutomaticTurnGate;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (task.childThreadId === null) return undefined;
    const key = `${task.threadId}:${request.id}`;
    const label = reportLabel(task.title?.trim() || task.prompt);
    const situation =
      request.responseCapability.type === "message"
        ? `Delegated task ${task.id} asked a question and is still working.`
        : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`;
    const messageId = MessageId.make(`message:delegated-task-question:${key}`);
    const wake = engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: task.threadId,
      messageId,
      text: `${situation} Read it with t3_pending_request action read, threadId ${task.childThreadId}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    return yield* gate.admit(
      {
        kind: "delegated_question",
        threadId: task.threadId,
        messageId,
        key: `${task.childThreadId}:${request.id}`,
        childThreadId: task.childThreadId,
        requestId: request.id,
        taskId: task.id,
        delegatingRunId: task.runId,
      },
      wake,
    );
  });

  /**
   * The app-owned task whose pending question, asked during `run` of `child`, wakes the parent:
   * the task that run answers, or for a run naming none the task the child was delegated for.
   * None once the task has settled, while the parent is archived or deleted, or while a blocking
   * delegate_task wait delivers the question itself.
   */
  const questionTask = Effect.fnUntraced(function* (
    child: OrchestrationV2AppThread,
    parentThreadId: ThreadId,
    run: OrchestrationV2Run | undefined,
    responseCapability: OrchestrationV2RuntimeRequest["responseCapability"],
  ) {
    const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
    const taskId =
      run?.delegatedTaskId ??
      (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
    const task = parent.subagents.find(
      (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
    );
    if (
      task === undefined ||
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null ||
      // The orchestrator drops a settled task's question wake (`isStaleQuestionWake`).
      ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
    ) {
      return undefined;
    }
    // A blocking delegate_task wait delivers the question itself.
    if (
      task.completionWake === "settled_only" &&
      responseCapability.type === "live" &&
      parent.runs.some(
        (run) =>
          run.id === task.runId &&
          (run.status === "preparing" || run.status === "starting" || run.status === "running"),
      )
    ) {
      return undefined;
    }
    return task;
  });

  const redeliver = Effect.fn("DelegatedTaskQuestionReactor.redeliver")(function* (
    input: Parameters<DelegatedTaskQuestionReactor["Service"]["redeliver"]>[0],
  ) {
    const child = yield* projections.getThread(input.childThreadId);
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null) return "moot";
    const { request, node } = yield* projections.getRuntimeResponseContext(
      child.id,
      input.requestId,
    );
    if (request?.kind !== "user_input" || request.status !== "pending") return "moot";
    // The run the question was asked in, through the request's own node: a later follow-up in
    // the same child conversation answers a task of its own. A question no node ties to a run
    // cannot be attributed, so it wakes nothing rather than a guessed task's parent.
    const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
    const run = runs.find((candidate) => candidate.id === node?.runId);
    if (run === undefined) return "moot";
    const task = yield* questionTask(child, parentThreadId, run, request.responseCapability);
    if (task === undefined) return "moot";
    const outcome = yield* wakeParent(task, request);
    // A declined wake never runs, like one no longer needed.
    return outcome?._tag === "Ran"
      ? "dispatched"
      : outcome?.reason === "deferred"
        ? "deferred"
        : "moot";
  });

  const cancelQueuedWakes = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    requestIds: ReadonlyArray<RuntimeRequestId>,
  ) {
    const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    for (const requestId of requestIds) {
      const key = `${parentThreadId}:${requestId}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      const queued = parent.runs.find(
        (run) => run.status === "queued" && run.userMessageId === messageId,
      );
      if (queued === undefined) continue;
      yield* engine
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
          threadId: parentThreadId,
          runId: queued.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cancelling a delegated task question wake failed", {
              threadId: parentThreadId,
              requestId,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          for (const request of child.runtimeRequests) {
            if (
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          return;
        }
        // A settled task can no longer use an answer to its still-pending questions.
        const { runtimeRequests } = yield* projections.getThreadRecords(task.childThreadId, [
          "runtimeRequests",
        ]);
        const questions = runtimeRequests.filter((request) => request.kind === "user_input");
        if (questions.length === 0) return;
        const child = yield* projections.getThreadRecords(task.childThreadId, ["runs", "nodes"]);
        const taskRunIds = new Set(
          child.runs
            .filter(
              (run) =>
                run.delegatedTaskId === task.id ||
                (run.delegatedTaskId === undefined &&
                  child.thread.forkedFrom?.type === "node" &&
                  child.thread.forkedFrom.nodeId === task.id),
            )
            .map((run) => run.id),
        );
        const taskNodeIds = new Set(
          child.nodes
            .filter((node) => node.runId !== null && taskRunIds.has(node.runId))
            .map((node) => node.id),
        );
        yield* cancelQueuedWakes(
          task.threadId,
          questions
            .filter((request) => taskNodeIds.has(request.nodeId))
            .map((request) => request.id),
        );
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        yield* cancelQueuedWakes(parentThreadId, [event.payload.id]);
        return;
      }
      const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
      const run =
        runs.find((run) => run.id === event.runId) ??
        runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const task = yield* questionTask(
        child,
        parentThreadId,
        run,
        event.payload.responseCapability,
      );
      if (task === undefined) return;
      yield* wakeParent(task, request);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // Every wake and cancel goes to the parent, so keying by it keeps a question's wake ahead of
  // its task's cancel while a busy parent's lock delays only that parent's reactions.
  const parentOf = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "run.updated":
        return Effect.succeed(event.threadId);
      case "subagent.updated":
        return Effect.succeed(event.payload.threadId);
      case "runtime-request.updated":
        return event.payload.kind === "user_input"
          ? projections
              .getThread(event.threadId)
              .pipe(Effect.map((child) => child.lineage.parentThreadId))
          : Effect.succeed(null);
      default:
        return Effect.succeed(null);
    }
  };

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskQuestionReactor.start",
  )(function* () {
    const parentReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        parentOf(event).pipe(
          Effect.flatMap((parentThreadId) =>
            parentThreadId === null
              ? Effect.void
              : parentReactions.run(parentThreadId, handle(event)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("finding the parent of a delegated task question failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle, redeliver } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
