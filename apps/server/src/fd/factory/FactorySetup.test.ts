import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import {
  type FactoryCommand,
  FactoryDeliveryId,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProcessRunner from "../../processRunner.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import { childDeliveryId } from "./FactoryChildren.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import { renderAuthorPrompt } from "./prompts/author.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  instanceId,
  runReached,
  stateOf,
  threadProjection,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * The project's setup command on the server's real stack: a Git project, the fake provider and
 * the server's own process runs. Setup runs in an author's worktree after core prepared it and
 * before the author's opening turn, never for any other thread or turn. Nothing sleeps: a test
 * holds a setup run back through the harness's process hook, and every step drains.
 */

const service = Factory.FactoryService.FactoryService;
const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

/** A command that runs `script` with the current Node executable, as Factory runs commands. */
const node = (script: string): FactoryCommand => ({
  executable: process.execPath,
  args: ["-e", script],
});

/** A setup command that appends the directory it ran in to `marker`, one line per run. */
const markingSetup = (marker: string) =>
  node(`require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.cwd() + "\\n")`);

/** Passes once the branch has committed `fixed.txt`, so a delivery gets one fix-verify round. */
const verifyUntilFixed = node(`process.exit(require("node:fs").existsSync("fixed.txt") ? 0 : 3)`);
const passingVerify = node(`console.log("checks passed")`);

/** Sets the project's setup command, keeping its other Factory settings. */
const useSetup = (world: World, setupCommand: FactoryCommand | null) =>
  Effect.gen(function* () {
    const settings = yield* Factory.FactorySettings.FactorySettings;
    const current = yield* settings.get(world.projectId);
    yield* settings.set(world.projectId, { ...current, setupCommand });
  }).pipe(Effect.orDie);

/** Whether the process runner was asked to run `command`. */
const isRun = (input: ProcessRunner.ProcessRunInput, command: FactoryCommand) =>
  input.command === command.executable &&
  JSON.stringify(input.args) === JSON.stringify(command.args);

/**
 * Holds the first run of `command` twice: before it starts, until `start` is released, and once
 * it ended, until `finish` is released. `started` and `ended` complete as it gets there.
 */
const holdFirstRun = (world: World, command: FactoryCommand) =>
  Effect.gen(function* () {
    const hold = {
      started: yield* Deferred.make<ProcessRunner.ProcessRunInput>(),
      start: yield* Deferred.make<void>(),
      ended: yield* Deferred.make<void>(),
      finish: yield* Deferred.make<void>(),
    };
    world.processes.around = (input, run) =>
      isRun(input, command)
        ? Deferred.succeed(hold.started, input).pipe(
            Effect.andThen(Deferred.await(hold.start)),
            Effect.andThen(run(input)),
            Effect.tap(() =>
              Deferred.succeed(hold.ended, undefined).pipe(
                Effect.andThen(Deferred.await(hold.finish)),
              ),
            ),
          )
        : run(input);
    return hold;
  });

/** The directories the setup command recorded, in run order. */
const markedRuns = (marker: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(marker))) return [];
    return (yield* fileSystem.readFileString(marker)).split("\n").filter(Boolean);
  }).pipe(Effect.orDie);

/** The setup logs in the delivery's evidence folder, in run order. */
const setupLogs = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = world.evidenceDir(deliveryId);
    if (!(yield* fileSystem.exists(directory))) return [];
    return (yield* fileSystem.readDirectory(directory))
      .filter((name) => /^setup-\d+\.log$/.test(name))
      .toSorted();
  }).pipe(Effect.orDie);

const realPath = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.realPath(path)).pipe(
    Effect.orDie,
  );

/** A marker file named `name` at the root of the test's T3 home, outside the project. */
const markerIn = (world: World, name: string) =>
  Effect.map(Path.Path, (path) => path.join(world.t3Home, name));

/** The thread and run the delivery awaits, once the provider has started the run's turn. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);

/** Commits `name` in the worktree, as an author agent would during its turn. */
const commitFile = (worktreePath: string, name: string, subject: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(worktreePath, name), `${name}\n`);
    yield* git(worktreePath, ["add", "-A"]);
    yield* git(worktreePath, [...identity, "commit", "--no-verify", "-m", subject]);
  }).pipe(Effect.orDie);

/** The thread's shell; null when no thread has that id. */
const threadShell = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId),
  ).pipe(Effect.orDie);

