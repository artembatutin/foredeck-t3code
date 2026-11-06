import { assert, describe, it, vi } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import {
  type WorkItemRef,
  type WorkItemSummary,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import {
  HandoffAdmission,
  HandoffBackend,
  ProjectAssistant,
  WorkCapture,
} from "../assistant/index.ts";
import type { WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  git,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  itemStatus,
  linkOf,
  reviewPasses,
  runStarted,
  syncPullRequest,
} from "./testkit/followThrough.ts";
import {
  admissionsOf,
  agree,
  agreeAndCapture,
  assertNothingHeld,
  assignmentOf,
  assignToFactory,
  assistantCaller,
  assistantThread,
  authorizeIdea,
  captureIdea,
  claimIdea,
  controlAssignment,
  demandsOf,
  failOutboxReads,
  failStartStep,
  freeOne,
  grantOutcomesOf,
  handoffRows,
  itemCount,
  linkOf as assignmentLink,
  managedRootOf,
  noticesOf,
  occupyBoth,
  ownerEdits,
  ownerRestores,
  parkAbsent,
  parkOrphan,
  queuePositionOf,
  restoreStartStep,
  rootIdOf,
  rootRowOf,
  runsOf,
  runToPullRequest,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  unreadableForAssistant,
  wakeThroughGate,
  writtenRows,
} from "./testkit/handoff.ts";

// Real Git, verify commands and rebuilt servers on every path: a loaded machine only takes longer,
// and nothing here waits on time, so the limit is just where a real hang fails.
vi.setConfig({ testTimeout: 240_000 });

/**
 * The whole handoff on the server's real stack: an idea discussed with the project assistant,
 * captured in real Markdown, authorized, queued and delivered through real Factory on temp Git
 * repositories with a fake provider and a fake PR service, down to its assignment's end. Each
 * assertion reads what the step left in the database, the provider or the port's calls. A restart
 * rebuilds every service over the one database, with core's startup recovery.
 */

const factoryService = Factory.FactoryService.FactoryService;

type Spy = ReturnType<typeof spyOnFactoryPort>;

const stack = (spy: Spy, extra: Parameters<typeof withProject>[2] = {}) => ({
  handoff: {},
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
  ...extra,
});

const ambiguous = () => Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "start" }));

/** Every delivery row of the item, as Factory holds them. */
const deliveriesOf = (ref: WorkItemRef) =>
  Effect.flatMap(factoryService, (factory) => factory.listByItem(ref)).pipe(
    Effect.map(({ deliveries }) => deliveries),
    Effect.orDie,
  );

/** The provider turns started on threads a launch of the root made. */
const launchesOf = (world: World, root: string) =>
  world.provider.started.filter(({ threadId }) => threadId.startsWith(`factory-thread:${root}:`));

