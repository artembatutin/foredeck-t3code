import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

type Threads = FactoryThreadEffects.FactoryThreadEffects["Service"];
type DeliveryStore = FactoryDeliveryStore.FactoryDeliveryStore["Service"];

/**
 * How the test answers the thread effects. Handlers receive the worker's delivery store, so a
 * test can read what was stored when an effect started; an unscripted call dies.
 */
interface ThreadScript {
  /** In order: each delivery write the worker made, and whatever the handlers add. */
  readonly log: Array<string>;
  launch?: (
    store: DeliveryStore,
    ...args: Parameters<Threads["launchThread"]>
  ) => ReturnType<Threads["launchThread"]>;
  turn?: (
    store: DeliveryStore,
    ...args: Parameters<Threads["sendFixCommitTurn"]>
  ) => ReturnType<Threads["sendFixCommitTurn"]>;
}

const scriptedThreads = (script: ThreadScript) =>
  Layer.effect(
    FactoryThreadEffects.FactoryThreadEffects,
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      return FactoryThreadEffects.FactoryThreadEffects.of({
        launchThread: (delivery, effect) =>
          script.launch?.(store, delivery, effect) ?? Effect.die("launch not scripted"),
        sendFixCommitTurn: (delivery, effect) =>
          script.turn?.(store, delivery, effect) ?? Effect.die("turn not scripted"),
        // Planning is driven in FactoryWorker.plan.test.ts.
        sendPlanRetryTurn: () => Effect.die("plan retry turn not scripted"),
        sendReplanTurn: () => Effect.die("replan turn not scripted"),
        sendReviewRetryTurn: () => Effect.die("review retry turn not scripted"),
        // Repair rounds are driven in FactoryRepair.test.ts.
        sendRepairTurn: () => Effect.die("repair turn not scripted"),
        sendReviewFollowUpTurn: () => Effect.die("review follow-up turn not scripted"),
        // Resumes are covered in FactoryResume.test.ts.
        launchState: () => Effect.die("launch read not scripted"),
        threadState: () => Effect.die("thread read not scripted"),
        liveRun: () => Effect.die("live run read not scripted"),
        carriesFactoryTurn: () => Effect.die("factory turn read not scripted"),
        liveRunsOn: () => Effect.die("live runs read not scripted"),
        launchedLiveRuns: Effect.die("live runs read not scripted"),
        // Every run is still going; its end arrives as a step.
        runEnded: () => Effect.succeedNone,
        // Cancels are covered in FactoryStopCancel.test.ts.
        interruptRun: () => Effect.die("interrupt not scripted"),
      });
    }),
  );

/**
 * The worker's view of the delivery store: it yields after each read and before each write, and
 * logs each write. In-memory SQLite never yields, so without this a concurrent step or a queued
 * effect could never run in between, even if the worker did not order them.
 */
const observedStore = (script: ThreadScript) =>
  Layer.effect(
    FactoryDeliveryStore.FactoryDeliveryStore,
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      return FactoryDeliveryStore.FactoryDeliveryStore.of({
        ...store,
        get: (id) => store.get(id).pipe(Effect.tap(() => Effect.yieldNow)),
        update: (id, state) =>
          Effect.yieldNow.pipe(
            Effect.andThen(store.update(id, state)),
            Effect.tap(() => Effect.sync(() => script.log.push(`stored ${state.status}`))),
          ),
      });
    }),
  );