const openingMessageId = (deliveryId: FactoryDeliveryId) =>
  MessageId.make(`factory-launch-message:${deliveryId}:1`);

const worktreeStatus = (worktreePath: string) =>
  git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);

describe("Factory setup before a single item's author", () => {
  it.live("runs once in the new worktree, after core prepared it and before the opening turn", () =>
    withProject(passingVerify, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const marker = yield* markerIn(world, "setup-runs");
        const setup = markingSetup(marker);
        yield* useSetup(world, setup);
        const branchStart = yield* git(world.root, ["rev-parse", "main"]);
        const hold = yield* holdFirstRun(world, setup);

        const { deliveryId } = yield* factory.start({ itemRef: world.itemRef }).pipe(Effect.orDie);
        const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);

        // It starts in the thread's new worktree, with no turn sent on the thread yet.
        const input = yield* Deferred.await(hold.started);
        const prepared = yield* threadProjection(threadId).pipe(Effect.orDie);
        const worktreePath = prepared.thread.worktreePath ?? assert.fail("No worktree yet.");
        assert.strictEqual(input.cwd, worktreePath);
        assert.isTrue(yield* world.exists(worktreePath));
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "HEAD"]), branchStart);
        assert.deepStrictEqual(prepared.messages, []);
        assert.deepStrictEqual(prepared.runs, []);
        yield* Deferred.succeed(hold.start, undefined);

        // It has finished, and still no turn was sent.
        yield* Deferred.await(hold.ended);
        assert.deepStrictEqual(yield* markedRuns(marker), [yield* realPath(worktreePath)]);
        const afterSetup = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(afterSetup.messages, []);
        assert.deepStrictEqual(afterSetup.runs, []);
        assert.deepStrictEqual(world.provider.started, []);
        yield* Deferred.succeed(hold.finish, undefined);

        // Then the author's opening turn: the author prompt under the launch's message id, on the
        // launch's thread, as a launch without setup sends it.
        const author = yield* world.launched(deliveryId);
        assert.strictEqual(author.threadId, threadId);
        assert.strictEqual(author.worktreePath, worktreePath);
        const state = yield* stateOf(deliveryId);
        const item = yield* Effect.flatMap(WorkService.WorkService, (work) =>
          work.getItem(reader, { ref: world.itemRef }),
        ).pipe(Effect.orDie);
        const opening = renderAuthorPrompt({ item, branch: state.branch });
        const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(
          thread.messages.map(({ id, text }) => ({ id, text })),
          [{ id: openingMessageId(deliveryId), text: opening }],
        );
        assert.deepStrictEqual(
          thread.runs.map(({ id, userMessageId }) => ({ id, userMessageId })),
          [{ id: author.runId, userMessageId: openingMessageId(deliveryId) }],
        );
        const [turn] = world.provider.started;
        assert.strictEqual(world.provider.started.length, 1);
        assert.strictEqual(turn?.runId, author.runId);
        assert.strictEqual(turn?.message.text, opening);
        assert.strictEqual(turn?.runtimePolicy.cwd, worktreePath);
        assert.strictEqual(turn?.runtimePolicy.interactionMode, "default");
        // The task baseline is where the branch started, as without setup.
        assert.strictEqual(state.baseline, branchStart);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId, runId: author.runId });

        // One run, logged in the delivery's evidence under T3 home, leaving the trees clean.
        assert.deepStrictEqual(yield* markedRuns(marker), [yield* realPath(worktreePath)]);
        assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log"]);
        assert.strictEqual(yield* worktreeStatus(worktreePath), "");
        assert.strictEqual(yield* worktreeStatus(world.root), world.rootStatus);
      }),
    ),
  );
});