const countOf = (table: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

/** How many slots are held or reserved, by anyone. */
const slotsInUse = countOf("fd_assistant_slots");

describe("a single item, from a discussion to its merge", () => {
  it.live(
    "is captured, authorized, claimed, delivered, followed up and merged, in that order",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            const factory = yield* factoryService;
            yield* startAssistantThread(world);

            // 1. Captured, and nothing else is created.
            yield* agree(world, "export");
            const items = yield* itemCount(world);
            const before = yield* writtenRows;
            const turnsBefore = world.provider.started.length;
            const captured = yield* captureIdea(world, "export");
            assert.strictEqual(captured.outcome, "created");
            assert.isTrue(captured.verified);
            assert.isFalse(captured.executionAuthorized);
            const ref = { sourceId: captured.item.sourceId, itemId: captured.item.itemId };
            assert.strictEqual(yield* itemCount(world), items + 1);
            assert.deepStrictEqual(yield* writtenRows, before);
            assert.strictEqual(world.provider.started.length, turnsBefore);
            assert.deepStrictEqual(yield* deliveriesOf(ref), []);
            assert.strictEqual(yield* countOf("fd_assistant_assignments"), 0);
            assert.strictEqual(yield* countOf("fd_assistant_factory_links"), 0);

            // 2. Refused until the owner authorizes it, leaving nothing behind.
            const refused = yield* Effect.flip(assignToFactory(world, "export"));
            assert.include(refused.message, "explicit execution authorization");
            assert.deepStrictEqual(yield* writtenRows, before);
            assert.strictEqual(yield* countOf("fd_assistant_assignments"), 0);
            assert.strictEqual(yield* countOf("fd_assistant_queue_positions"), 0);
            yield* authorizeIdea(world, "export");
            const queued = yield* assignToFactory(world, "export");
            assert.strictEqual(queued.state, "queued");
            assert.strictEqual(queued.executor, "factory");
            assert.deepStrictEqual(yield* assignmentLink("export"), {
              delivery_id: null,
              control: "none",
            });
            assert.isDefined(yield* queuePositionOf("export"));
            assert.deepStrictEqual(yield* deliveriesOf(ref), []);
            assert.strictEqual(spy.count("start"), 0);

            // 3. One claim: an active root, a held slot and one delivery under the intended id.
            yield* tick;
            const root = yield* rootIdOf("export");
            assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepStrictEqual(
              (yield* admissionsOf(root)).map(({ kind, state }) => ({ kind, state })),
              [{ kind: "claim", state: "dispatched" }],
            );
            assert.deepInclude(yield* grantOutcomesOf(root), { kind: "claim", outcome: "granted" });
            assert.deepStrictEqual(
              spy.calls.filter((call) => !call.startsWith("get:")),
              [`start:${root}`],
            );
            const author = yield* world.launched(root);
            assert.isTrue(author.threadId.startsWith(`factory-thread:${root}:`));
            const rows = yield* deliveriesOf(ref);
            assert.deepStrictEqual(
              rows.map(({ deliveryId }) => deliveryId),
              [root],
            );
            assert.strictEqual(yield* factory.familyRoot(author.threadId), root);
            assert.lengthOf(launchesOf(world, root), 1);
            // The dispatch's ordinary thread was never launched: no worker but Factory's.
            const { dispatches } = yield* assistant.inspect(world.projectId, "export");
            const ordinary = dispatches[0]?.threadId ?? assert.fail("The dispatch is gone.");
            assert.deepStrictEqual(
              world.provider.started.filter(({ threadId }) => threadId === ordinary),
              [],
            );
            assert.strictEqual((yield* assignmentOf("export")).state, "running");

            // Another assignment takes the other slot, and a third can only wait.
            const second = yield* claimIdea(world, "second");
            yield* agreeAndCapture(world, "third");
            yield* assignToFactory(world, "third");
            yield* tick;
            assert.strictEqual((yield* assignmentOf("third")).state, "queued");
            assert.strictEqual(yield* slotsInUse, 2);
            assert.strictEqual(spy.count("start"), 2);

            // 4. Its pull request opens: the owner's to merge, the slot goes, the third launches.
            const opened = yield* runToPullRequest(world, root);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* tick;
            const open = yield* assignmentOf("export");
            assert.strictEqual(open.state, "needs-input");
            assert.include(
              yield* noticesOf("export"),
              `PR ${fakePullRequest.url} open; review and merge.`,
            );
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
            assert.strictEqual((yield* assignmentOf("third")).state, "running");
            assert.strictEqual(spy.count("start"), 3);
            const third = yield* rootIdOf("third");
            assert.strictEqual((yield* slotOf(third))?.state, "held");
            assert.strictEqual(yield* slotsInUse, 2);

            // 5. Feedback with both slots taken: no run, one demand, however often it is asked.
            const thread = opened.threadId;
            const link = yield* linkOf(thread, fakePullRequest.number);
            const runs = (yield* runsOf(thread)).length;
            const turns = world.provider.started.length;
            for (const _ of [1, 2]) {
              const waiting = yield* wakeThroughGate(thread, link);
              assert.deepStrictEqual(waiting.outcome, AutomaticTurnGate.notNow("deferred"));
              assert.isUndefined(waiting.runId);
            }
            yield* tick;
            assert.strictEqual((yield* runsOf(thread)).length, runs);
            assert.strictEqual(world.provider.started.length, turns);
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ kind }) => kind),
              ["pull_request_wake"],
            );
            assert.isUndefined(yield* slotOf(root));
            assert.isTrue(
              (yield* noticesOf("export")).some(
                (note) =>
                  note.includes("Pull request feedback on") &&
                  note.includes("waiting for a project"),
              ),
            );

            // A slot frees: reserved for it, and the watch's next pass runs one round in that slot.
            yield* freeOne(world, second);
            assert.strictEqual((yield* slotOf(root))?.state, "reserved");
            assert.strictEqual((yield* runsOf(thread)).length, runs);
            const wake = yield* wakeThroughGate(thread, link);
            assert.strictEqual(wake.outcome._tag, "Ran");
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepStrictEqual(yield* demandsOf(root), []);
            assert.strictEqual(yield* slotsInUse, 2);
            yield* drainFactory;
            yield* world.endRun(wake.runId!, "completed");
            yield* reviewPasses(world, root);
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");
            assert.lengthOf(
              (yield* runsOf(thread)).filter((run) => run.userMessageId === wake.turn.messageId),
              1,
            );
            assert.strictEqual((yield* runsOf(thread)).length, runs + 1);
            // A round pushes to the pull request it has; it never opens a second one.
            const { branch } = yield* stateOf(root);
            assert.deepStrictEqual(
              world.pullRequestCalls
                .filter((call) => call.branch === branch)
                .map(({ input }) => input.action),
              ["create_pr", "push"],
            );
            yield* tick;
            assert.isUndefined(yield* slotOf(root));
            assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");

            // 6. Merged: Factory closes out and is done, but the assignment waits for quiescence.
            const restore = yield* failOutboxReads;
            yield* syncPullRequest(thread, yield* linkOf(thread, fakePullRequest.number), "merged");
            yield* drainFactory;
            assert.strictEqual((yield* stateOf(root)).status, "done");
            assert.strictEqual(yield* itemStatus(ref), "done");
            assert.lengthOf(world.worktreeRemovals, 1);
            assert.isFalse(yield* world.exists(author.worktreePath));
            yield* tick;
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "ending",
              reason: "completed",
            });
            assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
            yield* restore;

            yield* tick;
            const ended = yield* assignmentOf("export");
            assert.strictEqual(ended.state, "completed");
            const row = yield* rootRowOf(root);
            assert.deepStrictEqual(
              { state: row.state, reason: row.reason },
              { state: "retired", reason: "completed" },
            );
            assert.isNotNull(row.ending_at);
            assert.isNotNull(row.retired_at);
            yield* assertNothingHeld(root, "export");
            assert.deepStrictEqual(yield* slotOf(root), undefined);
            const { assignments } = yield* assistant.inspect(world.projectId, "export");
            assert.isTrue(
              assignments[0]?.evidence.some((line) => line.includes(fakePullRequest.url)),
            );
            // Nothing Factory did was the assistant's to call: only the one start.
            assert.deepStrictEqual(
              spy.calls.filter((call) => call.endsWith(root) && !call.startsWith("get:")),
              [`start:${root}`],
            );
            assert.lengthOf(yield* deliveriesOf(ref), 1);
          }),
        stack(spy, { limits: { maxReviewRounds: 10 } }),
      );
    },
    300_000,
  );
});

/** A root claimed and run to its open pull request, its slot let go by a tick. */
const atOpenPullRequest = (world: World, idea: string) =>
  Effect.gen(function* () {
    const { ref, root } = yield* claimIdea(world, idea);
    const opened = yield* runToPullRequest(world, root);
    yield* tick;
    assert.isUndefined(yield* slotOf(root));
    return { ref, root, thread: opened.threadId, opened };
  });

describe("what a pull request's end and a refused interrupt leave", () => {
  it.live("a pull request closed unmerged cancels only once the family is quiet", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root, thread } = yield* atOpenPullRequest(world, "export");

          // Feedback is running as a round, counted under its slot, when the close arrives.
          const link = yield* linkOf(thread, fakePullRequest.number);
          const wake = yield* wakeThroughGate(thread, link);
          assert.strictEqual(wake.outcome._tag, "Ran");
          yield* runStarted(wake.runId!);
          yield* drainFactory;
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          // Its agent goes on past the close, as a turn does whose interrupt core refused.
          world.factoryDispatch.beforeInterrupt = () => Effect.die("Core refused the interrupt.");
          yield* syncPullRequest(thread, link, "closed");
          yield* drainFactory;
          yield* drainOrchestration;
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          // Factory ended it; the assistant only follows, and the item is as the owner left it.
          assert.strictEqual(spy.count("cancel"), 0);
          assert.strictEqual(yield* itemStatus(ref), "todo");

          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "ending",
            reason: "cancelled",
          });
          assert.strictEqual((yield* slotOf(root))?.state, "held");

          yield* world.endRun(wake.runId!, "cancelled");
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
          assert.lengthOf(yield* deliveriesOf(ref), 1);
        }),
      stack(spy),
    );
  });

  it.live("a cancel whose interrupt core refused holds the slot until the run ends", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* claimIdea(world, "export");
          const author = yield* world.launched(root);
          world.factoryDispatch.beforeInterrupt = () => Effect.die("Core refused the interrupt.");

          assert.strictEqual((yield* controlAssignment("export", "cancel")).state, "stopping");
          assert.strictEqual(spy.count("cancel"), 1);
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          yield* drainFactory;
          yield* drainOrchestration;
          assert.deepStrictEqual(world.provider.interrupted, []);

          // Factory is cancelled, its author still works: the slot stays, and the wait is said.
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
          world.factoryDispatch.beforeInterrupt = undefined;

          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });
          yield* assertNothingHeld(root, "export");
        }),
      stack(spy),
    );
  });
});

