import { assert, describe, it } from "@effect/vitest";
import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  ProviderInstanceId,
  type RunId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { workItemScopeChanged } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { HandoffAdmission, ProjectAssistant } from "../assistant/index.ts";
import { WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
  authorCommits,
  type World,
} from "./testkit/deliveryHarness.ts";
import { agentSends, delegateFrom } from "./testkit/familyThreads.ts";
import {
  awaitedRun,
  linkOf,
  passingReview,
  reviewPasses,
  syncPullRequest,
  watchPullRequest,
} from "./testkit/followThrough.ts";
import {
  agreeAndCapture,
  assertNothingHeld,
  assignmentOf,
  assignToFactory,
  assistantThread,
  consult,
  controlAssignment,
  demandsOf,
  failOutboxReads,
  fill,
  handoffRows,
  managedRootOf,
  noticesOf,
  release,
  rootIdOf,
  rootRowOf,
  runToPullRequest,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  turns,
  wakeThroughGate,
} from "./testkit/handoff.ts";

/**
 * A Factory assignment's lifecycle on the server's real stack: the real delivery pipeline, the
 * assistant's real tick and controls, and what each leaves of the assignment and its capacity.
 */

const factoryService = Factory.FactoryService.FactoryService;
const WorkManagementService = WorkService.WorkService;
/** The owner reading the item, as their client does. */
const workOwner = {
  id: "session:owner",
  grants: [AuthWorkReadScope],
  label: "owner",
};
/** The owner editing the item in Work. */
const workWriter = { ...workOwner, grants: [AuthWorkReadScope, AuthWorkWriteScope] };

type Spy = ReturnType<typeof spyOnFactoryPort>;
const options = (spy: Spy) => ({
  handoff: {},
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
});

/** An idea captured, authorized, assigned and claimed by a tick; returns its root. */
const claimed = (world: World, idea: string) =>
  Effect.gen(function* () {
    yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    yield* tick;
    return yield* rootIdOf(idea);
  });

const revise = (world: World, idea: string, executionAuthorized: boolean) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({ projectId: world.projectId, ideaId: idea, patch: { executionAuthorized } }),
  ).pipe(Effect.orDie);

const onePlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "One task.",
};

/** The provider's question in the run's turn, once core stores it pending. */
const asked = (world: World, runId: RunId, mode: "live" | "message") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const turn =
      world.provider.started.find((candidate) => candidate.runId === runId) ??
      assert.fail(`No provider turn started run ${runId}.`);
    const requestId = yield* world.provider.ask(turn, mode);
    yield* sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "pending",
      ),
      Stream.runHead,
    );
    yield* drainOrchestration;
    return requestId;
  }).pipe(Effect.orDie);

const answer = (idea: string, requestId: RuntimeRequestId) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.answer({
      assignmentId: idea,
      managerThreadId: assistantThread,
      requestId,
      answers: { format: "CSV" },
    }),
  );

