import {
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ProviderThreadId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AutomaticTurn } from "../../orchestration-v2/AutomaticTurnGate.ts";
import type { FactoryManagement } from "./FactoryAdmission.ts";
import { factoryMessageDeliveryId, launchDeliveryId } from "./FactoryThreadEffects.ts";
import {
  adoptedRuns,
  type FactoryDeliveryState,
  type FactoryPullRequestWake,
  ownsWake,
} from "./pipeline/state.ts";

/**
 * Whose work a turn or run on a Factory family thread carries on, decided from its exact causal
 * source and never from neighbouring runs or timestamps: `factory` for a root delivery's own work,
 * `explicit` for work someone started on purpose (the owner, a schedule, or an agent outside the
 * family), `unknown` when nothing shows which. The decision is pure over records the caller reads:
 * a family thread's lineage, runs and delegated tasks, Factory's deliveries, the recorded
 * automatic turns and the management of a sender's root.
 */
export type FactoryProvenance =
  | { readonly class: "factory"; readonly root: FactoryDeliveryId }
  | { readonly class: "explicit" }
  | { readonly class: "unknown" };

const explicit: FactoryProvenance = { class: "explicit" };
const unknown: FactoryProvenance = { class: "unknown" };
const factory = (root: FactoryDeliveryId): FactoryProvenance => ({ class: "factory", root });

/** How many lineage levels below a thread a Factory launch made a family thread can be. */
export const MAX_FAMILY_DEPTH = 8;

/**
 * The thread's lineage goes up more than `MAX_FAMILY_DEPTH` delegations, or loops, so whether it
 * belongs to a Factory family cannot be told; callers treat it as a read that failed.
 */
export class FactoryFamilyDepthError extends Schema.TaggedError<FactoryFamilyDepthError>()(
  "FactoryFamilyDepthError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} descends through more than ${MAX_FAMILY_DEPTH} delegated threads, so Factory cannot tell whose it is.`;
  }
}

/** A thread as classification reads it; none for a thread with no record. */
export interface FamilyThread {
  readonly lineage: OrchestrationV2AppThreadLineage;
  /** For a delegated thread, the task node it was delegated for. */
  readonly forkedFrom: OrchestrationV2AppThread["forkedFrom"];
  /** Among them the delegation's spawn, which names the run the delegation started. */
  readonly contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  /** The tasks the thread delegated, each naming the run that delegated it. */
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}

/** A delivery as classification reads it. */
export interface FamilyDelivery {
  readonly parentId: FactoryDeliveryId | null;
  readonly state: FactoryDeliveryState;
}

/**
 * The records classification reads, each a strict read whose failure fails the decision. A record
 * that does not exist is undefined.
 */
export interface OwnershipReads<E> {
  readonly delivery: (
    deliveryId: FactoryDeliveryId,
  ) => Effect.Effect<FamilyDelivery | undefined, E>;
  readonly lineage: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThreadLineage | undefined, E>;
  readonly thread: (threadId: ThreadId) => Effect.Effect<FamilyThread | undefined, E>;
  readonly message: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, E>;
  /** The pull request watch's wake the run started, from its command's own records. */
  readonly wake: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<FactoryPullRequestWake | undefined, E>;
  /** The class recorded for the automatic turn that started from the message. */
  readonly recorded: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<FactoryProvenance | undefined, E>;
  readonly management: (root: FactoryDeliveryId) => Effect.Effect<FactoryManagement, E>;
}

/** The root delivery whose family a thread belongs to, and the delivery whose launch made it. */
export interface FactoryFamily {
  readonly root: FactoryDeliveryId;
  /** The delivery whose launch made the thread or its nearest launched ancestor. */
  readonly launchedBy: FactoryDeliveryId;
}

const isSubagentChild = (lineage: OrchestrationV2AppThreadLineage | undefined) =>
  lineage?.relationshipToParent === "subagent" && lineage.parentThreadId !== null;