/** Work's `createItem`, which a test holds before or after the real create. */
const createControl = () => {
  const control: {
    hold: ((created?: WorkItemSummary) => Effect.Effect<void>) | undefined;
    refuse: boolean;
  } = { hold: undefined, refuse: false };
  const missing = WorkSourceId.make("99999999-9999-4999-8999-999999999999");
  const wrap = (
    service: WorkService.WorkService["Service"],
  ): WorkService.WorkService["Service"] => ({
    ...service,
    createItem: (actor, input) =>
      control.refuse
        ? Effect.suspend(() => control.hold?.() ?? Effect.void).pipe(
            Effect.andThen(service.createItem(actor, { ...input, sourceId: missing })),
          )
        : service
            .createItem(actor, input)
            .pipe(
              Effect.tap((created) => Effect.suspend(() => control.hold?.(created) ?? Effect.void)),
            ),
  });
  return { control, wrap };
};

/** Holds the source write until the server's shutdown interrupts its writer. */
const untilShutdown = (entered: Deferred.Deferred<void>) =>
  Deferred.succeed(entered, undefined).pipe(
    Effect.andThen(Effect.exit(Effect.interruptible(Effect.never))),
    Effect.asVoid,
  );

/** Exactly one captured item with the idea's marker, and exactly one delivery under its root. */
const exactlyOne = (world: World, idea: string) =>
  Effect.gen(function* () {
    const ref = yield* authorizedAndAssigned(world, idea);
    yield* tick;
    const root = yield* rootIdOf(idea);
    const author = yield* world.launched(root);
    assert.lengthOf(yield* deliveriesOf(ref), 1);
    assert.lengthOf(launchesOf(world, root), 1);
    yield* world.endRun(author.runId, "completed");
  });

/** The idea's capture read back from the assistant, authorized by the owner and queued. */
const authorizedAndAssigned = (world: World, idea: string) =>
  Effect.gen(function* () {
    yield* authorizeIdea(world, idea);
    yield* assignToFactory(world, idea);
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly source_id: string;
      readonly item_id: string;
    }>`SELECT source_id, item_id FROM fd_assistant_work_captures WHERE idea_id = ${idea}`;
    return {
      sourceId: WorkSourceId.make(row?.source_id ?? assert.fail("Nothing was captured.")),
      itemId: row?.item_id ?? assert.fail("The capture names no item."),
    } as WorkItemRef;
  }).pipe(Effect.orDie);