describe("a Factory assignment followed through its delivery", () => {
  it.live("shows an open pull request as needing the owner, and completes only after merge", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const opened = yield* runToPullRequest(world, root);

          yield* tick;
          const open = yield* assignmentOf("export");
          assert.strictEqual(open.state, "needs-input");
          const notes = yield* noticesOf("export");
          assert.include(notes, `PR ${fakePullRequest.url} open; review and merge.`);
          // Its slot went, and with it no retirement, since the delivery has not ended.
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
          const refs = open.worker_refs_json;
          assert.include(refs, root);
          assert.include(refs, opened.threadId);
          assert.include(refs, "work-item");

          const before = yield* handoffRows;
          yield* tick;
          assert.deepStrictEqual(yield* handoffRows, before);
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");

          yield* syncPullRequest(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
            "merged",
          );
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "done");
          yield* tick;
          const ended = yield* assignmentOf("export");
          assert.strictEqual(ended.state, "completed");
          const row = yield* rootRowOf(root);
          assert.strictEqual(row.state, "retired");
          assert.strictEqual(row.reason, "completed");
          assert.isNotNull(row.ending_at);
          yield* assertNothingHeld(root, "export");
          const { assignments } = yield* Effect.flatMap(
            ProjectAssistant.ProjectAssistant,
            (assistant) => assistant.inspect(world.projectId, "export"),
          );
          assert.isTrue(
            assignments[0]?.evidence.some((line) => line.includes(fakePullRequest.url)),
          );
        }),
      options(spy),
    );
  });

  it.live("cancels once a pull request closed unmerged and the family is quiet", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const opened = yield* runToPullRequest(world, root);
          yield* tick;
          yield* syncPullRequest(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
            "closed",
          );
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          // Factory ended it; nobody asked the assistant, which only follows.
          assert.strictEqual(spy.count("cancel"), 0);
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });
          yield* assertNothingHeld(root, "export");
          assert.isTrue(
            (yield* noticesOf("export")).some((note) => note.includes("closed without merging")),
          );
        }),
      options(spy),
    );
  });

  it.live("stays fenced and short of completed while core's outbox cannot be read", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const opened = yield* runToPullRequest(world, root);
          yield* tick;
          yield* syncPullRequest(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
            "merged",
          );
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "done");

          const restore = yield* failOutboxReads;
          yield* tick;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "ending",
            reason: "completed",
          });
          assert.isTrue(
            (yield* noticesOf("export")).some((note) => note.includes("could not be read")),
          );
          yield* restore;

          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "completed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "completed",
          });
        }),
      options(spy),
    );
  });

  it.live("shows a failed close-out as needing the owner, and Resume finishes it", () => {
    const spy = spyOnFactoryPort();
    const failing = { on: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const opened = yield* runToPullRequest(world, root);
          yield* tick;
          failing.on = true;
          yield* syncPullRequest(
            opened.threadId,
            yield* linkOf(opened.threadId, fakePullRequest.number),
            "merged",
          );
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "blocked");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
          assert.isTrue(
            (yield* noticesOf("export")).some((note) =>
              note.includes("Resume it once that is fixed"),
            ),
          );
          assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });

          failing.on = false;
          yield* controlAssignment("export", "resume");
          assert.strictEqual(spy.count("resume"), 1);
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "done");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "completed");
          yield* assertNothingHeld(root, "export");
        }),
      {
        ...options(spy),
        work: (service) => ({
          ...service,
          setStatus: (actor, input) =>
            failing.on
              ? Effect.die("The task file could not be written.")
              : service.setStatus(actor, input),
        }),
      },
    );
  });
});

