import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryDeliveryStatus,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import type { FactoryEffect } from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const canonicalRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
/** The same item as a tracker would also accept it. */
const otherSpelling: WorkItemRef = { sourceId, itemId: WorkItemId.make("FD-AAAAAA") };
/** Another item of the source. */
const otherItem: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-bbbbbb") };
/** `workBranchName` of the item below. */
const branch = "work/fd-aaaaaa-add-the-export-button";
const workspaceRoot = "/projects/alpha";

// FactoryService reads only these fields of the item and the project.
const item = {
  ref: canonicalRef,
  kind: "markdown",
  key: "fd-aaaaaa",
  title: "Add the export button",
} as unknown as WorkItemDetail;

/** Stands in for a Work error, which only Work's own modules may construct. */
class FakeItemNotFound extends Schema.TaggedError<FakeItemNotFound>()("WorkItemNotFound", {
  itemId: Schema.String,
}) {}

/** What the fakes are told and what they saw. */
interface World {
  /** The refs Work was asked to read. */
  readonly reads: Array<WorkItemRef>;
  /** The workspaces the base check saw. */
  readonly checks: Array<ThreadLaunch.ThreadLaunchWorkspaceStrategy>;
  /** Every launch the worker asked the thread effects for. */
  readonly launches: Array<{
    readonly deliveryId: FactoryDeliveryId;
    readonly effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>;
  }>;
  /** Refs in the project's repository, as full names. */
  readonly refs: Set<string>;
  /** The directory and pattern of each ref lookup. */
  readonly refReads: Array<{ readonly cwd: string; readonly pattern: string }>;
  projectExists: boolean;
  itemReadable: boolean;
  baseRefused: boolean;
  /** Whether the repository has a commit at HEAD. */
  committed: boolean;
  /** Runs inside each base check, before its answer. */
  onCheck: Effect.Effect<void> | null;
}

const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(WorkService.WorkService)({
      // Work's markdown spelling is lowercase.
      canonicalRef: (ref) =>
        Effect.succeed({
          sourceId: ref.sourceId,
          itemId: WorkItemId.make(ref.itemId.toLowerCase()),
        }),
      resolveSource: () =>
        Effect.succeed({
          stored: { sourceId, projectId },
        } as unknown as WorkService.ResolvedSource),
      getItem: (_actor, { ref }) =>
        Effect.suspend(() => {
          world.reads.push(ref);
          return world.itemReadable &&
            (ref.itemId === canonicalRef.itemId || ref.itemId === otherItem.itemId)
            ? Effect.succeed(item)
            : Effect.fail(
                new FakeItemNotFound({ itemId: ref.itemId }) as unknown as WorkDomainError,
              );
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() =>
          world.projectExists
            ? Option.some({
                projectId: id,
                title: "Alpha",
                workspaceRoot,
              } as unknown as ProjectStore.ProjectRow)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: ({ workspaceStrategy }) =>
        Effect.suspend(() => {
          world.checks.push(workspaceStrategy);
          return (world.onCheck ?? Effect.void).pipe(
            Effect.andThen(
              world.baseRefused
                ? Effect.fail(
                    new ThreadLaunch.ThreadLaunchBaseRefError({
                      projectId,
                      projectTitle: "Alpha",
                      workspaceRoot: "/nowhere",
                      baseRef: "HEAD",
                    }),
                  )
                : Effect.void,
            ),
          );
        }),
    }),
    // Each delivery's author gets its own thread: one thread can hold one active stage attempt.
    Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
      launchThread: (delivery, effect) =>
        Effect.sync(() => {
          world.launches.push({ deliveryId: delivery.deliveryId, effect });
          return {
            threadId: ThreadId.make(`thread-${delivery.deliveryId}`),
            runId: RunId.make(`run-${delivery.deliveryId}`),
            worktreePath: `/worktrees/${delivery.deliveryId}`,
            baseline: "b".repeat(40),
          };
        }),
      runEnded: () => Effect.succeedNone,
    }),
    // Nothing here reaches verify, a settle check, a review, record or a pull request;
    // FactoryReview.test.ts, FactoryRecord.test.ts and FactoryPullRequest.test.ts cover those.
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryChildren.FactoryChildren)({}),
    Layer.mock(FactoryPlanning.FactoryPlanning)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    // Answers the ref lookups a start makes for a free branch name, from `world.refs`, and its
    // read of a commit at HEAD.
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: ({ cwd, args }) =>
        Effect.sync(() => {
          if (args[0] === "rev-parse") {
            return {
              exitCode: ChildProcessSpawner.ExitCode(world.committed ? 0 : 1),
              stdout: world.committed ? `${"c".repeat(40)}\n` : "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }
          const pattern = args.at(-1) ?? "";
          world.refReads.push({ cwd, pattern });
          const name = pattern.replace(/^refs\/\*\*\//, "");
          const found = [...world.refs].find((ref) => ref.endsWith(`/${name}`));
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: found === undefined ? "" : `${found}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
  );

/** The service and the real worker on in-memory SQLite, with everything outside Factory faked. */
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(fakes(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    reads: [],
    checks: [],
    launches: [],
    refs: new Set(),
    refReads: [],
    projectExists: true,
    itemReadable: true,
    baseRefused: false,
    committed: true,
    onCheck: null,
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const useVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({ verifyCommand: { executable: "vp", args: ["test", "run"] } }),
  ),
);

const start = (itemRef: WorkItemRef) =>
  Effect.flatMap(FactoryService.FactoryService, (service) => service.start({ itemRef }));
const get = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryService.FactoryService, (service) => service.get(deliveryId));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);

/** Rows in each Factory table that a start could write. */
const rowCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [deliveries] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_deliveries
  `;
  const [stageRuns] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_stage_runs
  `;
  const [tasks] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_tasks
  `;
  return { deliveries: deliveries?.count, stageRuns: stageRuns?.count, tasks: tasks?.count };
});

/** Asserts the refused start wrote nothing and launched nothing, once queued work has run. */
const assertNothingStarted = (world: World) =>
  Effect.gen(function* () {
    yield* drain;
    assert.deepStrictEqual(yield* rowCounts, { deliveries: 0, stageRuns: 0, tasks: 0 });
    const active = yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
      store.listActive(),
    );
    assert.strictEqual(active.length, 0);
    assert.strictEqual(world.launches.length, 0);
  });

/** The start's error, which must be the item's active delivery. */
const activeDelivery = (error: { readonly _tag: string }) => {
  assert.instanceOf(error, FactoryDeliveryStore.FactoryDeliveryActive);
  return error as FactoryDeliveryStore.FactoryDeliveryActive;
};

/** Moves a stored delivery to `status`, as the engine or a later owner action would. */
const storeStatus = (
  deliveryId: FactoryDeliveryId,
  status: FactoryDeliveryStatus,
  stage: "author" | "verify",
) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    const current = Option.getOrThrow(yield* store.get(deliveryId));
    yield* store.update(deliveryId, { ...current.state, status, stage, awaiting: null });
  });