describe("a capture cut at each seam, with its services rebuilt", () => {
  it.live("cut before its write, it creates once with the same marker", () => {
    const spy = spyOnFactoryPort();
    const { control, wrap } = createControl();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agree(world, "export");
          const items = yield* itemCount(world);
          const entered = yield* Deferred.make<void>();
          control.refuse = true;
          control.hold = () => untilShutdown(entered);
          yield* captureIdea(world, "export").pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* world.rebuild(
            Effect.gen(function* () {
              control.refuse = false;
              control.hold = undefined;
              const captured = yield* captureIdea(world, "export");
              assert.strictEqual(captured.outcome, "created");
              assert.strictEqual(yield* itemCount(world), items + 1);
              yield* exactlyOne(world, "export");
              assert.strictEqual(yield* itemCount(world), items + 1);
            }),
            { orchestration: true },
          );
        }),
      stack(spy, { work: wrap }),
    );
  });

  it.live("cut after its write, it adopts the one item it finds and writes no other", () => {
    const spy = spyOnFactoryPort();
    const { control, wrap } = createControl();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agree(world, "export");
          const items = yield* itemCount(world);
          const entered = yield* Deferred.make<void>();
          control.hold = () => untilShutdown(entered);
          yield* captureIdea(world, "export").pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* world.rebuild(
            Effect.gen(function* () {
              control.hold = undefined;
              const captured = yield* captureIdea(world, "export");
              assert.strictEqual(captured.outcome, "recovered");
              assert.isTrue(captured.verified);
              assert.strictEqual(yield* itemCount(world), items + 1);
              yield* exactlyOne(world, "export");
              assert.strictEqual(yield* itemCount(world), items + 1);
            }),
            { orchestration: true },
          );
        }),
      stack(spy, { work: wrap }),
    );
  });

  it.live("a write whose record failed is recorded later, with no second item", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* startAssistantThread(world);
          yield* agree(world, "export");
          const items = yield* itemCount(world);
          yield* sql`CREATE TRIGGER capture_record_fails BEFORE UPDATE ON fd_assistant_work_captures
            WHEN NEW.state = 'captured'
            BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
          assert.isTrue(
            (yield* Effect.exit(captureIdea(world, "export")))._tag === "Failure",
            "The capture reported success with no record.",
          );
          assert.strictEqual(yield* itemCount(world), items + 1);
          yield* sql`DROP TRIGGER capture_record_fails`;

          yield* world.rebuild(
            Effect.gen(function* () {
              const captured = yield* captureIdea(world, "export");
              assert.strictEqual(captured.outcome, "recovered");
              assert.strictEqual(yield* itemCount(world), items + 1);
              yield* exactlyOne(world, "export");
              assert.strictEqual(yield* itemCount(world), items + 1);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a read-back that fails queues nothing until a read confirms the same item", () => {
    const spy = spyOnFactoryPort();
    const failing = { on: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agree(world, "export");
          const items = yield* itemCount(world);
          failing.on = true;
          const captured = yield* captureIdea(world, "export");
          failing.on = false;
          assert.strictEqual(captured.outcome, "created");
          assert.isFalse(captured.verified);

          // Nothing confirmed what the item says, so nothing can be queued from it yet.
          yield* authorizeIdea(world, "export");
          const refused = yield* Effect.flip(assignToFactory(world, "export"));
          assert.include(refused.message, "No read has confirmed");
          assert.strictEqual(yield* countOf("fd_assistant_assignments"), 0);

          yield* world.rebuild(
            Effect.gen(function* () {
              const again = yield* captureIdea(world, "export");
              assert.strictEqual(again.item.itemId, captured.item.itemId);
              assert.isTrue(again.verified);
              assert.strictEqual(yield* itemCount(world), items + 1);
              yield* exactlyOne(world, "export");
              assert.strictEqual(yield* itemCount(world), items + 1);
            }),
            { orchestration: true },
          );
        }),
      stack(spy, { work: unreadableForAssistant(failing) }),
    );
  });
});

describe("a dispatch cut at each seam, with its services rebuilt", () => {
  /**
   * What the seam ended with: one delivery under the root and one author's thread, however it came.
   * A restart cuts an author's turn already running, so its delivery blocks for its owner, and a
   * resume goes on from that same thread. Nothing here launches another.
   */
  const converged = (world: World, ref: WorkItemRef, root: FactoryDeliveryId) =>
    Effect.gen(function* () {
      yield* drainOrchestration;
      yield* drainFactory;
      if ((yield* stateOf(root)).status === "blocked") {
        yield* tick;
        assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
        yield* controlAssignment("export", "resume");
        yield* drainFactory;
        yield* tick;
      }
      const { awaiting } = yield* stateOf(root);
      if (awaiting?.type === "run") yield* runStarted(awaiting.runId);
      assert.deepStrictEqual(
        (yield* deliveriesOf(ref)).map(({ deliveryId }) => deliveryId),
        [root],
      );
      assert.lengthOf([...new Set(launchesOf(world, root).map(({ threadId }) => threadId))], 1);
      assert.strictEqual(yield* rootIdOf("export"), root);
      assert.strictEqual((yield* assignmentOf("export")).state, "running");
      assert.strictEqual((yield* slotOf(root))?.state, "held");
    });

  it.live("a crash between the claim and its start starts the same id once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const root = FactoryDeliveryId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b21");
          yield* admission.claim({ assignmentId: "export", deliveryId: root });
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.deepStrictEqual(
                spy.calls.filter((call) => call.startsWith("start:")),
                [`start:${root}`],
              );
              yield* converged(world, ref, root);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a crash between the insert and its start step starts the orphan once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          yield* failStartStep;
          yield* tick;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* stateOf(root)).status, "queued");
          assert.strictEqual((yield* assignmentOf("export")).state, "launching");
          yield* restoreStartStep;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              // Started by its start, never its resume, under the same id.
              assert.strictEqual(spy.count("resume"), 0);
              assert.strictEqual(spy.count("start"), 2);
              yield* converged(world, ref, root);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a start whose reply was lost is adopted, with no second delivery", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          // The start's row and step commit; the reply never comes, and the read after it fails too.
          spy.control.onStart = (_input, start) => Effect.andThen(start, ambiguous());
          spy.control.failGet = true;
          yield* tick;
          spy.control.onStart = undefined;
          spy.control.failGet = false;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* assignmentOf("export")).state, "launch-uncertain");
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          yield* drainFactory;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.strictEqual(spy.count("start"), 1);
              yield* converged(world, ref, root);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a failing read keeps the slot across the rebuild, then the same id starts once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          spy.control.onStart = ambiguous;
          spy.control.failGet = true;
          yield* tick;
          spy.control.onStart = undefined;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* assignmentOf("export")).state, "launch-uncertain");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          const starts = spy.count("start");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.strictEqual(spy.count("start"), starts);
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              spy.control.failGet = false;
              yield* tick;
              assert.strictEqual(spy.count("start"), starts + 1);
              yield* converged(world, ref, root);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a mirror that failed after the start is written by the next pass", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          yield* sql`CREATE TRIGGER mirror_fails BEFORE UPDATE ON fd_assistant_assignments
            WHEN NEW.state = 'running'
            BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
          yield* tick.pipe(Effect.exit);
          const root = yield* rootIdOf("export");
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "launching");
          yield* sql`DROP TRIGGER mirror_fails`;
          yield* drainFactory;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.strictEqual(spy.count("start"), 1);
              yield* converged(world, ref, root);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("a known refusal with no row fails, and a retry is the only new delivery", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          spy.control.onStart = () =>
            Effect.fail(
              new HandoffBackend.HandoffFactoryRefused({
                operation: "start",
                reason: "no_base_commit",
              }),
            );
          yield* tick;
          spy.control.onStart = undefined;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          yield* assertNothingHeld(root, "export");
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.deepStrictEqual(yield* deliveriesOf(ref), []);
              yield* controlAssignment("export", "retry");
              yield* tick;
              const next = yield* rootIdOf("export");
              assert.notStrictEqual(next, root);
              yield* converged(world, ref, next);
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("repeated and concurrent requests take one assignment, claim and delivery", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          const assigned = yield* Effect.all(
            [assignToFactory(world, "export"), assignToFactory(world, "export")],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(assigned[0].assignmentId, assigned[1].assignmentId);
          yield* Effect.all([tick, tick], { concurrency: "unbounded" });
          const root = yield* rootIdOf("export");
          assert.strictEqual(spy.count("start"), 1);
          assert.strictEqual(yield* countOf("fd_assistant_managed_roots"), 1);
          yield* drainFactory;

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* assignToFactory(world, "export");
              yield* tick;
              assert.strictEqual(spy.count("start"), 1);
              yield* converged(world, ref, root);
            }),
          );
        }),
      stack(spy),
    );
  });
});