/** A one-task plan, so the parent integrates right after its child. */
const oneTaskPlan = {
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

const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export does what the criterion says.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

describe("Factory setup in a parent delivery", () => {
  it.live(
    "runs before a child's author in the parent's worktree, never for the planner, a repair or a reviewer",
    () =>
      withProject(verifyUntilFixed, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const marker = yield* markerIn(world, "setup-runs");
          const setup = markingSetup(marker);
          yield* useSetup(world, setup);

          // The planner's launch runs no setup.
          const planner = yield* world.startWith({ kind: "parent" });
          const parentId = planner.deliveryId;
          assert.deepStrictEqual(yield* markedRuns(marker), []);
          yield* factory
            .submitPlan({ threadId: planner.threadId, plan: oneTaskPlan })
            .pipe(Effect.orDie);
          yield* world.endRun(planner.runId, "completed");
          assert.strictEqual((yield* stateOf(parentId)).status, "waiting");
          assert.deepStrictEqual(yield* markedRuns(marker), []);

          // The child's author: setup runs in the parent's worktree before the author's launch,
          // which then prepares the workspace and starts the opening turn as any launch does.
          const hold = yield* holdFirstRun(world, setup);
          yield* factory.approvePlan(parentId).pipe(Effect.orDie);
          const childId = childDeliveryId(parentId, FactoryTaskId.make("export-csv"));
          const childThread = FactoryThreadEffects.launchThreadId(childId, 1);
          assert.strictEqual((yield* Deferred.await(hold.started)).cwd, planner.worktreePath);
          yield* Deferred.succeed(hold.start, undefined);
          yield* Deferred.await(hold.ended);
          assert.isNull(yield* threadShell(childThread));
          assert.deepStrictEqual(
            world.provider.started.map(({ threadId }) => threadId),
            [planner.threadId],
          );
          yield* Deferred.succeed(hold.finish, undefined);
          const author = yield* world.launched(childId);
          assert.strictEqual(author.threadId, childThread);
          assert.strictEqual(author.worktreePath, planner.worktreePath);
          assert.deepStrictEqual(
            (yield* threadProjection(childThread).pipe(Effect.orDie)).messages.map(({ id }) => id),
            [openingMessageId(childId)],
          );
          const worktree = yield* realPath(planner.worktreePath);
          assert.deepStrictEqual(yield* markedRuns(marker), [worktree]);

          // Verify fails, so the author gets a fix-verify turn on its thread: no setup.
          yield* authorCommits(author.worktreePath, "feat: export the table as CSV");
          yield* world.endRun(author.runId, "completed");
          const repair = yield* awaitedRun(childId);
          assert.strictEqual(repair.threadId, author.threadId);
          assert.notStrictEqual(repair.runId, author.runId);
          yield* commitFile(author.worktreePath, "fixed.txt", "fix: pass the checks");
          yield* world.endRun(repair.runId, "completed");

          // Verified: the child's reviewer launches on a thread of its own, without setup.
          const reviewer = yield* awaitedRun(childId);
          assert.notStrictEqual(reviewer.threadId, author.threadId);
          yield* factory
            .submitReview({ threadId: reviewer.threadId, review: passingReview })
            .pipe(Effect.orDie);
          yield* world.endRun(reviewer.runId, "completed");
          assert.strictEqual((yield* stateOf(childId)).status, "approved");

          // The parent verifies its branch and launches its integrate reviewer, without setup.
          const integrate = yield* awaitedRun(parentId);
          assert.strictEqual((yield* stateOf(parentId)).stage, "integrate");
          assert.notInclude([planner.threadId, author.threadId], integrate.threadId);

          // One setup run in all, the child author's, logged in the child's evidence only.
          assert.deepStrictEqual(yield* markedRuns(marker), [worktree]);
          assert.deepStrictEqual(yield* setupLogs(world, childId), ["setup-1.log"]);
          assert.deepStrictEqual(yield* setupLogs(world, parentId), []);
        }),
      ),
  );
});

