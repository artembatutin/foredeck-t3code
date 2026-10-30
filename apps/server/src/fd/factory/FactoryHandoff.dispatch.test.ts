import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { HandoffAdmission, HandoffBackend, ProjectAssistant } from "../assistant/index.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  admissionsOf,
  agreeAndCapture,
  assignmentOf,
  assignToFactory,
  controlAssignment,
  demandsOf,
  fill,
  grantOutcomesOf,
  handoffRows,
  linkOf,
  managedRootOf,
  queuePositionOf,
  release,
  rootIdOf,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
} from "./testkit/handoff.ts";

/**
 * Factory assignments on the server's real stack: the project assistant's real enqueue, tick and
 * controls over the bridge's Factory port and real Factory, with the port counting each call and
 * failing those a seam needs. A crash is a claim its dead instance never finished: the claim
 * committed directly, then services rebuilt over the same database.
 */

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

/** Stands in for Work's error, which only Work's own modules may construct. */
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

const factoryService = Factory.FactoryService.FactoryService;

type Spy = ReturnType<typeof spyOnFactoryPort>;

const ambiguous = () => Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "start" }));

/** Every delivery row of the item, each Factory holds. */
const deliveriesOf = (ref: WorkItemRef) =>
  Effect.flatMap(factoryService, (factory) => factory.listByItem(ref)).pipe(
    Effect.map(({ deliveries }) => deliveries),
    Effect.orDie,
  );

const deliveryOf = (root: string) =>
  Effect.flatMap(factoryService, (factory) => factory.get(FactoryDeliveryId.make(root))).pipe(
    Effect.orDie,
  );

/** How many provider turns started: the assistant's own, and each delivery's. */
const startedThreads = (world: World) =>
  world.provider.started.map(({ threadId }) => threadId as string);

const authorThreadsOf = (world: World, root: string) =>
  startedThreads(world).filter((threadId) => threadId.startsWith(`factory-thread:${root}:`));