describe("authority that no longer holds at a delivery's opening", () => {
  it.live(
    "revoked after the orphan's insert: one cancelled row, no author, and the notice",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const ref = yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            yield* failStartStep;
            yield* tick;
            const root = yield* rootIdOf("export");
            assert.strictEqual((yield* stateOf(root)).status, "queued");
            yield* authorizeIdea(world, "export", false);
            yield* restoreStartStep;

            const settled = Effect.gen(function* () {
              assert.strictEqual(spy.count("cancel"), 1);
              assert.strictEqual(spy.count("resume"), 0);
              assert.strictEqual((yield* stateOf(root)).status, "cancelled");
              assert.lengthOf(yield* deliveriesOf(ref), 1);
              assert.lengthOf(launchesOf(world, root), 0);
              assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
              assert.deepStrictEqual(yield* managedRootOf(root), {
                state: "retired",
                reason: "cancelled",
              });
              yield* assertNothingHeld(root, "export");
              assert.lengthOf(
                (yield* noticesOf("export")).filter((note) =>
                  note.startsWith(
                    `Factory delivery ${root} was cancelled before it started because`,
                  ),
                ),
                1,
              );
            });

            yield* tick;
            // The cancel holds the claim's slot and row until the family is known to be quiet.
            assert.strictEqual((yield* assignmentOf("export")).state, "stopping");
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* tick;
            yield* settled;
            yield* tick;
            yield* settled;
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* tick;
                yield* settled;
                yield* world.rebuild(
                  Effect.gen(function* () {
                    yield* tick;
                    yield* settled;
                  }),
                  { orchestration: true },
                );
              }),
            );
          }),
        stack(spy),
      );
    },
    240_000,
  );

  it.live("an item edited before its claim's start gets no start and no opening", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          yield* ownerEdits(ref);
          yield* tick;
          const root = yield* rootIdOf("export");
          assert.strictEqual(spy.count("start"), 0);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          yield* assertNothingHeld(root, "export");
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          assert.lengthOf(launchesOf(world, root), 0);
        }),
      stack(spy),
    );
  });

  it.live("an item edited after its launch was admitted gets no opening and blocks", () => {
    const spy = spyOnFactoryPort();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const hold = { armed: false };
      yield* withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const ref = yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            hold.armed = true;
            yield* tick;
            yield* Deferred.await(entered);
            hold.armed = false;
            const root = yield* rootIdOf("export");

            yield* ownerEdits(ref);
            yield* Deferred.succeed(go, undefined);
            yield* drainFactory;
            yield* drainOrchestration;

            const state = yield* stateOf(root);
            assert.strictEqual(state.status, "blocked");
            if (state.block?.reason !== "effect_failed") {
              return assert.fail("The launch did not fail.");
            }
            assert.include(
              state.block.detail,
              Factory.FactoryAdmission.admissionRefusalText.scope_changed,
            );
            assert.lengthOf(launchesOf(world, root), 0);
            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "needs-input");
            assert.isUndefined(yield* slotOf(root));

            // Put back as it was, a resume opens it once; nothing rebinds to the edit.
            yield* ownerRestores(ref);
            yield* controlAssignment("export", "resume");
            const author = yield* world.launched(root);
            assert.lengthOf(launchesOf(world, root), 1);
            yield* world.endRun(author.runId, "completed");
          }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
        stack(spy, {
          handoff: {
            probe: {
              admitted: (admitted) =>
                Effect.suspend(() =>
                  hold.armed && admitted.kind === "effect"
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(go)))
                    : Effect.void,
                ),
              released: () => Effect.void,
              observed: () => Effect.void,
            },
          },
        }),
      );
    });
  });
});

describe("what the handoff refuses, writing nothing", () => {
  it.live("a multi-repository project is refused at enqueue and never claimed", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projects = yield* ProjectService.ProjectService;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "queued-first");
          yield* assignToFactory(world, "queued-first");
          yield* agreeAndCapture(world, "export");

          // The project gains a second repository, with one assignment already queued.
          const other = path.join(path.dirname(world.root), "beta");
          yield* fileSystem.makeDirectory(other);
          yield* git(other, ["init", "-b", "main"]);
          yield* projects.update({
            commandId: "add-repository" as never,
            projectId: world.projectId,
            repositories: [
              { name: "Alpha", rootPath: world.root },
              { name: "Beta", rootPath: other },
            ],
          });

          const before = yield* writtenRows;
          const refused = yield* Effect.flip(assignToFactory(world, "export"));
          assert.include(refused.message, "Multi-repository");
          assert.deepStrictEqual(yield* writtenRows, before);
          assert.strictEqual(yield* countOf("fd_assistant_assignments"), 1);

          // What was queued before is not eligible while the project stays that way.
          yield* tick;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("queued-first")).state, "queued");
          assert.strictEqual(spy.count("start"), 0);
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          assert.strictEqual(yield* countOf("fd_assistant_managed_roots"), 0);
          assert.strictEqual(yield* slotsInUse, 0);
        }),
      stack(spy),
    );
  });

  it.live("a parent of a tracker source is refused, naming the supported paths", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const captures = yield* WorkCapture.WorkCapture;
          yield* startAssistantThread(world);
          yield* agree(world, "export");
          // A GitHub source beside the project's Markdown one, as settings store it.
          const [source] = yield* sql<Record<string, unknown>>`
            SELECT * FROM fd_work_sources WHERE source_id = ${world.itemRef.sourceId}`;
          const issues = WorkSourceId.make("11111111-1111-4111-8111-111111111111");
          yield* sql`INSERT INTO fd_work_sources ${sql.insert({
            ...source,
            source_id: issues,
            kind: "github",
            label: "Issues",
            config_json: JSON.stringify({
              kind: "github",
              host: "github.com",
              owner: "acme",
              name: "app",
            }),
          })}`;

          const before = yield* writtenRows;
          const items = yield* itemCount(world);
          const refused = yield* Effect.flip(
            captures.capture({
              caller: assistantCaller,
              projectId: world.projectId,
              ideaId: "export",
              kind: "parent",
              sourceId: issues,
            }),
          );
          assert.strictEqual(refused._tag, "WorkCaptureRefused");
          assert.include(refused.message, "Capture it as single");
          assert.include(refused.message, String(world.itemRef.sourceId));
          assert.deepStrictEqual(yield* writtenRows, before);
          assert.strictEqual(yield* itemCount(world), items);
          assert.strictEqual(yield* countOf("fd_assistant_work_captures"), 0);
          assert.strictEqual(yield* countOf("fd_assistant_assignments"), 0);
          assert.strictEqual(spy.count("start"), 0);

          // Named no source among several, it asks which rather than choose.
          const ambiguousSource = yield* Effect.flip(captureIdea(world, "export"));
          assert.include(ambiguousSource.message, "several Work sources");
          assert.strictEqual(yield* countOf("fd_assistant_work_captures"), 0);
        }),
      stack(spy),
    );
  });
});

