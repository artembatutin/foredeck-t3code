import { assert, describe, it, vi } from "@effect/vitest";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { AssistantToolkit, ProjectAssistant } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  editTaskFile,
  itemStatus,
  linkOf,
  passingReview,
  reviewPasses,
  syncPullRequest,
  twoTaskPlan,
} from "./testkit/followThrough.ts";
import {
  assertNothingHeld,
  assignmentOf,
  assistantThread,
  claimIdea,
  controlAssignment,
  demandsOf,
  driver,
  freeOne,
  grantOutcomesOf,
  managedRootOf,
  noticesOf,
  occupyBoth,
  rootRowOf,
  slotOf,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
} from "./testkit/handoff.ts";
import { withEndpoint } from "./testkit/mcpEndpoint.ts";

// Real Git, verify commands and rebuilt servers on every path: a loaded machine only takes longer,
// and nothing here waits on time, so the limit is just where a real hang fails.
vi.setConfig({ testTimeout: 240_000 });

/**
 * A parent's whole handoff on the server's real stack: its plan waits for its owner holding nothing,
 * the assistant has no way to approve it, its approval waits like any other work, and from there its
 * children, integrate and pull request all run in the one slot of its root.
 */

const factoryService = Factory.FactoryService.FactoryService;

type Spy = ReturnType<typeof spyOnFactoryPort>;

const stack = (spy: Spy) => ({
  handoff: {},
  automaticTurnGate: true,
  assistantFactory: spy.wrap,
  assistantThreads: spy.threads,
});