/**
 * The family a thread belongs to, structurally: a thread a Factory launch made belongs to that
 * delivery's root (a child's maps to its parent), and a thread delegated from a family thread, as
 * an app-owned task or a provider-native mirror, belongs to its parent's family, up to
 * `MAX_FAMILY_DEPTH` levels. Any other thread, including one delegated from a non-family thread,
 * has none. A lineage deeper than that fails, as a read does.
 */
export const familyOf = <E>(reads: OwnershipReads<E>, threadId: ThreadId) =>
  Effect.gen(function* () {
    let current = threadId;
    for (let levels = 0; ; levels += 1) {
      const launchedBy = launchDeliveryId(current);
      if (launchedBy !== undefined) {
        const delivery = yield* reads.delivery(launchedBy);
        return delivery === undefined
          ? null
          : ({ root: delivery.parentId ?? launchedBy, launchedBy } satisfies FactoryFamily);
      }
      const lineage = yield* reads.lineage(current);
      if (lineage === undefined || lineage.parentThreadId === null || !isSubagentChild(lineage)) {
        return null;
      }
      if (levels === MAX_FAMILY_DEPTH) return yield* new FactoryFamilyDepthError({ threadId });
      current = lineage.parentThreadId;
    }
  });

/** Sources of the owner's own messages: a client of theirs, never the server. */
const OWNER_SOURCES: ReadonlySet<OrchestrationV2CreationSource> = new Set(["web", "mobile", "mcp"]);

const DELEGATED_QUESTION = "message:delegated-task-question:";
const ASYNC_ANSWER = "async-answer:";

/**
 * The task a delegated thread's run answers: the one it names (a follow-up's), or for the run the
 * delegation itself started, as its spawn records it, the task the thread was delegated for.
 */
const taskOf = (thread: FamilyThread, run: OrchestrationV2Run) => {
  if (run.delegatedTaskId !== undefined) return run.delegatedTaskId;
  const spawned = thread.contextTransfers.some(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.targetRunId === run.id &&
      transfer.sourceThreadId === thread.lineage.parentThreadId,
  );
  return spawned && thread.forkedFrom?.type === "node" ? thread.forkedFrom.nodeId : undefined;
};

/**
 * What the owner started on purpose: an answer to an asynchronous question (governed callers
 * cannot send one), the owner's own message from a client, and a schedule's prompt.
 */
const isOwnersOwn = (message: OrchestrationV2ConversationMessage) =>
  message.id.startsWith(ASYNC_ANSWER) ||
  (message.createdBy === "user" && OWNER_SOURCES.has(message.creationSource)) ||
  message.scheduledTaskId !== undefined;

/** Factory work for `root` stays itself; anything else on a family thread is unknown. */
const onlyFactory = (provenance: FactoryProvenance, root: FactoryDeliveryId) =>
  provenance.class === "factory" && provenance.root === root ? provenance : unknown;

/** Factory work for another root is unknown here; explicit and unknown stay as they are. */
const forRoot = (provenance: FactoryProvenance, root: FactoryDeliveryId) =>
  provenance.class === "factory" && provenance.root !== root ? unknown : provenance;

/**
 * Classifies runs and automatic turns on the family threads of `root` (see `familyOf`) over the
 * given reads. A run's class is its message's, by the first rule that matches:
 *
 * - P1: a message Factory sent is Factory's.
 * - P2: a pull request watch's wake is Factory's when it is the root's own pull request on the
 *   thread it follows (see `ownsWake`), or one the root took, and explicit otherwise.
 * - P3: a restart continuation is its source run's class.
 * - P4: a recorded automatic turn keeps its recorded class.
 * - P5, P6: a delegated cohort's result and a delegated task's question are Factory's only when
 *   the run that delegated is; otherwise unknown.
 * - P7: a delegated thread's run, the one its delegation started or a follow-up naming its task,
 *   is Factory's only when the run that delegated the task is Factory's for the same root;
 *   otherwise unknown.
 * - P8: an asynchronous answer, the owner's own message, a schedule's prompt, and an agent's MCP
 *   message with no sender or a sender outside every managed family are explicit; an agent's
 *   message from a managed family is unknown. The owner's part comes before P7, since a follow-up
 *   the owner sends a delegated thread names a task that no run of theirs delegated.
 * - P9: anything else is unknown.
 *
 * An automatic turn takes its exact source's class: a pull request wake the P2 predicate's, a
 * restart continuation and a usage-limit resume the class of the run they continue, a question
 * and a completion the delegating run's when that is Factory's, and a native wake every run's on
 * its provider thread (see `providerThread`).
 */