describe("what a delivery's status shows on the real stack", () => {
  const WRITES = ["createItem", "updateItem", "setStatus", "addComment", "setLink"] as const;

  it.live(
    "reads a To do item's open delivery as separate facts, writing nothing to show them",
    () => {
      const spy = spyOnFactoryPort();
      const writes: Array<string> = [];
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* startAssistantThread(world);
            const root = yield* claimed(world, "export");
            yield* assistant.revise({
              projectId: world.projectId,
              ideaId: "export",
              patch: { priority: { rank: 1, reason: "First" } },
            });
            const opened = yield* runToPullRequest(world, root);
            yield* tick;
            yield* drainFactory;

            const factory = yield* factoryService;
            const before = [...writes];
            const messagesBefore = (yield* threadProjection(opened.threadId)).messages.length;

            const { assignments } = yield* assistant.overview;
            const [row] = assignments;
            assert.strictEqual(row?.factory?.status, "pr_open");
            assert.strictEqual(row?.factory?.pullRequestUrl, fakePullRequest.url);
            assert.isFalse(row?.factory?.proceeding);
            assert.strictEqual(row?.priority, 1);
            assert.strictEqual(row?.source?.status, "todo");
            assert.isNull(row?.source?.assignee);

            const [listed] = yield* factory.listForClients({});
            assert.strictEqual(listed?.state.status, "pr_open");
            assert.strictEqual(listed?.source?.status, "todo");
            assert.strictEqual(listed?.queuePriority, 1);

            const work = yield* WorkManagementService;
            const item = yield* work.getItem(workOwner, { ref: listed!.itemRef });
            assert.strictEqual(item.status, "todo");
            assert.isNull(item.assignee);

            // Reading all of that wrote to no source and sent no thread a message.
            assert.deepStrictEqual(writes, before);
            assert.strictEqual(
              (yield* threadProjection(opened.threadId)).messages.length,
              messagesBefore,
            );

            // Factory's own progress comments are not changed requirements on either link.
            for (const link of item.links) assert.isFalse(workItemScopeChanged(link, item));
            assert.isAbove(item.links.length, 0);
          }),
        {
          ...options(spy),
          work: (service) => {
            const spied = { ...service };
            for (const name of WRITES) {
              const write = service[name] as (
                ...args: ReadonlyArray<unknown>
              ) => Effect.Effect<never>;
              (spied as Record<string, unknown>)[name] = (...args: ReadonlyArray<unknown>) =>
                Effect.suspend(() => {
                  writes.push(name);
                  return write(...args);
                });
            }
            return spied;
          },
        },
      );
    },
  );

  it.live("reads a listing's new facts when its item or rank changes, the delivery idle", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const assistant = yield* ProjectAssistant.ProjectAssistant;
          const factory = yield* factoryService;
          const work = yield* WorkManagementService;
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          yield* runToPullRequest(world, root);
          yield* tick;
          yield* drainFactory;

          const epoch = factory.listingChanges.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          const listed = Effect.map(factory.listForClients({}), ([delivery]) => delivery!);
          const { itemRef } = yield* listed;
          const idle = () =>
            Effect.gen(function* () {
              const { state } = yield* listed;
              assert.strictEqual(state.status, "pr_open");
              assert.isNull(state.awaiting);
            });
          yield* idle();
          const factoryEpoch = factory.subscribe.pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          const factoryAtStart = yield* factoryEpoch;

          // A source-only edit: Factory itself writes nothing, and its own epoch stays put.
          const beforeStatus = yield* epoch;
          yield* work.setStatus(workWriter, { ref: itemRef, status: "in_progress" });
          assert.isAbove(yield* epoch, beforeStatus);
          assert.strictEqual((yield* listed).source?.status, "in_progress");

          const beforeAssignee = yield* epoch;
          yield* work.updateItem(workWriter, { ref: itemRef, assignee: "sam" });
          assert.isAbove(yield* epoch, beforeAssignee);
          assert.strictEqual((yield* listed).source?.assignee, "sam");

          // The assistant's rank, through the service its owner and agents revise it with.
          const beforeRank = yield* epoch;
          yield* assistant.revise({
            projectId: world.projectId,
            ideaId: "export",
            patch: { priority: { rank: 4, reason: "Later" } },
          });
          assert.isAbove(yield* epoch, beforeRank);
          assert.strictEqual((yield* listed).queuePriority, 4);

          yield* idle();
          assert.strictEqual(yield* factoryEpoch, factoryAtStart);
        }),
      options(spy),
    );
  });

  /** A ranked idea's delivery, run to its open pull request; returns what reads its facts. */
  const rankedToPullRequest = (world: World) =>
    Effect.gen(function* () {
      const assistant = yield* ProjectAssistant.ProjectAssistant;
      const factory = yield* factoryService;
      yield* startAssistantThread(world);
      const root = yield* claimed(world, "export");
      yield* assistant.revise({
        projectId: world.projectId,
        ideaId: "export",
        patch: { priority: { rank: 1, reason: "First" } },
      });
      const opened = yield* runToPullRequest(world, root);
      yield* tick;
      return {
        root,
        opened,
        rankOf: (deliveryId: string) =>
          Effect.map(
            factory.listForClients({}),
            (deliveries) =>
              deliveries.find((delivery) => delivery.deliveryId === deliveryId)?.queuePriority,
          ),
        overviewRank: Effect.map(assistant.overview, ({ assignments }) => assignments[0]?.priority),
      };
    });

  it.live.each(["merged", "closed"] as const)(
    "keeps the rank of a delivery whose pull request %s, the same as the assistant's",
    (outcome) => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, opened, rankOf, overviewRank } = yield* rankedToPullRequest(world);
            yield* syncPullRequest(
              opened.threadId,
              yield* linkOf(opened.threadId, fakePullRequest.number),
              outcome,
            );
            yield* drainFactory;
            assert.strictEqual(
              (yield* stateOf(root)).status,
              outcome === "merged" ? "done" : "cancelled",
            );
            yield* tick;
            assert.strictEqual((yield* managedRootOf(root))?.state, "retired");

            assert.strictEqual(yield* rankOf(root), 1);
            assert.strictEqual(yield* overviewRank, 1);

            // Its idea's rank moves on, and both go on reading the same.
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* assistant.revise({
              projectId: world.projectId,
              ideaId: "export",
              patch: { priority: { rank: 3, reason: "Later" } },
            });
            assert.strictEqual(yield* rankOf(root), 3);
            assert.strictEqual(yield* overviewRank, 3);
          }),
        options(spy),
      );
    },
  );

  it.live("keeps the rank of a delivery a retry left behind, whose link names it no more", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, rankOf } = yield* rankedToPullRequest(world);
          yield* controlAssignment("export", "cancel");
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");

          // Queued again, it has no delivery yet: Work still shows the cancelled one.
          yield* controlAssignment("export", "retry");
          assert.strictEqual(yield* rankOf(root), 1);

          yield* tick;
          const next = yield* rootIdOf("export");
          assert.notStrictEqual(next, root);
          assert.strictEqual(yield* rankOf(root), 1);
          assert.strictEqual(yield* rankOf(next), 1);
        }),
      options(spy),
    );
  });

  it.live("shows the rest of the overview when a Work source cannot answer", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* claimed(world, "export");
          const { assignments } = yield* Effect.flatMap(
            ProjectAssistant.ProjectAssistant,
            (assistant) => assistant.overview,
          );
          assert.strictEqual(assignments[0]?.assignmentId, "export");
          assert.notProperty(assignments[0], "source");
        }),
      {
        ...options(spy),
        work: (service) => ({
          ...service,
          currentSummaries: () => Effect.die("The tracker is down."),
        }),
      },
    );
  });
});

