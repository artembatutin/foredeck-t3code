import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  type PullRequestDetail,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  SourceControlProviderKind,
  ThreadId,
  type ThreadPullRequestLink,
  TurnItemId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as TxRef from "effect/TxRef";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as DelegatedTaskQuestionReactor from "../../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderContinuationService from "../../orchestration-v2/ProviderContinuationService.ts";
import * as PullRequestWatchReactor from "../../orchestration-v2/PullRequestWatchReactor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FactoryActivity from "./FactoryActivity.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import * as FactoryAutomaticTurns from "./FactoryAutomaticTurns.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryAutomaticTurnStore from "./persistence/FactoryAutomaticTurnStore.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import {
  agentSends,
  coreRecovery,
  delegateFrom,
  firstRun,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  linkOf,
  linkPullRequest,
  openParent,
  openSingle,
  ownerQueues,
  reviewPasses,
  runStarted,
  watchPullRequest,
} from "./testkit/followThrough.ts";

const driver = ProviderDriverKind.make("codex");

/** What reached the manager's port, as it saw each automatic turn. */
interface Reached {
  readonly kind: AutomaticTurnGate.AutomaticTurn["kind"];
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly root: FactoryDeliveryId;
  readonly provenance: "factory" | "unknown";
  readonly management: "active" | "retired";
}

/**
 * A manager whose roots are all `management`, recording every automatic turn that reaches it and
 * holding each back, so only Factory's gate runs anything inline.
 */
const recordingPort = (management: FactoryAdmission.FactoryManagement) => {
  const reached: Array<Reached> = [];
  const arrivals = TxRef.makeUnsafe(0);
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed(management),
    automaticTurn: (turn) =>
      Effect.sync(() => {
        reached.push({
          kind: turn.turn.kind,
          threadId: turn.turn.threadId,
          messageId: turn.turn.messageId,
          root: turn.root,
          provenance: turn.provenance,
          management: turn.management,
        });
      }).pipe(
        Effect.andThen(TxRef.update(arrivals, (count) => count + 1)),
        Effect.as(AutomaticTurnGate.notNow("deferred")),
      ),
  };
  /** Waits until a turn of `kind` has reached the port, as a producer presents it on its own. */
  const arrived = (kind: Reached["kind"]) =>
    TxRef.get(arrivals).pipe(
      Effect.flatMap(() =>
        reached.some((turn) => turn.kind === kind) ? Effect.void : Effect.txRetry,
      ),
      Effect.tx,
    );
  return { reached, port, arrived };
};

let presented = 0;
const fresh = (prefix: string) => `${prefix}-${(presented += 1)}`;

/** Each producer's presentation of a turn, in the shape it presents it to the gate. */
const turns = {
  pullRequestWake: (
    threadId: ThreadId,
    link: {
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
    },
    watchStartedAt: string,
  ): AutomaticTurnGate.PullRequestWakeTurn => ({
    kind: "pull_request_wake",
    threadId,
    messageId: MessageId.make(`message:pr-watch:${fresh("wake")}`),
    key: link.url,
    pullRequest: {
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
    },
    watchStartedAt,
    ending: null,
  }),
  restartContinuation: (
    threadId: ThreadId,
    sourceRunId: RunId,
  ): AutomaticTurnGate.RestartContinuationTurn => ({
    kind: "restart_continuation",
    threadId,
    messageId: MessageId.make(`message:restart-continuation:${sourceRunId}`),
    key: sourceRunId,
    sourceRunId,
    settled: false,
  }),
  usageLimitResume: (threadId: ThreadId, runId: RunId): AutomaticTurnGate.UsageLimitResumeTurn => {
    const id = `limit-resume:${runId}:${fresh("reset")}`;
    return {
      kind: "usage_limit_resume",
      threadId,
      messageId: MessageId.make(id),
      key: id,
      usageLimitContinuationOfRunId: runId,
    };
  },
  delegatedQuestion: (
    threadId: ThreadId,
    task: { readonly childThreadId: ThreadId; readonly taskId: NodeId },
    delegatingRunId: RunId | null,
  ): AutomaticTurnGate.DelegatedQuestionTurn => {
    const requestId = RuntimeRequestId.make(fresh("request"));
    return {
      kind: "delegated_question",
      threadId,
      messageId: MessageId.make(`message:delegated-task-question:${threadId}:${requestId}`),
      key: `${task.childThreadId}:${requestId}`,
      childThreadId: task.childThreadId,
      requestId,
      taskId: task.taskId,
      delegatingRunId,
    };
  },
  delegatedCompletion: (
    threadId: ThreadId,
    parentRunId: RunId,
    providerThreadId: ProviderThreadId,
  ): AutomaticTurnGate.DelegatedCompletionTurn => {
    const messageId = MessageId.make(fresh("delegated-completion"));
    return {
      kind: "delegated_completion",
      threadId,
      messageId,
      key: `${parentRunId}:1:${messageId}`,
      parentRunId,
      generation: 1,
      providerThreadId,
      driver,
      origin: "offer",
    };
  },
  backgroundWake: (
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
  ): AutomaticTurnGate.BackgroundWakeTurn => {
    const messageId = MessageId.make(fresh("native-wake"));
    return {
      kind: "background_wake",
      threadId,
      messageId,
      key: messageId,
      providerThreadId,
      driver,
      clearable: false,
    };
  },
};

/** The turns the gate ran inline, by the message each starts from. */
const ranInline: Array<MessageId> = [];

