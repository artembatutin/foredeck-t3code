import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  type WorkItemRef,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { WorkService } from "../work-management/index.ts";
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
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import {
  drainFactory,
  stateOf as harnessStateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

type Decision = FactoryAdmission.FactoryAdmissionDecision;

const proceed: Decision = { type: "proceed" };
const defer: Decision = { type: "defer" };

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef: WorkItemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
// FactoryService reads only these fields of the item.
const item = {
  ref: itemRef,
  kind: "markdown",
  key: "fd-aaaaaa",
  title: "Add the export button",
} as unknown as WorkItemDetail;

/** What the fakes are told and what they saw. */
interface World {
  /** Each author launch, by delivery. */
  readonly launches: Array<FactoryDeliveryId>;
  /** How many writes of an admission mark the delivery store refuses before it stores one. */
  failMarks: number;
  /** How the admission port answers each effect it is asked about. */
  decide: () => Effect.Effect<Decision>;
}

/**
 * The delivery store as the worker and service see it: a write that stores an admission mark
 * fails, as a storage failure would, while `world.failMarks` says so.
 */
const markFailingStore = (world: World) =>
  Layer.effect(
    FactoryDeliveryStore.FactoryDeliveryStore,
    Effect.map(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
      FactoryDeliveryStore.FactoryDeliveryStore.of({
        ...store,
        update: (deliveryId, state) =>
          Effect.suspend(() => {
            if (state.admissionWait === undefined || world.failMarks === 0) {
              return store.update(deliveryId, state);
            }
            world.failMarks -= 1;
            return Effect.fail(
              new FactoryStoreError({ operation: "deliveries.update", cause: "disk full" }),
            );
          }),
      }),
    ),
  );

const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(FactoryAdmission.FactoryAdmission, {
      ...FactoryAdmission.FactoryAdmission.defaultValue(),
      management: () => Effect.succeed("active"),
      enter: () => Effect.suspend(() => world.decide()),
      deferredDemand: () => Effect.succeed(true),
    }),
    Layer.mock(WorkService.WorkService)({
      canonicalRef: (ref) => Effect.succeed(ref),
      resolveSource: () =>
        Effect.succeed({
          stored: { sourceId, projectId },
        } as unknown as WorkService.ResolvedSource),
      getItem: () => Effect.succeed(item),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeed(Option.some({ projectId: id } as unknown as ProjectStore.ProjectRow)),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ checkWorktreeBase: () => Effect.void }),
    Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
      launchThread: (delivery) =>
        Effect.sync(() => {
          world.launches.push(delivery.deliveryId);
          return {
            threadId: ThreadId.make(`thread-${delivery.deliveryId}`),
            runId: RunId.make(`run-${delivery.deliveryId}`),
            worktreePath: `/worktrees/${delivery.deliveryId}`,
            baseline: "b".repeat(40),
          };
        }),
      runEnded: () => Effect.succeedNone,
      interruptRun: () => Effect.void,
    }),
    // Nothing here verifies, reviews, plans, records or opens a pull request.
    Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryChildren.FactoryChildren)({}),
    Layer.mock(FactoryPlanning.FactoryPlanning)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    // No ref holds the item's branch name, so a start keeps it.
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void }),
  );

/** The service and the real worker on in-memory SQLite, with everything outside Factory faked. */
const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = { launches: [], failMarks: 0, decide: () => Effect.succeed(proceed) };
  const layer = FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provide(fakes(world)),
    Layer.provide(markFailingStore(world)),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return body(world).pipe(Effect.provide(layer), Effect.scoped);
};

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

const useVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(projectId, decodeSettings({ verifyCommand: { executable: "vp", args: ["test"] } })),
);
const service = FactoryService.FactoryService;
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const stateOf = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(deliveryId)).pipe(
    Effect.map((stored) => Option.getOrThrow(stored).state),
  );