describe("Factory setup failures", () => {
  it.live.each([
    {
      name: "exits non-zero",
      command: node(`console.log("token=hunter2"); process.exit(3)`),
      ending: "The setup command exited with code 3.",
      output: true,
      timesOut: false,
    },
    {
      name: "is ended by a signal",
      command: node(`console.log("token=hunter2"); process.kill(process.pid, "SIGKILL")`),
      ending: "A signal ended the setup command.",
      output: true,
      timesOut: false,
    },
    {
      name: "times out under the verify timeout",
      command: node(`console.log("token=hunter2"); setInterval(() => {}, 1000)`),
      ending: "The setup command did not finish within 30 minutes.",
      output: false,
      timesOut: true,
    },
    {
      name: "has a missing executable",
      command: { executable: "fd-factory-no-such-setup", args: ["--token=hunter2"] },
      ending: "Factory could not start the setup command; check its executable.",
      output: false,
      timesOut: false,
    },
  ])("blocks a launch whose setup $name, sends no turn, and resumes into setup", (failure) =>
    withProject(passingVerify, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* useSetup(world, failure.command);
        const timeouts: Array<Duration.Input | undefined> = [];
        world.processes.around = (input, run) => {
          if (!isRun(input, failure.command)) return run(input);
          timeouts.push(input.timeout);
          // A millisecond stands in for the project's verify timeout; the command never ends.
          return run(failure.timesOut ? { ...input, timeout: Duration.millis(1) } : input);
        };

        const { deliveryId } = yield* factory.start({ itemRef: world.itemRef }).pipe(Effect.orDie);
        yield* drainFactory;

        // Blocked with fixed text naming how the setup ended, and nothing of its output.
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.stage, "author");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          `Factory could not launch the author thread. ${failure.ending}`,
        );
        assert.notInclude(JSON.stringify(state), "hunter2");
        assert.deepStrictEqual(state.threads, {});
        // It ran once, under the project's verify timeout.
        assert.strictEqual(timeouts.length, 1);
        assert.isTrue(
          Duration.equals(Duration.fromInputUnsafe(timeouts[0] ?? 0), Duration.minutes(30)),
        );

        // The launch's thread is in its worktree with no turn sent.
        const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);
        const blocked = yield* threadProjection(threadId).pipe(Effect.orDie);
        const worktreePath = blocked.thread.worktreePath ?? assert.fail("No worktree.");
        assert.deepStrictEqual(blocked.messages, []);
        assert.deepStrictEqual(blocked.runs, []);
        assert.deepStrictEqual(world.provider.started, []);

        // Its log is the delivery's evidence under T3 home, never the worktree's.
        assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log"]);
        const log = path.join(world.evidenceDir(deliveryId), "setup-1.log");
        if (failure.output) {
          assert.include(yield* fileSystem.readFileString(log).pipe(Effect.orDie), "hunter2");
        }
        assert.strictEqual(yield* worktreeStatus(worktreePath), "");

        // Resume runs setup again on the same thread, then starts the author.
        const marker = yield* markerIn(world, "setup-runs");
        yield* useSetup(world, markingSetup(marker));
        yield* factory.resume(deliveryId).pipe(Effect.orDie);
        const author = yield* world.launched(deliveryId);
        assert.strictEqual(author.threadId, threadId);
        assert.strictEqual(author.worktreePath, worktreePath);
        assert.deepStrictEqual(yield* markedRuns(marker), [yield* realPath(worktreePath)]);
        assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log", "setup-2.log"]);
        assert.deepStrictEqual(
          (yield* threadProjection(threadId).pipe(Effect.orDie)).messages.map(({ id }) => id),
          [openingMessageId(deliveryId)],
        );
        assert.deepStrictEqual(
          world.provider.started.map(({ runId }) => runId),
          [author.runId],
        );
      }),
    ),
  );
});

/** Factory's thread effects and verify runner as the worker uses them, on the harness's server. */
const threadEffects = Layer.mergeAll(
  FactoryThreadEffects.layer,
  FactoryVerifyRunner.layer.pipe(Layer.provide(FactoryEvidence.layer)),
).pipe(
  Layer.provide(ProviderRegistryMock.layer()),
  // Read only for a delivery with a runtime-mode ceiling, which these have none of.
  Layer.provide(Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({})),
);

