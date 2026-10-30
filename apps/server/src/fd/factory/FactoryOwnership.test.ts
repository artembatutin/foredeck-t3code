import { assert, describe, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AutomaticTurn } from "../../orchestration-v2/AutomaticTurnGate.ts";
import type { FactoryManagement } from "./FactoryAdmission.ts";
import {
  classifier,
  type FactoryProvenance,
  familyOf,
  type FamilyDelivery,
  type FamilyThread,
  type OwnershipReads,
} from "./FactoryOwnership.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import {
  type FactoryDeliveryState,
  type FactoryPullRequestWake,
  queuedDeliveryState,
} from "./pipeline/state.ts";

const at = DateTime.makeUnsafe("2026-10-29T10:00:00Z");
const later = DateTime.makeUnsafe("2026-10-29T10:05:00Z");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
/** The provider thread every run here starts on unless it names another. */
const providerThread = ProviderThreadId.make("provider-thread-main");
const otherProviderThread = ProviderThreadId.make("provider-thread-other");

const single = FactoryDeliveryId.make("delivery-single");
const parent = FactoryDeliveryId.make("delivery-parent");
const child = FactoryDeliveryId.make("delivery-child");
const otherRoot = FactoryDeliveryId.make("delivery-other");

const author = launchThreadId(single, 1);
const reviewer = launchThreadId(single, 4);
const childAuthor = launchThreadId(child, 1);
const pullRequest = { number: 7, url: "https://github.com/acme/alpha/pull/7" };

/** A thread's records, as the reads hand them over. */
interface Built {
  readonly threads: Map<ThreadId, FamilyThread>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly wakes: Map<string, FactoryPullRequestWake>;
  readonly recorded: Map<string, FactoryProvenance>;
  readonly deliveries: Map<FactoryDeliveryId, FamilyDelivery>;
  readonly management: Map<FactoryDeliveryId, FactoryManagement>;
}

const key = (threadId: ThreadId, id: string) => `${threadId}\u0000${id}`;

const readsOf = (world: Built): OwnershipReads<never> => ({
  delivery: (deliveryId) => Effect.succeed(world.deliveries.get(deliveryId)),
  lineage: (threadId) => Effect.succeed(world.threads.get(threadId)?.lineage),
  thread: (threadId) => Effect.succeed(world.threads.get(threadId)),
  message: (threadId, messageId) => Effect.succeed(world.messages.get(key(threadId, messageId))),
  wake: (threadId, runId) => Effect.succeed(world.wakes.get(key(threadId, runId))),
  recorded: (threadId, messageId) => Effect.succeed(world.recorded.get(key(threadId, messageId))),
  management: (root) => Effect.succeed(world.management.get(root) ?? "never"),
});

type MessageFields = Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource"> &
  Partial<
    Pick<
      OrchestrationV2ConversationMessage,
      "scheduledTaskId" | "senderThreadId" | "delegatedCompletion" | "notification"
    >
  >;
type RunFields = Partial<
  Pick<
    OrchestrationV2Run,
    | "status"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "delegatedTaskId"
    | "workStartedAt"
  >
>;

