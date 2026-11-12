import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryDeliveryStatus,
  FactoryProjectSettings,
  type FactoryReviewedExecution,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  type WorkItemSummary,
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
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
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
import { type FactoryEffect, queuedDeliveryState } from "./pipeline/state.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const canonicalRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
/** The same item as a tracker would also accept it. */
const otherSpelling: WorkItemRef = { sourceId, itemId: WorkItemId.make("FD-AAAAAA") };
/** Another item of the source. */
const otherItem: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-bbbbbb") };
/** `workBranchName` of the item below. */
const branch = "feature/fd-aaaaaa-add-the-export-button";
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
  /** What each `currentSummaries` asked for, by source. */
  readonly summaryReads: Array<ReadonlyArray<WorkItemId>>;
  /** Answers each `currentSummaries`; absent answers with no items. */
  summaries:
    | ((
        itemIds: ReadonlyArray<WorkItemId>,
      ) => Effect.Effect<ReadonlyArray<WorkItemSummary>, WorkDomainError>)
    | null;
  /** The queue ranks the admission port answers with, by root. */
  readonly priorities: Map<FactoryDeliveryId, number | null>;
  /** Work's refresh epoch and the admission port's queue counter, once a test makes them. */
  workEpoch: SubscriptionRef.SubscriptionRef<number> | null;
  queueEpoch: SubscriptionRef.SubscriptionRef<number> | null;
}

const summaryOf = (itemId: WorkItemId, overrides: Partial<WorkItemSummary> = {}) =>
  ({
    ref: { sourceId, itemId },
    key: itemId,
    title: "Add the export button",
    status: "todo",
    nativeStatus: null,
    assignee: null,
    ...overrides,
  }) as WorkItemSummary;