/** An unstored single-item delivery of the world's item and its author launch, on `branch`. */
const replayedDelivery = (world: World, name: string, branch: string) => {
  const delivery: FactoryDeliveryStore.StoredFactoryDelivery = {
    deliveryId: FactoryDeliveryId.make(name),
    projectId: world.projectId,
    itemRef: world.itemRef,
    parentId: null,
    state: queuedDeliveryState({ branch, baseRef: "main" }),
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  const launch = {
    id: 1,
    type: "launch_thread",
    role: "author",
    workspace: { type: "worktree", branch, baseRef: "main" },
  } as const;
  return { delivery, launch };
};

describe("Factory setup on a replayed author launch", () => {
  it.live(
    "runs nothing again once the opening turn exists, with setup or without, and returns its run",
    () =>
      withProject(passingVerify, (world) =>
        Effect.gen(function* () {
          const effects = yield* FactoryThreadEffects.FactoryThreadEffects;
          const runner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
          const marker = yield* markerIn(world, "setup-runs");
          const { delivery, launch } = replayedDelivery(world, "delivery-sent", "feature/sent");
          const setup = (worktreePath: string) =>
            runner.setup({
              deliveryId: delivery.deliveryId,
              worktreePath,
              command: markingSetup(marker),
              timeoutMinutes: 30,
            });

          const first = yield* effects.launchThread(delivery, launch, setup);
          const replayed = yield* effects.launchThread(delivery, launch, setup);
          // The setup command cleared since: the launch replays the opening turn it sent, and
          // neither queues nor prepares another.
          const withoutSetup = yield* effects.launchThread(delivery, launch);

          assert.deepStrictEqual(replayed, first);
          assert.deepStrictEqual(withoutSetup, first);
          assert.deepStrictEqual(yield* setupLogs(world, delivery.deliveryId), ["setup-1.log"]);
          assert.strictEqual((yield* markedRuns(marker)).length, 1);
          const thread = yield* threadProjection(first.threadId).pipe(Effect.orDie);
          assert.deepStrictEqual(
            thread.runs.map(({ id, userMessageId }) => ({ id, userMessageId })),
            [{ id: first.runId, userMessageId: openingMessageId(delivery.deliveryId) }],
          );
        }).pipe(Effect.provide(threadEffects), Effect.orDie),
      ),
  );

  it.live("runs setup again and sends one opening turn when the first try sent none", () =>
    withProject(passingVerify, (world) =>
      Effect.gen(function* () {
        const effects = yield* FactoryThreadEffects.FactoryThreadEffects;
        const runner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
        const marker = yield* markerIn(world, "setup-runs");
        const { delivery, launch } = replayedDelivery(world, "delivery-unsent", "feature/unsent");
        const setupWith = (command: FactoryCommand) => (worktreePath: string) =>
          runner.setup({
            deliveryId: delivery.deliveryId,
            worktreePath,
            command,
            timeoutMinutes: 30,
          });
        const threadId = FactoryThreadEffects.launchThreadId(delivery.deliveryId, 1);

        const failed = yield* Effect.flip(
          effects.launchThread(delivery, launch, setupWith(node("process.exit(3)"))),
        );
        assert.strictEqual(failed._tag, "FactorySetupFailedError");
        const unsent = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(unsent.messages, []);
        assert.deepStrictEqual(unsent.runs, []);

        const replayed = yield* effects.launchThread(
          delivery,
          launch,
          setupWith(markingSetup(marker)),
        );
        const again = yield* effects.launchThread(
          delivery,
          launch,
          setupWith(markingSetup(marker)),
        );

        assert.strictEqual(replayed.threadId, threadId);
        assert.strictEqual(replayed.worktreePath, unsent.thread.worktreePath);
        assert.deepStrictEqual(again, replayed);
        assert.deepStrictEqual(yield* setupLogs(world, delivery.deliveryId), [
          "setup-1.log",
          "setup-2.log",
        ]);
        assert.strictEqual((yield* markedRuns(marker)).length, 1);
        const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(
          thread.messages.map(({ id }) => id),
          [openingMessageId(delivery.deliveryId)],
        );
        assert.deepStrictEqual(
          thread.runs.map(({ id }) => id),
          [replayed.runId],
        );
      }).pipe(Effect.provide(threadEffects), Effect.orDie),
    ),
  );
});

describe("Factory setup and cancel", () => {
  it.live("sends no opening turn for a delivery cancelled while its setup runs", () =>
    withProject(passingVerify, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const marker = yield* markerIn(world, "setup-runs");
        const setup = markingSetup(marker);
        yield* useSetup(world, setup);
        const hold = yield* holdFirstRun(world, setup);

        const { deliveryId } = yield* factory.start({ itemRef: world.itemRef }).pipe(Effect.orDie);
        const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);
        yield* Deferred.await(hold.started);
        yield* factory.cancel(deliveryId).pipe(Effect.orDie);
        yield* Deferred.succeed(hold.start, undefined);
        yield* Deferred.succeed(hold.finish, undefined);
        yield* drainFactory;
        yield* drainOrchestration;
        yield* drainFactory;

        // The setup ran to its end, and no author turn followed it.
        assert.strictEqual((yield* markedRuns(marker)).length, 1);
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "cancelled");
        assert.deepStrictEqual(state.threads, {});
        const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(thread.messages, []);
        assert.deepStrictEqual(thread.runs, []);
        assert.deepStrictEqual(world.provider.started, []);
      }),
    ),
  );
});