/** Presents the turn to the gate core's producers consult, with a dispatch that records it ran. */
const consult = (turn: AutomaticTurnGate.AutomaticTurn) =>
  Effect.gen(function* () {
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const dispatch = Effect.sync(() => void ranInline.push(turn.messageId));
    return turn.kind === "background_wake"
      ? yield* gate.hand(turn, dispatch, {})
      : yield* gate.admit(turn, dispatch);
  });

/** Every decision Factory recorded, as SQLite holds it. */
const recordedTurns = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly thread_id: string;
      readonly message_id: string;
      readonly root_delivery_id: string;
      readonly delivery_id: string | null;
      readonly kind: string;
      readonly class: string;
      readonly source_run_id: string | null;
    }>`SELECT thread_id, message_id, root_delivery_id, delivery_id, kind, class, source_run_id
    FROM fd_factory_automatic_turns ORDER BY recorded_at, message_id`,
).pipe(Effect.orDie);

/** A folder beside the project for an owner's project of their own. */
const ownerFolder = (world: { readonly root: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(path.dirname(world.root), "owner-elsewhere");
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    return folder;
  }).pipe(Effect.orDie);

/** A task named by the questions presented below; their class reads only the delegating run. */
const questionTask = NodeId.make("node:delegated-task:asking");

/**
 * The five kinds that carry on a run of the thread: its restart's continuation, its usage-limit
 * resume, a question and the result of a task it delegated, and a native wake on its provider
 * thread.
 */
const fiveKinds = (
  threadId: ThreadId,
  source: RunId,
  task: { readonly childThreadId: ThreadId; readonly taskId: NodeId },
) =>
  Effect.gen(function* () {
    const providerThread = yield* providerThreadOf(threadId, source);
    return [
      turns.restartContinuation(threadId, source),
      turns.usageLimitResume(threadId, source),
      turns.delegatedQuestion(threadId, task, source),
      turns.delegatedCompletion(threadId, source, providerThread),
      turns.backgroundWake(threadId, providerThread),
    ];
  });

/** What the port must see for `turns`, each Factory's work for `root` under `management`. */
const expectedReached = (
  presented: ReadonlyArray<AutomaticTurnGate.AutomaticTurn>,
  root: FactoryDeliveryId,
  provenance: Reached["provenance"],
  management: Reached["management"],
): ReadonlyArray<Reached> =>
  presented.map((turn) => ({
    kind: turn.kind,
    threadId: turn.threadId,
    messageId: turn.messageId,
    root,
    provenance,
    management,
  }));