/** Starts a delivery's row stored and its start step failing, until `restoreStartStep`. */
const failStartStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER dispatch_start_step_fails BEFORE UPDATE ON fd_factory_deliveries
    WHEN OLD.status = 'queued'
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
).pipe(Effect.orDie);
const restoreStartStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER dispatch_start_step_fails`,
).pipe(Effect.orDie);

const revoke = (world: World, idea: string) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: { executionAuthorized: false },
    }),
  ).pipe(Effect.orDie);

const authorize = (world: World, idea: string) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: { executionAuthorized: true },
    }),
  ).pipe(Effect.orDie);

const ownerEdits = (ref: WorkItemRef) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const item = yield* work.getItem(owner, { ref });
    yield* work.updateItem(owner, {
      ref,
      expectedRevision: item.revision,
      title: `${item.title}, and more`,
      body: item.body,
    });
  }).pipe(Effect.orDie);

/** Everything a pre-start step must leave as it found it, with the assignment. */
const everything = (assignmentId: string) =>
  Effect.gen(function* () {
    return {
      rows: yield* handoffRows,
      assignment: yield* assignmentOf(assignmentId),
      link: yield* linkOf(assignmentId),
      position: yield* queuePositionOf(assignmentId),
    };
  });

/** An idea queued and claimed once, its start ending with no row: parked by a stop. */
const parkAbsent = (world: World, spy: Spy, idea: string) =>
  Effect.gen(function* () {
    const ref = yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    spy.control.onStart = ambiguous;
    yield* tick;
    spy.control.onStart = undefined;
    yield* controlAssignment(idea, "stop");
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    return { ref, root: yield* rootIdOf(idea) };
  });

/** The same with a queued orphan: its row stored, and its start step never stored. */
const parkOrphan = (world: World, idea: string) =>
  Effect.gen(function* () {
    const ref = yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    yield* failStartStep;
    yield* tick;
    yield* controlAssignment(idea, "stop");
    yield* restoreStartStep;
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    const root = yield* rootIdOf(idea);
    assert.strictEqual((yield* stateOf(root)).status, "queued");
    return { ref, root };
  });

const options = (spy: Spy, extra: Parameters<typeof withProject>[2] = {}) => ({
  handoff: {},
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
  ...extra,
});

describe("an authorized Factory assignment on the real stack", () => {
  it.live("claims, starts under its intended id, and launches one author and no worker", () => {
    const spy = spyOnFactoryPort();
    const seen: Record<string, unknown> = {};
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          const queued = yield* assignToFactory(world, "export");
          assert.strictEqual(queued.state, "queued");
          assert.strictEqual(queued.executor, "factory");
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);

          const database = yield* Effect.context<SqlClient.SqlClient>();
          spy.control.onStart = (input, start) =>
            Effect.gen(function* () {
              // Managed before any delivery of it can exist.
              seen.management = yield* admission.management(input.deliveryId).pipe(Effect.orDie);
              seen.slot = (yield* slotOf(input.deliveryId))?.state;
              seen.admission = (yield* admissionsOf(input.deliveryId))[0]?.state;
              return yield* start;
            }).pipe(Effect.provideContext(database));
          yield* tick;

          const root = yield* rootIdOf("export");
          assert.deepStrictEqual(seen, {
            management: "active",
            slot: "held",
            admission: "dispatching",
          });
          assert.strictEqual(spy.count("start"), 1);
          const author = yield* world.launched(root);
          assert.isTrue(author.threadId.startsWith(`factory-thread:${root}:`));
          assert.strictEqual((yield* stateOf(root)).runtimeModeCeiling, "full-access");
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          // The assistant's thread and the author: no ordinary worker thread.
          assert.lengthOf(startedThreads(world), 2);
          assert.strictEqual((yield* assignmentOf("export")).state, "running");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatched");

          yield* tick;
          assert.strictEqual(spy.count("start"), 1);
          assert.lengthOf(authorThreadsOf(world, root), 1);
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live("repeats an enqueue without a second delivery", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          const first = yield* assignToFactory(world, "export");
          yield* assignToFactory(world, "export");
          yield* tick;
          const root = yield* rootIdOf("export");
          const repeat = yield* assignToFactory(world, "export");
          assert.strictEqual(repeat.assignmentId, first.assignmentId);
          yield* tick;
          const author = yield* world.launched(root);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual(spy.count("start"), 1);
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live("refuses an idea the owner has not authorized, writing nothing", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "export");
          yield* revoke(world, "export");
          const before = yield* handoffRows;
          const refused = yield* Effect.flip(assignToFactory(world, "export"));
          assert.include(refused.message, "explicit execution authorization");
          assert.deepStrictEqual(yield* handoffRows, before);
          assert.deepStrictEqual(spy.calls, []);
        }),
      options(spy),
    );
  });
});

describe("a Factory assignment's partial failures", () => {
  it.live("a crash before the start leads to a recheck, then a start under the same id", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const claimed = yield* admission.claim({
            assignmentId: "export",
            deliveryId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20",
          });
          if (claimed.type !== "claimed") return assert.fail("The claim did not commit.");
          const root = FactoryDeliveryId.make(claimed.root);

          yield* world.rebuild(
            Effect.gen(function* () {
              assert.strictEqual((yield* assignmentOf("export")).state, "launching");
              assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
              yield* tick;
              assert.strictEqual(spy.count("start"), 1);
              assert.strictEqual(spy.calls.filter((call) => call === `start:${root}`).length, 1);
              const author = yield* world.launched(root);
              assert.lengthOf(yield* deliveriesOf(ref), 1);
              assert.lengthOf(authorThreadsOf(world, root), 1);
              assert.strictEqual((yield* assignmentOf("export")).state, "running");
              // The dead instance's claim is marked dispatched once its start returned.
              assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatched");
              yield* world.endRun(author.runId, "completed");
            }),
          );
        }),
      options(spy),
    );
  });

  it.live("a crash after the insert and before the start step starts the orphan once", () => {
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
          yield* restoreStartStep;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* stateOf(root)).status, "queued");
          assert.strictEqual((yield* assignmentOf("export")).state, "launching");
          assert.lengthOf(authorThreadsOf(world, root), 0);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              const author = yield* world.launched(root);
              assert.lengthOf(yield* deliveriesOf(ref), 1);
              assert.lengthOf(authorThreadsOf(world, root), 1);
              assert.strictEqual((yield* assignmentOf("export")).state, "running");
              yield* tick;
              assert.lengthOf(authorThreadsOf(world, root), 1);
              yield* world.endRun(author.runId, "completed");
            }),
          );
        }),
      options(spy),
    );
  });

  it.live("a lost reply is adopted, with no second delivery", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          spy.control.onStart = (_, start) => start.pipe(Effect.andThen(() => ambiguous()));
          yield* tick;
          spy.control.onStart = undefined;
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* assignmentOf("export")).state, "running");
          const author = yield* world.launched(root);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual(spy.count("start"), 1);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.strictEqual(spy.count("start"), 1);
              assert.lengthOf(yield* deliveriesOf(ref), 1);
              yield* world.endRun(author.runId, "completed");
            }),
          );
        }),
      options(spy),
    );
  });

  it.live("a known refusal with no row fails and retires", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const settings = yield* Factory.FactorySettings.FactorySettings;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          // The recheck passes, and Factory itself refuses before writing anything.
          spy.control.verifiesAnyway = true;
          const current = yield* settings.get(world.projectId);
          yield* settings.set(world.projectId, { ...current, verifyCommand: null });
          yield* tick;

          const root = yield* rootIdOf("export");
          assert.strictEqual(spy.count("start"), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* admissionsOf(root), []);
          assert.isUndefined(yield* queuePositionOf("export"));
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
        }),
      options(spy),
    );
  });

  it.live("a post-commit refusal retires a first claim without calling Factory's start", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const settings = yield* Factory.FactorySettings.FactorySettings;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const current = yield* settings.get(world.projectId);
          yield* settings.set(world.projectId, { ...current, verifyCommand: null });
          yield* tick;
          const root = yield* rootIdOf("export");
          assert.strictEqual(spy.count("start"), 0);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
        }),
      options(spy),
    );
  });

  it.live("a failing read keeps the slot as launch-uncertain, then the same id starts", () => {
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
          const root = yield* rootIdOf("export");
          assert.strictEqual((yield* assignmentOf("export")).state, "launch-uncertain");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          yield* tick;
          assert.strictEqual(spy.count("start"), 1);

          spy.control.onStart = undefined;
          spy.control.failGet = false;
          yield* tick;
          assert.strictEqual(yield* rootIdOf("export"), root);
          assert.strictEqual(spy.count("start"), 2);
          const author = yield* world.launched(root);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "running");
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live(
    "an outside active delivery fails without being adopted, and a retry mints a new id",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* factoryService;
            yield* startAssistantThread(world);
            const ref = yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            const outside = yield* factory.start({ itemRef: ref });
            const outsideAuthor = yield* world.launched(outside.deliveryId);
            const before = yield* stateOf(outside.deliveryId);

            yield* tick;
            const first = yield* rootIdOf("export");
            assert.notStrictEqual(first, outside.deliveryId);
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");
            assert.deepStrictEqual(yield* managedRootOf(first), {
              state: "retired",
              reason: "failed",
            });
            assert.isTrue(Option.isNone(yield* deliveryOf(first)));
            assert.deepStrictEqual(yield* stateOf(outside.deliveryId), before);
            assert.lengthOf(yield* deliveriesOf(ref), 1);

            // Retried while the outside delivery still runs, it is refused the same way, anew.
            yield* controlAssignment("export", "retry");
            assert.isNull((yield* linkOf("export")).delivery_id);
            assert.deepStrictEqual(yield* managedRootOf(first), {
              state: "retired",
              reason: "failed",
            });
            yield* tick;
            const second = yield* rootIdOf("export");
            assert.notStrictEqual(second, first);
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");

            // With the outside delivery ended, a retry delivers under a third id.
            yield* world.endRun(outsideAuthor.runId, "failed");
            yield* factory.cancel(outside.deliveryId);
            yield* controlAssignment("export", "retry");
            yield* tick;
            const third = yield* rootIdOf("export");
            assert.notStrictEqual(third, second);
            const author = yield* world.launched(third);
            assert.strictEqual((yield* assignmentOf("export")).state, "running");
            assert.strictEqual((yield* assignmentOf("export")).attempt, 3);
            assert.isTrue(Option.isNone(yield* deliveryOf(first)));
            assert.isTrue(Option.isNone(yield* deliveryOf(second)));
            assert.lengthOf(yield* deliveriesOf(ref), 2);
            yield* world.endRun(author.runId, "completed");
          }),
        options(spy),
      );
    },
  );

  it.live("an orphan whose authority is revoked is cancelled by its own id, never failed", () => {
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
          yield* revoke(world, "export");
          yield* restoreStartStep;

          const settled = Effect.gen(function* () {
            assert.strictEqual(spy.count("cancel"), 1);
            assert.strictEqual((yield* stateOf(root)).status, "cancelled");
            assert.lengthOf(yield* deliveriesOf(ref), 1);
            assert.lengthOf(authorThreadsOf(world, root), 0);
            assert.strictEqual((yield* assignmentOf("export")).state, "stopping");
            assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.lengthOf(yield* admissionsOf(root), 1);
          });
          yield* tick;
          yield* settled;
          yield* tick;
          yield* settled;
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              yield* settled;
            }),
          );
        }),
      options(spy),
    );
  });
});

describe("pre-delivery controls on the real stack", () => {
  it.live("a stop after an ambiguous first start parks with the delivery proven absent", () => {
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
            // The claim holds its slot and row while the start is out.
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatching");
            yield* Deferred.succeed(go, undefined);
            yield* Fiber.join(ticking);
            spy.control.onStart = undefined;
            assert.strictEqual((yield* assignmentOf("export")).state, "launch-uncertain");

            const position = yield* queuePositionOf("export");
            const stopped = yield* controlAssignment("export", "stop");
            assert.strictEqual(stopped.state, "stopped");
            assert.isTrue(Option.isNone(yield* deliveryOf(root)));
            assert.deepStrictEqual(yield* deliveriesOf(ref), []);
            assert.strictEqual(spy.count("start"), 1);
            assert.strictEqual(spy.count("stop"), 0);
            assert.strictEqual(spy.count("resume"), 0);
            assert.strictEqual(spy.count("cancel"), 0);
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(yield* admissionsOf(root), []);
            assert.deepStrictEqual(yield* demandsOf(root), []);
            assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
            assert.deepStrictEqual(yield* linkOf("export"), { delivery_id: root, control: "stop" });
            assert.deepStrictEqual(yield* queuePositionOf("export"), position);
            assert.deepInclude(yield* grantOutcomesOf(root), { kind: "park", outcome: "released" });
            assert.deepStrictEqual(spy.interrupted, []);

            // Nothing more changes: not on later passes, and not after a rebuild.
            const parked = yield* everything("export");
            yield* tick;
            yield* tick;
            yield* controlAssignment("export", "stop");
            assert.deepStrictEqual(yield* everything("export"), parked);
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* tick;
                assert.deepStrictEqual(yield* everything("export"), parked);
                assert.strictEqual(spy.count("start"), 1);
              }),
            );
          }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
        options(spy),
      );
    });
  });

  it.live(
    "a stop after a rebuild releases the dead instance's claim, marked dispatched first",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            yield* startAssistantThread(world);
            yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            yield* admission.claim({ assignmentId: "export", deliveryId: "root-export" });

            yield* world.rebuild(
              Effect.gen(function* () {
                assert.strictEqual((yield* admissionsOf("root-export"))[0]?.state, "dispatching");
                yield* controlAssignment("export", "stop");
                assert.strictEqual((yield* assignmentOf("export")).state, "stopped");
                assert.isUndefined(yield* slotOf("root-export"));
                assert.deepStrictEqual(yield* admissionsOf("root-export"), []);
                assert.deepStrictEqual(yield* managedRootOf("root-export"), {
                  state: "active",
                  reason: null,
                });
                assert.strictEqual(spy.count("start"), 0);
                const parked = yield* everything("export");
                yield* tick;
                yield* tick;
                assert.deepStrictEqual(yield* everything("export"), parked);
              }),
            );
          }),
        options(spy),
      );
    },
  );

  it.live("a stop over a queued orphan parks it with its row queued and no Factory call", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkOrphan(world, "export");
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual((yield* stateOf(root)).status, "queued");
          assert.strictEqual(spy.count("stop"), 0);
          assert.strictEqual(spy.count("resume"), 0);
          assert.strictEqual(spy.count("cancel"), 0);
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* admissionsOf(root), []);
          assert.lengthOf(authorThreadsOf(world, root), 0);
          const parked = yield* everything("export");
          yield* tick;
          assert.deepStrictEqual(yield* everything("export"), parked);
        }),
      options(spy),
    );
  });

  it.live("a failing read and a claim still dispatching here keep the slot and admission", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "held");
          yield* assignToFactory(world, "held");
          yield* admission.claim({ assignmentId: "held", deliveryId: "root-held" });
          yield* controlAssignment("held", "stop");
          assert.strictEqual((yield* slotOf("root-held"))?.state, "held");
          assert.strictEqual((yield* admissionsOf("root-held"))[0]?.state, "dispatching");
          assert.strictEqual((yield* linkOf("held")).control, "stop");
          assert.strictEqual(spy.count("start"), 0);

          yield* agreeAndCapture(world, "unread");
          yield* assignToFactory(world, "unread");
          spy.control.onStart = ambiguous;
          yield* tick;
          spy.control.onStart = undefined;
          const root = yield* rootIdOf("unread");
          spy.control.failGet = true;
          yield* controlAssignment("unread", "stop");
          assert.strictEqual((yield* assignmentOf("unread")).state, "launch-uncertain");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.lengthOf(yield* admissionsOf(root), 1);
          yield* tick;
          assert.strictEqual(spy.count("start"), 1);

          // Restored, the next pass parks it, and a start is never called while the stop is set.
          spy.control.failGet = false;
          yield* tick;
          assert.strictEqual((yield* assignmentOf("unread")).state, "stopped");
          assert.isUndefined(yield* slotOf(root));
          assert.strictEqual(spy.count("start"), 1);
        }),
      options(spy),
    );
  });

  it.live(
    "a cancel during launching retires abandoned only when the delivery is proven absent",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const absentRef = yield* agreeAndCapture(world, "absent");
            yield* assignToFactory(world, "absent");
            spy.control.onStart = ambiguous;
            yield* tick;
            spy.control.onStart = undefined;
            const absent = yield* rootIdOf("absent");

            // Unreadable, it waits; the intent stands, and nothing starts it meanwhile.
            spy.control.failGet = true;
            yield* controlAssignment("absent", "cancel");
            assert.strictEqual((yield* assignmentOf("absent")).state, "launch-uncertain");
            assert.strictEqual((yield* linkOf("absent")).control, "cancel");
            assert.strictEqual(spy.count("start"), 1);
            spy.control.failGet = false;

            yield* tick;
            assert.strictEqual((yield* assignmentOf("absent")).state, "cancelled");
            assert.deepStrictEqual(yield* managedRootOf(absent), {
              state: "retired",
              reason: "abandoned",
            });
            assert.isUndefined(yield* slotOf(absent));
            assert.deepStrictEqual(yield* admissionsOf(absent), []);
            assert.isUndefined(yield* queuePositionOf("absent"));
            assert.deepStrictEqual(yield* deliveriesOf(absentRef), []);
            assert.strictEqual(spy.count("cancel"), 0);
            assert.strictEqual(spy.count("start"), 1);
          }),
        options(spy),
      );
    },
  );

  it.live("a cancel over a queued orphan and over a running delivery acts on that id alone", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const orphanRef = yield* agreeAndCapture(world, "orphan");
          yield* assignToFactory(world, "orphan");
          yield* failStartStep;
          yield* tick;
          yield* restoreStartStep;
          const orphan = yield* rootIdOf("orphan");

          const cancelling = yield* controlAssignment("orphan", "cancel");
          assert.strictEqual(cancelling.state, "stopping");
          assert.deepStrictEqual(
            spy.calls.filter((call) => call.startsWith("cancel:")),
            [`cancel:${orphan}`],
          );
          assert.strictEqual((yield* stateOf(orphan)).status, "cancelled");
          assert.lengthOf(yield* deliveriesOf(orphanRef), 1);
          assert.lengthOf(authorThreadsOf(world, orphan), 0);
          assert.strictEqual((yield* slotOf(orphan))?.state, "held");
          assert.strictEqual((yield* admissionsOf(orphan))[0]?.state, "dispatched");
          yield* tick;
          assert.lengthOf(authorThreadsOf(world, orphan), 0);
          assert.strictEqual(spy.count("start"), 1);

          yield* agreeAndCapture(world, "running");
          yield* assignToFactory(world, "running");
          yield* tick;
          const running = yield* rootIdOf("running");
          const author = yield* world.launched(running);
          assert.strictEqual((yield* controlAssignment("running", "cancel")).state, "stopping");
          assert.strictEqual((yield* stateOf(running)).status, "cancelled");
          assert.strictEqual((yield* slotOf(running))?.state, "held");
          yield* world.endRun(author.runId, "cancelled");
        }),
      options(spy),
    );
  });

  it.live("a stop over a running delivery goes through Factory.stop, by its id", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          yield* tick;
          const root = yield* rootIdOf("export");
          const author = yield* world.launched(root);
          assert.strictEqual((yield* controlAssignment("export", "stop")).state, "stopping");
          assert.deepStrictEqual(
            spy.calls.filter((call) => call.startsWith("stop:")),
            [`stop:${root}`],
          );
          assert.strictEqual((yield* stateOf(root)).status, "stopping");
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });
});

describe("controls of a delivery whose claim did not hear back, on the real stack", () => {
  /** A claim whose start stored and ran its row, with the reply and the read after it lost. */
  const lostReply = (world: World, spy: Spy, idea: string) =>
    Effect.gen(function* () {
      const ref = yield* agreeAndCapture(world, idea);
      yield* assignToFactory(world, idea);
      spy.control.onStart = (_, start) => start.pipe(Effect.andThen(() => ambiguous()));
      spy.control.failGet = true;
      yield* tick;
      spy.control.onStart = undefined;
      spy.control.failGet = false;
      assert.strictEqual((yield* assignmentOf(idea)).state, "launch-uncertain");
      return { ref, root: yield* rootIdOf(idea) };
    });

  it.live("a stop reads the row its lost reply stored, and stops that id", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* lostReply(world, spy, "export");
          const author = yield* world.launched(root);
          const stopped = yield* controlAssignment("export", "stop");
          assert.strictEqual(stopped.state, "stopping");
          assert.deepStrictEqual(
            spy.calls.filter((call) => call.startsWith("stop:")),
            [`stop:${root}`],
          );
          assert.strictEqual((yield* stateOf(root)).status, "stopping");
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.strictEqual(spy.count("start"), 1);
          assert.deepStrictEqual(spy.interrupted, []);
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live(
    "a cancel after a rebuild reads the row its lost reply stored, and cancels that id",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } = yield* lostReply(world, spy, "export");
            yield* world.launched(root);
            yield* world.rebuild(
              Effect.gen(function* () {
                const cancelled = yield* controlAssignment("export", "cancel");
                assert.strictEqual(cancelled.state, "stopping");
                assert.deepStrictEqual(
                  spy.calls.filter((call) => call.startsWith("cancel:")),
                  [`cancel:${root}`],
                );
                assert.strictEqual((yield* stateOf(root)).status, "cancelled");
                assert.lengthOf(yield* deliveriesOf(ref), 1);
                assert.strictEqual((yield* slotOf(root))?.state, "held");
                assert.strictEqual(spy.count("start"), 1);
                assert.deepStrictEqual(spy.interrupted, []);
              }),
            );
          }),
        options(spy),
      );
    },
  );

  it.live("an intent honored after a rebuild marks the dead instance's claim dispatched", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          const factory = yield* factoryService;
          yield* startAssistantThread(world);
          const ref = yield* agreeAndCapture(world, "export");
          yield* assignToFactory(world, "export");
          const root = FactoryDeliveryId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
          // The dead instance's claim, and its start storing the row and failing its step.
          yield* admission.claim({ assignmentId: "export", deliveryId: root });
          yield* failStartStep;
          yield* Effect.flip(
            factory.start({ itemRef: ref, deliveryId: root, runtimeModeCeiling: "full-access" }),
          );
          yield* restoreStartStep;

          yield* world.rebuild(
            Effect.gen(function* () {
              assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatching");
              const cancelled = yield* controlAssignment("export", "cancel");
              assert.strictEqual(cancelled.state, "stopping");
              assert.strictEqual(spy.count("start"), 0);
              assert.strictEqual(spy.count("cancel"), 1);
              assert.strictEqual((yield* stateOf(root)).status, "cancelled");
              const [claim] = yield* admissionsOf(root);
              assert.deepStrictEqual(
                { kind: claim?.kind, state: claim?.state },
                { kind: "claim", state: "dispatched" },
              );
              assert.strictEqual((yield* slotOf(root))?.state, "held");
              assert.lengthOf(authorThreadsOf(world, root), 0);
            }),
          );
        }),
      options(spy),
    );
  });

  it.live("a retry after a terminal row mints a new id, and the old row stays as it ended", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkOrphan(world, "export");
          yield* controlAssignment("export", "cancel");
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });

          const retried = yield* controlAssignment("export", "retry");
          assert.strictEqual(retried.state, "queued");
          assert.isNull((yield* linkOf("export")).delivery_id);
          assert.strictEqual((yield* linkOf("export")).control, "none");
          yield* tick;
          const next = yield* rootIdOf("export");
          assert.notStrictEqual(next, root);
          const author = yield* world.launched(next);
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });
          assert.deepStrictEqual(yield* managedRootOf(next), { state: "active", reason: null });
          assert.lengthOf(yield* deliveriesOf(ref), 2);
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });
});

describe("resuming a root parked before its first start, on the real stack", () => {
  it.live("an absent park re-enters the queue, and a fair grant starts the same id once", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkAbsent(world, spy, "export");
          const before = yield* queuePositionOf("export");
          const [first] = yield* fill(world, 2);

          const resumed = yield* controlAssignment("export", "resume");
          assert.strictEqual(resumed.state, "queued");
          assert.strictEqual((yield* linkOf("export")).control, "none");
          assert.isAbove((yield* queuePositionOf("export"))?.seq ?? 0, before?.seq ?? 0);
          assert.isUndefined(yield* slotOf(root));
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);

          // Both slots held by others: no re-claim, start or run.
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "queued");
          assert.strictEqual(spy.count("start"), 1);
          assert.lengthOf(authorThreadsOf(world, root), 0);

          yield* release(first!);
          yield* tick;
          assert.strictEqual(yield* rootIdOf("export"), root);
          assert.strictEqual(spy.count("start"), 2);
          assert.strictEqual(spy.count("resume"), 0);
          const author = yield* world.launched(root);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.lengthOf(authorThreadsOf(world, root), 1);
          assert.strictEqual((yield* assignmentOf("export")).state, "running");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          const [claim] = yield* admissionsOf(root);
          assert.deepStrictEqual(
            { kind: claim?.kind, state: claim?.state },
            { kind: "claim", state: "dispatched" },
          );
          assert.deepInclude(yield* grantOutcomesOf(root), { kind: "claim", outcome: "granted" });
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live("a queued orphan's park is started through start(id), never Factory.resume", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkOrphan(world, "export");
          yield* controlAssignment("export", "resume");
          assert.strictEqual((yield* stateOf(root)).status, "queued");
          yield* tick;
          assert.strictEqual(spy.count("resume"), 0);
          const author = yield* world.launched(root);
          assert.lengthOf(yield* deliveriesOf(ref), 1);
          assert.lengthOf(authorThreadsOf(world, root), 1);
          assert.strictEqual((yield* stateOf(root)).status, "running");
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live("a repeated resume is refused unchanged, and a rebuild keeps the position", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* parkAbsent(world, spy, "export");
          const [first] = yield* fill(world, 2);
          yield* controlAssignment("export", "resume");

          const pending = yield* everything("export");
          const refused = yield* Effect.flip(controlAssignment("export", "resume"));
          assert.include(refused.message, "Waiting for a project assistant slot");
          assert.deepStrictEqual(yield* everything("export"), pending);

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              assert.deepStrictEqual(yield* everything("export"), pending);
              assert.strictEqual(spy.count("start"), 1);
              yield* release(first!);
              yield* tick;
              assert.strictEqual(spy.count("start"), 2);
              const author = yield* world.launched(root);
              assert.lengthOf(authorThreadsOf(world, root), 1);
              yield* world.endRun(author.runId, "completed");
            }),
          );
        }),
      options(spy),
    );
  });

  it.live("a re-claim refused with no row fails, and with a queued row cancels that id", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const absent = yield* parkAbsent(world, spy, "absent");
          const orphan = yield* parkOrphan(world, "orphan");
          yield* controlAssignment("absent", "resume");
          yield* controlAssignment("orphan", "resume");
          yield* ownerEdits(absent.ref);
          yield* ownerEdits(orphan.ref);
          const starts = spy.count("start");
          yield* tick;

          assert.strictEqual(spy.count("start"), starts);
          assert.strictEqual((yield* assignmentOf("absent")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(absent.root), {
            state: "retired",
            reason: "failed",
          });
          assert.isUndefined(yield* slotOf(absent.root));

          assert.strictEqual((yield* assignmentOf("orphan")).state, "stopping");
          assert.strictEqual((yield* stateOf(orphan.root)).status, "cancelled");
          assert.lengthOf(authorThreadsOf(world, orphan.root), 0);
          assert.deepStrictEqual(yield* managedRootOf(orphan.root), {
            state: "active",
            reason: null,
          });
          assert.strictEqual((yield* slotOf(orphan.root))?.state, "held");
        }),
      options(spy),
    );
  });

  it.live("a paused re-claim loses nothing to a release, a park or a parked retirement", () => {
    const spy = spyOnFactoryPort();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
      const go = yield* Deferred.make<void>();
      const hold = { armed: false };
      yield* withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            yield* startAssistantThread(world);
            const { root } = yield* parkAbsent(world, spy, "export");
            yield* controlAssignment("export", "resume");
            yield* agreeAndCapture(world, "behind");
            yield* assignToFactory(world, "behind");
            yield* fill(world, 1);

            hold.armed = true;
            const ticking = yield* tick.pipe(Effect.forkChild);
            const admitted = yield* Deferred.await(entered);
            hold.armed = false;
            assert.strictEqual(admitted.root, root);

            const held = yield* everything("export");
            assert.strictEqual(yield* admission.release(root, admitted.entrySeq), "kept");
            assert.strictEqual(
              yield* admission.parkPreStart({
                root,
                admissionId: admitted.admissionId,
                entrySeq: admitted.entrySeq,
              }),
              "contended",
            );
            assert.strictEqual(
              yield* admission.retirePreDelivery({
                root,
                reason: "abandoned",
                shape: { type: "parked" },
              }),
              "contended",
            );
            const next = yield* admission.next;
            assert.strictEqual(next.free, 0);
            assert.isUndefined(next.head);
            assert.deepStrictEqual(yield* everything("export"), held);
            assert.strictEqual(spy.count("start"), 1);

            yield* Deferred.succeed(go, undefined);
            yield* Fiber.join(ticking);
            assert.strictEqual(spy.count("start"), 2);
            assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatched");
            const author = yield* world.launched(root);
            assert.strictEqual((yield* assignmentOf("behind")).state, "queued");
            yield* world.endRun(author.runId, "completed");
          }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
        options(spy, {
          handoff: {
            probe: {
              admitted: (admitted) =>
                Effect.suspend(() =>
                  hold.armed && admitted.kind === "claim"
                    ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
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

  it.live("a stopped delivery and a blocked one still resume through Factory.resume", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, "blocked");
          yield* assignToFactory(world, "blocked");
          yield* tick;
          const blocked = yield* rootIdOf("blocked");
          const blockedAuthor = yield* world.launched(blocked);

          // Its author's run failing blocks the delivery, and only a resume moves it.
          yield* world.endRun(blockedAuthor.runId, "failed");
          assert.strictEqual((yield* stateOf(blocked)).status, "blocked");
          yield* controlAssignment("blocked", "resume");
          assert.deepStrictEqual(
            spy.calls.filter((call) => call.startsWith("resume:")),
            [`resume:${blocked}`],
          );
          yield* drainFactory;

          // Stopped at a step boundary, it resumes the same way.
          yield* agreeAndCapture(world, "stopped");
          yield* assignToFactory(world, "stopped");
          yield* tick;
          const stopped = yield* rootIdOf("stopped");
          const stoppedAuthor = yield* world.launched(stopped);
          yield* controlAssignment("stopped", "stop");
          yield* authorCommits(stoppedAuthor.worktreePath, "feat: add the export button", "x\n");
          yield* world.endRun(stoppedAuthor.runId, "completed");
          assert.strictEqual((yield* stateOf(stopped)).status, "stopped");
          yield* controlAssignment("stopped", "resume");
          assert.deepStrictEqual(
            spy.calls.filter((call) => call.startsWith("resume:")),
            [`resume:${blocked}`, `resume:${stopped}`],
          );
          assert.notStrictEqual((yield* stateOf(stopped)).status, "stopped");
          assert.strictEqual(spy.count("start"), 2);
        }),
      options(spy),
    );
  });
});

describe("cancelling a parked or pending-resume root, on the real stack", () => {
  const branches = [
    { name: "a parked root with no row", row: false, pending: false },
    { name: "a parked root with a queued row", row: true, pending: false },
    { name: "a pending resume with no row", row: false, pending: true },
    { name: "a pending resume with a queued row", row: true, pending: true },
  ];

  it.live.each(
    branches.flatMap((branch) => [
      { ...branch, rebuilt: false, when: "" },
      { ...branch, rebuilt: true, when: ", after a rebuild" },
    ]),
  )("$name ends as its row says$when, with no late start", (branch) => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = branch.row
            ? yield* parkOrphan(world, "export")
            : yield* parkAbsent(world, spy, "export");
          if (branch.pending) yield* controlAssignment("export", "resume");
          const starts = spy.count("start");

          const finish = Effect.gen(function* () {
            // A failing read persists the intent, and nothing else changes until restored.
            spy.control.failGet = true;
            yield* controlAssignment("export", "cancel");
            assert.strictEqual((yield* linkOf("export")).control, "cancel");
            assert.strictEqual(
              (yield* assignmentOf("export")).state,
              branch.pending ? "queued" : "stopped",
            );
            yield* tick;
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "active",
              reason: null,
            });
            spy.control.failGet = false;

            yield* tick;
            assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: branch.row ? "cancelled" : "abandoned",
            });
            assert.lengthOf(yield* deliveriesOf(ref), branch.row ? 1 : 0);
            if (branch.row) {
              assert.strictEqual((yield* stateOf(root)).status, "cancelled");
            }
            assert.strictEqual(spy.count("cancel"), branch.row ? 1 : 0);
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(yield* admissionsOf(root), []);
            assert.deepStrictEqual(yield* demandsOf(root), []);
            assert.isUndefined(yield* queuePositionOf("export"));

            yield* tick;
            yield* tick;
            assert.strictEqual(spy.count("start"), starts);
            assert.strictEqual(spy.count("stop"), 0);
            assert.strictEqual(spy.count("resume"), 0);
            assert.lengthOf(authorThreadsOf(world, root), 0);
            assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          });
          yield* branch.rebuilt ? world.rebuild(finish) : finish;
        }),
      options(spy),
    );
  });

  it.live("a row an owner cancelled in Factory retires the parked root, recreating no slot", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          yield* startAssistantThread(world);
          const { root } = yield* parkOrphan(world, "export");
          yield* factory.cancel(root);
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });
          assert.isUndefined(yield* slotOf(root));
          assert.strictEqual(spy.count("cancel"), 0);
        }),
      options(spy),
    );
  });

  it.live("a cancel during a paused re-claim waits for its start, then cancels the same id", () => {
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
            const { ref, root } = yield* parkAbsent(world, spy, "export");
            yield* controlAssignment("export", "resume");

            hold.armed = true;
            const ticking = yield* tick.pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            hold.armed = false;
            const cancelling = yield* controlAssignment("export", "cancel").pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            assert.strictEqual((yield* linkOf("export")).control, "none");

            yield* Deferred.succeed(go, undefined);
            yield* Fiber.join(ticking);
            const cancelled = yield* Fiber.join(cancelling);
            assert.strictEqual(cancelled.state, "stopping");
            assert.strictEqual(spy.count("start"), 2);
            assert.deepStrictEqual(
              spy.calls.filter((call) => call.startsWith("cancel:")),
              [`cancel:${root}`],
            );
            const rows = yield* deliveriesOf(ref);
            assert.lengthOf(rows, 1);
            assert.strictEqual(rows[0]?.deliveryId, root);
            assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
        options(spy, {
          handoff: {
            probe: {
              admitted: (admitted) =>
                Effect.suspend(() =>
                  hold.armed && admitted.kind === "claim"
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

describe("parked roots and capacity, on the real stack", () => {
  it.live(
    "two parked roots hold nothing, and a third authorized assignment launches past them",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            yield* startAssistantThread(world);
            const absent = yield* parkAbsent(world, spy, "absent");
            const orphan = yield* parkOrphan(world, "orphan");
            assert.strictEqual((yield* admission.next).free, 2);

            yield* agreeAndCapture(world, "third");
            yield* assignToFactory(world, "third");
            yield* tick;
            const third = yield* rootIdOf("third");
            const author = yield* world.launched(third);
            assert.strictEqual((yield* assignmentOf("third")).state, "running");
            assert.strictEqual((yield* slotOf(third))?.state, "held");
            for (const idea of ["absent", "orphan"]) {
              assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
            }
            assert.isUndefined(yield* slotOf(absent.root));
            assert.isUndefined(yield* slotOf(orphan.root));
            yield* world.endRun(author.runId, "completed");
          }),
        options(spy),
      );
    },
  );

  it.live("a revoked brief keeps a pending resume queued and unclaimed until restored", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* parkAbsent(world, spy, "export");
          yield* controlAssignment("export", "resume");
          const [first] = yield* fill(world, 2);
          yield* revoke(world, "export");
          yield* release(first!);
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "queued");
          assert.isUndefined(yield* slotOf(root));
          assert.strictEqual(spy.count("start"), 1);

          yield* authorize(world, "export");
          yield* tick;
          assert.strictEqual(spy.count("start"), 2);
          const author = yield* world.launched(root);
          assert.lengthOf(authorThreadsOf(world, root), 1);
          yield* world.endRun(author.runId, "completed");
        }),
      options(spy),
    );
  });

  it.live("an edit while it waits is caught by the post-commit read, with no start", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { ref, root } = yield* parkAbsent(world, spy, "export");
          yield* controlAssignment("export", "resume");
          const [first] = yield* fill(world, 2);
          yield* ownerEdits(ref);
          const starts = spy.count("start");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("export")).state, "queued");

          yield* release(first!);
          yield* tick;
          assert.strictEqual(spy.count("start"), starts);
          assert.strictEqual((yield* assignmentOf("export")).state, "failed");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "failed",
          });
          assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          assert.lengthOf(authorThreadsOf(world, root), 0);
        }),
      options(spy),
    );
  });

  it.live(
    "a failing Work read while it waits is caught by the post-commit read, with no start",
    () => {
      const spy = spyOnFactoryPort();
      const reads = { fail: false };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* startAssistantThread(world);
            const { ref, root } = yield* parkAbsent(world, spy, "export");
            yield* controlAssignment("export", "resume");
            reads.fail = true;
            const starts = spy.count("start");
            yield* tick;
            reads.fail = false;
            assert.strictEqual(spy.count("start"), starts);
            assert.strictEqual((yield* assignmentOf("export")).state, "failed");
            assert.deepStrictEqual(yield* managedRootOf(root), {
              state: "retired",
              reason: "failed",
            });
            assert.deepStrictEqual(yield* deliveriesOf(ref), []);
          }),
        options(spy, {
          work: (service) => ({
            ...service,
            getItem: (actor, input) =>
              reads.fail && actor.id === "assistant:handoff"
                ? Effect.fail(
                    new FakeWorkUnavailable({
                      detail: "The source could not be reached.",
                    }) as unknown as WorkDomainError,
                  )
                : service.getItem(actor, input),
          }),
        }),
      );
    },
  );
});