describe("Factory setup on a replayed launch into an existing worktree", () => {
  it.live("runs setup before the launch once, and replays the opening turn after it", () =>
    withProject(passingVerify, (world) =>
      Effect.gen(function* () {
        const effects = yield* FactoryThreadEffects.FactoryThreadEffects;
        const runner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
        const path = yield* Path.Path;
        const marker = yield* markerIn(world, "setup-runs");
        const branch = "feature/shared";
        const worktreePath = path.join(world.t3Home, "shared-worktree");
        yield* git(world.root, ["worktree", "add", "-b", branch, worktreePath, "main"]);
        const deliveryId = FactoryDeliveryId.make("delivery-shared");
        const delivery: FactoryDeliveryStore.StoredFactoryDelivery = {
          ...replayedDelivery(world, deliveryId, branch).delivery,
          state: queuedDeliveryState({ branch, baseRef: "main", worktreePath }),
        };
        const launch = {
          id: 1,
          type: "launch_thread",
          role: "author",
          workspace: { type: "existing_worktree", worktreePath },
        } as const;
        const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        // Records whether the thread existed when setup ran.
        const threadAtSetup: Array<boolean> = [];
        const setup = (cwd: string) =>
          orchestrator.getThreadShell(threadId).pipe(
            Effect.orDie,
            Effect.tap((shell) => Effect.sync(() => threadAtSetup.push(shell !== null))),
            Effect.andThen(
              runner.setup({
                deliveryId,
                worktreePath: cwd,
                command: markingSetup(marker),
                timeoutMinutes: 30,
              }),
            ),
          );

        const first = yield* effects.launchThread(delivery, launch, setup);
        const replayed = yield* effects.launchThread(delivery, launch, setup);
        const withoutSetup = yield* effects.launchThread(delivery, launch);

        // Setup ran once, in the worktree, before the launch made the thread.
        assert.deepStrictEqual(threadAtSetup, [false]);
        assert.deepStrictEqual(yield* markedRuns(marker), [yield* realPath(worktreePath)]);
        assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log"]);
        assert.deepStrictEqual(replayed, first);
        assert.deepStrictEqual(withoutSetup, first);
        assert.strictEqual(first.threadId, threadId);
        assert.strictEqual(first.worktreePath, worktreePath);
        const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
        assert.deepStrictEqual(
          thread.runs.map(({ id, userMessageId }) => ({ id, userMessageId })),
          [{ id: first.runId, userMessageId: openingMessageId(deliveryId) }],
        );
      }).pipe(Effect.provide(threadEffects), Effect.orDie),
    ),
  );
});

/** Plans the one-task parent and leaves it waiting at the plan gate. */
const plannedParent = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan: oneTaskPlan }).pipe(Effect.orDie);
    yield* world.endRun(planner.runId, "completed");
    const childId = childDeliveryId(planner.deliveryId, FactoryTaskId.make("export-csv"));
    return { planner, childId, childThread: FactoryThreadEffects.launchThreadId(childId, 1) };
  });

/**
 * Holds the project setup script core starts for `threadId` until `fail` is released, then fails
 * it in `operation`, as a terminal that cannot open or take the command does. `started`
 * completes once core has asked for it.
 */
const failingScript = (
  world: World,
  threadId: ThreadId,
  operation: "openTerminal" | "writeCommand",
) =>
  Effect.gen(function* () {
    const script = {
      started: yield* Deferred.make<void>(),
      fail: yield* Deferred.make<void>(),
    };
    world.setupScripts.runForThread = (input) =>
      input.threadId !== threadId
        ? Effect.succeed({ status: "no-script" as const })
        : Deferred.succeed(script.started, undefined).pipe(
            Effect.andThen(Deferred.await(script.fail)),
            Effect.andThen(
              Effect.fail(
                new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                  threadId: input.threadId,
                  worktreePath: input.worktreePath,
                  operation,
                  cause: "The terminal is unavailable.",
                }),
              ),
            ),
          );
    return script;
  });