describe("assignments of the other executors, beside a Factory one", () => {
  it.live("an ordinary assignment launches, counts and cancels as it always has", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const assistant = yield* ProjectAssistant.ProjectAssistant;
          yield* startAssistantThread(world);
          yield* assistant.revise({
            projectId: world.projectId,
            ideaId: "plain",
            patch: {
              goal: "Deliver plain",
              acceptanceCriteria: ["Check plain"],
              executionAuthorized: true,
            },
          });
          const assign = (assignmentId: string) =>
            assistant.enqueue({
              assignmentId,
              projectId: world.projectId,
              ideaId: "plain",
              managerThreadId: assistantThread,
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              looperConfig: null,
            });
          const queued = yield* assign("plain-1");
          assert.strictEqual(queued.executor, "foredeck");
          yield* tick;
          yield* drainOrchestration;

          // An ordinary worker thread, under no root, link, slot or admission of the handoff.
          const launched = yield* assignmentOf("plain-1");
          assert.include(["running", "launching"], launched.state);
          const { dispatches } = yield* assistant.inspect(world.projectId, "plain");
          const worker = dispatches[0]?.threadId ?? assert.fail("The dispatch is gone.");
          yield* runStarted(
            (yield* runsOf(worker))[0]?.id ?? assert.fail("The worker has no run."),
          );
          assert.lengthOf(
            world.provider.started.filter(({ threadId }) => threadId === worker),
            1,
          );
          assert.strictEqual(yield* countOf("fd_assistant_factory_links"), 0);
          assert.strictEqual(yield* countOf("fd_assistant_managed_roots"), 0);
          assert.strictEqual(yield* slotsInUse, 0);
          assert.strictEqual(spy.count("start"), 0);

          // It is counted by its state, so one Factory assignment takes the one slot left.
          const factory = yield* claimIdea(world, "export");
          assert.strictEqual((yield* slotOf(factory.root))?.state, "held");
          yield* agreeAndCapture(world, "third");
          yield* assignToFactory(world, "third");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("third")).state, "queued");

          // Stopped, it holds nothing, and its cancel is immediate, with no Factory call.
          yield* controlAssignment("plain-1", "stop");
          const turn = world.provider.started.find(({ threadId }) => threadId === worker);
          yield* world.provider.endTurn(turn!, "cancelled");
          yield* drainOrchestration;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("plain-1")).state, "stopped");
          assert.strictEqual((yield* assignmentOf("third")).state, "running");
          yield* controlAssignment("plain-1", "cancel");
          assert.strictEqual((yield* assignmentOf("plain-1")).state, "cancelled");
          assert.strictEqual(spy.count("cancel"), 0);
          // A rebuilt assistant reconciles it no further.
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.strictEqual((yield* assignmentOf("plain-1")).state, "cancelled");
            }),
          );
        }),
      stack(spy),
    );
  });
});

/** The grant history's newest number, for counting the grants made after it. */
const historyMark = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly mark: number | null }>`SELECT MAX(grant_number) AS mark
    FROM fd_assistant_grant_history`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]?.mark ?? 0),
);

/** How many grants the fair order made after `mark` and before the assignment's own claim. */
const grantsBeforeClaim = (assignmentId: string, mark: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly passed: number }>`SELECT COUNT(*) AS passed
      FROM fd_assistant_grant_history
      WHERE outcome = 'granted' AND grant_number > ${mark} AND grant_number < (
        SELECT MIN(grant_number) FROM fd_assistant_grant_history
        WHERE assignment_id = ${assignmentId} AND kind = 'claim' AND outcome = 'granted'
          AND grant_number > ${mark}
      )`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.passed ?? assert.fail("It was never claimed.")),
  );

describe("fair progress against two feedback-heavy roots", () => {
  it.live(
    "a waiting assignment is claimed within the bound, each feedback round running in one slot",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* startAssistantThread(world);
            const rank = (idea: string, value: number) =>
              assistant
                .revise({
                  projectId: world.projectId,
                  ideaId: idea,
                  patch: { priority: { rank: value, reason: "Ranked for the test." } },
                })
                .pipe(Effect.orDie);
            const feedback = [];
            for (const idea of ["first", "second"]) {
              yield* agreeAndCapture(world, idea);
              yield* rank(idea, 1);
              yield* assignToFactory(world, idea);
              yield* tick;
              const root = yield* rootIdOf(idea);
              const opened = yield* runToPullRequest(world, root);
              yield* tick;
              assert.isUndefined(yield* slotOf(root));
              feedback.push({ idea, root, thread: opened.threadId });
            }
            // Ranked behind every wake, so only the fair order's bound can bring it through.
            yield* agreeAndCapture(world, "third");
            yield* rank("third", 9);
            yield* assignToFactory(world, "third");
            const mark = yield* historyMark;
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const { candidates } = yield* admission.next;
            const own = yield* queuePositionOf("third");
            // Nothing waits ahead of it, so W is none.
            assert.lengthOf(
              candidates.filter(({ seq }) => seq < (own?.seq ?? 0)),
              0,
            );

            let rounds = 0;
            for (let pass = 0; pass < 16; pass += 1) {
              if ((yield* assignmentOf("third")).state !== "queued") break;
              for (const { root, thread } of feedback) {
                // Each round's feedback arrives whether or not a slot is there for it.
                const link = yield* linkOf(thread, fakePullRequest.number);
                const wake = yield* wakeThroughGate(thread, link);
                if (wake.outcome._tag !== "Ran") continue;
                assert.strictEqual((yield* slotOf(root))?.state, "held");
                rounds += 1;
                yield* drainFactory;
                yield* world.endRun(wake.runId!, "completed");
                yield* reviewPasses(world, root);
                assert.strictEqual((yield* stateOf(root)).status, "pr_open");
              }
              assert.isAtMost(yield* slotsInUse, 2);
              yield* tick;
              assert.isAtMost(yield* slotsInUse, 2);
            }
            assert.notStrictEqual((yield* assignmentOf("third")).state, "queued");
            // Nothing waited before it, so at most K grants pass it and the next is its own.
            assert.isAtMost(yield* grantsBeforeClaim("third", mark), 2);
            assert.isAtLeast(rounds, 1);
            const third = yield* rootIdOf("third");
            assert.strictEqual((yield* slotOf(third))?.state, "held");
            assert.lengthOf(launchesOf(world, third), 0);
            yield* world.launched(third);
            assert.lengthOf(launchesOf(world, third), 1);
          }),
        stack(spy, { limits: { maxReviewRounds: 10, maxFixRounds: 10 } }),
      );
    },
    300_000,
  );
});

/** Everything a pre-start step must leave as it found it. */
const preStartRows = (assignmentId: string) =>
  Effect.gen(function* () {
    return {
      rows: yield* handoffRows,
      assignment: yield* assignmentOf(assignmentId),
      link: yield* assignmentLink(assignmentId),
      position: yield* queuePositionOf(assignmentId),
    };
  });

/** The calls of the assistant's Factory port that move a delivery, leaving its reads out. */
const moves = (spy: Spy) => spy.calls.filter((call) => !call.startsWith("get:"));

