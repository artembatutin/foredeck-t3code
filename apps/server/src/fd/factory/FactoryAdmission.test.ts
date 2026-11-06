import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import type { FactoryEffect } from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { linkOf, openSingle, reviewPasses, syncPullRequest } from "./testkit/followThrough.ts";

type Decision = FactoryAdmission.FactoryAdmissionDecision;
type Entry = FactoryAdmission.FactoryAdmissionEntry;

const proceed: Decision = { type: "proceed" };
const defer: Decision = { type: "defer" };

/**
 * An admission port that records every effect it is asked about, in order, and answers each with
 * `control.decide`, which a test changes as it goes.
 */
const recordingPort = () => {
  const asked: Array<Entry> = [];
  const control: {
    decide: (entry: Entry) => Effect.Effect<Decision, FactoryAdmission.FactoryAdmissionReadError>;
  } = { decide: () => Effect.succeed(proceed) };
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed("active"),
    enter: (entry) =>
      Effect.suspend(() => {
        asked.push(entry);
        return control.decide(entry);
      }),
    deferredDemand: () => Effect.succeed(false),
  };
  return { asked, control, port };
};

/** What the port was asked about one delivery's effects, in order. */
const askedFor = (asked: ReadonlyArray<Entry>, deliveryId: FactoryDeliveryId) =>
  asked
    .filter((entry) => entry.deliveryId === deliveryId)
    .map(({ root, effectId, effectType, fresh }) => ({ root, effectId, effectType, fresh }));

const service = Factory.FactoryService.FactoryService;

/** The thread's shell as orchestration has it; null when no such thread was ever created. */
const threadShell = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId),
  ).pipe(Effect.orDie);