/** A world of Factory's deliveries and core's threads, built up by each case. */
const makeWorld = () => {
  const world: Built = {
    threads: new Map(),
    messages: new Map(),
    wakes: new Map(),
    recorded: new Map(),
    deliveries: new Map(),
    management: new Map(),
  };
  const followThrough: NonNullable<FactoryDeliveryState["followThrough"]> = {
    watchedAfter: 10,
    armedAt: 10,
    watchStartedAt: "2026-10-29T09:00:00.000Z",
    heldUntil: null,
    runs: [],
    pending: [],
    watchEnded: false,
  };
  const parentState: FactoryDeliveryState = {
    ...queuedDeliveryState({ kind: "parent", branch: "work/parent", baseRef: "HEAD" }),
    status: "pr_open",
    children: [child],
    pullRequest: { ...pullRequest, headBranch: "work/parent" },
    pullRequestThread: childAuthor,
    followThrough,
  };
  const singleState: FactoryDeliveryState = {
    ...queuedDeliveryState({ branch: "work/single", baseRef: "HEAD" }),
    status: "pr_open",
    threads: { author, reviewer },
    pullRequest: { ...pullRequest, headBranch: "work/single" },
    followThrough,
  };
  world.deliveries.set(single, { parentId: null, state: singleState });
  world.deliveries.set(parent, { parentId: null, state: parentState });
  world.deliveries.set(child, {
    parentId: parent,
    state: { ...queuedDeliveryState({ kind: "child", branch: "work/parent", baseRef: "HEAD" }) },
  });
  world.deliveries.set(otherRoot, {
    parentId: null,
    state: queuedDeliveryState({ branch: "work/other", baseRef: "HEAD" }),
  });

  const thread = (threadId: ThreadId, parentThreadId: ThreadId | null = null) => {
    world.threads.set(threadId, {
      lineage: {
        parentThreadId,
        relationshipToParent: parentThreadId === null ? null : "subagent",
        rootThreadId: threadId,
      },
      forkedFrom: null,
      contextTransfers: [],
      runs: [],
      subagents: [],
      providerThreads: [],
    });
    return threadId;
  };
  /**
   * The thread a task the parent's run delegated runs on, as core's delegation leaves it: forked
   * from the task's node, with a spawn naming the run it started, which names no task itself.
   */
  const delegatedThread = (threadId: ThreadId, parentThreadId: ThreadId, taskId: NodeId) => {
    thread(threadId, parentThreadId);
    const records = world.threads.get(threadId) ?? assert.fail(`No thread ${threadId}.`);
    world.threads.set(threadId, { ...records, forkedFrom: { type: "node", nodeId: taskId } });
    return threadId;
  };
  const spawned = (threadId: ThreadId, runId: RunId) => {
    const records = world.threads.get(threadId) ?? assert.fail(`No thread ${threadId}.`);
    const parentThreadId = records.lineage.parentThreadId ?? assert.fail("A spawn has a parent.");
    world.threads.set(threadId, {
      ...records,
      contextTransfers: [
        ...records.contextTransfers,
        {
          id: ContextTransferId.make(`transfer:${runId}`),
          type: "subagent_spawn",
          sourceThreadId: parentThreadId,
          targetThreadId: threadId,
          sourcePoint: { threadId: parentThreadId },
          basePoint: null,
          sourceProviderInstanceId: instanceId,
          targetProviderInstanceId: instanceId,
          targetRunId: runId,
          status: "consumed",
          resolution: null,
          createdBy: "agent",
          error: null,
          createdAt: at,
          updatedAt: at,
          consumedAt: at,
        },
      ],
    });
  };
  let ordinal = 0;
  /** A run on the thread started from a message of its own. */
  const run = (
    threadId: ThreadId,
    id: string,
    messageId: string,
    message: MessageFields | null,
    fields: RunFields = {},
  ) => {
    const records = world.threads.get(threadId) ?? assert.fail(`No thread ${threadId}.`);
    ordinal += 1;
    const runId = RunId.make(id);
    const created: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: providerThread,
      userMessageId: MessageId.make(messageId),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
      ...fields,
    };
    world.threads.set(threadId, { ...records, runs: [...records.runs, created] });
    if (message !== null) {
      world.messages.set(key(threadId, messageId), {
        id: MessageId.make(messageId),
        threadId,
        runId,
        nodeId: null,
        role: "user",
        text: "Go on.",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
        ...message,
      });
    }
    return runId;
  };
  /** A task the thread's run delegated, with the thread it runs on. */
  const delegated = (
    threadId: ThreadId,
    taskId: string,
    runId: RunId | null,
    childThreadId: ThreadId | null,
    origin: OrchestrationV2Subagent["origin"] = "app_owned",
  ) => {
    const records = world.threads.get(threadId) ?? assert.fail(`No thread ${threadId}.`);
    const task: OrchestrationV2Subagent = {
      id: NodeId.make(taskId),
      threadId,
      runId,
      parentNodeId: NodeId.make(`${taskId}:parent`),
      origin,
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Check the export.",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    };
    world.threads.set(threadId, { ...records, subagents: [...records.subagents, task] });
    return task.id;
  };
  return { world, thread, delegatedThread, spawned, run, delegated, reads: readsOf(world) };
};

const factoryOf = (root: FactoryDeliveryId): FactoryProvenance => ({ class: "factory", root });

const deliveryOf = (world: Built, deliveryId: FactoryDeliveryId) =>
  world.deliveries.get(deliveryId) ?? assert.fail(`No delivery ${deliveryId}.`);
const followThroughOf = (delivery: FamilyDelivery) =>
  delivery.state.followThrough ?? assert.fail("The delivery follows no pull request.");
/** The thread `depth` levels below the author, as `levels` lists them from the first. */
const levelAt = (levels: ReadonlyArray<ThreadId>, depth: number) =>
  levels[depth - 1] ?? assert.fail(`No thread at depth ${depth}.`);
const explicit: FactoryProvenance = { class: "explicit" };
const unknown: FactoryProvenance = { class: "unknown" };