describe("a stop before the first start", () => {
  it.live(
    "parks once a start held out ends ambiguously: absent, unasked and released, the same root kept",
    () => {
      const spy = spyOnFactoryPort();
      return Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        yield* withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              yield* startAssistantThread(world);
              const ref = yield* agreeAndCapture(world, "export");
              yield* assignToFactory(world, "export");
              spy.control.onStart = () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(go)),
                  Effect.andThen(ambiguous()),
                );
              const ticking = yield* tick.pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              const root = yield* rootIdOf("export");

              // While the start is out, the claim holds its slot and its row dispatching.
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatching");
              // A stop waits for the claim, which holds the assistant's lock from commit to start.
              const stopping = yield* controlAssignment("export", "stop").pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              assert.strictEqual((yield* assignmentLink("export")).control, "none");
              assert.lengthOf(yield* admissionsOf(root), 1);

              yield* Deferred.succeed(go, undefined);
              yield* Fiber.join(ticking);
              spy.control.onStart = undefined;
              const stopped = yield* Fiber.join(stopping);
              assert.strictEqual(stopped.state, "stopped");

              // The delivery is strictly absent, and Factory was asked nothing but that one start.
              assert.isTrue(Option.isNone(yield* (yield* factoryService).get(root)));
              assert.deepStrictEqual(yield* deliveriesOf(ref), []);
              assert.deepStrictEqual(moves(spy), [`start:${root}`]);
              assert.isUndefined(yield* slotOf(root));
              assert.deepStrictEqual(yield* admissionsOf(root), []);
              assert.deepStrictEqual(yield* demandsOf(root), []);
              assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
              assert.deepStrictEqual(yield* assignmentLink("export"), {
                delivery_id: root,
                control: "stop",
              });
              assert.isTrue(
                (yield* noticesOf("export")).some((note) =>
                  note.startsWith(`Stopped before Factory started delivery ${root}.`),
                ),
              );
              assert.lengthOf(launchesOf(world, root), 0);

              // Repeated passes, a repeated stop and a rebuild change nothing.
              const parked = yield* preStartRows("export");
              yield* tick;
              yield* tick;
              yield* controlAssignment("export", "stop");
              assert.deepStrictEqual(yield* preStartRows("export"), parked);
              yield* world.rebuild(
                Effect.gen(function* () {
                  yield* tick;
                  yield* tick;
                  assert.deepStrictEqual(yield* preStartRows("export"), parked);
                  assert.deepStrictEqual(moves(spy), [`start:${root}`]);
                  assert.lengthOf(launchesOf(world, root), 0);
                }),
                { orchestration: true },
              );
            }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
          stack(spy),
        );
      });
    },
    240_000,
  );

  it.live("parks a queued orphan with its row queued, unasked, across ticks and a rebuild", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkOrphan(world, "export");
          assert.deepStrictEqual(
            (yield* deliveriesOf(ref)).map(({ deliveryId }) => deliveryId),
            [root],
          );
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* admissionsOf(root), []);
          assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
          assert.deepStrictEqual(moves(spy), [`start:${root}`]);
          assert.isTrue(
            (yield* noticesOf("export")).some((note) =>
              note.startsWith(`Stopped before Factory started delivery ${root}.`),
            ),
          );
          const parked = yield* preStartRows("export");
          const check = Effect.gen(function* () {
            yield* tick;
            yield* tick;
            assert.deepStrictEqual(yield* preStartRows("export"), parked);
            assert.strictEqual((yield* stateOf(root)).status, "queued");
            assert.deepStrictEqual(moves(spy), [`start:${root}`]);
            assert.lengthOf(launchesOf(world, root), 0);
          });
          yield* check;
          yield* world.rebuild(check, { orchestration: true });
        }),
      stack(spy),
    );
  });

  it.live("two parked roots, one absent and one a queued orphan, leave a third its claim", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          const absent = yield* parkAbsent(world, spy, "absent");
          const orphan = yield* parkOrphan(world, "orphan");
          assert.strictEqual((yield* stateOf(orphan.root)).status, "queued");
          assert.strictEqual((yield* admission.next).free, 2);
          assert.strictEqual(yield* slotsInUse, 0);
          assert.deepStrictEqual(yield* deliveriesOf(absent.ref), []);

          const third = yield* claimIdea(world, "third");
          const author = yield* world.launched(third.root);
          assert.strictEqual((yield* assignmentOf("third")).state, "running");
          assert.strictEqual((yield* slotOf(third.root))?.state, "held");
          assert.lengthOf(launchesOf(world, third.root), 1);
          // Neither took a turn, and each stays as it was parked.
          for (const { root, idea } of [
            { root: absent.root, idea: "absent" },
            { root: orphan.root, idea: "orphan" },
          ]) {
            assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
            assert.isUndefined(yield* slotOf(root));
            assert.lengthOf(launchesOf(world, root), 0);
          }
          yield* world.endRun(author.runId, "completed");
        }),
      stack(spy),
    );
  });
});