/** Two tasks, so a parent has a first child and one it starts after it. */
const twoTasks = {
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
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names."],
      testPlan: [{ criterion: 1, check: "Read the first line.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "Both tasks change the export module.",
};

describe("FactoryAdmission's default", () => {
  it.effect("manages nothing: every root is never managed, every effect proceeds", () =>
    Effect.gen(function* () {
      const root = FactoryDeliveryId.make("delivery-1");
      const port = yield* FactoryAdmission.FactoryAdmission;
      assert.strictEqual(yield* port.management(root), "never");
      assert.deepStrictEqual(
        yield* port.enter({
          root,
          deliveryId: root,
          effectId: 1,
          effectType: "launch_thread",
          fresh: true,
        }),
        proceed,
      );
      assert.isFalse(yield* port.deferredDemand({ root, deliveryId: root, effectId: 1 }));
    }),
  );

  it("asks for a fresh read exactly for launches, turns, child creation and the PR stage", () => {
    const types: ReadonlyArray<FactoryEffect["type"]> = [
      "launch_thread",
      "send_fix_commit_turn",
      "check_settle",
      "run_command",
      "read_fallback_plan",
      "send_plan_retry_turn",
      "send_replan_turn",
      "read_fallback_review",
      "send_review_retry_turn",
      "send_repair_turn",
      "send_review_follow_up_turn",
      "record_approval",
      "open_pr",
      "close_out",
      "create_children",
      "start_child",
    ];
    assert.deepStrictEqual(types.filter(FactoryAdmission.isFreshEffect), [
      "launch_thread",
      "send_fix_commit_turn",
      "send_plan_retry_turn",
      "send_replan_turn",
      "send_review_retry_turn",
      "send_repair_turn",
      "send_review_follow_up_turn",
      "open_pr",
      "create_children",
    ]);
  });
});

describe("FactoryAdmission on the server's real stack", () => {
  it.live(
    "asks once about each effect of a single item through its merge, but its close-out",
    () => {
      const admission = recordingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { deliveryId, threadId: author } = yield* openSingle(world);
            const link = yield* linkOf(author, fakePullRequest.number);
            yield* syncPullRequest(author, link, "merged");

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "done");
            const root = deliveryId;
            assert.deepStrictEqual(askedFor(admission.asked, deliveryId), [
              { root, effectId: 1, effectType: "launch_thread", fresh: true },
              { root, effectId: 2, effectType: "check_settle", fresh: false },
              { root, effectId: 3, effectType: "run_command", fresh: false },
              { root, effectId: 4, effectType: "launch_thread", fresh: true },
              { root, effectId: 5, effectType: "record_approval", fresh: false },
              { root, effectId: 6, effectType: "open_pr", fresh: true },
            ]);
            // The seventh, the close-out, ran without being asked about.
            assert.strictEqual(state.effectsIssued, 7);
            assert.strictEqual(admission.asked.length, 6);
          }),
        { admission: admission.port },
      );
    },
  );

  it.live("asks about a parent's effects and its first child's with the parent as root", () => {
    const admission = recordingPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const planner = yield* world.startWith({ kind: "parent" });
          const root = planner.deliveryId;
          yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTasks });
          yield* world.endRun(planner.runId, "completed");
          yield* factory.approvePlan(root);
          yield* drainFactory;
          const [first, second] = (yield* stateOf(root)).children;
          if (first === undefined || second === undefined) return assert.fail("No children.");
          const author = yield* world.launched(first);
          yield* authorCommits(author.worktreePath, "feat: export the table as CSV", "0\n");
          yield* world.endRun(author.runId, "completed");
          yield* reviewPasses(world, first);

          assert.strictEqual((yield* stateOf(first)).status, "approved");
          assert.deepStrictEqual((yield* stateOf(root)).awaiting, {
            type: "child",
            deliveryId: second,
          });
          assert.deepStrictEqual(askedFor(admission.asked, root), [
            { root, effectId: 1, effectType: "launch_thread", fresh: true },
            { root, effectId: 2, effectType: "create_children", fresh: true },
            { root, effectId: 3, effectType: "start_child", fresh: false },
            { root, effectId: 4, effectType: "start_child", fresh: false },
          ]);
          assert.deepStrictEqual(askedFor(admission.asked, first), [
            { root, effectId: 1, effectType: "launch_thread", fresh: true },
            { root, effectId: 2, effectType: "check_settle", fresh: false },
            { root, effectId: 3, effectType: "run_command", fresh: false },
            { root, effectId: 4, effectType: "launch_thread", fresh: true },
            { root, effectId: 5, effectType: "record_approval", fresh: false },
          ]);
          assert.deepStrictEqual(askedFor(admission.asked, second), [
            { root, effectId: 1, effectType: "launch_thread", fresh: true },
          ]);
          assert.strictEqual(admission.asked.length, 10);
        }),
      { admission: admission.port },
    );
  });

  it.live("runs a deferred launch only once redispatched, and only once", () => {
    const admission = recordingPort();
    admission.control.decide = () => Effect.succeed(defer);
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
          yield* drainFactory;

          // Deferred: nothing launched, and the delivery awaits its launch, marked.
          const waiting = yield* stateOf(deliveryId);
          assert.strictEqual(waiting.status, "running");
          assert.strictEqual(waiting.awaiting?.type, "effect");
          assert.deepStrictEqual(waiting.admissionWait, { effectId: 1 });
          assert.deepStrictEqual(world.provider.started, []);
          assert.isNull(yield* threadShell(launchThreadId(deliveryId, 1)));
          // Another effect's redispatch runs nothing.
          assert.strictEqual(yield* factory.redispatch(deliveryId, 2), "stale");

          admission.control.decide = () => Effect.succeed(proceed);
          assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
          const author = yield* world.launched(deliveryId);
          assert.strictEqual(author.threadId, launchThreadId(deliveryId, 1));
          assert.notProperty(yield* stateOf(deliveryId), "admissionWait");

          // Launched: a second redispatch is stale and launches nothing more.
          assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
          yield* drainFactory;
          assert.strictEqual(world.provider.started.length, 1);
          // Asked before it waited, and again by the redispatched job.
          assert.deepStrictEqual(
            askedFor(admission.asked, deliveryId).map(({ effectId }) => effectId),
            [1, 1],
          );
        }),
      { admission: admission.port },
    );
  });

  it.live("redispatches nothing once the waiting delivery is cancelled", () => {
    const admission = recordingPort();
    admission.control.decide = () => Effect.succeed(defer);
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
          yield* drainFactory;
          yield* factory.cancel(deliveryId);
          admission.control.decide = () => Effect.succeed(proceed);

          assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
          yield* drainFactory;
          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "cancelled");
          assert.notProperty(state, "admissionWait");
          assert.deepStrictEqual(world.provider.started, []);
          assert.isNull(yield* threadShell(launchThreadId(deliveryId, 1)));
          assert.strictEqual(admission.asked.length, 1);
        }),
      { admission: admission.port },
    );
  });

  it.live("redispatches nothing while the effect's job is in flight", () => {
    const admission = recordingPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const entered = yield* Deferred.make<void>();
          const decided = yield* Deferred.make<Decision>();
          admission.control.decide = () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(decided)));
          const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
          // The launch's job waits on the port.
          yield* Deferred.await(entered);

          assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
          assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "running");
          assert.notProperty(yield* stateOf(deliveryId), "admissionWait");

          // The port defers it; once marked, a redispatch runs it.
          yield* Deferred.succeed(decided, defer);
          yield* drainFactory;
          assert.deepStrictEqual((yield* stateOf(deliveryId)).admissionWait, { effectId: 1 });
          assert.deepStrictEqual(world.provider.started, []);
          admission.control.decide = () => Effect.succeed(proceed);
          assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
          yield* world.launched(deliveryId);
          assert.strictEqual(world.provider.started.length, 1);
        }),
      { admission: admission.port },
    );
  });

  it.live.each([
    [
      "revoked",
      "The project assistant no longer authorizes this delivery. Authorize it again in the assistant and Resume, or cancel the delivery.",
    ],
    [
      "scope_changed",
      "The Work item changed after the project assistant authorized it. Restore the authorized content and Resume, or cancel the delivery.",
    ],
    [
      "unreadable",
      "The Work item could not be read to confirm what the project assistant authorized. Check its Work source, then Resume.",
    ],
    [
      "item_closed",
      "The Work item is done or cancelled. Reopen it and Resume, or cancel the delivery.",
    ],
    [
      "ended",
      "The project assistant assignment for this delivery has ended. Retry the assignment for a new delivery.",
    ],
  ] as const)(
    "blocks a launch refused as %s with its fixed text, launching nothing",
    ([category, text]) => {
      const admission = recordingPort();
      admission.control.decide = () => Effect.succeed({ type: "refuse", category });
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { deliveryId } = yield* Effect.flatMap(service, (factory) =>
              factory.start({ itemRef: world.itemRef }),
            );
            yield* drainFactory;

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            assert.isNull(state.awaiting);
            assert.deepStrictEqual(state.block, {
              reason: "effect_failed",
              effect: {
                id: 1,
                type: "launch_thread",
                role: "author",
                workspace: {
                  type: "worktree",
                  branch: state.branch,
                  baseRef: state.baseRef,
                },
              },
              detail: `Factory did not launch the author thread. ${text}`,
            });
            assert.deepStrictEqual(world.provider.started, []);
            assert.isNull(yield* threadShell(launchThreadId(deliveryId, 1)));
          }),
        { admission: admission.port },
      );
    },
  );
});