/** The worker on in-memory SQLite, real git and real processes, with scripted thread effects. */
const makeLayer = (script: ThreadScript) =>
  FactoryWorker.layer.pipe(
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(observedStore(script)),
    Layer.provide(scriptedThreads(script)),
    // Reviews are judged in FactoryReview.test.ts, approvals recorded in FactoryRecord.test.ts and
    // pull requests opened in FactoryPullRequest.test.ts; here no review is submitted.
    Layer.provide(Layer.mock(FactoryReview.FactoryReview)({})),
    Layer.provide(Layer.mock(FactoryChildren.FactoryChildren)({})),
    Layer.provide(Layer.mock(FactoryPlanning.FactoryPlanning)({})),
    Layer.provide(Layer.mock(FactoryRecord.FactoryRecord)({})),
    Layer.provide(Layer.mock(FactoryPullRequest.FactoryPullRequest)({})),
    Layer.provide(
      FactoryVerifyRunner.layer.pipe(
        Layer.provide(FactoryEvidence.layer),
        Layer.provide(ProcessRunner.layer),
      ),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-worker-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const projectId = ProjectId.make("project-alpha");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const deliveryId = FactoryDeliveryId.make("delivery-1");
const missingId = FactoryDeliveryId.make("delivery-missing");
/** A second delivery, of another item, for steps across deliveries. */
const otherId = FactoryDeliveryId.make("delivery-2");
const otherItem = { ...itemRef, itemId: WorkItemId.make("fd-bbbbbb") };
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const firstRun = RunId.make("run-1");
const fixRun = RunId.make("run-2");
const reviewRun = RunId.make("run-review");
const reviewedSha = "e".repeat(40);
const branch = "feature/item-7";
const baseline = "b".repeat(40);

const queued = queuedDeliveryState({ branch, baseRef: "main" });
const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);
const launchedAt = (worktreePath: string, baselineSha: string) => ({
  threadId: author,
  runId: firstRun,
  worktreePath,
  baseline: baselineSha,
});
const authorFinished = (runId: RunId): FactoryEvent => ({
  type: "run.finished",
  threadId: author,
  runId,
  status: "completed",
});

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

const insert = (state: FactoryDeliveryState = queued, id = deliveryId, item = itemRef) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
    store.insert({ deliveryId: id, projectId, itemRef: item, state }),
  );
const storedOf = (id: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(id)).pipe(
    Effect.map(Option.getOrThrow),
  );
const stored = storedOf(deliveryId);
const step = (event: FactoryEvent, id = deliveryId) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(id, event));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
);