const slotsInUse = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fd_assistant_slots`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]?.count ?? 0),
);

const launchesOf = (world: World, delivery: string) =>
  world.provider.started.filter(({ threadId }) =>
    threadId.startsWith(`factory-thread:${delivery}:`),
  );

/** A parent claimed and planned by its planner, at its gate with its slot let go by a tick. */
const atPlanGate = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    const { ref, root } = yield* claimIdea(world, "big", "parent");
    const planner = yield* world.launched(root);
    assert.isTrue(planner.threadId.startsWith(`factory-thread:${root}:`));
    assert.strictEqual((yield* slotOf(root))?.state, "held");
    yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTaskPlan });
    yield* world.endRun(planner.runId, "completed");
    assert.strictEqual((yield* stateOf(root)).status, "waiting");
    yield* tick;
    return { ref, root, planner };
  });

/** Every delivery row and item of the parent's source, for what a step must not have added. */
const childItemsOf = (root: FactoryDeliveryId) =>
  Effect.flatMap(stateOf(root), ({ children }) =>
    Effect.forEach(children, (child) =>
      Effect.flatMap(factoryService, (factory) => factory.get(child)).pipe(
        Effect.orDie,
        Effect.map(Option.getOrThrow),
        Effect.map(({ itemRef }) => ({ deliveryId: child, ref: itemRef })),
      ),
    ),
  );

describe("a parent, from its plan to its merge", () => {
  it.live(
    "waits for its owner holding nothing, and runs children, integrate and PR in one slot",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* factoryService;
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* startAssistantThread(world);
            const { ref, root } = yield* atPlanGate(world);

            // The plan gate parks: the owner's wait holds no capacity, and says what it needs.
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isUndefined(yield* slotOf(root));
            assert.deepStrictEqual(yield* managedRootOf(root), { state: "active", reason: null });
            assert.isTrue(
              (yield* noticesOf("big")).some((note) => note.includes("Approve, edit or replan")),
            );

            // Approved with both slots held by others: nothing of it runs, and it says so.
            const others = yield* occupyBoth(world);
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
            const shown = (yield* assistant.overview).assignments.find(
              ({ assignmentId }) => assignmentId === "big",
            );
            assert.isTrue(shown?.factory?.capacityWait);
            assert.isTrue(
              (yield* noticesOf("big")).some((note) =>
                note.includes("waiting for a project assistant slot"),
              ),
            );

            // A slot frees: the grant takes it, and everything after runs in that one slot.
            yield* freeOne(world, others[0]!);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.deepInclude(yield* grantOutcomesOf(root), {
              kind: "effect",
              outcome: "granted",
            });
            yield* drainFactory;
            const children = yield* childItemsOf(root);
            assert.lengthOf(children, 2);
            assert.deepStrictEqual(yield* demandsOf(root), []);
            const [first, second] = children;
            if (first === undefined || second === undefined) return assert.fail("No children.");
            // The children are its family, not roots of their own.
            for (const child of children) {
              assert.isUndefined(yield* managedRootOf(child.deliveryId));
              assert.isUndefined(yield* slotOf(child.deliveryId));
            }
            const firstAuthor = yield* world.launched(first.deliveryId);
            assert.strictEqual(yield* factory.familyRoot(firstAuthor.threadId), root);
            assert.strictEqual((yield* assignmentOf("big")).state, "running");

            // The second child's item is edited after the approval froze its task.
            yield* editTaskFile(world, second.ref, (text) =>
              text.replace(
                `title: ${twoTaskPlan.tasks[1]!.title}`,
                `title: ${twoTaskPlan.tasks[1]!.title}, and a footer`,
              ),
            );

            yield* authorCommits(firstAuthor.worktreePath, "feat: task one", "one\n");
            yield* world.endRun(firstAuthor.runId, "completed");
            yield* reviewPasses(world, first.deliveryId);
            assert.strictEqual((yield* stateOf(first.deliveryId)).status, "approved");
            yield* drainFactory;
            yield* drainOrchestration;

            // Its opening is refused before anything renders: no thread runs, and the owner is told.
            const refused = yield* stateOf(second.deliveryId);
            assert.strictEqual(refused.status, "blocked");
            if (refused.block?.reason !== "effect_failed") {
              return assert.fail("The child's launch did not fail.");
            }
            assert.include(
              refused.block.detail,
              Factory.FactoryAdmission.admissionRefusalText.scope_changed,
            );
            assert.lengthOf(launchesOf(world, second.deliveryId), 0);
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isTrue(
              (yield* noticesOf("big")).some((note) => note.includes(second.deliveryId)),
            );
            assert.isUndefined(yield* slotOf(root));

            // Put back as frozen, a resume opens it, in the root's slot again.
            yield* editTaskFile(world, second.ref, (text) =>
              text.replace(
                `title: ${twoTaskPlan.tasks[1]!.title}, and a footer`,
                `title: ${twoTaskPlan.tasks[1]!.title}`,
              ),
            );
            yield* controlAssignment("big", "resume");
            assert.isTrue(spy.calls.includes(`resume:${second.deliveryId}`));
            const secondAuthor = yield* world.launched(second.deliveryId);
            assert.lengthOf(launchesOf(world, second.deliveryId), 1);
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            assert.strictEqual(yield* slotsInUse, 2);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");

            yield* authorCommits(secondAuthor.worktreePath, "feat: task two", "two\n");
            yield* world.endRun(secondAuthor.runId, "completed");
            yield* reviewPasses(world, second.deliveryId);
            assert.strictEqual((yield* slotOf(root))?.state, "held");

            // Integrate runs in the same slot, and one pull request opens.
            const integrate = yield* awaitedRun(root);
            yield* tick;
            assert.strictEqual((yield* slotOf(root))?.state, "held");
            yield* factory.submitReview({ threadId: integrate.threadId, review: passingReview(2) });
            yield* world.endRun(integrate.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "pr_open");
            // One pull request for the whole branch, beside the other assignment's own.
            const { branch } = yield* stateOf(root);
            assert.lengthOf(
              world.pullRequestCalls.filter((call) => call.branch === branch),
              1,
            );

            // Its pull request open, the slot goes; only the owner's merge moves it on.
            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
            assert.isUndefined(yield* slotOf(root));
            assert.include(
              yield* noticesOf("big"),
              `PR ${fakePullRequest.url} open; review and merge.`,
            );
            const followed = secondAuthor.threadId;
            yield* syncPullRequest(
              followed,
              yield* linkOf(followed, fakePullRequest.number),
              "merged",
            );
            yield* drainFactory;
            assert.strictEqual((yield* stateOf(root)).status, "done");
            for (const child of children) {
              assert.strictEqual(yield* itemStatus(child.ref), "done");
            }
            assert.strictEqual(yield* itemStatus(ref), "done");

            yield* tick;
            assert.strictEqual((yield* assignmentOf("big")).state, "completed");
            const row = yield* rootRowOf(root);
            assert.deepStrictEqual(
              { state: row.state, reason: row.reason },
              { state: "retired", reason: "completed" },
            );
            assert.isNotNull(row.ending_at);
            yield* assertNothingHeld(root, "big");
            // Never one call to approve, stop or cancel: only its start, and the child's resume.
            assert.deepStrictEqual(
              spy.calls.filter(
                (call) =>
                  !call.startsWith("get:") &&
                  (call.endsWith(root) ||
                    children.some(({ deliveryId }) => call.endsWith(deliveryId))),
              ),
              [`start:${root}`, `resume:${second.deliveryId}`],
            );
          }),
        stack(spy),
      );
    },
    300_000,
  );

  it.live("the assistant has no path to approve a plan, and a rebuild changes none of that", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startAssistantThread(world);
          const { root } = yield* atPlanGate(world);
          const gate = yield* stateOf(root);

          // No tool of the assistant's names a plan, and each control it has leaves the plan be.
          assert.deepStrictEqual(
            Object.keys(AssistantToolkit.tools).filter((name) => /plan|approve/i.test(name)),
            [],
          );
          const unmoved = Effect.gen(function* () {
            const now = yield* stateOf(root);
            assert.strictEqual(now.status, "waiting");
            assert.deepStrictEqual(now.plan, gate.plan);
            assert.isFalse(now.planApproved);
            assert.deepStrictEqual(now.children, []);
          });
          const stopped = yield* Effect.exit(controlAssignment("big", "resume"));
          assert.strictEqual(stopped._tag, "Failure");
          yield* unmoved;
          const retried = yield* Effect.flip(controlAssignment("big", "retry"));
          assert.include(retried.message, "Resume keeps");
          yield* unmoved;
          assert.isUndefined(yield* slotOf(root));

          // Through the endpoint the same: the assistant's agent can reach only those controls, and
          // it cannot deliver or start the item another way.
          yield* withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const agent = yield* endpoint.callerOn(assistantThread);
              const refused = yield* agent.call("assistant_control", {
                assignmentId: "big",
                action: "resume",
              });
              assert.isTrue(refused.isError, refused.text);
              yield* unmoved;
              for (const tool of ["factory_deliver", "work_start_thread"]) {
                const direct = yield* agent.call(tool, { item: "anything" });
                assert.isTrue(direct.isError, tool);
              }
              yield* unmoved;
            }),
          );

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              yield* tick;
              yield* unmoved;
              assert.strictEqual((yield* assignmentOf("big")).state, "needs-input");
              assert.isUndefined(yield* slotOf(root));
            }),
            { orchestration: true },
          );
        }),
      stack(spy),
    );
  });

  it.live("the owner's rejection ends it, and the assistant follows", () => {
    const spy = spyOnFactoryPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          yield* startAssistantThread(world);
          const { ref, root } = yield* atPlanGate(world);
          yield* factory.rejectPlan(root);
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "cancelled");
          assert.deepStrictEqual((yield* stateOf(root)).children, []);
          assert.strictEqual(spy.count("cancel"), 0);

          yield* tick;
          assert.strictEqual((yield* assignmentOf("big")).state, "cancelled");
          assert.deepStrictEqual(yield* managedRootOf(root), {
            state: "retired",
            reason: "cancelled",
          });
          yield* assertNothingHeld(root, "big");
          assert.strictEqual(yield* itemStatus(ref), "todo");
        }),
      stack(spy),
    );
  });

  it.live(
    "an approval waiting at a restart keeps its demand, and creates its children once",
    () => {
      const spy = spyOnFactoryPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* factoryService;
            yield* startAssistantThread(world);
            const { root } = yield* atPlanGate(world);
            const others = yield* occupyBoth(world);
            yield* factory.approvePlan(root);
            yield* drainFactory;
            assert.isDefined((yield* stateOf(root)).admissionWait);

            // Their authors are cut by the restart, which blocks them and lets their slots go.
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                assert.isDefined((yield* stateOf(root)).admissionWait);
                assert.lengthOf(yield* demandsOf(root), 1);
                assert.deepStrictEqual((yield* stateOf(root)).children, []);
                assert.isDefined(others[0]);

                // The next pass sees both quiet, and the waiting approval takes a slot, once.
                yield* tick;
                yield* drainFactory;
                yield* tick;
                yield* drainFactory;
                const children = yield* childItemsOf(root);
                assert.lengthOf(children, 2);
                assert.deepStrictEqual(yield* demandsOf(root), []);
                assert.strictEqual((yield* slotOf(root))?.state, "held");
                const first = yield* world.launched(children[0]!.deliveryId);
                assert.lengthOf(launchesOf(world, children[0]!.deliveryId), 1);
                assert.lengthOf((yield* stateOf(root)).children, 2);
                yield* world.endRun(first.runId, "completed");
              }),
              { orchestration: true },
            );
          }),
        stack(spy),
      );
    },
  );
});