describe("Factory setup and core's workspace preparation", () => {
  it.live.each(["openTerminal", "writeCommand"] as const)(
    "starts no child author while core starts the project's setup script, nor once it fails (%s)",
    (operation) =>
      withProject(passingVerify, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const marker = yield* markerIn(world, "setup-runs");
          yield* useSetup(world, markingSetup(marker));
          const { planner, childId, childThread } = yield* plannedParent(world);
          const script = yield* failingScript(world, childThread, operation);

          yield* factory.approvePlan(planner.deliveryId).pipe(Effect.orDie);

          // Factory's setup ran in the shared worktree, then the launch; core holds the author's
          // opening turn while it starts the project's own setup script.
          yield* Deferred.await(script.started);
          assert.deepStrictEqual(yield* markedRuns(marker), [
            yield* realPath(planner.worktreePath),
          ]);
          const preparing = yield* threadProjection(childThread).pipe(Effect.orDie);
          assert.deepStrictEqual(
            preparing.runs.map(({ userMessageId, status }) => ({ userMessageId, status })),
            [{ userMessageId: openingMessageId(childId), status: "preparing" }],
          );
          assert.deepStrictEqual(
            world.provider.started.map(({ threadId }) => threadId),
            [planner.threadId],
          );

          // Core fails the run when the script cannot start, so the author never starts.
          yield* Deferred.succeed(script.fail, undefined);
          yield* drainFactory;
          yield* drainOrchestration;
          yield* drainFactory;
          const [run] = (yield* threadProjection(childThread).pipe(Effect.orDie)).runs;
          if (run === undefined) return assert.fail("The child's launch recorded no run.");
          assert.strictEqual(run.status, "failed");
          const child = yield* stateOf(childId);
          assert.strictEqual(child.status, "blocked");
          assert.deepStrictEqual(child.block, {
            reason: "run_ended",
            threadId: childThread,
            runId: run.id,
            runStatus: "failed",
          });
          assert.deepStrictEqual(
            world.provider.started.map(({ threadId }) => threadId),
            [planner.threadId],
          );
          assert.deepStrictEqual(yield* setupLogs(world, childId), ["setup-1.log"]);
        }),
      ),
  );

  it.live(
    "runs no setup or opening turn for a new worktree whose project setup script cannot start",
    () =>
      withProject(passingVerify, (world) =>
        Effect.gen(function* () {
          const factory = yield* service;
          const marker = yield* markerIn(world, "setup-runs");
          yield* useSetup(world, markingSetup(marker));
          const { deliveryId } = yield* factory
            .start({ itemRef: world.itemRef })
            .pipe(Effect.orDie);
          const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);
          // The launch's preparation has no run, so only Factory can hold the turn back.
          const script = yield* failingScript(world, threadId, "openTerminal");

          yield* Deferred.await(script.started);
          assert.deepStrictEqual(yield* markedRuns(marker), []);
          const starting = yield* threadProjection(threadId).pipe(Effect.orDie);
          assert.deepStrictEqual(starting.messages, []);
          assert.deepStrictEqual(starting.runs, []);
          yield* Deferred.succeed(script.fail, undefined);
          yield* drainFactory;

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(
            state.block?.reason === "effect_failed" ? state.block.detail : undefined,
            "Factory could not launch the author thread (FactoryWorkspacePreparationError).",
          );
          assert.deepStrictEqual(yield* markedRuns(marker), []);
          assert.deepStrictEqual(world.provider.started, []);
          const blocked = yield* threadProjection(threadId).pipe(Effect.orDie);
          assert.deepStrictEqual(blocked.runs, []);
          const worktreePath = blocked.thread.worktreePath ?? assert.fail("No worktree.");

          // Resumed by its owner, the launch takes the worktree core recorded, runs setup and
          // starts the author.
          world.setupScripts.runForThread = undefined;
          yield* factory.resume(deliveryId).pipe(Effect.orDie);
          const author = yield* world.launched(deliveryId);
          assert.strictEqual(author.threadId, threadId);
          assert.strictEqual(author.worktreePath, worktreePath);
          assert.deepStrictEqual(yield* markedRuns(marker), [yield* realPath(worktreePath)]);
          assert.deepStrictEqual(
            (yield* threadProjection(threadId).pipe(Effect.orDie)).messages.map(({ id }) => id),
            [openingMessageId(deliveryId)],
          );
        }),
      ),
  );
});

/** Stores a single-item delivery of the world's item as it is once its start issued its launch. */
const storeLaunching = (world: World, deliveryId: FactoryDeliveryId, branch: string) =>
  Effect.gen(function* () {
    const state = advance(queuedDeliveryState({ branch, baseRef: "main" }), {
      type: "start",
    }).delivery;
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({ deliveryId, projectId: world.projectId, itemRef: world.itemRef, state });
    const awaiting = state.awaiting;
    if (awaiting?.type !== "effect" || awaiting.effect.type !== "launch_thread") {
      return assert.fail("The start issued no launch.");
    }
    const stored = yield* store.get(deliveryId);
    return { launch: awaiting.effect, delivery: Option.getOrThrow(stored) };
  }).pipe(Effect.orDie);