describe("a parent's slot on the real stack", () => {
  it.live(
    "releases at the plan gate, defers its children under full capacity, and shares one slot",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* factoryService;
            yield* startAssistantThread(world);
            const ref = yield* agreeAndCapture(world, "big", "parent");
            yield* assignToFactory(world, "big");
            yield* tick;
            const root = yield* rootIdOf("big");
            const planner = yield* world.launched(root);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
            yield* world.endRun(planner.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "waiting");

            // The plan gate releases: the owner's wait holds no capacity.
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isUndefined(yield* slotOf(root));

            // Approved with both slots held by others, its children wait for a grant.
            const [first] = yield* fill(world, 2);
            yield* factory.approvePlan(root);
            yield* drainFactory;
            const waiting = yield* stateOf(root);
            assert.strictEqual(waiting.status, "running");
            assert.strictEqual(
              waiting.awaiting?.type === "effect" ? waiting.awaiting.effect.type : "none",
              "create_children",
            );
            assert.isDefined(waiting.admissionWait);
            assert.deepStrictEqual(waiting.children, []);
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ kind }) => kind),
              ["effect"],
            );
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "running");
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual((yield* stateOf(root)).children, []);

            // A slot frees: the grant takes it, and everything after runs in it.
            yield* release(first!);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* drainFactory;
            const { children } = yield* stateOf(root);
            assert.lengthOf(children, 1);
            assert.deepStrictEqual(yield* demandsOf(root), []);
            const child = children[0]!;
            const author = yield* world.launched(child);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* authorCommits(author.worktreePath, "feat: export");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, child);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            const integrate = yield* awaitedRun(root);
            yield* factory.submitReview({
              threadId: integrate.threadId,
              review: passingReview(1),
            });
            yield* world.endRun(integrate.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");

            // Its pull request open, the slot goes; a round of feedback takes one slot again.
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isUndefined(yield* slotOf(root));
            const followed = author.threadId;
            yield* watchPullRequest(followed, yield* linkOf(followed, fakePullRequest.number));
            const wake = yield* wakeThroughGate(
              followed,
              yield* linkOf(followed, fakePullRequest.number),
            );
            assert.strictEqual(wake.outcome._tag, "Ran");
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* drainFactory;
            yield* world.endRun(wake.runId!, "completed");
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "running");
            const reviewer = yield* awaitedRun(root);
            yield* factory.submitReview({ threadId: reviewer.threadId, review: passingReview(1) });
            yield* world.endRun(reviewer.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");
            yield* tick;
            assert.isUndefined(yield* slotOf(root));
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isDefined(ref);
          }),
        options(spy),
      );
    },
    240_000,
  );
});