describe("FactoryService.start", () => {
  it.effect("refuses one of two different items starting at once under one id", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const factory = yield* FactoryService.FactoryService;
        const intended = FactoryDeliveryId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
        // Each holds its base check open: past every check that found no row under the id, and
        // holding only its own item's lock, so neither has stored anything when both go on.
        const arrivals = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const waiting = [...arrivals];
        const release = yield* Deferred.make<void>();
        world.onCheck = Effect.suspend(() => {
          const arrival = waiting.shift();
          return arrival === undefined ? Effect.void : Deferred.succeed(arrival, undefined);
        }).pipe(Effect.andThen(Deferred.await(release)));
        const first = yield* Effect.forkChild(
          Effect.exit(factory.start({ itemRef: canonicalRef, deliveryId: intended })),
        );
        const second = yield* Effect.forkChild(
          Effect.exit(factory.start({ itemRef: otherItem, deliveryId: intended })),
        );
        yield* Effect.forEach(arrivals, Deferred.await, { discard: true });
        assert.isTrue(Option.isNone(yield* get(intended)));

        yield* Deferred.succeed(release, undefined);
        const exits = [yield* Fiber.join(first), yield* Fiber.join(second)];
        yield* drain;

        const stored = exits.filter(Exit.isSuccess).map((exit) => exit.value);
        const errors = exits
          .filter(Exit.isFailure)
          .map((exit) => Option.getOrThrow(Cause.findErrorOption(exit.cause)));
        assert.lengthOf(stored, 1);
        assert.lengthOf(errors, 1);
        assert.instanceOf(errors[0], FactoryService.FactoryDeliveryIdConflictError);
        const row = Option.getOrThrow(yield* get(intended));
        assert.deepStrictEqual(row.itemRef, stored[0]?.itemRef);
        const counts = yield* rowCounts;
        assert.strictEqual(counts.deliveries, 1);
        assert.strictEqual(counts.tasks, 1);
        assert.deepStrictEqual(
          world.launches.map(({ deliveryId }) => deliveryId),
          [intended],
        );
      }),
    ),
  );

  it.effect("stores a running author delivery for the canonical item and queues one launch", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const started = yield* start(otherSpelling);
        assert.deepStrictEqual(started.itemRef, canonicalRef);
        assert.strictEqual(started.projectId, projectId);
        assert.strictEqual(started.parentId, null);
        assert.strictEqual(started.state.status, "running");
        assert.strictEqual(started.state.stage, "author");
        assert.strictEqual(started.state.branch, branch);
        assert.strictEqual(started.state.baseRef, "HEAD");
        assert.deepStrictEqual(world.reads, [canonicalRef]);
        assert.deepStrictEqual(world.checks, [{ type: "worktree", baseRef: "HEAD", branch }]);

        yield* drain;
        assert.deepStrictEqual(
          world.launches.map(({ deliveryId, effect }) => ({
            deliveryId,
            role: effect.role,
            workspace: effect.workspace,
          })),
          [
            {
              deliveryId: started.deliveryId,
              role: "author",
              workspace: { type: "worktree", branch, baseRef: "HEAD" },
            },
          ],
        );
        const stored = Option.getOrThrow(yield* get(started.deliveryId));
        assert.deepStrictEqual(stored.itemRef, canonicalRef);
        assert.strictEqual(stored.state.status, "running");
        assert.strictEqual(stored.state.stage, "author");
        assert.strictEqual(stored.state.branch, branch);
        assert.strictEqual(stored.state.baseRef, "HEAD");
        // The launch's result is stored: the delivery now awaits the author's first run.
        assert.deepStrictEqual(stored.state.awaiting, {
          type: "run",
          threadId: ThreadId.make(`thread-${started.deliveryId}`),
          runId: RunId.make(`run-${started.deliveryId}`),
        });
        assert.deepStrictEqual(yield* rowCounts, { deliveries: 1, stageRuns: 1, tasks: 1 });
      }),
    ),
  );

  it.effect("names the delivery after the first branch no ref in the repository holds", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        // A thread started from the item outside Factory left its branch, and a remote has the
        // next name.
        world.refs.add(`refs/heads/${branch}`);
        world.refs.add(`refs/remotes/origin/${branch}-2`);
        const started = yield* start(canonicalRef);
        yield* drain;
        assert.strictEqual(started.state.branch, `${branch}-3`);
        assert.deepStrictEqual(world.refReads, [
          { cwd: workspaceRoot, pattern: `refs/**/${branch}` },
          { cwd: workspaceRoot, pattern: `refs/**/${branch}-2` },
          { cwd: workspaceRoot, pattern: `refs/**/${branch}-3` },
        ]);
        assert.deepStrictEqual(world.launches.at(-1)?.effect.workspace, {
          type: "worktree",
          branch: `${branch}-3`,
          baseRef: "HEAD",
        });
      }),
    ),
  );

  it.effect("refuses a project without a verify command", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(start(canonicalRef));
        assert.strictEqual(error._tag, "FactoryVerifyCommandMissingError");
        assert.match(error.message, /^Set a verify command/);
        assert.deepStrictEqual(world.checks, []);
        yield* assertNothingStarted(world);
      }),
    ),
  );

  it.effect("refuses a project that is not on this environment", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        world.projectExists = false;
        const error = yield* Effect.flip(start(canonicalRef));
        assert.strictEqual(error._tag, "FactoryProjectMissingError");
        yield* assertNothingStarted(world);
      }),
    ),
  );

  it.effect("refuses an item Work cannot read with Work's error", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        world.itemReadable = false;
        const error = yield* Effect.flip(start(canonicalRef));
        assert.strictEqual(error._tag, "WorkItemNotFound");
        assert.deepStrictEqual(world.checks, []);
        yield* assertNothingStarted(world);
      }),
    ),
  );

  it.effect("refuses a base the worktree cannot start from", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        world.baseRefused = true;
        const error = yield* Effect.flip(start(canonicalRef));
        assert.strictEqual(error._tag, "ThreadLaunchBaseRefError");
        yield* assertNothingStarted(world);
      }),
    ),
  );

  it.effect("refuses a repository with no commit yet, which core's base check lets through", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        world.committed = false;
        const error = yield* Effect.flip(start(canonicalRef));
        assert.strictEqual(error._tag, "ThreadLaunchBaseRefError");
        assert.deepStrictEqual(world.checks, []);
        yield* assertNothingStarted(world);
      }),
    ),
  );

  it.effect("refuses a second start of the item under another spelling", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const first = yield* start(canonicalRef);
        yield* drain;
        const error = activeDelivery(yield* Effect.flip(start(otherSpelling)));
        assert.deepStrictEqual(error.itemRef, canonicalRef);
        assert.strictEqual(error.deliveryId, first.deliveryId);
        yield* drain;
        assert.strictEqual(world.launches.length, 1);
        assert.deepStrictEqual(yield* rowCounts, { deliveries: 1, stageRuns: 1, tasks: 1 });
      }),
    ),
  );

  it.effect("refuses a second start while the first delivery is stopped at verify", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const first = yield* start(canonicalRef);
        yield* drain;
        yield* storeStatus(first.deliveryId, "stopped", "verify");
        const error = activeDelivery(yield* Effect.flip(start(otherSpelling)));
        assert.strictEqual(error.deliveryId, first.deliveryId);
        yield* drain;
        assert.strictEqual(world.launches.length, 1);
        assert.strictEqual((yield* rowCounts).deliveries, 1);
      }),
    ),
  );

  it.effect.each(["done", "cancelled"] as const)(
    "starts a new delivery once the first is %s",
    (status) =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const first = yield* start(canonicalRef);
          yield* drain;
          yield* storeStatus(first.deliveryId, status, "author");
          const second = yield* start(otherSpelling);
          yield* drain;
          assert.notStrictEqual(second.deliveryId, first.deliveryId);
          assert.deepStrictEqual(second.itemRef, canonicalRef);
          assert.strictEqual(second.state.status, "running");
          // The first keeps its branch: the second starts over on one of its own.
          assert.strictEqual(second.state.branch, `${branch}-2`);
          assert.deepStrictEqual(world.checks.at(-1), {
            type: "worktree",
            baseRef: "HEAD",
            branch: `${branch}-2`,
          });
          assert.strictEqual(Option.getOrThrow(yield* get(first.deliveryId)).state.branch, branch);
          assert.deepStrictEqual(
            world.launches.map(({ deliveryId }) => deliveryId),
            [first.deliveryId, second.deliveryId],
          );
          assert.strictEqual(Option.getOrThrow(yield* get(first.deliveryId)).state.status, status);
          assert.deepStrictEqual(yield* rowCounts, { deliveries: 2, stageRuns: 2, tasks: 2 });
        }),
      ),
  );

  it.effect("stores one of two concurrent starts of the item", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        // The first start holds its base check open. The second, under another spelling of the
        // item, waits for it to be stored rather than checking alongside it, then finds it
        // active. The database refuses a second active row by itself too (FactoryStores.test.ts).
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        world.onCheck = Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const first = yield* Effect.forkChild(Effect.exit(start(canonicalRef)));
        yield* Deferred.await(reached);
        world.onCheck = null;
        const second = yield* Effect.forkChild(Effect.exit(start(otherSpelling)));
        for (let turn = 0; turn < 100; turn += 1) yield* Effect.yieldNow;
        assert.strictEqual(world.checks.length, 1);

        yield* Deferred.succeed(release, undefined);
        const exits = [yield* Fiber.join(first), yield* Fiber.join(second)];
        yield* drain;

        // The second chose its branch with the first stored, so it never asked for the same one.
        assert.deepStrictEqual(
          world.checks.map((check) => (check.type === "worktree" ? check.branch : null)),
          [branch, `${branch}-2`],
        );
        const stored = exits.filter(Exit.isSuccess).map((exit) => exit.value.deliveryId);
        const errors = exits
          .filter(Exit.isFailure)
          .map((exit) => Option.getOrThrow(Cause.findErrorOption(exit.cause)));
        assert.strictEqual(stored.length, 1);
        assert.strictEqual(errors.length, 1);
        for (const error of errors)
          assert.deepStrictEqual(activeDelivery(error).deliveryId, stored[0]);
        assert.deepStrictEqual(
          world.launches.map(({ deliveryId }) => deliveryId),
          stored,
        );
        assert.deepStrictEqual(yield* rowCounts, { deliveries: 1, stageRuns: 1, tasks: 1 });
      }),
    ),
  );
});

describe("FactoryService.get", () => {
  it.effect("returns a stored delivery and none for an unknown id", () =>
    withWorld(() =>
      Effect.gen(function* () {
        yield* useVerify;
        const started = yield* start(canonicalRef);
        yield* drain;
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        const known = yield* get(started.deliveryId);
        assert.strictEqual(Option.getOrThrow(known).deliveryId, started.deliveryId);
        const stageRuns = yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
          runs.listByDelivery(started.deliveryId),
        );
        assert.deepStrictEqual(
          known,
          Option.map(yield* store.get(started.deliveryId), (delivery) => ({
            ...delivery,
            stageRuns,
          })),
        );
        assert.isTrue(Option.isNone(yield* get(FactoryDeliveryId.make("delivery-unknown"))));
      }),
    ),
  );
});