/** The delivery's row exactly as SQLite holds it. */
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`;
});

/** Sets the project's verify command to `script` run by the current Node; null clears it. */
const useVerify = (script: string | null) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(
      projectId,
      decodeSettings({
        verifyCommand:
          script === null ? null : { executable: process.execPath, args: ["-e", script] },
      }),
    ),
  );

const evidenceDirectory = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(stateDir, "fd-factory", deliveryId);
});

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

const commit = (cwd: string, message: string, extra: ReadonlyArray<string> = []) =>
  git(cwd, [
    ...ada,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    message,
    ...extra,
  ]);

/** A repository with its baseline on `main` and the delivery branch checked out. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-worker-wt-" });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* commit(cwd, "chore: root");
  const baselineSha = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* git(cwd, ["switch", "-c", branch]);
  return { cwd, baselineSha };
});

/**
 * Starts the delivery with its author thread launched into a fresh repository, standing in for
 * the delivery worktree, and leaves it waiting for the author's first run.
 */
const startOnRepository = (script: ThreadScript, state: FactoryDeliveryState = queued) =>
  Effect.gen(function* () {
    const repository = yield* makeRepository;
    script.launch = (_store, _delivery, effect) =>
      Effect.succeed(
        effect.role === "reviewer"
          ? // A reviewer's launch reports its worktree's HEAD, the commit it reviews.
            {
              threadId: reviewer,
              runId: reviewRun,
              worktreePath: repository.cwd,
              baseline: reviewedSha,
            }
          : launchedAt(repository.cwd, repository.baselineSha),
      );
    yield* insert(state);
    yield* step({ type: "start" });
    yield* drain;
    return repository;
  });

/** Runs `body` against a fresh database, evidence folder and worker. */
const withWorker = <A, E, R>(body: (script: ThreadScript) => Effect.Effect<A, E, R>) => {
  const script: ThreadScript = { log: [] };
  return body(script).pipe(Effect.provide(makeLayer(script)), Effect.scoped);
};

const passingVerify = `console.log("all checks passed")`;

class FakeLaunchError extends Schema.TaggedError<FakeLaunchError>()("FakeLaunchError", {
  output: Schema.String,
}) {
  override get message(): string {
    return this.output;
  }
}

describe("FactoryWorker steps", () => {
  it.effect("stores the started delivery before its launch runs", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const seen: Array<FactoryDeliveryState> = [];
        script.launch = (store) =>
          Effect.sync(() => script.log.push("launch")).pipe(
            Effect.andThen(store.get(deliveryId)),
            Effect.tap((delivery) =>
              Effect.sync(() => seen.push(Option.getOrThrow(delivery).state)),
            ),
            Effect.as(launchedAt("/worktrees/item-7", baseline)),
          );
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        // Started, launched, then the launch's result stored.
        assert.deepStrictEqual(script.log, ["stored running", "launch", "stored running"]);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0]?.status, "running");
        assert.strictEqual(seen[0]?.stage, "author");
        assert.deepStrictEqual(seen[0]?.awaiting, {
          type: "effect",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "worktree", branch, baseRef: "main" },
          },
        });
        const { state } = yield* stored;
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: firstRun });
        assert.strictEqual(state.worktreePath, "/worktrees/item-7");
        assert.strictEqual(state.threads.author, author);
      }),
    ),
  );

  it.effect("applies only one of two concurrent results for the same effect", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const turns: Array<ReadonlyArray<string>> = [];
        script.turn = (_store, _delivery, effect) =>
          Effect.sync(() => turns.push(effect.problems)).pipe(Effect.as({ runId: fixRun }));
        // Awaiting the settle check (effect 2) after the author's first run.
        yield* insert(
          fold(
            queued,
            { type: "start" },
            { type: "thread.launched", effectId: 1, ...launchedAt("/worktrees/item-7", baseline) },
            authorFinished(firstRun),
          ),
        );
        const repairable: FactoryEvent = {
          type: "settle.checked",
          effectId: 2,
          result: { status: "repairable", problems: ["Worktree has uncommitted changes."] },
        };

        yield* Effect.all([step(repairable), step(repairable)], { concurrency: "unbounded" });
        yield* drain;

        assert.deepStrictEqual(turns, [["Worktree has uncommitted changes."]]);
        const { state } = yield* stored;
        assert.strictEqual(state.fixCommitTurns, 1);
        assert.strictEqual(state.effectsIssued, 3);
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: fixRun });
      }),
    ),
  );

  it.effect("changes and runs nothing for an unknown delivery", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        let launches = 0;
        script.launch = () =>
          Effect.sync(() => (launches += 1)).pipe(Effect.as(launchedAt("/worktrees/x", baseline)));
        yield* insert();
        const before = yield* rawRow;

        const result = yield* step({ type: "start" }, missingId);
        yield* drain;

        assert.deepStrictEqual(result, Option.none());
        assert.strictEqual(launches, 0);
        assert.deepStrictEqual(yield* rawRow, before);
        const sql = yield* SqlClient.SqlClient;
        const counts = yield* sql<{ readonly deliveries: number; readonly runs: number }>`
          SELECT
            (SELECT COUNT(*) FROM fd_factory_deliveries) AS deliveries,
            (SELECT COUNT(*) FROM fd_factory_stage_runs) AS runs
        `;
        assert.deepStrictEqual(counts, [{ deliveries: 1, runs: 0 }]);
      }),
    ),
  );

  it.effect("drains only after a gated effect and the step its result fed back", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const called = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        script.launch = () =>
          Deferred.succeed(called, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(launchedAt("/worktrees/item-7", baseline)),
          );
        yield* insert();
        yield* step({ type: "start" });

        const draining = yield* Effect.forkChild(drain);
        yield* Deferred.await(called);
        yield* Effect.yieldNow;
        assert.isUndefined(draining.pollUnsafe());
        assert.strictEqual((yield* stored).state.awaiting?.type, "effect");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(draining);
        assert.deepStrictEqual((yield* stored).state.awaiting, {
          type: "run",
          threadId: author,
          runId: firstRun,
        });
      }),
    ),
  );
  it.effect("drains a delivery started while a drain already waits", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const gate = Effect.all({
          called: Deferred.make<void>(),
          release: Deferred.make<void>(),
          returned: Deferred.make<void>(),
        });
        const gates = new Map([
          [deliveryId, yield* gate],
          [otherId, yield* gate],
        ]);
        const gateOf = (id: FactoryDeliveryId) => {
          const found = gates.get(id);
          if (found === undefined) throw new Error(`no gate for ${id}`);
          return found;
        };
        // Each delivery's thread is its own: one thread holds one active attempt.
        const threadOf = (id: FactoryDeliveryId) => ThreadId.make(`thread-${id}`);
        script.launch = (_store, delivery) => {
          const { called, release, returned } = gateOf(delivery.deliveryId);
          return Deferred.succeed(called, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(returned, undefined)),
            Effect.as({
              ...launchedAt(`/worktrees/${delivery.deliveryId}`, baseline),
              threadId: threadOf(delivery.deliveryId),
            }),
          );
        };
        yield* insert();
        yield* insert(queued, otherId, otherItem);
        yield* step({ type: "start" });
        const draining = yield* Effect.forkChild(drain);
        yield* Deferred.await(gateOf(deliveryId).called);

        // The second delivery starts only after the drain began waiting.
        yield* step({ type: "start" }, otherId);
        yield* Deferred.await(gateOf(otherId).called);
        // Let the first delivery's chain finish: its fed-back step holds its lock, so this stale
        // step returns only after that step has stored the launch.
        yield* Deferred.succeed(gateOf(deliveryId).release, undefined);
        yield* Deferred.await(gateOf(deliveryId).returned);
        yield* step({
          type: "command.finished",
          effectId: 1,
          outcome: { type: "refused", refusals: ["tree_dirty"] },
        });
        yield* Effect.yieldNow;
        assert.strictEqual((yield* stored).state.awaiting?.type, "run");
        assert.isUndefined(draining.pollUnsafe());

        yield* Deferred.succeed(gateOf(otherId).release, undefined);
        yield* Fiber.join(draining);
        assert.deepStrictEqual((yield* storedOf(otherId)).state.awaiting, {
          type: "run",
          threadId: threadOf(otherId),
          runId: firstRun,
        });
      }),
    ),
  );
});

describe("FactoryWorker settle checks", () => {
  it.effect("moves a conforming branch on to verify", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        yield* useVerify(passingVerify);
        const { cwd } = yield* startOnRepository(script);
        yield* commit(cwd, "feat(server): add the thing");

        yield* step(authorFinished(firstRun));
        yield* drain;

        // Verify ran on the settled branch and passed, so review began.
        const { state } = yield* stored;
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(state.stage, "review");
        assert.isNull(state.block);
      }),
    ),
  );

  it.effect("sends a fix-commit turn naming a non-conventional subject", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const turns: Array<{
          readonly threadId: ThreadId;
          readonly problems: ReadonlyArray<string>;
        }> = [];
        script.turn = (_store, _delivery, effect) =>
          Effect.sync(() =>
            turns.push({ threadId: effect.threadId, problems: effect.problems }),
          ).pipe(Effect.as({ runId: fixRun }));
        const { cwd } = yield* startOnRepository(script);
        yield* commit(cwd, "updated stuff");
        const sha = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* step(authorFinished(firstRun));
        yield* drain;

        assert.deepStrictEqual(turns, [
          {
            threadId: author,
            problems: [
              `Commit ${sha.slice(0, 12)} subject is not a Conventional Commit: "updated stuff".`,
            ],
          },
        ]);
        const { state } = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.deepStrictEqual(state.awaiting, { type: "run", threadId: author, runId: fixRun });
        // The author attempt follows the run the delivery now waits for.
        const [authorAttempt] = yield* attempts;
        assert.strictEqual(authorAttempt?.runId, fixRun);
        assert.isNull(authorAttempt?.outcome);
      }),
    ),
  );

  it.effect("blocks a commit by an AI identity as unsettled without a repair turn", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const { cwd } = yield* startOnRepository(script);
        yield* commit(cwd, "feat: add the thing", ["--author", "Codex <codex@example.com>"]);
        const sha = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* step(authorFinished(firstRun));
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "unsettled",
          problems: [
            `Commit ${sha.slice(0, 12)} author identity names an AI agent, model or provider.`,
          ],
        });
        assert.strictEqual(state.fixCommitTurns, 0);
        const [authorAttempt] = yield* attempts;
        assert.strictEqual(authorAttempt?.outcome, "blocked");
      }),
    ),
  );

  it.effect("blocks a worktree that cannot be read as unsettled", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const { cwd, baselineSha } = yield* makeRepository;
        const gone = `${cwd}/gone`;
        script.launch = () => Effect.succeed(launchedAt(gone, baselineSha));
        yield* insert();
        yield* step({ type: "start" });
        yield* drain;

        yield* step(authorFinished(firstRun));
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "unsettled",
          problems: [`Factory worktree ${gone} does not exist.`],
        });
        assert.strictEqual(state.fixCommitTurns, 0);
      }),
    ),
  );
});

describe("FactoryWorker verify", () => {
  it.effect("passes verify with one receipt and starts the review in the delivery worktree", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        yield* useVerify(passingVerify);
        const { cwd, baselineSha } = yield* startOnRepository(script);
        const launches: Array<Parameters<Threads["launchThread"]>[1]> = [];
        const launch = script.launch;
        script.launch = (store, delivery, effect) => {
          launches.push(effect);
          return launch?.(store, delivery, effect) ?? Effect.die("launch not scripted");
        };
        yield* commit(cwd, "feat(server): add the thing");
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* step(authorFinished(firstRun));
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "review");
        assert.strictEqual(state.reviewRound, 1);
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(state.receipts[0]?.code, 0);
        assert.strictEqual(state.receipts[0]?.headSha, head);
        assert.deepStrictEqual(launches, [
          {
            id: 4,
            type: "launch_thread",
            role: "reviewer",
            workspace: { type: "existing_worktree", worktreePath: cwd },
          },
        ]);
        assert.deepStrictEqual(state.threads, { author, reviewer });
        assert.deepStrictEqual(state.awaiting, {
          type: "run",
          threadId: reviewer,
          runId: reviewRun,
        });
        // The task baseline stays the author's: review covers baseline..HEAD.
        assert.strictEqual(state.baseline, baselineSha);

        const directory = yield* evidenceDirectory;
        const runs = yield* attempts;
        assert.deepStrictEqual(
          runs.map(({ stage, attempt, threadId, runId, outcome, evidencePath }) => ({
            stage,
            attempt,
            threadId,
            runId,
            outcome,
            evidencePath,
          })),
          [
            {
              stage: "author",
              attempt: 1,
              threadId: author,
              runId: firstRun,
              outcome: "passed",
              evidencePath: null,
            },
            {
              stage: "verify",
              attempt: 1,
              threadId: null,
              runId: null,
              outcome: "passed",
              evidencePath: `${directory}/verify-1.json`,
            },
            {
              stage: "review",
              attempt: 1,
              threadId: reviewer,
              runId: reviewRun,
              outcome: null,
              evidencePath: null,
            },
          ],
        );
        assert.deepStrictEqual(
          runs.map((run) => run.finishedAt !== null),
          [true, true, false],
        );
      }),
    ),
  );

  it.effect("blocks a failing verify command without fix rounds and records it as failed", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        yield* useVerify(`console.error("1 test failed"); process.exitCode = 1;`);
        const { cwd } = yield* startOnRepository(
          script,
          queuedDeliveryState({
            branch,
            baseRef: "main",
            limits: { maxFixRounds: 0, maxReviewRounds: 0 },
          }),
        );
        yield* commit(cwd, "fix: repair the thing");

        yield* step(authorFinished(firstRun));
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, { reason: "verify_failed" });
        assert.strictEqual(state.receipts.length, 1);
        assert.strictEqual(state.receipts[0]?.code, 1);

        const directory = yield* evidenceDirectory;
        const runs = yield* attempts;
        assert.deepStrictEqual(
          runs.map(({ stage, outcome, evidencePath }) => ({ stage, outcome, evidencePath })),
          [
            { stage: "author", outcome: "passed", evidencePath: null },
            { stage: "verify", outcome: "failed", evidencePath: `${directory}/verify-1.json` },
          ],
        );
      }),
    ),
  );

  it.effect("fails the effect without running anything once the verify command is removed", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* useVerify(passingVerify);
        const { cwd } = yield* startOnRepository(script);
        yield* commit(cwd, "feat(server): add the thing");
        yield* useVerify(null);

        yield* step(authorFinished(firstRun));
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: { id: 3, type: "run_command", stage: "verify" },
          detail: "Factory could not run the verify command (FactoryVerifyCommandMissingError).",
        });
        assert.deepStrictEqual(state.receipts, []);
        assert.isFalse(yield* fileSystem.exists(yield* evidenceDirectory));
        const runs = yield* attempts;
        assert.deepStrictEqual(
          runs.map(({ stage, outcome }) => ({ stage, outcome })),
          [
            { stage: "author", outcome: "passed" },
            { stage: "verify", outcome: "blocked" },
          ],
        );
      }),
    ),
  );
});

describe("FactoryWorker failures and stale results", () => {
  it.effect("blocks a failed launch with a detail that carries none of its message", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        const output = "npm ERR! token=hunter2 could not reach the registry";
        script.launch = () => Effect.fail(new FakeLaunchError({ output }));
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.deepStrictEqual(state.block, {
          reason: "effect_failed",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "worktree", branch, baseRef: "main" },
          },
          detail: "Factory could not launch the author thread (FakeLaunchError).",
        });
        assert.notInclude(JSON.stringify(state), "hunter2");
        assert.notInclude(JSON.stringify(state), "registry");
        const runs = yield* attempts;
        assert.deepStrictEqual(
          runs.map(({ stage, threadId, outcome }) => ({ stage, threadId, outcome })),
          [{ stage: "author", threadId: null, outcome: "blocked" }],
        );
      }),
    ),
  );

  it.effect("blocks a launch whose executor throws before returning an effect", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        script.launch = () => {
          throw new Error("npm ERR! token=hunter2 could not reach the registry");
        };
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.block?.reason, "effect_failed");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not launch the author thread (unexpected error).",
        );
        assert.notInclude(JSON.stringify(state), "hunter2");
      }),
    ),
  );

  it.effect("blocks a launch that dies with a generic detail", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        script.launch = () => Effect.die(new Error("provider exploded: secret-value"));
        yield* insert();

        yield* step({ type: "start" });
        yield* drain;

        const { state } = yield* stored;
        assert.strictEqual(state.block?.reason, "effect_failed");
        assert.strictEqual(
          state.block?.reason === "effect_failed" ? state.block.detail : undefined,
          "Factory could not launch the author thread (unexpected error).",
        );
      }),
    ),
  );

  it.effect("leaves the stored row byte-for-byte unchanged for a stale command result", () =>
    withWorker((script) =>
      Effect.gen(function* () {
        script.launch = () => Effect.succeed(launchedAt("/worktrees/item-7", baseline));
        yield* insert();
        yield* step({ type: "start" });
        yield* drain;
        const before = yield* rawRow;
        const runsBefore = yield* attempts;
        // A write now would move updated_at.
        yield* TestClock.adjust("1 minute");

        const result = yield* step({
          type: "command.finished",
          effectId: 1,
          outcome: { type: "refused", refusals: ["tree_dirty"] },
        });
        yield* drain;

        assert.deepStrictEqual(yield* rawRow, before);
        assert.deepStrictEqual(yield* attempts, runsBefore);
        assert.deepStrictEqual(
          Option.map(result, (delivery) => delivery.state),
          Option.some((yield* stored).state),
        );
      }),
    ),
  );
});