describe("a Factory assignment's controls on the real stack", () => {
  it.live("stops through Factory after its step, releases, and resumes through Factory", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          assert.strictEqual((yield* controlAssignment("export", "stop")).state, "stopping");
          assert.strictEqual(spy.count("stop"), 1);
          assert.strictEqual((yield* stateOf(root)).status, "stopping");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");

          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "stopped");
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });

          // A retry would replace what a resume keeps.
          assert.include(
            (yield* Effect.flip(controlAssignment("export", "retry"))).message,
            "Resume keeps",
          );
          const resumed = yield* controlAssignment("export", "resume");
          assert.strictEqual(resumed.state, "running");
          assert.strictEqual(spy.count("resume"), 1);
          assert.strictEqual(spy.count("start"), 1);
          yield* drainFactory;
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* reviewPasses(world, root);
          assert.strictEqual((yield* stateOf(root)).status, "pr_open");
        }),
      options(spy),
    );
  });

  it.live("a cancel with a refused interrupt holds the slot until the run ends", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          world.factoryDispatch.beforeInterrupt = () => Effect.die("Core refused the interrupt.");
          assert.strictEqual((yield* controlAssignment("export", "cancel")).state, "stopping");
          assert.strictEqual(spy.count("cancel"), 1);
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          assert.deepStrictEqual(spy.interrupted, []);
          yield* drainFactory;
          yield* drainOrchestration;

          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "stopping");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "ending",
            reason: "cancelled",
          });
          assert.isTrue(
            (yield* noticesOf("export")).some((note) =>
              note.includes("Stop it in the thread to finish cancelling"),
            ),
          );

          yield* world.endRun(author.runId, "completed");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          yield* assertNothingHeld(root, "export");
        }),
      options(spy),
    );
  });

  it.live("a cancel leaves a live run of unknown origin holding the slot until it ends", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          // An agent's message from a family thread: not shown to be the owner's or Factory's.
          const unknown = yield* agentSends(world.projectId, author.threadId, author.threadId);
          yield* controlAssignment("export", "cancel");
          yield* drainFactory;
          yield* world.endRun(author.runId, "cancelled");
          yield* drainOrchestration;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "stopping");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* world.endRun(unknown, "completed");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          yield* assertNothingHeld(root, "export");
        }),
      options(spy),
    );
  });

  it.live("answers reach only a live question of Factory's own running agent", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          const live = yield* asked(world, author.runId, "live");
          yield* tick;
          assert.isTrue(
            (yield* noticesOf("export")).some(
              (note) => note.includes(author.threadId) && note.includes(live),
            ),
          );
          yield* answer("export", live);
          yield* drainOrchestration;
          assert.lengthOf(
            world.provider.responded.filter((response) => response.requestId === live),
            1,
          );

          // Answering this one would start a turn; the owner answers it in its thread.
          const message = yield* asked(world, author.runId, "message");
          assert.include(
            (yield* Effect.flip(answer("export", message))).message,
            `Answer this one in thread ${author.threadId}`,
          );
          assert.lengthOf(
            world.provider.responded.filter((response) => response.requestId === message),
            0,
          );

          // A delegate's question is another thread's: it goes to that thread.
          const delegate = yield* delegateFrom(author.threadId, author.runId);
          const delegated = yield* asked(world, delegate.runId, "live");
          yield* answer("export", delegated);
          yield* drainOrchestration;
          assert.lengthOf(
            world.provider.responded.filter((response) => response.requestId === delegated),
            1,
          );
        }),
      options(spy),
    );
  });
});