const factoryLaunch = (deliveryId: FactoryDeliveryId, effectId: number) =>
  `factory-launch-message:${deliveryId}:${effectId}`;
const owner: MessageFields = { createdBy: "user", creationSource: "web" };
const nativeWake: MessageFields = { createdBy: "agent", creationSource: "provider" };
const serverMessage: MessageFields = { createdBy: "agent", creationSource: "server" };

describe("familyOf", () => {
  it.effect("follows launches and lineage children of family threads, and nothing else", () =>
    Effect.gen(function* () {
      const { world, thread, reads } = makeWorld();
      thread(author);
      thread(childAuthor);
      const delegate = thread(ThreadId.make("thread-delegate"), author);
      const nested = thread(ThreadId.make("thread-delegate-nested"), delegate);
      const mirror = thread(ThreadId.make("thread-native-mirror"), author);
      const ownerThread = thread(ThreadId.make("thread-owner"));
      const ownerDelegate = thread(ThreadId.make("thread-owner-delegate"), ownerThread);
      const fork = ThreadId.make("thread-fork");
      world.threads.set(fork, {
        forkedFrom: null,
        contextTransfers: [],
        runs: [],
        subagents: [],
        providerThreads: [],
        lineage: { parentThreadId: author, relationshipToParent: "fork", rootThreadId: fork },
      });

      const rootOf = (threadId: ThreadId) =>
        familyOf(reads, threadId).pipe(Effect.map((family) => family?.root ?? null));
      assert.deepStrictEqual(yield* familyOf(reads, author), {
        root: single,
        launchedBy: single,
      });
      // A child delivery's thread belongs to its parent's family.
      assert.deepStrictEqual(yield* familyOf(reads, childAuthor), {
        root: parent,
        launchedBy: child,
      });
      assert.strictEqual(yield* rootOf(delegate), single);
      assert.strictEqual(yield* rootOf(nested), single);
      assert.strictEqual(yield* rootOf(mirror), single);
      // Threads of no launch, delegated from one, or forked from a family thread are not family.
      assert.strictEqual(yield* rootOf(ownerThread), null);
      assert.strictEqual(yield* rootOf(ownerDelegate), null);
      assert.strictEqual(yield* rootOf(fork), null);
      assert.strictEqual(yield* rootOf(ThreadId.make("thread-unrecorded")), null);
      // A launch's id naming no stored delivery made no family thread.
      assert.strictEqual(yield* rootOf(launchThreadId(FactoryDeliveryId.make("gone"), 1)), null);
    }),
  );

  it.effect("goes eight levels down and fails beyond, or around a loop, as a read failure", () =>
    Effect.gen(function* () {
      const { thread, reads } = makeWorld();
      thread(author);
      let level = author;
      const levels: Array<ThreadId> = [];
      for (let depth = 1; depth <= 9; depth += 1) {
        level = thread(ThreadId.make(`thread-level-${depth}`), level);
        levels.push(level);
      }
      assert.strictEqual((yield* familyOf(reads, levelAt(levels, 8)))?.root, single);
      const deeper = yield* Effect.flip(familyOf(reads, levelAt(levels, 9)));
      assert.strictEqual(deeper._tag, "FactoryFamilyDepthError");
      assert.strictEqual(deeper.threadId, levelAt(levels, 9));

      const first = ThreadId.make("thread-loop-a");
      const second = ThreadId.make("thread-loop-b");
      thread(first, second);
      thread(second, first);
      assert.strictEqual(
        (yield* Effect.flip(familyOf(reads, first)))._tag,
        "FactoryFamilyDepthError",
      );
    }),
  );
});