describe("a resume of a root parked before its first start", () => {
  const branches = [
    { name: "absent", park: parkAbsent },
    { name: "a queued orphan", park: null },
  ] as const;

  it.live.each(branches)(
    "$name waits for a fair grant under two held slots, and one counted re-claim starts it once",
    ({ park }) => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } =
              park === null
                ? yield* parkOrphan(world, "export")
                : yield* park(world, spy, "export");
            const others = yield* occupyBoth(world);
            const starts = spy.count("start");
            const before = (yield* queuePositionOf("export"))?.seq ?? 0;

            const resumed = yield* controlAssignment("export", "resume");
            assert.strictEqual(resumed.state, "queued");
            assert.strictEqual((yield* assignmentLink("export")).control, "none");
            assert.isAbove((yield* queuePositionOf("export"))?.seq ?? 0, before);
            assert.isTrue(
              (yield* noticesOf("export")).some((note) =>
                note.includes(`Factory delivery ${root} starts once it gets`),
              ),
            );

            // Both slots held by other work: no re-claim, start or run, however often it looks.
            yield* tick;
            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "queued");
            assert.strictEqual(spy.count("start"), starts);
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(yield* admissionsOf(root), []);
            assert.lengthOf(launchesOf(world, root), 0);
            assert.strictEqual(yield* slotsInUse, 2);

            yield* freeOne(world, others[0]!);
            assert.strictEqual(yield* rootIdOf("export"), root);
            assert.strictEqual(spy.count("start"), starts + 1);
            assert.strictEqual(spy.count("resume"), 0);
            assert.strictEqual(spy.count("stop"), 0);
            assert.strictEqual(spy.count("cancel"), 0);
            assert.deepInclude(yield* grantOutcomesOf(root), { kind: "claim", outcome: "granted" });
            const author = yield* world.launched(root);
            assert.deepStrictEqual(
              (yield* deliveriesOf(ref)).map(({ deliveryId }) => deliveryId),
              [root],
            );
            assert.lengthOf(launchesOf(world, root), 1);
            assert.strictEqual((yield* assignmentOf("export")).state, "running");
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            const counted = yield* admissionsOf(root);
            assert.strictEqual(counted[0]?.kind, "claim");
            assert.isTrue(counted.every(({ state }) => state === "dispatched"));
            assert.strictEqual(yield* slotsInUse, 2);

            // Started now, it runs on as any delivery does, with no second launch.
            yield* tick;
            assert.strictEqual(spy.count("start"), starts + 1);
            assert.lengthOf(launchesOf(world, root), 1);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, root);
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");
          }),
        stack(spy),
      );
    },
    240_000,
  );

  const spoilers = [
    {
      name: "a Work edit",
      spoil: (_world: World, ref: WorkItemRef) => ownerEdits(ref),
      restore: undefined,
    },
    {
      name: "a brief revocation",
      spoil: (world: World) => authorizeIdea(world, "export", false),
      restore: (world: World) => authorizeIdea(world, "export"),
    },
  ] as const;

  it.live.each(spoilers)("$name while it waits causes no launch", ({ name, spoil, restore }) => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkAbsent(world, spy, "export");
          const others = yield* occupyBoth(world);
          const starts = spy.count("start");
          yield* controlAssignment("export", "resume");
          yield* spoil(world, ref);

          yield* tick;
          assert.strictEqual(spy.count("start"), starts);
          yield* freeOne(world, others[0]!);
          assert.strictEqual(spy.count("start"), starts);
          assert.lengthOf(launchesOf(world, root), 0);
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);

          if (restore === undefined) {
            // An edit is caught by the re-claim's fresh read: refused with no row, so it fails.
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: "failed",
            });
            yield* assertNothingHeld(root, "export");
            return;
          }
          // A revoked brief is not eligible at all: it stays queued, holding nothing.
          assert.strictEqual((yield* assignmentOf("export")).state, "queued", name);
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* admissionsOf(root), []);
          yield* restore(world);
          yield* tick;
          assert.strictEqual(spy.count("start"), starts + 1);
          yield* world.launched(root);
          assert.lengthOf(launchesOf(world, root), 1);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
        }),
      stack(spy),
    );
  });

  it.live("a failing Work read while it waits causes no launch", () => {
    const spy = spyOnFactoryPort();
    const reads = { on: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkAbsent(world, spy, "export");
          const others = yield* occupyBoth(world);
          const starts = spy.count("start");
          yield* controlAssignment("export", "resume");
          // The other delivery reaches its pull request first, which its own effects read Work for.
          yield* runToPullRequest(world, others[0]!.root);
          reads.on = true;
          yield* tick;
          reads.on = false;

          assert.isUndefined(yield* slotOf(others[0]!.root));
          assert.strictEqual(spy.count("start"), starts);
          assert.lengthOf(launchesOf(world, root), 0);
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          yield* assertNothingHeld(root, "export");
        }),
      stack(spy, { work: unreadableForAssistant(reads) }),
    );
  });

  it.live("a failing Work read refuses the resume itself, changing nothing", () => {
    const spy = spyOnFactoryPort();
    const reads = { on: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* parkAbsent(world, spy, "export");
          const parked = yield* preStartRows("export");
          reads.on = true;
          const refused = yield* Effect.flip(controlAssignment("export", "resume"));
          reads.on = false;
          assert.include(refused.message, "Not resumed");
          assert.deepStrictEqual(yield* preStartRows("export"), parked);
          assert.strictEqual((yield* assignmentOf("export")).state, "stopped");
          assert.isUndefined(yield* slotOf(root));
        }),
      stack(spy, { work: unreadableForAssistant(reads) }),
    );
  });
});

describe("a cancel of a root parked before its first start", () => {
  const branches = [
    { name: "stopped with no row", row: false, pending: false, rebuilt: false },
    { name: "stopped with a queued row", row: true, pending: false, rebuilt: false },
    { name: "pending a resume with no row", row: false, pending: true, rebuilt: false },
    { name: "pending a resume with a queued row", row: true, pending: true, rebuilt: false },
    { name: "stopped with no row, after a rebuild", row: false, pending: false, rebuilt: true },
    {
      name: "stopped with a queued row, after a rebuild",
      row: true,
      pending: false,
      rebuilt: true,
    },
    {
      name: "pending a resume with no row, after a rebuild",
      row: false,
      pending: true,
      rebuilt: true,
    },
    {
      name: "pending a resume with a queued row, after a rebuild",
      row: true,
      pending: true,
      rebuilt: true,
    },
  ];

  it.live.each(branches)(
    "$name ends by what its row says, with no late start and nothing left",
    ({ row, pending, rebuilt }) => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } = row
              ? yield* parkOrphan(world, "export")
              : yield* parkAbsent(world, spy, "export");
            if (pending) yield* controlAssignment("export", "resume");
            const starts = spy.count("start");

            const finish = Effect.gen(function* () {
              yield* controlAssignment("export", "cancel");
              yield* tick;
              assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
              assert.deepStrictEqual(yield* managedRootOf(root), {
                state: "retired",
                reason: row ? "cancelled" : "abandoned",
              });
              if (row) {
                assert.strictEqual((yield* stateOf(root)).status, "cancelled");
                assert.deepStrictEqual(
                  (yield* deliveriesOf(ref)).map(({ deliveryId }) => deliveryId),
                  [root],
                );
              } else {
                assert.deepStrictEqual(yield* deliveriesOf(ref), []);
              }
              // The stop's notice is on record, and so is how it ended.
              const notices = yield* noticesOf("export");
              assert.isTrue(
                notices.some((note) =>
                  note.startsWith(`Stopped before Factory started delivery ${root}.`),
                ),
              );
              assert.include(
                notices,
                row
                  ? `Factory delivery ${root} was cancelled.`
                  : `Factory delivery ${root} was cancelled before it started.`,
              );
              assert.strictEqual(spy.count("cancel"), row ? 1 : 0);
              yield* assertNothingHeld(root, "export");
              assert.strictEqual(yield* slotsInUse, 0);

              // Nothing late: repeated passes and another rebuild start nothing.
              const check = Effect.gen(function* () {
                yield* tick;
                yield* tick;
                assert.strictEqual(spy.count("start"), starts);
                assert.strictEqual(spy.count("stop"), 0);
                assert.strictEqual(spy.count("resume"), 0);
                assert.lengthOf(launchesOf(world, root), 0);
                assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
                yield* assertNothingHeld(root, "export");
              });
              yield* check;
              yield* world.rebuild(check, { orchestration: true });
            });
            yield* rebuilt ? world.rebuild(finish, { orchestration: true }) : finish;
          }),
        stack(spy),
      );
    },
    240_000,
  );
});
