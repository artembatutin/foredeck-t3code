import { assert, describe, it } from "@effect/vitest";
import type { RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { HandoffAdmission, ProjectAssistant } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
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
