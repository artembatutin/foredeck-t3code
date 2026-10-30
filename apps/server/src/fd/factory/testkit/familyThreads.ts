import { assert } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderRuntimeRecoveryService from "../../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as FactoryReactor from "../FactoryReactor.ts";
import {
  drainOrchestration,
  ended,
  runReached,
  threadProjection,
  type World,
} from "./deliveryHarness.ts";

/**
 * Runs on a Factory family's threads, made the ways core makes them on the delivery harness:
 * delegations, agents' messages and what core's restart recovery reads.
 */

/** The run's provider thread, as core recorded it when the run started. */
export const providerThreadOf = (threadId: ThreadId, runId: RunId) =>
  threadProjection(threadId).pipe(
    Effect.map(
      ({ runs }) =>
        runs.find((run) => run.id === runId)?.providerThreadId ??
        assert.fail(`Run ${runId} started on no provider thread.`),
    ),
    Effect.orDie,
  );

/** The thread's first run, its launch's. */
export const firstRun = (threadId: ThreadId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ runs }) => runs[0]?.id ?? assert.fail(`Thread ${threadId} has no run.`)),
    Effect.orDie,
  );

/** Waits until the provider's running turn on the thread is stored, as core recovery reads it. */
export const providerTurnRunning = (threadId: ThreadId) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "provider-turn.updated" &&
          event.threadId === threadId &&
          event.payload.status === "running",
      ),
      Stream.runHead,
    ),
  ).pipe(Effect.orDie);

/** Core's runtime recovery, over the server's stores: its shutdown and startup reconciles. */
export const coreRecovery = Effect.service(
  ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService,
).pipe(
  Effect.provide(ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(EffectOutbox.layer))),
);

let delegations = 0;

/**
 * Delegates a task from the thread's live run, as `delegate_task` does for the agent running it,
 * or as the owner does with `by` "user": the child thread's run starts at once. Returns the task,
 * its thread and its first run.
 */
export const delegateFrom = (threadId: ThreadId, runId: RunId, by: "agent" | "user" = "agent") =>
  Effect.gen(function* () {
    delegations += 1;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* threadProjection(threadId);
    const run = parent.runs.find((candidate) => candidate.id === runId);
    const parentNodeId = run?.rootNodeId ?? assert.fail(`Run ${runId} has no root node.`);
    const sent = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`test-delegate:${delegations}`),
      createdBy: by,
      creationSource: by === "agent" ? "mcp" : "web",
      parentThreadId: threadId,
      parentRunId: runId,
      parentNodeId,
      task: `Check the export, part ${delegations}.`,
      modelSelection: parent.thread.modelSelection,
      runtimeMode: parent.thread.runtimeMode,
      interactionMode: parent.thread.interactionMode,
      completionWake: "always",
    });
    yield* drainOrchestration;
    const childThreadId =
      sent.storedEvents.flatMap(({ event }) =>
        event.type === "thread.created" && event.payload.lineage.parentThreadId === threadId
          ? [event.payload.id]
          : [],
      )[0] ?? assert.fail("The delegation created no child thread.");
    const task =
      (yield* threadProjection(threadId)).subagents.find(
        (candidate) => candidate.childThreadId === childThreadId,
      ) ?? assert.fail("The delegation recorded no task.");
    return { taskId: task.id, childThreadId, runId: yield* firstRun(childThreadId) };
  }).pipe(Effect.orDie);

let agentMessages = 0;

/** An agent's message to the thread from `senderThreadId`, as `t3_thread_send` sends one. */
export const agentSends = (projectId: ProjectId, threadId: ThreadId, senderThreadId: ThreadId) =>
  Effect.gen(function* () {
    agentMessages += 1;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sent = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make(`test-agent-send:${agentMessages}`),
      threadId,
      messageId: MessageId.make(`test-agent-message:${agentMessages}`),
      senderThreadId,
      text: "Check the export once more.",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* drainOrchestration;
    return sent.run.id;
  }).pipe(Effect.orDie);

/**
 * Ends the provider turn of the run and waits until orchestration has finished it and Factory's
 * reactor has handed its end on, but not for the effects that set off: one a test holds back
 * stays in flight.
 */
export const endTurnOnly = (world: World, runId: RunId) =>
  Effect.gen(function* () {
    const turn =
      world.provider.started.find((candidate) => candidate.runId === runId) ??
      assert.fail(`No provider turn started run ${runId}.`);
    yield* world.provider.endTurn(turn, "completed");
    yield* runReached(runId, ["waiting", ...ended]);
    yield* drainOrchestration;
    yield* Effect.flatMap(FactoryReactor.FactoryReactor, (reactor) => reactor.drain);
  });