describe("Factory's automatic turn gate on the server's real stack", () => {
  it.live(
    "sends every kind on an active single item's threads and their delegates to the manager",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            ranInline.length = 0;
            const author = yield* world.start;
            // The author delegates a task while its run goes on, as delegate_task does.
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            const reviewer = yield* reviewPasses(world, author.deliveryId);
            const reviewerRun = yield* firstRun(reviewer);
            const state = yield* stateOf(author.deliveryId);
            assert.strictEqual(state.status, "pr_open");
            const link = yield* linkOf(author.threadId, 7);
            const watchStartedAt = link.watch?.startedAt ?? assert.fail("Factory watches its PR.");

            const ownWake = turns.pullRequestWake(author.threadId, link, watchStartedAt);
            const factoryTurns = [
              ownWake,
              ...(yield* fiveKinds(author.threadId, author.runId, delegate)),
              ...(yield* fiveKinds(reviewer, reviewerRun, delegate)),
              ...(yield* fiveKinds(delegate.childThreadId, delegate.runId, delegate)),
            ];
            // The pull request's wake on any other thread is someone's watch, not Factory's.
            const otherWakes = [reviewer, delegate.childThreadId].map((threadId) =>
              turns.pullRequestWake(threadId, link, watchStartedAt),
            );
            for (const turn of [...factoryTurns, ...otherWakes]) {
              const outcome = yield* consult(turn);
              assert.deepStrictEqual(
                outcome,
                otherWakes.some((wake) => wake === turn)
                  ? AutomaticTurnGate.ran(undefined)
                  : AutomaticTurnGate.notNow("deferred"),
                turn.kind,
              );
            }
            assert.deepStrictEqual(
              reached,
              expectedReached(factoryTurns, author.deliveryId, "factory", "active"),
            );
            assert.deepStrictEqual(
              ranInline,
              otherWakes.map(({ messageId }) => messageId),
            );
            const recorded = yield* recordedTurns;
            assert.strictEqual(recorded.length, factoryTurns.length + otherWakes.length);
            assert.isTrue(
              recorded.every(({ root_delivery_id }) => root_delivery_id === author.deliveryId),
            );

            // Presented again, each turn keeps the decision recorded for it.
            for (const turn of [...factoryTurns, ...otherWakes]) yield* consult(turn);
            assert.deepStrictEqual(yield* recordedTurns, recorded);
            assert.strictEqual(reached.length, factoryTurns.length * 2);

            // The owner's own turn and what carries it on are theirs, and run inline.
            const ownerRun = yield* world.ownerTurn(author.threadId, "Tweak the export label.");
            const ownerContinued = turns.restartContinuation(author.threadId, ownerRun);
            assert.deepStrictEqual(
              yield* consult(ownerContinued),
              AutomaticTurnGate.ran(undefined),
            );
            assert.strictEqual(reached.length, factoryTurns.length * 2);
            assert.include(ranInline, ownerContinued.messageId);
            assert.deepStrictEqual(
              (yield* recordedTurns).find(
                ({ message_id }) => message_id === ownerContinued.messageId,
              )?.class,
              "explicit",
            );
            yield* world.endRun(ownerRun, "completed");
            yield* world.endRun(delegate.runId, "completed");
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
    120_000,
  );

  it.live(
    "sends a parent's child and last-child threads' turns to the manager under the parent",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            ranInline.length = 0;
            const parent = yield* openParent(world);
            const [first, last] = parent.children;
            if (first === undefined || last === undefined) return assert.fail("Two children.");
            const link = yield* linkOf(last.author, 7);
            const watchStartedAt = link.watch?.startedAt ?? assert.fail("Factory watches its PR.");
            const task = { childThreadId: ThreadId.make("thread-asking"), taskId: questionTask };
            const factoryTurns = [
              turns.pullRequestWake(last.author, link, watchStartedAt),
              ...(yield* fiveKinds(first.author, yield* firstRun(first.author), task)),
              ...(yield* fiveKinds(last.author, yield* firstRun(last.author), task)),
            ];
            // The parent follows its pull request on its last child's author thread only.
            const firstWake = turns.pullRequestWake(first.author, link, watchStartedAt);
            for (const turn of [...factoryTurns, firstWake]) yield* consult(turn);

            assert.deepStrictEqual(
              reached,
              expectedReached(factoryTurns, parent.deliveryId, "factory", "active"),
            );
            assert.deepStrictEqual(ranInline, [firstWake.messageId]);
            const recorded = yield* recordedTurns;
            assert.isTrue(
              recorded.every(({ root_delivery_id }) => root_delivery_id === parent.deliveryId),
            );
            // Each turn's record names the child whose launch made its thread.
            assert.isTrue(
              recorded.every(
                ({ thread_id, delivery_id }) =>
                  delivery_id === (thread_id === first.author ? first.deliveryId : last.deliveryId),
              ),
            );
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
    180_000,
  );

  it.live("runs every turn inline and records nothing for a root nothing manages", () => {
    const { reached, port } = recordingPort("never");
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          ranInline.length = 0;
          const author = yield* world.start;
          const task = { childThreadId: ThreadId.make("thread-asking"), taskId: questionTask };
          const presented = yield* fiveKinds(author.threadId, author.runId, task);
          for (const turn of presented) {
            assert.deepStrictEqual(yield* consult(turn), AutomaticTurnGate.ran(undefined));
          }
          assert.deepStrictEqual(
            ranInline,
            presented.map(({ messageId }) => messageId),
          );
          assert.deepStrictEqual(reached, []);
          assert.deepStrictEqual(yield* recordedTurns, []);
          yield* world.endRun(author.runId, "completed");
        }),
      { admission: port, automaticTurnGate: true },
    );
  });

  it.live("marks a retired root's turns retired, and runs its explicit turns inline", () => {
    const { reached, port } = recordingPort("retired");
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          ranInline.length = 0;
          const author = yield* world.start;
          const task = { childThreadId: ThreadId.make("thread-asking"), taskId: questionTask };
          const factoryTurns = yield* fiveKinds(author.threadId, author.runId, task);
          for (const turn of factoryTurns) yield* consult(turn);
          yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
          yield* world.endRun(author.runId, "completed");
          const ownerRun = yield* world.ownerTurn(author.threadId, "Rename the button.");
          const ownerContinued = turns.restartContinuation(author.threadId, ownerRun);
          yield* consult(ownerContinued);

          assert.deepStrictEqual(
            reached,
            expectedReached(factoryTurns, author.deliveryId, "factory", "retired"),
          );
          assert.deepStrictEqual(ranInline, [ownerContinued.messageId]);
          assert.strictEqual((yield* recordedTurns).length, factoryTurns.length + 1);
          yield* world.endRun(ownerRun, "completed");
        }),
      { admission: port, automaticTurnGate: true },
    );
  });

  it.live("runs inline, recording nothing, on a thread of no Factory family", () => {
    const { reached, port } = recordingPort("active");
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          ranInline.length = 0;
          const elsewhere = yield* ownerFolder(world);
          const owned = yield* world.ownerThreadAt(elsewhere, "Look around the project.");
          const task = { childThreadId: ThreadId.make("thread-asking"), taskId: questionTask };
          const presented = [
            turns.pullRequestWake(
              owned.threadId,
              { host: "github.com", repository: "acme/alpha", ...fakePullRequest },
              "2026-10-29T09:00:00.000Z",
            ),
            ...(yield* fiveKinds(owned.threadId, owned.runId, task)),
          ];
          for (const turn of presented) {
            assert.deepStrictEqual(yield* consult(turn), AutomaticTurnGate.ran(undefined));
          }
          assert.deepStrictEqual(
            ranInline,
            presented.map(({ messageId }) => messageId),
          );
          assert.deepStrictEqual(reached, []);
          assert.deepStrictEqual(yield* recordedTurns, []);
        }),
      { admission: port, automaticTurnGate: true },
    );
  });
});

/**
 * Wakes the thread about its watched pull request as core's watch reactor does, through the
 * gate: one `thread.pull-request-watch.sync` recording failed checks and queuing the wake, which
 * runs only if the gate runs it. Returns the turn and the wake's run when it ran.
 */