describe("a Factory assignment revoked mid-delivery", () => {
  it.live("stops asking, blocks fresh work and goes on once restored and resumed", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          const record = { ran: [] as Array<string>, dropped: [] as Array<string> };

          yield* revise(world, "export", false);
          yield* tick;
          assert.strictEqual(spy.count("stop"), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "stopping");
          assert.isTrue(
            (yield* noticesOf("export")).some((note) => note.includes("is being stopped because")),
          );

          // Waiting work blocks and runs nothing; a continuation declines; a delegation refuses.
          const limit = turns.usageLimitResume(author.threadId, author.runId);
          assert.deepStrictEqual(
            yield* consult(limit, record),
            AutomaticTurnGate.notNow("deferred"),
          );
          assert.deepStrictEqual(
            (yield* demandsOf(root)).map(({ blockedReason }) => blockedReason),
            ["revoked"],
          );
          assert.deepStrictEqual(
            yield* consult(turns.restartContinuation(author.threadId, author.runId), record),
            AutomaticTurnGate.notNow("declined"),
          );
          assert.deepStrictEqual(
            yield* admission.admitDelegation({
              root,
              threadId: author.threadId,
              messageId: "mcp-delegation:revoked",
              work: { type: "unreadable" },
            }),
            { type: "refused", category: "revoked" },
          );
          assert.deepStrictEqual(record.ran, []);

          // The next effect refuses, and the delivery blocks with the fix named.
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const blocked = yield* stateOf(root);
          assert.strictEqual(blocked.status, "blocked");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
          assert.isUndefined(yield* slotOf(root));
          assert.include(
            (yield* Effect.flip(controlAssignment("export", "resume"))).message,
            "Not resumed",
          );
          assert.strictEqual(spy.count("resume"), 0);

          // Restored exactly, a resume unblocks what waited and goes on.
          yield* revise(world, "export", true);
          assert.strictEqual((yield* controlAssignment("export", "resume")).state, "running");
          assert.strictEqual(spy.count("resume"), 1);
          const [unblocked] = yield* demandsOf(root);
          assert.isDefined(unblocked);
          assert.isNull(unblocked?.blockedReason ?? null);
          yield* drainFactory;
          assert.notStrictEqual((yield* stateOf(root)).status, "blocked");

          // Unblocked ahead of the effect, the resume takes its grant, and the effect its holding.
          yield* tick;
          assert.strictEqual((yield* slotOf(root))?.state, "reserved");
          assert.deepStrictEqual(yield* consult(limit, record), AutomaticTurnGate.ran(undefined));
          assert.deepStrictEqual(record.ran, [limit.messageId]);
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* tick;
          yield* drainFactory;
          yield* reviewPasses(world, root);
          assert.strictEqual((yield* stateOf(root)).status, "pr_open");
        }),
      options(spy),
    );
  });
});

describe("a Factory assignment with no review receipt", () => {
  it.live("still retries into a new delivery once cancelled, as it always has", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          assert.notProperty(yield* stateOf(root), "reviewedExecution");
          yield* controlAssignment("export", "cancel");
          yield* drainFactory;
          yield* world.endRun(author.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");

          const retried = yield* controlAssignment("export", "retry");
          assert.strictEqual(retried.state, "queued");
          assert.strictEqual(retried.attempt, 2);
          yield* tick;
          assert.notStrictEqual(yield* rootIdOf("export"), root);
        }),
      options(spy),
    );
  });

  it.live("still takes a fresh assignment id once cancelled, starting it exactly once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const root = yield* claimed(world, "export");
          const author = yield* world.launched(root);
          yield* controlAssignment("export", "cancel");
          yield* drainFactory;
          yield* world.endRun(author.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");

          const fresh = {
            assignmentId: "export-again",
            projectId: world.projectId,
            ideaId: "export",
            executor: "factory",
            managerThreadId: assistantThread,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
            looperConfig: null,
          } as const;
          const assistant = yield* ProjectAssistant.ProjectAssistant;
          assert.strictEqual((yield* assistant.enqueue(fresh)).state, "queued");
          // A repeat of the same request is the same assignment.
          assert.strictEqual((yield* assistant.enqueue(fresh)).state, "queued");
          yield* tick;

          const started = yield* rootIdOf("export-again");
          assert.notStrictEqual(started, root);
          assert.notProperty(yield* stateOf(started), "reviewedExecution");
          const factory = yield* factoryService;
          assert.lengthOf(yield* factory.list({ projectId: world.projectId }), 2);
          assert.isFalse(
            yield* Effect.flatMap(HandoffAdmission.HandoffAdmission, (admission) =>
              admission.ideaReviewed({ projectId: world.projectId, ideaId: "export" }),
            ),
          );
        }),
      options(spy),
    );
  });
});