describe("the class of a run on a family thread (P1-P9)", () => {
  it.effect("takes Factory's own messages as Factory's, a child's for its parent's root", () =>
    Effect.gen(function* () {
      const { thread, run, reads } = makeWorld();
      thread(author);
      thread(childAuthor);
      const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
      const repair = run(author, "run-repair", `factory-fix-verify-message:${single}:9`, null);
      const childLaunch = run(childAuthor, "run-child", factoryLaunch(child, 1), null);
      const strayed = run(
        author,
        "run-strayed",
        factoryLaunch(FactoryDeliveryId.make("x"), 1),
        null,
      );
      const singleClasses = classifier(reads, single);
      assert.deepStrictEqual(yield* singleClasses.run(author, launch), factoryOf(single));
      assert.deepStrictEqual(yield* singleClasses.run(author, repair), factoryOf(single));
      // Naming no stored delivery, it shows nothing of whose it is.
      assert.deepStrictEqual(yield* singleClasses.run(author, strayed), unknown);
      assert.deepStrictEqual(
        yield* classifier(reads, parent).run(childAuthor, childLaunch),
        factoryOf(parent),
      );
      // Factory's work for another root is not this root's.
      assert.deepStrictEqual(yield* classifier(reads, otherRoot).run(author, launch), unknown);
    }),
  );

  it.effect("takes the root's own pull request wakes and those it took as Factory's (P2)", () =>
    Effect.gen(function* () {
      const { world, thread, run, reads } = makeWorld();
      thread(author);
      thread(childAuthor);
      const wake = (threadId: ThreadId, id: string, fields: Partial<FactoryPullRequestWake>) => {
        const runId = run(threadId, id, `message:pr-watch:${id}`, serverMessage);
        world.wakes.set(key(threadId, runId), {
          threadId,
          ...pullRequest,
          sequence: 20,
          watchStartedAt: "2026-10-29T09:00:00.000Z",
          linkSequence: 19,
          ...fields,
        });
        return runId;
      };
      const own = wake(author, "run-own-wake", {});
      const other = wake(author, "run-other-pr", { number: 8, url: `${pullRequest.url}x` });
      const before = wake(author, "run-before-watch", { sequence: 9 });
      const onReviewer = (() => {
        thread(reviewer);
        return wake(reviewer, "run-reviewer-wake", { threadId: reviewer });
      })();
      const parentWake = wake(childAuthor, "run-parent-wake", { threadId: childAuthor });
      const classes = classifier(reads, single);
      assert.deepStrictEqual(yield* classes.run(author, own), factoryOf(single));
      assert.deepStrictEqual(yield* classes.run(author, other), explicit);
      assert.deepStrictEqual(yield* classes.run(author, before), explicit);
      assert.deepStrictEqual(yield* classes.run(reviewer, onReviewer), explicit);
      assert.deepStrictEqual(
        yield* classifier(reads, parent).run(childAuthor, parentWake),
        factoryOf(parent),
      );

      // Merged since, the pull request takes no new wake, but one the root took stays its own.
      const stored = deliveryOf(world, single);
      world.deliveries.set(single, {
        ...stored,
        state: {
          ...stored.state,
          status: "done",
          pullRequest: { ...pullRequest, headBranch: "work/single", outcome: "merged" },
          followThrough: { ...followThroughOf(stored), runs: [own] },
        },
      });
      const merged = classifier(reads, single);
      assert.deepStrictEqual(yield* merged.run(author, own), factoryOf(single));
      const late = wake(author, "run-late-wake", {});
      assert.deepStrictEqual(yield* merged.run(author, late), explicit);
    }),
  );

  it.effect("takes a continuation's class from the run it continues (P3)", () =>
    Effect.gen(function* () {
      const { thread, run, reads } = makeWorld();
      thread(author);
      const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
      const ownerTurn = run(author, "run-owner", "owner-message-1", owner);
      const continued = (source: RunId, id: string) =>
        run(author, id, `message:restart-continuation:${source}`, serverMessage, {
          restartContinuationOfRunId: source,
        });
      const ofLaunch = continued(launch, "run-continue-launch");
      const ofOwner = continued(ownerTurn, "run-continue-owner");
      const twice = continued(ofLaunch, "run-continue-twice");
      const classes = classifier(reads, single);
      assert.deepStrictEqual(yield* classes.run(author, ofLaunch), factoryOf(single));
      assert.deepStrictEqual(yield* classes.run(author, ofOwner), explicit);
      assert.deepStrictEqual(yield* classes.run(author, twice), factoryOf(single));
      // A chain that leads back to itself shows nothing.
      const looped = run(
        author,
        "run-looped",
        "message:restart-continuation:looped",
        serverMessage,
        {
          restartContinuationOfRunId: RunId.make("run-looped"),
        },
      );
      assert.deepStrictEqual(yield* classes.run(author, looped), unknown);
    }),
  );

  it.effect(
    "keeps a recorded automatic turn's class, and finds an unrecorded one unknown (P4, P9)",
    () =>
      Effect.gen(function* () {
        const { world, thread, run, reads } = makeWorld();
        thread(author);
        const recordedWake = run(author, "run-recorded-wake", "native-wake-1", nativeWake);
        const unrecordedWake = run(author, "run-unrecorded-wake", "native-wake-2", nativeWake);
        const recordedResume = run(author, "run-recorded-resume", "limit-resume:a", {
          createdBy: "user",
          creationSource: "server",
        });
        const unrecordedResume = run(author, "run-unrecorded-resume", "limit-resume:b", {
          createdBy: "user",
          creationSource: "server",
        });
        world.recorded.set(key(author, "native-wake-1"), factoryOf(single));
        world.recorded.set(key(author, "limit-resume:a"), explicit);
        const classes = classifier(reads, single);
        assert.deepStrictEqual(yield* classes.run(author, recordedWake), factoryOf(single));
        assert.deepStrictEqual(yield* classes.run(author, unrecordedWake), unknown);
        assert.deepStrictEqual(yield* classes.run(author, recordedResume), explicit);
        assert.deepStrictEqual(yield* classes.run(author, unrecordedResume), unknown);
      }),
  );

  it.effect(
    "takes delegated results and questions as Factory's only through Factory's runs (P5, P6)",
    () =>
      Effect.gen(function* () {
        const { thread, run, delegated, reads } = makeWorld();
        thread(author);
        const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
        const ownerTurn = run(author, "run-owner", "owner-message-1", owner);
        const unknownRun = run(author, "run-native", "native-wake-1", nativeWake);
        const completion = (id: string, parentRunId: RunId) =>
          run(author, id, `delegated-completion:${id}`, {
            ...serverMessage,
            delegatedCompletion: { parentRunId, generation: 1, taskIds: [NodeId.make("task")] },
          });
        const fromLaunch = completion("run-result-factory", launch);
        const fromOwner = completion("run-result-owner", ownerTurn);
        const fromUnknown = completion("run-result-unknown", unknownRun);
        const byFactory = delegated(author, "task-factory", launch, null);
        const byOwner = delegated(author, "task-owner", ownerTurn, null);
        const question = (id: string, taskIds: ReadonlyArray<NodeId>) =>
          run(author, id, `message:delegated-task-question:${author}:${id}`, {
            ...serverMessage,
            notification: {
              source: { kind: "delegated_task", taskIds },
              outcome: "updated",
              summary: "Delegated task has a question",
            },
          });
        const classes = classifier(reads, single);
        assert.deepStrictEqual(yield* classes.run(author, fromLaunch), factoryOf(single));
        assert.deepStrictEqual(yield* classes.run(author, fromOwner), unknown);
        assert.deepStrictEqual(yield* classes.run(author, fromUnknown), unknown);
        assert.deepStrictEqual(
          yield* classes.run(author, question("run-question-factory", [byFactory])),
          factoryOf(single),
        );
        assert.deepStrictEqual(
          yield* classes.run(author, question("run-question-owner", [byOwner])),
          unknown,
        );
        assert.deepStrictEqual(
          yield* classes.run(author, question("run-question-missing", [NodeId.make("gone")])),
          unknown,
        );
      }),
  );

  it.effect(
    "takes a delegated thread's run as Factory's only through the run that delegated it (P7)",
    () =>
      Effect.gen(function* () {
        const { thread, delegatedThread, spawned, run, delegated, reads } = makeWorld();
        thread(author);
        const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
        const ownerTurn = run(author, "run-owner", "owner-message-1", owner);
        const unknownRun = run(author, "run-native", "native-wake-1", nativeWake);
        /** A task the run delegated, and the run its delegation started on the task's thread. */
        const delegateRun = (taskId: string, by: RunId | null, origin?: "provider_native") => {
          const threadId = ThreadId.make(`thread-${taskId}`);
          const task = delegated(author, taskId, by, threadId, origin);
          delegatedThread(threadId, author, task);
          // The delegated prompt reads as an agent's message sent from the delegating thread.
          const runId = run(threadId, `run-${taskId}`, `delegate-message:${taskId}`, {
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: author,
          });
          spawned(threadId, runId);
          return { threadId, runId };
        };
        const classes = classifier(reads, single);
        const byFactory = delegateRun("task-factory", launch);
        const byOwner = delegateRun("task-owner", ownerTurn);
        const byUnknown = delegateRun("task-unknown", unknownRun);
        const mirror = delegateRun("task-native", launch, "provider_native");
        assert.deepStrictEqual(
          yield* classes.run(byFactory.threadId, byFactory.runId),
          factoryOf(single),
        );
        assert.deepStrictEqual(yield* classes.run(byOwner.threadId, byOwner.runId), unknown);
        assert.deepStrictEqual(yield* classes.run(byUnknown.threadId, byUnknown.runId), unknown);
        assert.deepStrictEqual(
          yield* classes.run(mirror.threadId, mirror.runId),
          factoryOf(single),
        );
        // Its own continuation follows it.
        const continued = run(
          byFactory.threadId,
          "run-delegate-continued",
          "message:restart-continuation:delegate",
          serverMessage,
          { restartContinuationOfRunId: byFactory.runId },
        );
        assert.deepStrictEqual(
          yield* classes.run(byFactory.threadId, continued),
          factoryOf(single),
        );
        // A follow-up an agent delegates from Factory's run names a task of its own.
        const followUpTask = delegated(author, "task-follow-up", launch, byFactory.threadId);
        const followUp = run(
          byFactory.threadId,
          "run-follow-up",
          "delegate-message:follow-up",
          { createdBy: "agent", creationSource: "mcp", senderThreadId: author },
          { delegatedTaskId: followUpTask },
        );
        assert.deepStrictEqual(yield* classes.run(byFactory.threadId, followUp), factoryOf(single));
        // The owner's follow-up gets a task whose run is only the parent's latest: it stays theirs.
        const ownerFollowUpTask = delegated(
          author,
          "task-owner-follow-up",
          launch,
          byFactory.threadId,
        );
        const ownerFollowUp = run(
          byFactory.threadId,
          "run-owner-follow-up",
          "owner-follow-up",
          owner,
          { delegatedTaskId: ownerFollowUpTask },
        );
        assert.deepStrictEqual(yield* classes.run(byFactory.threadId, ownerFollowUp), explicit);
        // A wake on the task's thread that no record decided is not the delegation's run.
        const wake = run(
          byFactory.threadId,
          "run-delegate-wake",
          "native-wake-delegate",
          nativeWake,
        );
        assert.deepStrictEqual(yield* classes.run(byFactory.threadId, wake), unknown);
        // A task the parent no longer records shows nothing.
        const orphan = thread(ThreadId.make("thread-orphan"), author);
        const orphanRun = run(
          orphan,
          "run-orphan",
          "delegate-message:orphan",
          { createdBy: "agent", creationSource: "mcp", senderThreadId: author },
          { delegatedTaskId: NodeId.make("task-gone") },
        );
        assert.deepStrictEqual(yield* classes.run(orphan, orphanRun), unknown);
      }),
  );

  it.effect(
    "takes what someone sent on purpose as explicit, and a managed family's agent as unknown (P8)",
    () =>
      Effect.gen(function* () {
        const { world, thread, run, reads } = makeWorld();
        thread(author);
        thread(reviewer);
        const ownerThread = thread(ThreadId.make("thread-owner"));
        thread(launchThreadId(otherRoot, 1));
        const classes = classifier(reads, single);
        const cases: ReadonlyArray<readonly [string, string, MessageFields, FactoryProvenance]> = [
          ["web", "owner-web", { createdBy: "user", creationSource: "web" }, explicit],
          ["mobile", "owner-mobile", { createdBy: "user", creationSource: "mobile" }, explicit],
          ["outside client", "owner-mcp", { createdBy: "user", creationSource: "mcp" }, explicit],
          [
            "answer",
            "async-answer:request-1",
            { createdBy: "user", creationSource: "server" },
            explicit,
          ],
          [
            "schedule",
            "scheduled-1",
            {
              createdBy: "agent",
              creationSource: "server",
              scheduledTaskId: ScheduledTaskId.make("task-1"),
            },
            explicit,
          ],
          ["agent, no sender", "agent-1", { createdBy: "agent", creationSource: "mcp" }, explicit],
          [
            "agent outside every family",
            "agent-2",
            { createdBy: "agent", creationSource: "mcp", senderThreadId: ownerThread },
            explicit,
          ],
          [
            "agent of an active managed family",
            "agent-3",
            { createdBy: "agent", creationSource: "mcp", senderThreadId: reviewer },
            unknown,
          ],
          [
            "agent of a retired managed family",
            "agent-4",
            {
              createdBy: "agent",
              creationSource: "mcp",
              senderThreadId: launchThreadId(otherRoot, 1),
            },
            unknown,
          ],
          [
            "server's own message",
            "server-1",
            { createdBy: "user", creationSource: "server" },
            unknown,
          ],
          ["provider's message", "provider-1", nativeWake, unknown],
        ];
        world.management.set(single, "active");
        world.management.set(otherRoot, "retired");
        for (const [name, messageId, message, expected] of cases) {
          const runId = run(author, `run-${messageId}`, messageId, message);
          assert.deepStrictEqual(yield* classes.run(author, runId), expected, name);
        }
        // A family whose root nothing manages sends as anyone outside one does.
        world.management.set(otherRoot, "never");
        const neverManaged = run(author, "run-agent-never", "agent-5", {
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: launchThreadId(otherRoot, 1),
        });
        assert.deepStrictEqual(yield* classes.run(author, neverManaged), explicit);
        // A run whose message cannot be found shows nothing.
        const missing = run(author, "run-no-message", "message-missing", null);
        assert.deepStrictEqual(yield* classes.run(author, missing), unknown);
      }),
  );

  it.effect("keeps each run's causal class whatever runs or start times neighbour it", () =>
    Effect.gen(function* () {
      const { thread, run, reads } = makeWorld();
      thread(author);
      const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
      // Right after Factory's run, reporting work that started when Factory's run did.
      const wakeAfterFactory = run(author, "run-wake-after-factory", "native-wake-1", nativeWake, {
        workStartedAt: at,
      });
      const ownerAfterFactory = run(author, "run-owner-after-factory", "owner-1", owner, {
        workStartedAt: at,
      });
      const ownerContinued = run(
        author,
        "run-owner-continued",
        "message:restart-continuation:owner",
        serverMessage,
        { restartContinuationOfRunId: ownerAfterFactory, workStartedAt: at },
      );
      // Right after the owner's run, carrying on Factory's earlier one.
      const factoryContinued = run(
        author,
        "run-factory-continued",
        "message:restart-continuation:factory",
        serverMessage,
        { restartContinuationOfRunId: launch, workStartedAt: later },
      );
      const classes = classifier(reads, single);
      assert.deepStrictEqual(yield* classes.run(author, wakeAfterFactory), unknown);
      assert.deepStrictEqual(yield* classes.run(author, ownerAfterFactory), explicit);
      assert.deepStrictEqual(yield* classes.run(author, ownerContinued), explicit);
      assert.deepStrictEqual(yield* classes.run(author, factoryContinued), factoryOf(single));
    }),
  );
});