describe("an admission mark the worker could not store", () => {
  it.effect("is stored again by ensureDeferred, running nothing, and runs once redispatched", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const factory = yield* service;
        world.failMarks = 1;
        world.decide = () => Effect.succeed(defer);
        const { deliveryId } = yield* factory.start({ itemRef });
        yield* drain;

        // Deferred, its mark refused: still awaited, unmarked, and not launched.
        const unmarked = yield* stateOf(deliveryId);
        assert.strictEqual(world.failMarks, 0);
        assert.deepStrictEqual(unmarked.awaiting, {
          type: "effect",
          effect: {
            id: 1,
            type: "launch_thread",
            role: "author",
            workspace: { type: "worktree", branch: unmarked.branch, baseRef: unmarked.baseRef },
          },
        });
        assert.notProperty(unmarked, "admissionWait");
        assert.deepStrictEqual(world.launches, []);
        // An unmarked effect is never redispatched.
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
        yield* drain;
        assert.deepStrictEqual(world.launches, []);

        // Marked again, running nothing, and marked it stays.
        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "deferred");
        assert.deepStrictEqual((yield* stateOf(deliveryId)).admissionWait, { effectId: 1 });
        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "deferred");
        yield* drain;
        assert.deepStrictEqual(world.launches, []);

        // Redispatched, it runs once.
        world.decide = () => Effect.succeed(proceed);
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
        yield* drain;
        assert.deepStrictEqual(world.launches, [deliveryId]);
        const launched = yield* stateOf(deliveryId);
        assert.strictEqual(launched.awaiting?.type, "run");
        assert.notProperty(launched, "admissionWait");

        // Moved on: neither is the effect redispatched nor marked again.
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "stale");
        yield* drain;
        assert.deepStrictEqual(world.launches, [deliveryId]);
        assert.deepStrictEqual(yield* stateOf(deliveryId), launched);
      }),
    ),
  );

  it.effect("is not marked or run once its delivery is cancelled", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const factory = yield* service;
        world.failMarks = 1;
        world.decide = () => Effect.succeed(defer);
        const { deliveryId } = yield* factory.start({ itemRef });
        yield* drain;
        yield* factory.cancel(deliveryId);
        world.decide = () => Effect.succeed(proceed);

        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "stale");
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
        yield* drain;
        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "cancelled");
        assert.notProperty(state, "admissionWait");
        assert.deepStrictEqual(world.launches, []);
        // An unknown delivery is stale too.
        const unknown = FactoryDeliveryId.make("delivery-unknown");
        assert.strictEqual(yield* factory.ensureDeferred(unknown, 1), "stale");
        assert.strictEqual(yield* factory.redispatch(unknown, 1), "stale");
      }),
    ),
  );

  it.effect("is reported running while the effect's job is in flight, and marked after it", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* useVerify;
        const factory = yield* service;
        const entered = yield* Deferred.make<void>();
        const decided = yield* Deferred.make<Decision>();
        world.decide = () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(decided)));
        const { deliveryId } = yield* factory.start({ itemRef });
        yield* Deferred.await(entered);

        // In flight: neither marked nor redispatched.
        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "running");
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
        assert.notProperty(yield* stateOf(deliveryId), "admissionWait");

        // Deferred, its mark refused once: the job ends without a mark, and none in flight.
        world.failMarks = 1;
        yield* Deferred.succeed(decided, defer);
        yield* drain;
        assert.notProperty(yield* stateOf(deliveryId), "admissionWait");
        assert.strictEqual(yield* factory.ensureDeferred(deliveryId, 1), "deferred");
        assert.deepStrictEqual((yield* stateOf(deliveryId)).admissionWait, { effectId: 1 });
        assert.deepStrictEqual(world.launches, []);

        world.decide = () => Effect.succeed(proceed);
        assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
        yield* drain;
        assert.deepStrictEqual(world.launches, [deliveryId]);
      }),
    ),
  );
});

/**
 * An admission port whose effects wait for admission until `control.decide` says otherwise, and
 * whose deferrals a boot finds as `control.demand` reports; it records which effects a boot asked
 * about.
 */
const restartPort = () => {
  const demanded: Array<number> = [];
  const control: {
    decide: Decision;
    demand: Effect.Effect<boolean, FactoryAdmission.FactoryAdmissionReadError>;
  } = { decide: defer, demand: Effect.succeed(true) };
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed("active"),
    enter: () => Effect.sync(() => control.decide),
    deferredDemand: ({ effectId }) =>
      Effect.suspend(() => {
        demanded.push(effectId);
        return control.demand;
      }),
  };
  return { control, demanded, port };
};

/**
 * Has SQLite refuse each update that stores an admission mark on a delivery's row, as a storage
 * failure would fail the delivery store's write, until the returned effect lifts it.
 */