const wakeThroughGate = (threadId: ThreadId, link: ThreadPullRequestLink) =>
  Effect.gen(function* () {
    const watch = link.watch ?? assert.fail(`Pull request #${link.number} is not watched.`);
    const turn = turns.pullRequestWake(threadId, link, watch.startedAt);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const outcome = yield* gate.admit(
      turn,
      orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${threadId}:${turn.messageId}`),
        threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        startedAt: watch.startedAt,
        watch: { ...watch, failedChecks: [...watch.failedChecks, `ci-${turn.messageId}`] },
        wake: {
          messageId: turn.messageId,
          text: `Update on pull request #${link.number} (${link.url}): checks failed.`,
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: `#${link.number}: checks failed`,
          },
        },
      }),
    );
    const runId =
      outcome._tag === "Ran"
        ? outcome.value.storedEvents.flatMap(({ event }) =>
            event.type === "run.created" ? [event.payload.id] : [],
          )[0]
        : undefined;
    yield* drainOrchestration;
    return { turn, outcome, runId };
  }).pipe(Effect.orDie);

describe("automatic turns after intervening runs on the real stack", () => {
  it.live(
    "keeps a native wake unknown once the owner's turn shares its provider thread, either way round",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            ranInline.length = 0;
            const author = yield* world.start;
            const providerThread = yield* providerThreadOf(author.threadId, author.runId);
            // Only Factory's run has used the provider thread so far.
            const early = turns.backgroundWake(author.threadId, providerThread);
            yield* consult(early);
            // (e) A usage-limit resume of Factory's run is Factory's.
            const resumeFactory = turns.usageLimitResume(author.threadId, author.runId);
            yield* consult(resumeFactory);
            // The owner queues a turn behind the author's; Factory's repair turn queues behind it.
            const ownerRun = yield* ownerQueues(author.threadId, "Rename the button.");
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            yield* runStarted(ownerRun);
            // (a) Factory's work, then the owner's turn, then the wake: unknown.
            const afterOwner = turns.backgroundWake(author.threadId, providerThread);
            yield* consult(afterOwner);
            // (f) Presented again, the early wake keeps the class recorded for it.
            yield* consult(early);
            yield* world.endRun(ownerRun, "completed");
            const repair = yield* awaitedRun(author.deliveryId);
            assert.strictEqual(repair.threadId, author.threadId);
            // (b) The owner's turn, then Factory's repair turn, then the wake: unknown still.
            const afterRepair = turns.backgroundWake(author.threadId, providerThread);
            yield* consult(afterRepair);
            // (e) Factory's repair turn's own limit resume is Factory's.
            const resumeRepair = turns.usageLimitResume(author.threadId, repair.runId);
            yield* consult(resumeRepair);

            assert.deepStrictEqual(
              reached.map(({ messageId, provenance }) => [messageId, provenance]),
              [
                [early.messageId, "factory"],
                [resumeFactory.messageId, "factory"],
                [afterOwner.messageId, "unknown"],
                [early.messageId, "factory"],
                [afterRepair.messageId, "unknown"],
                [resumeRepair.messageId, "factory"],
              ],
            );
            assert.deepStrictEqual(ranInline, []);
            yield* world.endRun(repair.runId, "completed");
          }),
        { admission: port, automaticTurnGate: true, limits: { maxFixRounds: 1 } },
      );
    },
    120_000,
  );

  it.live(
    "runs the owner's pull request wake and what carries it on inline, and judges senders",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            ranInline.length = 0;
            const opened = yield* openSingle(world);
            const reviewer = opened.reviewer;
            // (d) The owner watches another pull request on the author thread, after Factory's runs.
            const owned = {
              host: "github.com",
              repository: "acme/alpha",
              number: 8,
              url: "https://github.com/acme/alpha/pull/8",
            };
            yield* linkPullRequest(opened.threadId, owned);
            yield* watchPullRequest(opened.threadId, owned);
            const wake = yield* wakeThroughGate(opened.threadId, yield* linkOf(opened.threadId, 8));
            assert.strictEqual(wake.outcome._tag, "Ran");
            const wakeRun = wake.runId ?? assert.fail("The owner's wake queued no run.");
            yield* runStarted(wakeRun);
            const continued = turns.restartContinuation(opened.threadId, wakeRun);
            const resumed = turns.usageLimitResume(opened.threadId, wakeRun);
            assert.deepStrictEqual(yield* consult(continued), AutomaticTurnGate.ran(undefined));
            assert.deepStrictEqual(yield* consult(resumed), AutomaticTurnGate.ran(undefined));
            assert.deepStrictEqual(ranInline, [continued.messageId, resumed.messageId]);
            assert.deepStrictEqual(reached, []);
            // Factory took nothing of it: the delivery still waits on its own pull request.
            const state = yield* stateOf(opened.deliveryId);
            assert.strictEqual(state.status, "pr_open");
            assert.strictEqual(state.awaiting, null);
            yield* world.endRun(wakeRun, "completed");

            // (g) An agent of the managed family messages the thread: its resume is unknown.
            const familyMessage = yield* agentSends(world.projectId, opened.threadId, reviewer);
            yield* runStarted(familyMessage);
            const fromFamily = turns.usageLimitResume(opened.threadId, familyMessage);
            yield* consult(fromFamily);
            yield* world.endRun(familyMessage, "completed");
            // An agent on an ordinary owner thread messages it: its resume is explicit.
            const elsewhere = yield* ownerFolder(world);
            const ownerThread = yield* world.ownerThreadAt(elsewhere, "Look around.");
            const ownerMessage = yield* agentSends(
              world.projectId,
              opened.threadId,
              ownerThread.threadId,
            );
            yield* runStarted(ownerMessage);
            const fromOwner = turns.usageLimitResume(opened.threadId, ownerMessage);
            assert.deepStrictEqual(yield* consult(fromOwner), AutomaticTurnGate.ran(undefined));
            assert.deepStrictEqual(
              reached.map(({ messageId, provenance }) => [messageId, provenance]),
              [[fromFamily.messageId, "unknown"]],
            );
            assert.include(ranInline, fromOwner.messageId);
            yield* world.endRun(ownerMessage, "completed");
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
    120_000,
  );

  it.live(
    "treats a task the owner's turn delegates as family work of unknown origin",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            ranInline.length = 0;
            const author = yield* world.start;
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            const ownerRun = yield* world.ownerTurn(author.threadId, "Split the export.");
            // (h) The agent working the owner's turn delegates a task.
            const delegate = yield* delegateFrom(author.threadId, ownerRun);
            const factory = yield* Factory.FactoryService.FactoryService;
            assert.strictEqual(
              yield* factory.familyRoot(delegate.childThreadId),
              author.deliveryId,
            );
            const delegateWake = turns.backgroundWake(
              delegate.childThreadId,
              yield* providerThreadOf(delegate.childThreadId, delegate.runId),
            );
            const result = turns.delegatedCompletion(
              author.threadId,
              ownerRun,
              yield* providerThreadOf(author.threadId, ownerRun),
            );
            yield* consult(delegateWake);
            yield* consult(result);
            // (c) The owner delegates a task themselves: its thread's provider thread carries only
            // the owner's work, and its wake is the owner's.
            const ownerTask = yield* delegateFrom(author.threadId, ownerRun, "user");
            const ownerTaskWake = turns.backgroundWake(
              ownerTask.childThreadId,
              yield* providerThreadOf(ownerTask.childThreadId, ownerTask.runId),
            );
            assert.deepStrictEqual(yield* consult(ownerTaskWake), AutomaticTurnGate.ran(undefined));

            assert.deepStrictEqual(
              reached.map(({ messageId, provenance }) => [messageId, provenance]),
              [
                [delegateWake.messageId, "unknown"],
                [result.messageId, "unknown"],
              ],
            );
            assert.deepStrictEqual(ranInline, [ownerTaskWake.messageId]);
            yield* world.endRun(delegate.runId, "completed");
            yield* world.endRun(ownerTask.runId, "completed");
            yield* world.endRun(ownerRun, "completed");
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
    120_000,
  );
});