export const classifier = <E>(reads: OwnershipReads<E>, root: FactoryDeliveryId) => {
  // Runs already on the path being classified: a source that leads back to one is unknown.
  const runClass = (
    threadId: ThreadId,
    runId: RunId,
    path: ReadonlySet<string>,
  ): Effect.Effect<FactoryProvenance, E | FactoryFamilyDepthError> =>
    Effect.gen(function* () {
      const key = `${threadId}\u0000${runId}`;
      if (path.has(key)) return unknown;
      const thread = yield* reads.thread(threadId);
      const run = thread?.runs.find((candidate) => candidate.id === runId);
      if (thread === undefined || run === undefined) return unknown;
      return yield* messageClass(threadId, thread, run, new Set([...path, key]));
    });

  /** The class of the message that started the run: its first matching rule, P1 to P9. */
  const messageClass = (
    threadId: ThreadId,
    thread: FamilyThread,
    run: OrchestrationV2Run,
    path: ReadonlySet<string>,
  ): Effect.Effect<FactoryProvenance, E | FactoryFamilyDepthError> =>
    Effect.gen(function* () {
      // P1: a message Factory sent is the root's of the delivery it names.
      const sender = factoryMessageDeliveryId(run.userMessageId);
      if (sender !== undefined) {
        const delivery = yield* reads.delivery(sender);
        return delivery === undefined ? unknown : factory(delivery.parentId ?? sender);
      }
      const message = yield* reads.message(threadId, run.userMessageId);
      // P2: a pull request watch's wake. Its message is the watch sync's own, which only the
      // server creates. The delivery's own pull request on the thread it follows is Factory's,
      // and so is every wake it took; any other pull request's is explicit.
      if (message === undefined || message.creationSource === "server") {
        const wake = yield* reads.wake(threadId, run.id);
        if (wake !== undefined) {
          const owner = yield* reads.delivery(root);
          const own =
            owner !== undefined &&
            (adoptedRuns(owner.state).includes(run.id) || ownsWake(owner.state, wake));
          return own ? factory(root) : explicit;
        }
      }
      // P3: a restart's continuation carries on the run it continues.
      if (run.restartContinuationOfRunId !== undefined) {
        return yield* runClass(threadId, run.restartContinuationOfRunId, path);
      }
      // P4: an automatic turn keeps the class recorded when it was decided.
      const recorded = yield* reads.recorded(threadId, run.userMessageId);
      if (recorded !== undefined) return recorded;
      // P5: a delegated cohort's result is Factory's only when the run that delegated it is.
      const parentRunId = message?.delegatedCompletion?.parentRunId;
      if (parentRunId !== undefined) {
        return onlyFactory(yield* runClass(threadId, parentRunId, path), root);
      }
      // P6: a delegated task's question is Factory's only when the run that delegated it is.
      if (message !== undefined && message.id.startsWith(DELEGATED_QUESTION)) {
        const source = message.notification?.source;
        const taskIds = source?.kind === "delegated_task" ? source.taskIds : [];
        const task =
          taskIds.length === 1
            ? thread.subagents.find((candidate) => candidate.id === taskIds[0])
            : undefined;
        if (task?.runId === undefined || task.runId === null) return unknown;
        return onlyFactory(yield* runClass(threadId, task.runId, path), root);
      }
      // P8, the owner's part: what the owner started on purpose is explicit wherever it runs. On
      // a delegated thread core gives the owner's follow-up a task whose run is the parent's
      // latest, not one that delegated anything, so that task never decides it.
      if (message !== undefined && isOwnersOwn(message)) return explicit;
      // P7: a delegated thread's run is Factory's only when the run that delegated its task, on
      // the parent thread, is Factory's for the same root.
      const taskId = taskOf(thread, run);
      if (taskId !== undefined) {
        const parentThreadId = isSubagentChild(thread.lineage)
          ? thread.lineage.parentThreadId
          : null;
        if (parentThreadId === null) return unknown;
        const parent = yield* reads.thread(parentThreadId);
        const task = parent?.subagents.find((candidate) => candidate.id === taskId);
        if (task?.runId === undefined || task.runId === null) return unknown;
        return onlyFactory(yield* runClass(parentThreadId, task.runId, path), root);
      }
      // P8: an agent's message from outside every managed family is explicit too.
      if (message !== undefined) {
        if (message.createdBy === "agent" && message.creationSource === "mcp") {
          if (message.senderThreadId === undefined) return explicit;
          const senderFamily = yield* familyOf(reads, message.senderThreadId);
          if (senderFamily === null) return explicit;
          return (yield* reads.management(senderFamily.root)) === "never" ? explicit : unknown;
        }
      }
      // P9: anything else, an unrecorded native wake or usage-limit resume included.
      return unknown;
    });

  /**
   * A native wake's class: every run on its provider thread, where the background work it reports
   * could only have been started, decides it. All Factory's for this root is Factory's, all
   * explicit is explicit, and anything else (mixed, unknown, another root, or no run) is unknown.
   */
  const providerThreadClass = (threadId: ThreadId, providerThreadId: ProviderThreadId) =>
    Effect.gen(function* () {
      const thread = yield* reads.thread(threadId);
      const runs = (thread?.runs ?? []).filter((run) => run.providerThreadId === providerThreadId);
      if (runs.length === 0) return unknown;
      const classes = yield* Effect.forEach(runs, (run) => runClass(threadId, run.id, new Set()));
      if (classes.every((provenance) => onlyFactory(provenance, root).class === "factory")) {
        return factory(root);
      }
      return classes.every((provenance) => provenance.class === "explicit") ? explicit : unknown;
    });

  return {
    run: (threadId: ThreadId, runId: RunId) =>
      runClass(threadId, runId, new Set()).pipe(
        Effect.map((provenance) => forRoot(provenance, root)),
      ),
    providerThread: providerThreadClass,
    /** An automatic turn's class, from the exact source its producer presents. */
    turn: (turn: AutomaticTurn): Effect.Effect<FactoryProvenance, E | FactoryFamilyDepthError> =>
      Effect.gen(function* () {
        switch (turn.kind) {
          case "pull_request_wake": {
            const owner = yield* reads.delivery(root);
            const own =
              owner !== undefined &&
              ownsWake(owner.state, {
                threadId: turn.threadId,
                number: turn.pullRequest.number,
                url: turn.pullRequest.url,
                watchStartedAt: turn.watchStartedAt,
              });
            return own ? factory(root) : explicit;
          }
          case "restart_continuation":
            return forRoot(yield* runClass(turn.threadId, turn.sourceRunId, new Set()), root);
          case "usage_limit_resume":
            return forRoot(
              yield* runClass(turn.threadId, turn.usageLimitContinuationOfRunId, new Set()),
              root,
            );
          case "delegated_question":
            return turn.delegatingRunId === null
              ? unknown
              : onlyFactory(yield* runClass(turn.threadId, turn.delegatingRunId, new Set()), root);
          case "delegated_completion":
            return onlyFactory(yield* runClass(turn.threadId, turn.parentRunId, new Set()), root);
          case "background_wake":
            return yield* providerThreadClass(turn.threadId, turn.providerThreadId);
        }
      }),
  };
};