const refuseMarkWrites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TRIGGER test_refuse_admission_mark BEFORE UPDATE ON fd_factory_deliveries
    WHEN json_extract(NEW.state_json, '$.admissionWait') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'admission mark refused'); END
  `;
  return sql`DROP TRIGGER test_refuse_admission_mark`.pipe(Effect.asVoid, Effect.orDie);
}).pipe(Effect.orDie);

const harnessService = Factory.FactoryService.FactoryService;

const interrupted = "Factory could not launch the author thread: a server restart interrupted it.";

describe("FactoryAdmission across a restart", () => {
  it.live("keeps a marked effect waiting through a rebuilt server, and runs it once", () => {
    const admission = restartPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { deliveryId } = yield* Effect.flatMap(harnessService, (factory) =>
            factory.start({ itemRef: world.itemRef }),
          );
          yield* drainFactory;
          assert.deepStrictEqual((yield* harnessStateOf(deliveryId)).admissionWait, {
            effectId: 1,
          });

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              // The boot sweep left it waiting, marked, without asking the port.
              const state = yield* harnessStateOf(deliveryId);
              assert.strictEqual(state.status, "running");
              assert.strictEqual(state.awaiting?.type, "effect");
              assert.deepStrictEqual(state.admissionWait, { effectId: 1 });
              assert.deepStrictEqual(admission.demanded, []);
              assert.deepStrictEqual(world.provider.started, []);

              admission.control.decide = proceed;
              const factory = yield* harnessService;
              assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
              yield* world.launched(deliveryId);
              assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
              yield* drainFactory;
              assert.strictEqual(world.provider.started.length, 1);
            }),
            { orchestration: true },
          );
        }),
      { admission: admission.port },
    );
  });

  it.live("marks an effect whose mark was lost when the port still holds its deferral", () => {
    const admission = restartPort();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const lift = yield* refuseMarkWrites;
          const { deliveryId } = yield* Effect.flatMap(harnessService, (factory) =>
            factory.start({ itemRef: world.itemRef }),
          );
          yield* drainFactory;
          yield* lift;
          const unmarked = yield* harnessStateOf(deliveryId);
          assert.strictEqual(unmarked.awaiting?.type, "effect");
          assert.notProperty(unmarked, "admissionWait");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              assert.deepStrictEqual(admission.demanded, [1]);
              const state = yield* harnessStateOf(deliveryId);
              assert.strictEqual(state.status, "running");
              assert.deepStrictEqual(state.admissionWait, { effectId: 1 });
              assert.deepStrictEqual(world.provider.started, []);

              admission.control.decide = proceed;
              const factory = yield* harnessService;
              assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "dispatched");
              yield* world.launched(deliveryId);
              yield* drainFactory;
              assert.strictEqual(world.provider.started.length, 1);
            }),
          );
        }),
      { admission: admission.port },
    );
  });

  it.live.each([
    ["holds no deferral", Effect.succeed(false)],
    [
      "cannot be read",
      Effect.fail(
        new FactoryAdmission.FactoryAdmissionReadError({
          root: FactoryDeliveryId.make("delivery-unread"),
          cause: "database is locked",
        }),
      ),
    ],
  ] as const)("blocks an effect whose mark was lost when the port %s", ([, demand]) => {
    const admission = restartPort();
    admission.control.demand = demand;
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const lift = yield* refuseMarkWrites;
          const { deliveryId } = yield* Effect.flatMap(harnessService, (factory) =>
            factory.start({ itemRef: world.itemRef }),
          );
          yield* drainFactory;
          yield* lift;
          assert.notProperty(yield* harnessStateOf(deliveryId), "admissionWait");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* drainFactory;
              assert.deepStrictEqual(admission.demanded, [1]);
              const state = yield* harnessStateOf(deliveryId);
              assert.strictEqual(state.status, "blocked");
              assert.isNull(state.awaiting);
              assert.notProperty(state, "admissionWait");
              assert.strictEqual(
                state.block?.reason === "effect_failed" ? state.block.detail : undefined,
                interrupted,
              );

              admission.control.decide = proceed;
              const factory = yield* harnessService;
              assert.strictEqual(yield* factory.redispatch(deliveryId, 1), "stale");
              yield* drainFactory;
              assert.deepStrictEqual(world.provider.started, []);
            }),
          );
        }),
      { admission: admission.port },
    );
  });
});
