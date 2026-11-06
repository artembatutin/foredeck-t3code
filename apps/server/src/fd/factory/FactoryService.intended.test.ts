import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  drainFactory,
  git,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * `FactoryService.start` under an id its caller minted, on the real stack: the id a retry converges
 * on, so a start repeated after a lost reply, a crash or a race finds what the first one stored.
 */

const intended = FactoryDeliveryId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

const factoryService = Factory.FactoryService.FactoryService;

const startIntended = (world: World) =>
  Effect.flatMap(factoryService, (factory) =>
    factory.start({ itemRef: world.itemRef, deliveryId: intended }),
  );

const deliveriesOf = (world: World) =>
  Effect.flatMap(factoryService, (factory) => factory.listByItem(world.itemRef)).pipe(
    Effect.map(({ deliveries }) => deliveries),
  );

const taskRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly task_id: string }>`SELECT task_id FROM fd_factory_tasks
    WHERE delivery_id = ${intended}`,
);

/** The delivery's start step fails to store, as a storage failure does, until `restore`. */
const failingStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER intended_step_fails BEFORE UPDATE ON fd_factory_deliveries
    WHEN NEW.delivery_id = ${sql.literal(`'${intended}'`)}
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
);
const restoreStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER intended_step_fails`,
);

const branches = (world: World) => git(world.root, ["branch", "--list"]);

describe("FactoryService.start with a caller's delivery id", () => {
  it.live(
    "stores the id with its task, launches the author once, and a repeat changes nothing",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const started = yield* startIntended(world);
          assert.strictEqual(started.deliveryId, intended);
          assert.strictEqual(started.state.status, "running");
          assert.deepStrictEqual(yield* taskRows, [{ task_id: "item" }]);

          const author = yield* world.launched(intended);
          assert.isTrue(author.threadId.startsWith(`factory-thread:${intended}:`));
          assert.lengthOf(world.provider.started, 1);

          const before = yield* stateOf(intended);
          const repeated = yield* startIntended(world);
          yield* drainFactory;
          assert.strictEqual(repeated.deliveryId, intended);
          assert.deepStrictEqual(repeated.state, before);
          assert.lengthOf(yield* deliveriesOf(world), 1);
          assert.lengthOf(world.provider.started, 1);
          assert.deepStrictEqual(yield* stateOf(intended), before);
          yield* world.endRun(author.runId, "completed");
        }),
      ),
  );

  it.live("launches a parent's planner under the id", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        yield* factory.start({ itemRef: world.itemRef, kind: "parent", deliveryId: intended });
        const planner = yield* world.launched(intended);
        assert.isTrue(planner.threadId.startsWith(`factory-thread:${intended}:`));
        assert.strictEqual((yield* stateOf(intended)).kind, "parent");
        assert.deepStrictEqual(yield* taskRows, []);
        yield* factory.start({ itemRef: world.itemRef, kind: "parent", deliveryId: intended });
        yield* drainFactory;
        assert.lengthOf(world.provider.started, 1);
        yield* world.endRun(planner.runId, "completed");
      }),
    ),
  );

  it.live("takes two starts held at the same moment as one row and one launch", () => {
    const hold: {
      arrived: Array<Deferred.Deferred<void>>;
      go?: Deferred.Deferred<void>;
    } = { arrived: [] };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const arrivals = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
          hold.arrived = [...arrivals];
          hold.go = yield* Deferred.make<void>();
          const first = yield* startIntended(world).pipe(Effect.forkChild);
          const second = yield* startIntended(world).pipe(Effect.forkChild);
          yield* Effect.forEach(arrivals, Deferred.await, { discard: true });
          // Both found no row, and both read the item; neither has stored anything yet.
          assert.lengthOf(yield* deliveriesOf(world), 0);
          yield* Deferred.succeed(hold.go, undefined);
          const [one, two] = [yield* Fiber.join(first), yield* Fiber.join(second)];
          assert.strictEqual(one.deliveryId, intended);
          assert.strictEqual(two.deliveryId, intended);
          const author = yield* world.launched(intended);
          assert.lengthOf(yield* deliveriesOf(world), 1);
          assert.deepStrictEqual(yield* taskRows, [{ task_id: "item" }]);
          assert.lengthOf(world.provider.started, 1);
          yield* world.endRun(author.runId, "completed");
        }),
      {
        work: (service) => ({
          ...service,
          getItem: (actor, input) =>
            actor.id === "factory" && hold.go !== undefined
              ? Effect.suspend(() => {
                  const arrival = hold.arrived.shift();
                  return arrival === undefined ? Effect.void : Deferred.succeed(arrival, undefined);
                }).pipe(
                  Effect.andThen(Deferred.await(hold.go!)),
                  Effect.andThen(service.getItem(actor, input)),
                )
              : service.getItem(actor, input),
        }),
      },
    );
  });

  it.live("starts a queued orphan once after a rebuild", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        // The row and task commit, and the start step that would launch fails to store.
        yield* failingStep;
        const failed = yield* Effect.flip(startIntended(world));
        assert.strictEqual(failed._tag, "FactoryStoreError");
        yield* restoreStep;
        assert.strictEqual((yield* stateOf(intended)).status, "queued");
        assert.deepStrictEqual(yield* taskRows, [{ task_id: "item" }]);
        assert.lengthOf(world.provider.started, 0);

        yield* world.rebuild(
          Effect.gen(function* () {
            // A rebuilt server's boot leaves it queued: only a start moves a queued delivery.
            yield* drainFactory;
            assert.strictEqual((yield* stateOf(intended)).status, "queued");
            const restarted = yield* startIntended(world);
            assert.strictEqual(restarted.state.status, "running");
            const author = yield* world.launched(intended);
            assert.lengthOf(yield* deliveriesOf(world), 1);
            assert.lengthOf(world.provider.started, 1);

            yield* startIntended(world);
            yield* drainFactory;
            assert.lengthOf(world.provider.started, 1);
            yield* world.endRun(author.runId, "completed");
          }),
        );
      }),
    ),
  );

  it.live("returns running, blocked, cancelled and done rows unchanged", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        const sql = yield* SqlClient.SqlClient;
        yield* startIntended(world);
        const author = yield* world.launched(intended);
        const refs = yield* branches(world);

        const unchanged = Effect.gen(function* () {
          const before = yield* stateOf(intended);
          const launches = world.provider.started.length;
          const repeated = yield* startIntended(world);
          yield* drainFactory;
          assert.strictEqual(repeated.deliveryId, intended);
          assert.deepStrictEqual(repeated.state, before);
          assert.deepStrictEqual(yield* stateOf(intended), before);
          assert.lengthOf(yield* deliveriesOf(world), 1);
          assert.lengthOf(world.provider.started, launches);
          assert.strictEqual(yield* branches(world), refs);
        });

        assert.strictEqual((yield* stateOf(intended)).status, "running");
        yield* unchanged;

        // The author's run failing blocks the delivery.
        yield* world.endRun(author.runId, "failed");
        assert.strictEqual((yield* stateOf(intended)).status, "blocked");
        yield* unchanged;

        yield* factory.cancel(intended);
        assert.strictEqual((yield* stateOf(intended)).status, "cancelled");
        yield* unchanged;

        // Done, as a merge's close-out leaves it; only its status decides here.
        yield* sql`UPDATE fd_factory_deliveries SET status = 'done',
            state_json = json_set(state_json, '$.status', 'done')
          WHERE delivery_id = ${intended}`;
        assert.strictEqual((yield* stateOf(intended)).status, "done");
        yield* unchanged;
      }),
    ),
  );

  it.live("finds a row it named even when what it was started from is gone", () => {
    const control = { failReads: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* startIntended(world);
          const author = yield* world.launched(intended);
          control.failReads = true;
          const repeated = yield* startIntended(world);
          control.failReads = false;
          assert.strictEqual(repeated.deliveryId, intended);
          assert.lengthOf(world.provider.started, 1);
          yield* world.endRun(author.runId, "completed");
        }),
      {
        work: (service) => ({
          ...service,
          resolveSource: (sourceId) =>
            control.failReads ? Effect.die("resolved") : service.resolveSource(sourceId),
          getItem: (actor, input) =>
            control.failReads ? Effect.die("read") : service.getItem(actor, input),
        }),
      },
    );
  });

  it.live("refuses the id for another item, kind or ceiling, writing nothing", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        const work = yield* WorkService.WorkService;
        yield* startIntended(world);
        const author = yield* world.launched(intended);
        const other = yield* work.createItem(owner, {
          sourceId: world.itemRef.sourceId,
          title: "Another item",
        });
        const before = yield* stateOf(intended);
        const refs = yield* branches(world);

        const conflicts = [
          factory.start({ itemRef: other.ref, deliveryId: intended }),
          factory.start({ itemRef: world.itemRef, kind: "parent", deliveryId: intended }),
          factory.start({
            itemRef: world.itemRef,
            runtimeModeCeiling: "approval-required",
            deliveryId: intended,
          }),
        ];
        for (const conflict of conflicts) {
          const refused = yield* Effect.flip(conflict);
          assert.strictEqual(refused._tag, "FactoryDeliveryIdConflictError");
        }

        assert.deepStrictEqual(yield* stateOf(intended), before);
        assert.lengthOf(yield* deliveriesOf(world), 1);
        assert.lengthOf((yield* factory.listByItem(other.ref)).deliveries, 0);
        assert.lengthOf(world.provider.started, 1);
        assert.strictEqual(yield* branches(world), refs);
        yield* world.endRun(author.runId, "completed");
      }),
    ),
  );

  it.live("refuses a new id while the item has another active delivery", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        const running = yield* world.start;
        const refused = yield* Effect.flip(startIntended(world));
        assert.strictEqual(refused._tag, "FactoryDeliveryActive");
        assert.isTrue((yield* factory.get(intended))._tag === "None");
        assert.lengthOf(yield* deliveriesOf(world), 1);
        yield* world.endRun(running.runId, "completed");
      }),
    ),
  );

  it.live("keeps minting an id of its own for a start without one", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        const author = yield* world.start;
        assert.notStrictEqual(author.deliveryId, intended);
        const refused = yield* Effect.flip(factory.start({ itemRef: world.itemRef }));
        assert.strictEqual(refused._tag, "FactoryDeliveryActive");
        assert.lengthOf(yield* deliveriesOf(world), 1);
        yield* world.endRun(author.runId, "completed");
      }),
    ),
  );
});