/**
 * The host's view of a watched pull request whose `lint` check fails, which core's watch reactor
 * reports to the thread watching it.
 */
const failingPullRequest = (link: ThreadPullRequestLink, at: string): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: ProjectId.make("project-factory-delivery"),
  projectTitle: "Alpha",
  workspaceRoot: "/workspace/alpha",
  repository: link.repository,
  number: link.number,
  title: "Add the export button",
  body: "",
  url: link.url,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "work/fd-aaaaaa-add-the-export-button",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const projected = (reached: ReadonlyArray<Reached>) =>
  reached.map(({ kind, threadId, root, provenance, management }) => ({
    kind,
    threadId,
    root,
    provenance,
    management,
  }));

describe("core's producers consulting Factory's gate on the real stack", () => {
  it.live(
    "a restart's continuation of Factory's cut run reaches the manager and runs nothing",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            // Core's shutdown records restart intent for the turn its provider is still working on.
            yield* providerTurnRunning(author.threadId);
            const recovery = yield* coreRecovery;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            yield* world.rebuild(
              Effect.gen(function* () {
                // Core's startup recovery cut the author's run and left its continuation queued.
                yield* drainOrchestration;
                yield* drainFactory;
                assert.deepStrictEqual(
                  reached.map(({ kind, threadId, messageId, provenance }) => ({
                    kind,
                    threadId,
                    messageId,
                    provenance,
                  })),
                  [
                    {
                      kind: "restart_continuation",
                      threadId: author.threadId,
                      messageId: MessageId.make(`message:restart-continuation:${author.runId}`),
                      provenance: "factory",
                    },
                  ],
                );
                const { runs } = yield* threadProjection(author.threadId).pipe(Effect.orDie);
                assert.isTrue(runs.every((run) => run.restartContinuationOfRunId === undefined));
              }),
              { orchestration: true },
            );
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
  );

  it.live(
    "a native wake and a delegated result offered to the continuation worker reach it",
    () => {
      const { reached, port, arrived } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const providerThread = yield* providerThreadOf(author.threadId, author.runId);
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            yield* requests.offer({
              threadId: author.threadId,
              providerThreadId: providerThread,
              driver,
              detail: null,
            });
            yield* arrived("background_wake");
            // The author's delegate finishes while the author still works: its result is offered.
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            yield* world.endRun(delegate.runId, "completed");
            yield* arrived("delegated_completion");
            assert.deepStrictEqual(
              reached.map(({ kind, threadId, root, provenance }) => ({
                kind,
                threadId,
                root,
                provenance,
              })),
              [
                {
                  kind: "background_wake",
                  threadId: author.threadId,
                  root: author.deliveryId,
                  provenance: "factory",
                },
                {
                  kind: "delegated_completion",
                  threadId: author.threadId,
                  root: author.deliveryId,
                  provenance: "factory",
                },
              ],
            );
            yield* world.endRun(author.runId, "completed");
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
  );

  it.live("the watch reactor's wake of Factory's own pull request reaches the manager", () => {
    const { reached, port } = recordingPort("active");
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const link = yield* linkOf(opened.threadId, fakePullRequest.number);
          const before = (yield* threadProjection(opened.threadId).pipe(Effect.orDie)).runs.length;
          const at = DateTime.formatIso(yield* DateTime.now);
          const reactor = yield* PullRequestWatchReactor.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.mock(PullRequestService.PullRequestService)({
                  detail: () => Effect.succeed(failingPullRequest(link, at)),
                  activity: () =>
                    Effect.succeed({
                      comments: [],
                      commentCount: 0,
                      commentsTruncated: false,
                      reviewThreads: [],
                      commits: [],
                    }),
                }),
              ),
            ),
          );
          yield* reactor.sweep;
          assert.deepStrictEqual(projected(reached), [
            {
              kind: "pull_request_wake",
              threadId: opened.threadId,
              root: opened.deliveryId,
              provenance: "factory",
              management: "active",
            },
          ]);
          // Held back, the wake ran nothing and recorded nothing of the watch's progress.
          assert.strictEqual(
            (yield* threadProjection(opened.threadId).pipe(Effect.orDie)).runs.length,
            before,
          );
          assert.deepStrictEqual((yield* linkOf(opened.threadId, link.number)).watch, link.watch);
        }),
      { admission: port, automaticTurnGate: true },
    );
  });

  it.live("the usage-limit sweep's resume of Factory's run reaches the manager", () => {
    const { reached, port } = recordingPort("active");
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const sink = yield* EventSink.EventSinkV2;
          const run =
            (yield* threadProjection(author.threadId).pipe(Effect.orDie)).runs.find(
              (candidate) => candidate.id === author.runId,
            ) ?? assert.fail("The author's run is not recorded.");
          const now = yield* DateTime.now;
          const failedAt = DateTime.subtract(now, { minutes: 2 });
          // The author's run stopped on its provider's usage limit, which has reset since.
          yield* sink.write({
            commandId: CommandId.make("test-usage-limit"),
            events: [
              {
                id: EventId.make("test-usage-limit-run"),
                type: "run.updated",
                threadId: author.threadId,
                occurredAt: failedAt,
                payload: { ...run, status: "failed", completedAt: failedAt },
              },
              {
                id: EventId.make("test-usage-limit-error"),
                type: "turn-item.updated",
                threadId: author.threadId,
                occurredAt: failedAt,
                payload: {
                  id: TurnItemId.make("test-usage-limit-error"),
                  type: "error",
                  threadId: author.threadId,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 3,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: failedAt,
                  completedAt: failedAt,
                  updatedAt: failedAt,
                  failure: {
                    class: "usage_limit",
                    message: "Plan limit reached.",
                    code: "usageLimitExceeded",
                    retryable: null,
                    resetAt: DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })),
                  },
                },
              },
            ],
          });
          yield* drainFactory;
          const registered = yield* Deferred.make<Effect.Effect<void>>();
          const worker = UsageLimitRecoveryWorker.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Scheduler.Scheduler)({
                  // Hands the sweep to the test to run, as the scheduler would each tick.
                  register: <E, R>(_name: string, runDueWork: Effect.Effect<void, E, R>) =>
                    Effect.gen(function* () {
                      const context = yield* Effect.context<R>();
                      yield* Deferred.succeed(
                        registered,
                        runDueWork.pipe(Effect.provideContext(context), Effect.orDie),
                      );
                    }),
                }),
                ServerSettings.layerTest({ autoResumeLimitedThreads: true }),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const sweep = yield* Deferred.await(registered);
            // The first sweep arms the recovery; the reset has passed, so the next presents it.
            yield* sweep;
            assert.deepStrictEqual(reached, []);
            yield* sweep;
          }).pipe(Effect.provide(worker));
          assert.deepStrictEqual(projected(reached), [
            {
              kind: "usage_limit_resume",
              threadId: author.threadId,
              root: author.deliveryId,
              provenance: "factory",
              management: "active",
            },
          ]);
          assert.isTrue(
            (yield* threadProjection(author.threadId).pipe(Effect.orDie)).runs.every(
              (candidate) => candidate.id === author.runId,
            ),
          );
        }),
      { admission: port, automaticTurnGate: true },
    );
  });

  it.live(
    "the question reactor's wake for a task Factory's run delegated reaches the manager",
    () => {
      const { reached, port } = recordingPort("active");
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            const childRun =
              (yield* threadProjection(delegate.childThreadId).pipe(Effect.orDie)).runs[0] ??
              assert.fail("The delegated task has no run.");
            const nodeId = childRun.rootNodeId ?? assert.fail("The task's run has no root node.");
            const sink = yield* EventSink.EventSinkV2;
            const now = yield* DateTime.now;
            // The delegated agent asks a question that waits for an answer.
            const asked: OrchestrationV2DomainEvent = {
              id: EventId.make("test-question"),
              type: "runtime-request.updated",
              threadId: delegate.childThreadId,
              runId: childRun.id,
              nodeId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make("request-question"),
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("provider-session:test"),
                },
                createdAt: now,
                resolvedAt: null,
              },
            };
            yield* sink.write({ commandId: CommandId.make("test-question"), events: [asked] });
            const questions = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor.pipe(
              Effect.provide(DelegatedTaskQuestionReactor.layer),
            );
            yield* questions.handle(asked);
            assert.deepStrictEqual(projected(reached), [
              {
                kind: "delegated_question",
                threadId: author.threadId,
                root: author.deliveryId,
                provenance: "factory",
                management: "active",
              },
            ]);
            // Held back, the author got no wake about it.
            assert.isTrue(
              (yield* threadProjection(author.threadId).pipe(Effect.orDie)).runs.every(
                (candidate) => candidate.id === author.runId,
              ),
            );
            yield* world.endRun(delegate.runId, "completed");
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
  );

  it.live(
    "a delegated result steered into Factory's turn that ended first reaches the manager again",
    () => {
      const offered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const delivered = Deferred.makeUnsafe<void>();
      const reached: Array<{
        readonly origin: string;
        readonly messageId: MessageId;
        readonly provenance: string;
      }> = [];
      // The manager runs the first offer, then holds back what follows it.
      const port: typeof FactoryAdmission.FactoryAdmission.Service = {
        ...FactoryAdmission.FactoryAdmission.defaultValue(),
        management: () => Effect.succeed("active"),
        automaticTurn: (turn) =>
          Effect.suspend(() => {
            if (turn.turn.kind !== "delegated_completion") {
              return Effect.succeed(AutomaticTurnGate.notNow("deferred"));
            }
            reached.push({
              origin: turn.turn.origin,
              messageId: turn.turn.messageId,
              provenance: turn.provenance,
            });
            return turn.turn.origin === "offer" && reached.length === 1
              ? Deferred.succeed(offered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.map(turn.dispatch, AutomaticTurnGate.ran)),
                  Effect.tap(() => Deferred.succeed(delivered, undefined)),
                )
              : Effect.succeed(AutomaticTurnGate.notNow("deferred"));
          }),
      };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const authorTurn =
              world.provider.started.find((candidate) => candidate.runId === author.runId) ??
              assert.fail("The author's turn did not start.");
            const delegate = yield* delegateFrom(author.threadId, author.runId);
            // The task ends while the author works: its result is offered, and core steers the
            // delivery into the author's running turn.
            yield* world.endRun(delegate.runId, "completed");
            yield* Deferred.await(offered);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(delivered);
            // The author's turn ends before the steer reaches its provider.
            yield* world.provider.endTurn(authorTurn, "completed");
            yield* runReached(author.runId, ["waiting", ...ended]);
            yield* drainOrchestration;
            const [offer, steer] = reached;
            assert.deepStrictEqual(
              reached.map(({ origin, provenance }) => [origin, provenance]),
              [
                ["offer", "factory"],
                ["steer", "factory"],
              ],
            );
            // The steer's follow-up keeps the delivery's message, and its recorded class.
            assert.strictEqual(steer?.messageId, offer?.messageId);
            yield* drainFactory;
          }),
        { admission: port, automaticTurnGate: true },
      );
    },
  );
});