describe("the class of an automatic turn, from its exact source", () => {
  const turnOn = (threadId: ThreadId) => ({
    threadId,
    messageId: MessageId.make("turn"),
    key: "turn",
  });

  it.effect("takes each producer's causal run", () =>
    Effect.gen(function* () {
      const { world, thread, run, delegated, reads } = makeWorld();
      thread(author);
      thread(childAuthor);
      const launch = run(author, "run-launch", factoryLaunch(single, 1), null);
      const ownerTurn = run(author, "run-owner", "owner-1", owner);
      const byFactory = delegated(author, "task-factory", launch, null);
      const byOwner = delegated(author, "task-owner", ownerTurn, null);
      const classes = classifier(reads, single);
      const wakeOf = (number: number, watchStartedAt: string) =>
        ({
          ...turnOn(author),
          kind: "pull_request_wake",
          pullRequest: {
            host: "github.com",
            repository: "acme/alpha",
            number,
            url: number === pullRequest.number ? pullRequest.url : `${pullRequest.url}0`,
          },
          watchStartedAt,
          ending: null,
        }) satisfies AutomaticTurn;
      const cases: ReadonlyArray<readonly [string, AutomaticTurn, FactoryProvenance]> = [
        ["own pull request", wakeOf(7, "2026-10-29T09:00:00.000Z"), factoryOf(single)],
        ["another pull request", wakeOf(70, "2026-10-29T09:00:00.000Z"), explicit],
        [
          "continuation of Factory's run",
          { ...turnOn(author), kind: "restart_continuation", sourceRunId: launch, settled: false },
          factoryOf(single),
        ],
        [
          "continuation of the owner's run",
          {
            ...turnOn(author),
            kind: "restart_continuation",
            sourceRunId: ownerTurn,
            settled: false,
          },
          explicit,
        ],
        [
          "limit resume of Factory's run",
          { ...turnOn(author), kind: "usage_limit_resume", usageLimitContinuationOfRunId: launch },
          factoryOf(single),
        ],
        [
          "limit resume of the owner's run",
          {
            ...turnOn(author),
            kind: "usage_limit_resume",
            usageLimitContinuationOfRunId: ownerTurn,
          },
          explicit,
        ],
        [
          "question of Factory's delegation",
          {
            ...turnOn(author),
            kind: "delegated_question",
            childThreadId: ThreadId.make("thread-child"),
            requestId: RuntimeRequestId.make("request-1"),
            taskId: byFactory,
            delegatingRunId: launch,
          },
          factoryOf(single),
        ],
        [
          "question of the owner's delegation",
          {
            ...turnOn(author),
            kind: "delegated_question",
            childThreadId: ThreadId.make("thread-child"),
            requestId: RuntimeRequestId.make("request-2"),
            taskId: byOwner,
            delegatingRunId: ownerTurn,
          },
          unknown,
        ],
        [
          "question with no delegating run",
          {
            ...turnOn(author),
            kind: "delegated_question",
            childThreadId: ThreadId.make("thread-child"),
            requestId: RuntimeRequestId.make("request-3"),
            taskId: byOwner,
            delegatingRunId: null,
          },
          unknown,
        ],
        [
          "result of Factory's delegation",
          {
            ...turnOn(author),
            kind: "delegated_completion",
            parentRunId: launch,
            generation: 1,
            providerThreadId: providerThread,
            driver: ProviderDriverKind.make("codex"),
            origin: "offer",
          },
          factoryOf(single),
        ],
        [
          "result of the owner's delegation",
          {
            ...turnOn(author),
            kind: "delegated_completion",
            parentRunId: ownerTurn,
            generation: 1,
            providerThreadId: providerThread,
            driver: ProviderDriverKind.make("codex"),
            origin: "steer",
          },
          unknown,
        ],
      ];
      for (const [name, turn, expected] of cases) {
        assert.deepStrictEqual(yield* classes.turn(turn), expected, name);
      }
      // A child's last author thread follows its parent's pull request.
      assert.deepStrictEqual(
        yield* classifier(reads, parent).turn({
          ...wakeOf(7, "2026-10-29T09:00:00.000Z"),
          threadId: childAuthor,
        }),
        factoryOf(parent),
      );
      // Cancelled, the root owns only what the watch Factory started sends.
      const stored = deliveryOf(world, single);
      world.deliveries.set(single, { ...stored, state: { ...stored.state, status: "cancelled" } });
      const cancelled = classifier(reads, single);
      assert.deepStrictEqual(
        yield* cancelled.turn(wakeOf(7, "2026-10-29T09:00:00.000Z")),
        factoryOf(single),
      );
      assert.deepStrictEqual(
        yield* cancelled.turn(wakeOf(7, "2026-10-29T09:30:00.000Z")),
        explicit,
      );
    }),
  );

  it.effect("decides a native wake by every run on its provider thread", () =>
    Effect.gen(function* () {
      const nativeTurn = (
        threadId: ThreadId,
        onProviderThread = providerThread,
      ): AutomaticTurn => ({
        ...turnOn(threadId),
        kind: "background_wake",
        providerThreadId: onProviderThread,
        driver: ProviderDriverKind.make("codex"),
        clearable: false,
      });
      const { world, thread, run, reads } = makeWorld();
      const classes = classifier(reads, single);
      const allFactory = thread(launchThreadId(single, 2));
      run(allFactory, "run-a1", factoryLaunch(single, 2), null);
      run(allFactory, "run-a2", `factory-fix-verify-message:${single}:3`, null);
      // Another provider thread's runs never reported this work.
      run(allFactory, "run-a3", "owner-a3", owner, { providerThreadId: otherProviderThread });
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(allFactory)), factoryOf(single));
      assert.deepStrictEqual(
        yield* classes.turn(nativeTurn(allFactory, otherProviderThread)),
        explicit,
      );

      const mixed = thread(launchThreadId(single, 5));
      run(mixed, "run-m1", factoryLaunch(single, 5), null);
      run(mixed, "run-m2", "owner-m2", owner);
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(mixed)), unknown);

      const withUnknown = thread(launchThreadId(single, 6));
      run(withUnknown, "run-u1", factoryLaunch(single, 6), null);
      run(withUnknown, "run-u2", "native-u2", nativeWake);
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(withUnknown)), unknown);

      const twoRoots = thread(launchThreadId(single, 7));
      run(twoRoots, "run-t1", factoryLaunch(single, 7), null);
      run(twoRoots, "run-t2", factoryLaunch(otherRoot, 1), null);
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(twoRoots)), unknown);

      const unused = thread(launchThreadId(single, 8));
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(unused)), unknown);

      // A recorded wake keeps its class among the runs that decide the next one, and a later
      // run of the owner's makes the provider thread mixed rather than moving that record.
      const recorded = thread(launchThreadId(single, 9));
      run(recorded, "run-r1", factoryLaunch(single, 9), null);
      run(recorded, "run-r2", "native-r2", nativeWake);
      world.recorded.set(key(recorded, "native-r2"), factoryOf(single));
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(recorded)), factoryOf(single));
      run(recorded, "run-r3", "owner-r3", owner);
      assert.deepStrictEqual(yield* classes.turn(nativeTurn(recorded)), unknown);
      assert.deepStrictEqual(yield* classes.run(recorded, RunId.make("run-r2")), factoryOf(single));
    }),
  );
});