describe("Factory setup after a restart", () => {
  it.live(
    "prepares the worktree again on a resume after a restart cut the launch short before it",
    () =>
      withProject(
        passingVerify,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const marker = yield* markerIn(world, "setup-runs");
            yield* useSetup(world, markingSetup(marker));
            const deliveryId = FactoryDeliveryId.make("delivery-restarted");
            const branch = "feature/restarted";
            const branchStart = yield* git(world.root, ["rev-parse", "main"]);
            yield* storeLaunching(world, deliveryId, branch);
            // The launch created its thread, without a message, and the server stopped before
            // the preparation it began recorded a worktree.
            const threadId = FactoryThreadEffects.launchThreadId(deliveryId, 1);
            yield* Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
              threads.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`factory-launch:${deliveryId}:1`),
                threadId,
                projectId: world.projectId,
                title: `${world.itemKey}: ${world.itemTitle}`,
                modelSelection: { instanceId, model: "test-model" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch,
                worktreePath: null,
                createdBy: "system",
                creationSource: "server",
              }),
            ).pipe(Effect.orDie);

            yield* world.boot(
              Effect.gen(function* () {
                // The boot sweep blocks the launch the restart interrupted.
                const blocked = yield* stateOf(deliveryId);
                assert.strictEqual(blocked.status, "blocked");
                assert.strictEqual(blocked.block?.reason, "effect_failed");

                yield* factory.resume(deliveryId).pipe(Effect.orDie);
                const author = yield* world.launched(deliveryId);

                assert.strictEqual(author.threadId, threadId);
                assert.strictEqual(
                  yield* git(author.worktreePath, ["branch", "--show-current"]),
                  branch,
                );
                assert.deepStrictEqual(yield* markedRuns(marker), [
                  yield* realPath(author.worktreePath),
                ]);
                assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log"]);
                const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
                assert.deepStrictEqual(
                  thread.messages.map(({ id }) => id),
                  [openingMessageId(deliveryId)],
                );
                assert.deepStrictEqual(
                  thread.runs.map(({ id }) => id),
                  [author.runId],
                );
                assert.strictEqual((yield* stateOf(deliveryId)).baseline, branchStart);
              }),
            );
          }),
        { manualReactor: true },
      ),
  );

  it.live(
    "takes the opening turn a restart left without its result, with the setup command cleared",
    () =>
      withProject(
        passingVerify,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const effects = yield* FactoryThreadEffects.FactoryThreadEffects;
            const runner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
            const marker = yield* markerIn(world, "setup-runs");
            const setup = markingSetup(marker);
            yield* useSetup(world, setup);
            const deliveryId = FactoryDeliveryId.make("delivery-lost");
            const { delivery, launch } = yield* storeLaunching(world, deliveryId, "feature/lost");
            // The launch ran its setup and sent the opening turn; the server stopped before its
            // result was stored, and the owner cleared the setup command meanwhile.
            const sent = yield* effects.launchThread(delivery, launch, (worktreePath) =>
              runner.setup({ deliveryId, worktreePath, command: setup, timeoutMinutes: 30 }),
            );
            yield* useSetup(world, null);

            yield* world.boot(
              Effect.gen(function* () {
                assert.strictEqual((yield* stateOf(deliveryId)).status, "blocked");
                yield* factory.resume(deliveryId).pipe(Effect.orDie);
                const author = yield* world.launched(deliveryId);

                // The replay returns that turn's run, queuing or preparing no other.
                assert.strictEqual(author.threadId, sent.threadId);
                assert.strictEqual(author.runId, sent.runId);
                assert.strictEqual(author.worktreePath, sent.worktreePath);
                const thread = yield* threadProjection(sent.threadId).pipe(Effect.orDie);
                assert.deepStrictEqual(
                  thread.runs.map(({ id }) => id),
                  [sent.runId],
                );
                assert.deepStrictEqual(
                  thread.messages.map(({ id }) => id),
                  [openingMessageId(deliveryId)],
                );
                assert.deepStrictEqual(
                  world.provider.started.map(({ runId }) => runId),
                  [sent.runId],
                );
                assert.deepStrictEqual(yield* setupLogs(world, deliveryId), ["setup-1.log"]);
                assert.strictEqual((yield* markedRuns(marker)).length, 1);
              }),
            );
          }).pipe(Effect.provide(threadEffects), Effect.orDie),
        { manualReactor: true },
      ),
  );
});