/** What the focused stack fails, how often, and what its parts saw. */
interface Faults {
  /** Projection reads Factory's gate makes that fail, before they read again. */
  reads: number;
  /** Reads of the root's management that fail. */
  management: number;
  /** Record writes that fail. */
  records: number;
  /** The message of each turn whose decision was written or tried. */
  readonly attempts: Array<MessageId>;
  readonly tried: TxRef.TxRef<number>;
  readonly cleared: Array<MessageId>;
}

const focusedProject = ProjectId.make("project-focused");
const focusedDelivery = FactoryDeliveryId.make("delivery-focused");
const focusedThread = launchThreadId(focusedDelivery, 1);
const focusedRun = RunId.make("run-focused-launch");
const focusedProviderThread = ProviderThreadId.make("provider-thread-focused");

/**
 * Factory's gate between core's continuation worker and a recording manager, over in-memory SQLite,
 * with the projection reads, the manager's management read and the record writes Factory's gate
 * makes failing while `faults` says so. The rest of the server is absent: nothing here launches.
 */
const focusedStack = (faults: Faults, port: typeof FactoryAdmission.FactoryAdmission.Service) => {
  const projections = Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.map(ProjectionStore.ProjectionStoreV2, (store) =>
      ProjectionStore.ProjectionStoreV2.of({
        ...store,
        getThreadRecords: (threadId, fields, filter) =>
          Effect.suspend(() => {
            if (faults.reads === 0) return store.getThreadRecords(threadId, fields, filter);
            faults.reads -= 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "disk read failed" }),
            );
          }),
      }),
    ),
  ).pipe(Layer.provide(ProjectionStore.layer));
  const decisions = Layer.effect(
    FactoryAutomaticTurnStore.FactoryAutomaticTurnStore,
    Effect.map(FactoryAutomaticTurnStore.FactoryAutomaticTurnStore, (store) =>
      FactoryAutomaticTurnStore.FactoryAutomaticTurnStore.of({
        ...store,
        record: (decision) =>
          Effect.suspend(() => {
            faults.attempts.push(decision.messageId);
            if (faults.records === 0) return store.record(decision);
            faults.records -= 1;
            return Effect.fail(
              new FactoryStoreError({ operation: "automaticTurns.record", cause: "disk full" }),
            );
          }).pipe(Effect.ensuring(TxRef.update(faults.tried, (count) => count + 1))),
      }),
    ),
  );
  const manager = Layer.succeed(FactoryAdmission.FactoryAdmission, {
    ...port,
    management: (root) =>
      Effect.suspend(() => {
        if (faults.management === 0) return port.management(root);
        faults.management -= 1;
        return Effect.fail(
          new FactoryAdmission.FactoryAdmissionReadError({ root, cause: "unreachable" }),
        );
      }),
  });
  // The continuation worker reads the thread before it consults the gate, never failing here.
  const threads = Layer.unwrap(
    Effect.map(ProjectionStore.ProjectionStoreV2, (store) =>
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: (threadId, fields, filter) =>
          store.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
        dispatch: () => Effect.die("A held-back wake dispatches nothing."),
      }),
    ),
  ).pipe(Layer.provide(ProjectionStore.layer));
  return Layer.mergeAll(
    ProviderContinuationService.layer,
    FactoryAutomaticTurns.layerOverActivity,
  ).pipe(
    Layer.provide(FactoryActivity.layerOverReaders),
    Layer.provide(
      Layer.mergeAll(
        projections,
        EventStore.layer,
        CommandReceiptStore.layer,
        EffectOutbox.layer,
        Layer.mock(FactoryWorker.FactoryWorker)({ jobsInFlight: () => Effect.succeed(0) }),
        decisions,
        manager,
        threads,
        IdAllocator.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(AutomaticTurnGate.layerInstallable, ProviderContinuationRequests.layer),
    ),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

/** A single item's author thread, launched by an earlier process, with its first run. */
const seedFocused = Effect.gen(function* () {
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  yield* deliveries.insert({
    deliveryId: focusedDelivery,
    projectId: focusedProject,
    itemRef: {
      sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
      itemId: WorkItemId.make("fd-focus"),
    },
    state: queuedDeliveryState({ branch: "work/fd-focus", baseRef: "HEAD" }),
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
  yield* projections.apply({
    id: EventId.make("focused-thread-created"),
    type: "thread.created",
    threadId: focusedThread,
    occurredAt: now,
    payload: {
      id: focusedThread,
      projectId: focusedProject,
      title: "Author",
      createdBy: "system",
      creationSource: "server",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "work/fd-focus",
      worktreePath: "/worktrees/fd-focus",
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: focusedThread,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projections.apply({
    id: EventId.make("focused-run-created"),
    type: "run.created",
    threadId: focusedThread,
    occurredAt: now,
    payload: {
      id: focusedRun,
      threadId: focusedThread,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: focusedProviderThread,
      userMessageId: MessageId.make(`factory-launch-message:${focusedDelivery}:1`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
}).pipe(Effect.orDie);

const makeFaults = (): Faults => ({
  reads: 0,
  management: 0,
  records: 0,
  attempts: [],
  tried: TxRef.makeUnsafe(0),
  cleared: [],
});

/** Waits until `count` decisions were written or tried. */
const triedAtLeast = (faults: Faults, count: number) =>
  TxRef.get(faults.tried).pipe(
    Effect.flatMap((tried) => (tried >= count ? Effect.void : Effect.txRetry)),
    Effect.tx,
  );

describe("Factory's gate when it cannot decide", () => {
  it.effect("runs nothing and fails the consult when a read or the record fails", () => {
    const faults = makeFaults();
    const { reached, port } = recordingPort("active");
    return Effect.gen(function* () {
      yield* seedFocused;
      const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
      const dispatched: Array<string> = [];
      const turn = turns.restartContinuation(focusedThread, focusedRun);
      const present = gate.admit(
        turn,
        Effect.sync(() => void dispatched.push(turn.messageId)),
      );
      const refusal = Effect.flip(present).pipe(
        Effect.map((error) => ({ tag: error._tag, stage: error.stage, thread: error.thread })),
      );
      const failed = (stage: string) => ({
        tag: "AutomaticTurnDecisionError",
        stage,
        thread: focusedThread,
      });

      faults.reads = 1;
      assert.deepStrictEqual(yield* refusal, failed("read"));
      faults.management = 1;
      assert.deepStrictEqual(yield* refusal, failed("read"));
      faults.records = 1;
      assert.deepStrictEqual(yield* refusal, failed("record"));
      assert.deepStrictEqual(dispatched, []);
      assert.deepStrictEqual(reached, []);
      assert.deepStrictEqual(yield* recordedTurns, []);

      // Once everything reads again, it decides and the manager holds it.
      assert.deepStrictEqual(yield* present, AutomaticTurnGate.notNow("deferred"));
      assert.deepStrictEqual(
        reached.map(({ kind, provenance }) => [kind, provenance]),
        [["restart_continuation", "factory"]],
      );
      assert.deepStrictEqual(dispatched, []);
    }).pipe(Effect.provide(focusedStack(faults, port)), Effect.scoped);
  });

  it.effect.each([
    { shape: "with no callback", clearable: false },
    { shape: "that can be cleared", clearable: true },
  ] as const)(
    "offers a native wake $shape again under its id until it reaches the manager once",
    ({ clearable }) => {
      const faults = makeFaults();
      const { reached, port } = recordingPort("active");
      return Effect.gen(function* () {
        yield* seedFocused;
        faults.records = 2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* requests.offer({
          threadId: focusedThread,
          providerThreadId: focusedProviderThread,
          driver,
          detail: null,
          ...(clearable
            ? {
                clearIfCurrent: () =>
                  Effect.sync(() => void faults.cleared.push(MessageId.make("cleared"))),
              }
            : {}),
        });
        yield* triedAtLeast(faults, 1);
        assert.deepStrictEqual(reached, []);
        // Undecided twice: offered again after each backoff step, under the same message id.
        yield* TestClock.adjust("100 millis");
        yield* triedAtLeast(faults, 2);
        assert.deepStrictEqual(reached, []);
        yield* TestClock.adjust("200 millis");
        yield* triedAtLeast(faults, 3);
        const [first] = faults.attempts;
        assert.isDefined(first);
        assert.deepStrictEqual(faults.attempts, [first, first, first]);
        assert.deepStrictEqual(
          reached.map(({ kind, messageId, provenance }) => [kind, messageId, provenance]),
          [["background_wake", first, "factory"]],
        );
        // Decided, it is offered no more, and nothing cleared the adapter's offer.
        yield* TestClock.adjust("1 hour");
        assert.strictEqual(reached.length, 1);
        assert.deepStrictEqual(faults.cleared, []);
      }).pipe(Effect.provide(focusedStack(faults, port)), Effect.scoped);
    },
  );
});
