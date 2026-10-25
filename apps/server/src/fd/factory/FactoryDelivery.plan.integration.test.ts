import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, type RunId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  drainOrchestration,
  ended,
  git,
  instanceId,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

/** A plan of two tasks, the second building on the first. */
const twoTaskPlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [
        {
          criterion: 1,
          check: "Export two rows and read back the CSV.",
          paths: ["src/export.test.ts"],
        },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names.", "An empty table exports the header."],
      testPlan: [
        { criterion: 1, check: "The first CSV line is the header.", paths: ["src/export.test.ts"] },
        { criterion: 2, check: "Export an empty table.", paths: ["src/export.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
  ],
  note: "Both tasks change the same module.",
};

const fenced = (value: unknown) =>
  `I read the item and the code.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** Reads the item's thread links; Factory's carry its origin. */
const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };

const submitPlan = (threadId: ThreadId, plan: unknown) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
    service.submitPlan({ threadId, plan }),
  ).pipe(Effect.orDie);

const snapshotOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) => service.get(deliveryId)).pipe(
    Effect.map((found) => toFactoryDelivery(Option.getOrThrow(found))),
    Effect.orDie,
  );

const attemptsOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
    runs.listByDelivery(deliveryId),
  ).pipe(Effect.map((runs) => runs.map(({ stage, outcome }) => [stage, outcome])));

/** The provider turn that started the run. */
const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((turn) => turn.runId === runId) ??
  assert.fail(`No provider turn started run ${runId}.`);

/** The `plan.json` the delivery's evidence holds, as written. */
const planEvidence = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(world.evidenceDir(deliveryId), "plan.json");
    return { file, evidence: JSON.parse(yield* fileSystem.readFileString(file)) };
  }).pipe(Effect.orDie);

/** The worktree has nothing staged, modified or untracked, so no evidence landed in it. */
const assertWorktreeClean = (worktreePath: string) =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]),
      "",
    );
  }).pipe(Effect.orDie);

/** The reference that ends each comment a delivery posts, naming it and the update. */
const reference = (deliveryId: FactoryDeliveryId) => `Factory delivery ${deliveryId}, update 1.`;

/** Untracked and ignored paths in a checkout. */
const untrackedIn = (cwd: string) =>
  git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]).pipe(
    Effect.map((status) =>
      status.split("\n").filter((line) => line.startsWith("??") || line.startsWith("!!")),
    ),
    Effect.orDie,
  );

describe("Factory parent delivery planning", () => {
  it.live("plans a Markdown parent and waits at the plan gate with the planner's plan", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const planner = yield* world.startWith({
          kind: "parent",
          runtimeModeCeiling: "auto-accept-edits",
        });
        const { deliveryId, threadId, runId, worktreePath } = planner;

        // The planner runs first, in plan mode on a new worktree of the delivery branch, with
        // the author's profile (the project sets no planner profile), under the ceiling.
        const planning = yield* stateOf(deliveryId);
        assert.strictEqual(planning.kind, "parent");
        assert.strictEqual(planning.stage, "plan");
        assert.strictEqual(planning.threads.planner, threadId);
        assert.isUndefined(planning.threads.author);
        const turn = turnOf(world, runId);
        assert.strictEqual(turn.runtimePolicy.interactionMode, "plan");
        assert.strictEqual(turn.runtimePolicy.runtimeMode, "auto-accept-edits");
        assert.include(turn.message.text, `Factory plan for Work item ${world.itemKey}`);
        assert.include(turn.message.text, "`factory_submit_plan`");
        const { thread } = yield* threadProjection(threadId);
        assert.deepStrictEqual(thread.modelSelection, { instanceId, model: "test-model" });
        assert.strictEqual(thread.worktreePath, worktreePath);
        assert.strictEqual(thread.branch, planning.branch);
        assert.notStrictEqual(worktreePath, world.root);
        const work = yield* WorkService.WorkService;
        const { links } = yield* work.listLinks(reader, { ref: world.itemRef });
        assert.deepStrictEqual(
          links.map((link) => [link.threadId, link.origin]),
          [[threadId, "factory"]],
        );

        // The planner submits through the tool while its run goes on; the plan is acted on
        // once the run completes.
        const accepted = yield* submitPlan(threadId, twoTaskPlan);
        assert.strictEqual(accepted.deliveryId, deliveryId);
        assert.strictEqual((yield* stateOf(deliveryId)).status, "running");
        yield* world.endRun(runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.isNull(state.awaiting);
        assert.isNull(state.block);
        assert.strictEqual(state.plan?.source, "mcp");
        assert.strictEqual(state.plan?.round, 1);
        assert.deepStrictEqual(
          state.plan?.tasks.map((task) => task.id),
          ["export-csv", "export-header"],
        );
        assert.strictEqual(state.plan?.note, twoTaskPlan.note);
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", null],
        ]);
        assert.strictEqual(
          (yield* snapshotOf(deliveryId)).needsYou,
          "A plan of 2 tasks awaits your approval.",
        );

        // plan.json is under T3 home, never in the worktree or the project's checkout.
        const { file, evidence } = yield* planEvidence(world, deliveryId);
        assert.strictEqual(state.plan?.evidencePath, file);
        assert.deepInclude(evidence, { deliveryId, round: 1, source: "mcp", threadId });
        assert.deepStrictEqual(evidence.plan, twoTaskPlan);
        assert.isFalse(file.startsWith(worktreePath));
        assert.isFalse(file.startsWith(world.root));
        yield* assertWorktreeClean(worktreePath);
        // The checkout gains no file either; only the item's task file holds the comment below.
        assert.deepStrictEqual(yield* untrackedIn(world.root), []);

        // One waiting comment, posted once, from Factory.
        assert.deepStrictEqual(
          world.commentCalls.map(({ actor, input }) => [actor.label, input.body]),
          [
            [
              "Factory",
              `Factory is waiting for your decision on this item in Foredeck. ${reference(deliveryId)}`,
            ],
          ],
        );
        // Nothing more happens while the plan waits for its owner.
        assert.deepStrictEqual(
          world.provider.started.map((started) => started.threadId),
          [threadId],
        );
      }),
    ),
  );

  it.live("blocks a parent whose planner submits an empty plan, with the planner's note", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId, runId, worktreePath } = yield* world.startWith({
          kind: "parent",
        });
        const note = "The export button already exists.\nNothing is left to plan.";

        const accepted = yield* submitPlan(threadId, { tasks: [], note });
        assert.deepStrictEqual(accepted.plan.tasks, []);
        yield* world.endRun(runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "plan");
        assert.deepStrictEqual(state.block, { reason: "plan_empty", note });
        assert.strictEqual(
          (yield* snapshotOf(deliveryId)).needsYou,
          "The planner found nothing to plan: The export button already exists. Nothing is left to plan.",
        );
        const { evidence } = yield* planEvidence(world, deliveryId);
        assert.deepStrictEqual(evidence.plan, { tasks: [], note });
        yield* assertWorktreeClean(worktreePath);
        assert.deepStrictEqual(
          world.commentCalls.map(({ input }) => input.body),
          [
            `Factory is blocked on this item and needs you. The planner found nothing to plan: The export button already exists. Nothing is left to plan. Resume or cancel the delivery in Foredeck. ${reference(deliveryId)}`,
          ],
        );
      }),
    ),
  );

  it.live("takes the fenced plan of a planner run that ends without the tool", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId, runId, worktreePath } = yield* world.startWith({
          kind: "parent",
        });

        yield* world.provider.say(turnOf(world, runId), fenced(twoTaskPlan));
        yield* world.endRun(runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.stage, "approve_plan");
        assert.strictEqual(state.plan?.source, "fallback");
        assert.strictEqual(state.plan?.tasks.length, 2);
        const { evidence } = yield* planEvidence(world, deliveryId);
        assert.deepInclude(evidence, { source: "fallback", threadId, round: 1 });
        yield* assertWorktreeClean(worktreePath);
      }),
    ),
  );

  it.live("asks once for a corrected plan after an invalid fenced plan", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, threadId, runId } = yield* world.startWith({ kind: "parent" });

        // No test plan entry for the task's one criterion.
        yield* world.provider.say(
          turnOf(world, runId),
          fenced({ tasks: [{ ...twoTaskPlan.tasks[0], testPlan: [] }] }),
        );
        yield* world.endRun(runId, "completed");

        // The planner thread gets one retry turn naming the problem.
        const retrying = yield* stateOf(deliveryId);
        assert.strictEqual(retrying.status, "running");
        assert.strictEqual(retrying.stage, "plan");
        assert.strictEqual(retrying.invalidSubmissions, 1);
        assert.isNull(retrying.plan);
        if (retrying.awaiting?.type !== "run") return assert.fail("The retry turn is not running.");
        const retry = retrying.awaiting;
        assert.strictEqual(retry.threadId, threadId);
        assert.notStrictEqual(retry.runId, runId);
        assert.strictEqual(yield* runReached(retry.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        const retryText = turnOf(world, retry.runId).message.text;
        assert.include(retryText, "Factory could not accept your plan:");
        assert.include(
          retryText,
          'Task "export-csv": acceptance criterion 1 has no test plan entry; add one naming criterion 1.',
        );
        assert.include(retryText, "This is the last attempt before the delivery blocks.");
        assert.deepStrictEqual(
          world.provider.started.map((started) => started.threadId),
          [threadId, threadId],
        );

        // The corrected plan, again only in the fenced block, takes the delivery to the gate.
        yield* world.provider.say(turnOf(world, retry.runId), fenced(twoTaskPlan));
        yield* world.endRun(retry.runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "waiting");
        assert.strictEqual(state.plan?.source, "fallback");
        assert.deepStrictEqual(yield* attemptsOf(deliveryId), [
          ["plan", "passed"],
          ["approve_plan", null],
        ]);
      }),
    ),
  );
});