const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(FactoryAdmission.FactoryAdmission, {
      ...FactoryAdmission.FactoryAdmission.defaultValue(),
      queueChanges: Stream.suspend(() =>
        world.queueEpoch === null ? Stream.never : SubscriptionRef.changes(world.queueEpoch),
      ),
      queuePriorities: (roots) =>
        Effect.sync(
          () =>
            new Map(
              roots.flatMap((root) => {
                const priority = world.priorities.get(root);
                return priority === undefined ? [] : [[root, priority] as const];
              }),
            ),
        ),
    }),
    Layer.mock(WorkService.WorkService)({
      subscribeRefreshes: Stream.suspend(() =>
        world.workEpoch === null ? Stream.never : SubscriptionRef.changes(world.workEpoch),
      ),
      currentSummaries: (_sourceId, itemIds) =>
        Effect.suspend(() => {
          world.summaryReads.push(itemIds);
          return world.summaries === null ? Effect.succeed([]) : world.summaries(itemIds);
        }),
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
    Layer.provideMerge(NodeCrypto.layer),
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
    summaryReads: [],
    summaries: null,
    priorities: new Map(),
    workEpoch: null,
    queueEpoch: null,
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

  describe("with a reviewed execution", () => {
    const reviewed = {
      receiptId: "receipt-1",
      reviewVersion: 1,
      roles: {
        planner: { instanceId: "codex", model: "plan-model" },
        author: { instanceId: "codex", model: "author-model" },
        reviewer: { instanceId: "codex", model: "review-model" },
      },
      verifyCommand: { executable: "vp", args: ["test"] },
      setupCommand: null,
      limits: {
        maxFixRounds: 3,
        maxReviewRounds: 4,
        maxFixCommitTurns: 1,
        verifyTimeoutMinutes: 9,
      },
      blockingSeverities: ["high"],
      highRiskEffort: "xhigh",
      pipelineId: "standard",
      repository: {
        projectId,
        workspaceRoot,
        publication: {
          push: [],
          head: [],
          provider: "unknown",
          repository: null,
          remoteConfig: "reviewed-config",
        },
      },
      runtimeCeiling: "auto-accept-edits",
      promptOverrides: {
        plan: "absent",
        author: "absent",
        review: "absent",
        "fix-verify": "absent",
        "fix-review": "absent",
        "fix-commit": "absent",
        integrate: "absent",
      },
    };
    const startWith = (reviewedExecution: unknown, runtimeModeCeiling?: "approval-required") =>
      Effect.flatMap(FactoryService.FactoryService, (factory) =>
        factory.start({
          itemRef: canonicalRef,
          reviewedExecution,
          ...(runtimeModeCeiling === undefined ? {} : { runtimeModeCeiling }),
        }),
      );

    it.effect.each([
      { name: "nothing", input: null, reason: "malformed" },
      { name: "an empty value", input: {}, reason: "malformed" },
      {
        name: "a review with a field missing",
        input: { ...reviewed, verifyCommand: undefined },
        reason: "malformed",
      },
      {
        name: "a review with a role unresolved",
        input: { ...reviewed, roles: { ...reviewed.roles, reviewer: null } },
        reason: "malformed",
      },
      {
        name: "a review naming no receipt",
        input: { ...reviewed, receiptId: "" },
        reason: "malformed",
      },
      {
        name: "a pipeline this server does not ship",
        input: { ...reviewed, pipelineId: "another" },
        reason: "pipeline",
      },
      {
        name: "another project's review",
        input: {
          ...reviewed,
          repository: { ...reviewed.repository, projectId: "project-beta" },
        },
        reason: "project",
      },
      {
        name: "another repository's review",
        input: {
          ...reviewed,
          repository: { ...reviewed.repository, workspaceRoot: "/projects/beta" },
        },
        reason: "repository",
      },
      {
        name: "a provider bound with no target",
        input: {
          ...reviewed,
          repository: {
            ...reviewed.repository,
            publication: { ...reviewed.repository.publication, provider: "gitlab" },
          },
        },
        reason: "malformed",
      },
    ] as const)("refuses $name, writing nothing and starting nothing", ({ input, reason }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(startWith(input));
          assert.strictEqual(error._tag, "FactoryReviewedExecutionInvalidError");
          assert.include(error, { reason });
          yield* assertNothingStarted(world);
        }),
      ),
    );

    it.effect("refuses a review broader than whoever starts it", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(startWith(reviewed, "approval-required"));
          assert.include(error, {
            _tag: "FactoryReviewedExecutionInvalidError",
            reason: "runtime_ceiling",
          });
          yield* assertNothingStarted(world);
        }),
      ),
    );

    it.effect("runs on the review's limits and ceiling, with no settings to read", () =>
      withWorld(() =>
        Effect.gen(function* () {
          const started = yield* startWith(reviewed);
          assert.deepStrictEqual(started.state.limits, { maxFixRounds: 3, maxReviewRounds: 4 });
          assert.strictEqual(started.state.runtimeModeCeiling, "auto-accept-edits");
          assert.strictEqual(started.state.reviewedExecution?.receiptId, "receipt-1");
        }),
      ),
    );
  });

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
            stageAttempts: { author: 1 },
          })),
        );
        assert.isTrue(Option.isNone(yield* get(FactoryDeliveryId.make("delivery-unknown"))));
      }),
    ),
  );

  describe("listForClients", () => {
    const listed = Effect.flatMap(FactoryService.FactoryService, (service) =>
      service.listForClients({}),
    );
    const setState = (deliveryId: FactoryDeliveryId, status: "cancelled" | "done" | "pr_open") =>
      Effect.gen(function* () {
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        const current = Option.getOrThrow(yield* store.get(deliveryId));
        yield* store.update(deliveryId, { ...current.state, status, awaiting: null });
      });

    it.effect("carries what the item's source says and its queue rank, apart from its status", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const started = yield* start(canonicalRef);
          yield* drain;
          yield* setState(started.deliveryId, "pr_open");
          world.summaries = (itemIds) =>
            Effect.succeed(
              itemIds.map((itemId) =>
                summaryOf(itemId, {
                  title: "Format durations",
                  nativeStatus: { id: "1", name: "Backlog" },
                  assignee: { id: "sam", label: "Sam" },
                }),
              ),
            );
          world.priorities.set(started.deliveryId, 1);

          const [delivery] = yield* listed;
          assert.strictEqual(delivery?.state.status, "pr_open");
          assert.deepStrictEqual(delivery?.source, {
            key: "fd-aaaaaa",
            title: "Format durations",
            status: "todo",
            statusName: "Backlog",
            assignee: "Sam",
          });
          assert.strictEqual(delivery?.queuePriority, 1);
        }),
      ),
    );

    it.effect("asks each source once, and only about deliveries still under way", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const ended = yield* start(canonicalRef);
          yield* drain;
          yield* setState(ended.deliveryId, "done");
          yield* start(otherItem);
          yield* drain;

          const deliveries = yield* listed;
          assert.deepStrictEqual(world.summaryReads, [[otherItem.itemId]]);
          const byId = new Map(deliveries.map((delivery) => [delivery.deliveryId, delivery]));
          assert.notProperty(byId.get(ended.deliveryId), "source");
        }),
      ),
    );

    it.effect.each(["done", "cancelled"] as const)(
      "keeps a %s delivery's rank, read with no tracker, as Work goes on showing it",
      (status) =>
        withWorld((world) =>
          Effect.gen(function* () {
            yield* useVerify;
            const ended = yield* start(canonicalRef);
            yield* drain;
            yield* setState(ended.deliveryId, status);
            world.priorities.set(ended.deliveryId, 1);

            const [delivery] = yield* listed;
            assert.strictEqual(delivery?.state.status, status);
            assert.strictEqual(delivery?.queuePriority, 1);
            assert.strictEqual(toFactoryDelivery(delivery!).queuePriority, 1);
            // Nothing is under way, so no source was asked anything.
            assert.deepStrictEqual(world.summaryReads, []);
            assert.notProperty(delivery, "source");
          }),
        ),
    );

    it.effect("reads an ended delivery's rank apart from one it never had", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const unranked = yield* start(canonicalRef);
          yield* drain;
          yield* setState(unranked.deliveryId, "cancelled");
          const unmanaged = yield* start(otherItem);
          yield* drain;
          yield* setState(unmanaged.deliveryId, "done");
          world.priorities.set(unranked.deliveryId, null);

          const deliveries = yield* listed;
          const byId = new Map(deliveries.map((delivery) => [delivery.deliveryId, delivery]));
          assert.isNull(byId.get(unranked.deliveryId)?.queuePriority);
          assert.notProperty(byId.get(unmanaged.deliveryId), "queuePriority");
        }),
      ),
    );

    it.effect("reads an ended child's rank from its parent, the root its idea ranks", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const parent = yield* start(canonicalRef);
          yield* drain;
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const childId = FactoryDeliveryId.make("delivery-child");
          yield* store.insert({
            deliveryId: childId,
            projectId,
            itemRef: otherItem,
            parentId: parent.deliveryId,
            state: {
              ...queuedDeliveryState({ kind: "child", branch: "child", baseRef: "HEAD" }),
              status: "cancelled",
            },
          });
          world.priorities.set(parent.deliveryId, 2);

          const deliveries = yield* listed;
          const child = deliveries.find(({ deliveryId }) => deliveryId === childId);
          assert.strictEqual(child?.queuePriority, 2);
        }),
      ),
    );

    it.effect("leaves a source that fails out, and lists the delivery all the same", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const started = yield* start(canonicalRef);
          yield* drain;
          world.summaries = () =>
            Effect.fail(new FakeItemNotFound({ itemId: "x" }) as unknown as WorkDomainError);

          const [delivery] = yield* listed;
          assert.strictEqual(delivery?.deliveryId, started.deliveryId);
          assert.notProperty(delivery, "source");
        }),
      ),
    );

    it.effect("lists without a source that does not answer in time", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          const started = yield* start(canonicalRef);
          yield* drain;
          const asked = yield* Deferred.make<void>();
          world.summaries = () => Effect.andThen(Deferred.succeed(asked, undefined), Effect.never);

          const listing = yield* Effect.forkChild(listed);
          yield* Deferred.await(asked);
          yield* TestClock.adjust("3 seconds");
          const [delivery] = yield* Fiber.join(listing);
          assert.strictEqual(delivery?.deliveryId, started.deliveryId);
          assert.notProperty(delivery, "source");
        }),
      ),
    );

    it.effect("sets no queue rank for a root its manager does not hold", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useVerify;
          yield* start(canonicalRef);
          yield* drain;
          world.summaries = (itemIds) => Effect.succeed(itemIds.map((itemId) => summaryOf(itemId)));
          const [delivery] = yield* listed;
          assert.notProperty(delivery, "queuePriority");
          assert.strictEqual(delivery?.source?.assignee, null);
        }),
      ),
    );
  });

  describe("listingChanges", () => {
    /** Makes Work's and the queue's counters, then answers the epoch a new subscription gets. */
    const following = (world: World) =>
      Effect.gen(function* () {
        const work = yield* SubscriptionRef.make(3);
        const queue = yield* SubscriptionRef.make(5);
        world.workEpoch = work;
        world.queueEpoch = queue;
        const service = yield* FactoryService.FactoryService;
        const current = service.listingChanges.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        return { work, queue, service, current };
      });
    const rise = (counter: SubscriptionRef.SubscriptionRef<number>) =>
      SubscriptionRef.update(counter, (value) => value + 1);

    it.effect("moves with a Work edit and a queue rank, with no Factory write", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { work, queue, service, current } = yield* following(world);
          const start = yield* current;
          const seen = yield* Queue.unbounded<number>();
          yield* Effect.forkChild(
            service.listingChanges.pipe(Stream.runForEach((value) => Queue.offer(seen, value))),
          );
          assert.strictEqual(yield* Queue.take(seen), start);

          yield* rise(work);
          assert.strictEqual(yield* Queue.take(seen), start + 1);
          yield* rise(queue);
          assert.strictEqual(yield* Queue.take(seen), start + 2);
        }),
      ),
    );

    it.effect(
      "moves with Factory's own writes, as a subscriber to Factory's epoch alone does",
      () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const { service, current } = yield* following(world);
            yield* useVerify;
            const before = yield* current;
            const factoryBefore = yield* service.subscribe.pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            yield* start(canonicalRef);
            yield* drain;
            const factoryAfter = yield* service.subscribe.pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            assert.isAbove(factoryAfter, factoryBefore);
            assert.strictEqual(yield* current, before + (factoryAfter - factoryBefore));
          }),
        ),
    );

    it.effect("answers a new subscription the same value while nothing has moved", () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const { current } = yield* following(world);
          assert.strictEqual(yield* current, yield* current);
        }),
      ),
    );
  });

  describe("what a delivery has spent", () => {
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "project-model" };

    /** A delivery that repaired once after a blocking review, then passed its second review. */
    const repairedOnce = (reviewed: boolean) =>
      withWorld(() =>
        Effect.gen(function* () {
          yield* useVerify;
          const started = yield* start(canonicalRef);
          yield* drain;
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
          const current = Option.getOrThrow(yield* store.get(started.deliveryId));
          yield* store.update(started.deliveryId, {
            ...current.state,
            rounds: { fix: 0, review: 1 },
            limits: { maxFixRounds: 2, maxReviewRounds: 2 },
            ...(reviewed
              ? {
                  reviewedExecution: {
                    receiptId: "receipt-1",
                    reviewVersion: 1,
                    roles: { planner: selection, author: selection, reviewer: selection },
                    verifyCommand: { executable: "vp", args: ["test"] },
                    setupCommand: null,
                    limits: {
                      maxFixRounds: 3,
                      maxReviewRounds: 3,
                      maxFixCommitTurns: 2,
                      verifyTimeoutMinutes: 30,
                    },
                    blockingSeverities: ["high"],
                    highRiskEffort: "xhigh",
                    pipelineId: "standard",
                    repository: {
                      projectId,
                      workspaceRoot,
                      publication: {
                        push: [],
                        head: [],
                        provider: "unknown",
                        repository: null,
                        remoteConfig: "reviewed-config",
                      },
                    },
                    runtimeCeiling: "approval-required",
                    promptOverrides: {
                      plan: "absent",
                      author: "absent",
                      review: "absent",
                      "fix-verify": "absent",
                      "fix-review": "absent",
                      "fix-commit": "absent",
                      integrate: "absent",
                    },
                  } satisfies FactoryReviewedExecution,
                }
              : {}),
          });
          // The author's attempt is stored; these follow it as the worker's steps append them.
          for (const stage of ["verify", "review", "repair", "verify", "review"] as const) {
            yield* runs.append({ deliveryId: started.deliveryId, stage });
          }
          return toFactoryDelivery(Option.getOrThrow(yield* get(started.deliveryId))).allowance;
        }),
      );

    it.effect("reports one repair and two review attempts for a delivery with no review", () =>
      Effect.map(repairedOnce(false), (allowance) =>
        assert.deepStrictEqual(allowance, {
          counted: "since_resume",
          verificationFixes: { used: 0, limit: 2, remaining: 2 },
          reviewFollowUps: { used: 1, limit: 2, remaining: 1 },
          fixCommitTurns: { used: 0, limit: 1, remaining: 1 },
          attempts: { verify: 2, review: 2 },
        }),
      ),
    );

    /** One review, then more verify and repair attempts than the timeline's window holds. */
    const longHistory = Effect.gen(function* () {
      yield* useVerify;
      const started = yield* start(canonicalRef);
      yield* drain;
      const runs = yield* FactoryStageRunStore.FactoryStageRunStore;
      yield* runs.append({ deliveryId: started.deliveryId, stage: "review" });
      for (let round = 0; round < 25; round += 1) {
        yield* runs.append({ deliveryId: started.deliveryId, stage: "verify" });
        yield* runs.append({ deliveryId: started.deliveryId, stage: "repair" });
      }
      return started.deliveryId;
    });

    it.effect("counts a review the timeline's window no longer holds, by every read", () =>
      withWorld(() =>
        Effect.gen(function* () {
          const deliveryId = yield* longHistory;
          const service = yield* FactoryService.FactoryService;
          const expected = { verify: 25, review: 1 };

          const read = Option.getOrThrow(yield* get(deliveryId));
          assert.strictEqual(read.stageRuns.length, 50);
          assert.isFalse(read.stageRuns.some(({ stage }) => stage === "review"));
          const snapshot = toFactoryDelivery(read);
          assert.strictEqual(snapshot.stageRuns.length, 50);
          assert.deepStrictEqual(snapshot.allowance?.attempts, expected);

          const [listed] = yield* service.list({});
          assert.deepStrictEqual(toFactoryDelivery(listed!).allowance?.attempts, expected);
          const [forClient] = yield* service.listForClients({});
          assert.deepStrictEqual(toFactoryDelivery(forClient!).allowance?.attempts, expected);

          // What a control answers with reads the same as a later list.
          const stopped = yield* service.stop(deliveryId);
          assert.strictEqual(stopped.stageRuns.length, 50);
          assert.deepStrictEqual(toFactoryDelivery(stopped).allowance?.attempts, expected);
        }),
      ),
    );

    it.effect("reports what remains of a reviewed delivery's cumulative allowance", () =>
      Effect.map(repairedOnce(true), (allowance) =>
        assert.deepStrictEqual(allowance, {
          counted: "whole_delivery",
          verificationFixes: { used: 0, limit: 3, remaining: 3 },
          reviewFollowUps: { used: 1, limit: 3, remaining: 2 },
          fixCommitTurns: { used: 0, limit: 2, remaining: 2 },
          attempts: { verify: 2, review: 2 },
        }),
      ),
    );
  });
});
