import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expectTypeOf, vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../../connection/model.ts";
import * as EnvironmentRegistry from "../../connection/registry.ts";
import * as EnvironmentSupervisor from "../../connection/supervisor.ts";
import type { EnvironmentSubscriptionRpcTag, EnvironmentUnaryRpcTag } from "../../rpc/client.ts";
import type { RpcSession } from "../../rpc/session.ts";
import { createFactoryEnvironmentAtoms } from "./index.ts";

const projectId = ProjectId.make("p1");
const deliveryId = FactoryDeliveryId.make("d1");
const delivery: FactoryDelivery = {
  deliveryId,
  projectId,
  itemRef: {
    sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
    itemId: WorkItemId.make("fd-7k3qa2"),
  },
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
};
const settings = Schema.decodeSync(FactoryProjectSettings)({});

const READS = [
  WS_METHODS.factoryDeliveriesList,
  WS_METHODS.factoryDeliveriesGet,
  WS_METHODS.factorySettingsGet,
] as const;
const requestsOf = (environmentId: EnvironmentId, methods: ReadonlyArray<string>) =>
  methods.map((method) => `${environmentId} ${method}`).toSorted();

type Read = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

const config = (capabilities: object) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;
const FACTORY = config({ factory: { version: 1 } });

/**
 * Environments connected to fake sessions that record each Factory request as
 * `<environment> <method>` and stream the epochs offered to them. Each session's server
 * advertises Factory until `reconnect` replaces it. The registry runs its work on a queue that
 * `drain` empties, as a test drains a worker, so every check reads a settled state.
 */
const makeHarness = Effect.fn("TestFactoryAtoms.makeHarness")(function* (
  environmentIds: ReadonlyArray<EnvironmentId>,
) {
  const requests = yield* Queue.unbounded<string>();
  const record = (environmentId: EnvironmentId, method: string) =>
    Queue.offer(requests, `${environmentId} ${method}`);
  // The environments whose change stream the server has seen end, in order.
  const closed = yield* Queue.unbounded<EnvironmentId>();
  const epochs = new Map<EnvironmentId, Queue.Queue<number>>();
  const sessions = new Map<EnvironmentId, (serverConfig: ServerConfig) => RpcSession>();
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  for (const environmentId of environmentIds) {
    const environmentEpochs = yield* Queue.unbounded<number>();
    epochs.set(environmentId, environmentEpochs);
    const reply =
      <A>(method: string, value: A) =>
      () =>
        record(environmentId, method).pipe(Effect.as(value));
    const client = {
      [WS_METHODS.factoryDeliveriesSubscribe]: () =>
        Stream.unwrap(
          record(environmentId, WS_METHODS.factoryDeliveriesSubscribe).pipe(
            Effect.as(Stream.fromQueue(environmentEpochs)),
          ),
        ).pipe(Stream.ensuring(Queue.offer(closed, environmentId))),
      [WS_METHODS.factoryDeliveriesList]: reply(WS_METHODS.factoryDeliveriesList, {
        deliveries: [delivery],
      }),
      [WS_METHODS.factoryDeliveriesGet]: reply(WS_METHODS.factoryDeliveriesGet, delivery),
      [WS_METHODS.factorySettingsGet]: reply(WS_METHODS.factorySettingsGet, settings),
    };
    const session = (serverConfig: ServerConfig) =>
      ({ client, initialConfig: Effect.succeed(serverConfig) }) as unknown as RpcSession;
    sessions.set(environmentId, session);
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://factory.example.test",
          wsBaseUrl: "wss://factory.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session(FACTORY))),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const supervisor = (environmentId: EnvironmentId) => {
    const found = supervisors.get(environmentId);
    if (found === undefined) throw new Error(`No test environment ${environmentId}`);
    return found;
  };
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor(environmentId),
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor(environmentId),
    );
  const registryService = {
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
  );
  const serverConfigs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map()).pipe(
    Atom.keepAlive,
  );

  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {
        const index = tasks.indexOf(task);
        if (index >= 0) tasks.splice(index, 1);
      };
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const factory = createFactoryEnvironmentAtoms(runtime, serverConfigs);
  const readsOf = (environmentId: EnvironmentId): ReadonlyArray<Read> => [
    factory.deliveries({ environmentId, input: { projectId } }),
    factory.delivery({ environmentId, input: { deliveryId } }),
    factory.settings({ environmentId, input: { projectId } }),
  ];
  return {
    factory,
    registry,
    /** Runs the registry's work until none is left; each pass first lets the test's fibers hand theirs over. */
    drain: Effect.gen(function* () {
      for (let pass = 0; pass < 100; pass++) {
        yield* Effect.yieldNow;
        if (tasks.length === 0) return;
        while (tasks.length > 0) tasks.shift()?.();
      }
      return yield* Effect.die(new Error("The registry kept scheduling work."));
    }),
    setConfigs: (configs: ReadonlyArray<readonly [EnvironmentId, ServerConfig]>) =>
      registry.set(serverConfigs, new Map(configs)),
    /** Replaces the environment's session with one to a server that sent `serverConfig`. */
    reconnect: (environmentId: EnvironmentId, serverConfig: ServerConfig) =>
      SubscriptionRef.set(
        supervisor(environmentId).session,
        Option.some(sessions.get(environmentId)!(serverConfig)),
      ),
    /** The environments whose change stream ended since the last call. */
    closed: Queue.clear(closed),
    emit: (environmentId: EnvironmentId, epoch: number) => {
      const queue = epochs.get(environmentId);
      if (queue === undefined) throw new Error(`No test environment ${environmentId}`);
      return Queue.offer(queue, epoch);
    },
    /** The requests made since the last call, sorted. */
    requests: Queue.clear(requests).pipe(Effect.map((made) => made.toSorted())),
    /** Every read of one environment, mounted for the rest of the test. */
    mountReads: (environmentId: EnvironmentId) => {
      const reads = readsOf(environmentId);
      for (const atom of reads) registry.mount(atom);
      return reads;
    },
    readsOf,
  };
});

const valueOf = (registry: AtomRegistry.AtomRegistry, atom: Read) =>
  Option.getOrUndefined(AsyncResult.value(registry.get(atom)));

describe("createFactoryEnvironmentAtoms", () => {
  it("lists the Factory change stream among subscriptions, next to Work's refresh stream", () => {
    // Enforced by the package typecheck.
    expectTypeOf<
      typeof WS_METHODS.workSubscribeRefreshes
    >().toExtend<EnvironmentSubscriptionRpcTag>();
    expectTypeOf<
      typeof WS_METHODS.factoryDeliveriesSubscribe
    >().toExtend<EnvironmentSubscriptionRpcTag>();
    expectTypeOf<
      Extract<EnvironmentUnaryRpcTag, typeof WS_METHODS.factoryDeliveriesSubscribe>
    >().toBeNever();
  });

  it.effect("follows the change stream as one subscription that keeps delivering epochs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = EnvironmentId.make("factory");
        const harness = yield* makeHarness([env]);
        harness.setConfigs([[env, FACTORY]]);
        const changes = harness.factory.changes({ environmentId: env, input: {} });
        harness.registry.mount(changes);
        for (const epoch of [0, 1, 2]) {
          yield* harness.emit(env, epoch);
          yield* harness.drain;
          expect(valueOf(harness.registry, changes)).toBe(epoch);
        }
        expect(yield* harness.requests).toEqual(
          requestsOf(env, [WS_METHODS.factoryDeliveriesSubscribe]),
        );
      }),
    ),
  );

  it.effect(
    "refetches the list, a delivery and the settings once per epoch move, and never polls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          const env = EnvironmentId.make("factory");
          const harness = yield* makeHarness([env]);
          harness.setConfigs([[env, FACTORY]]);
          const changes = harness.factory.changes({ environmentId: env, input: {} });
          harness.registry.mount(changes);
          yield* harness.emit(env, 4);
          yield* harness.drain;
          const reads = harness.mountReads(env);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual(
            requestsOf(env, [WS_METHODS.factoryDeliveriesSubscribe, ...READS]),
          );
          expect(reads.map((atom) => valueOf(harness.registry, atom))).toEqual([
            { deliveries: [delivery] },
            delivery,
            settings,
          ]);

          // The same epoch again, as a resubscribe answers it, is not a move.
          yield* harness.emit(env, 4);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual([]);

          yield* harness.emit(env, 5);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual(requestsOf(env, READS));

          // With the epoch still, time passing requests nothing.
          vi.advanceTimersByTime(60 * 60_000);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual([]);
        }),
      ),
  );

  it.effect("issues no Factory read to an environment that does not advertise Factory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const older = EnvironmentId.make("older");
        const unknown = EnvironmentId.make("unknown");
        const current = EnvironmentId.make("current");
        const harness = yield* makeHarness([older, unknown, current]);
        // `older` predates Factory and `unknown` has sent no config yet.
        harness.setConfigs([
          [older, config({})],
          [current, FACTORY],
        ]);
        const olderChanges: Read = harness.factory.changes({ environmentId: older, input: {} });
        harness.registry.mount(olderChanges);
        const olderReads = [olderChanges, ...harness.mountReads(older)];
        const idle = [...olderReads, ...harness.mountReads(unknown)];
        harness.mountReads(current);
        yield* harness.drain;
        expect(yield* harness.requests).toEqual(
          requestsOf(current, [WS_METHODS.factoryDeliveriesSubscribe, ...READS]),
        );
        const isIdle = (atom: Read) => {
          const result = harness.registry.get(atom);
          return AsyncResult.isInitial(result) && !result.waiting;
        };
        expect(idle.every(isIdle)).toBe(true);
        // A refresh, as a retry control would ask for, builds no query either.
        for (const atom of idle) harness.registry.refresh(atom);
        yield* harness.drain;
        expect(yield* harness.requests).toEqual([]);
        expect(idle.every(isIdle)).toBe(true);
        expect(harness.registry.get(harness.factory.supported(older))).toBe(false);
        expect(harness.registry.get(harness.factory.supported(unknown))).toBe(false);

        // Once the server advertises Factory, the reads already mounted go out.
        harness.setConfigs([
          [older, FACTORY],
          [current, FACTORY],
        ]);
        yield* harness.drain;
        expect(harness.registry.get(harness.factory.supported(older))).toBe(true);
        expect(yield* harness.requests).toEqual(
          requestsOf(older, [WS_METHODS.factoryDeliveriesSubscribe, ...READS]),
        );

        // A server that stops advertising it leaves them idle again.
        harness.setConfigs([
          [older, config({ factory: { version: 2 } })],
          [current, FACTORY],
        ]);
        yield* harness.drain;
        expect(olderReads.every(isIdle)).toBe(true);
        expect(yield* harness.closed).toEqual([older]);
        for (const atom of olderReads) harness.registry.refresh(atom);
        yield* harness.drain;
        expect(yield* harness.requests).toEqual([]);
        // Nor does a reconnect with the reads still mounted, however its server answers.
        yield* harness.reconnect(older, FACTORY);
        yield* harness.emit(older, 0);
        yield* harness.drain;
        expect(yield* harness.requests).toEqual([]);
        expect(olderReads.every(isIdle)).toBe(true);
      }),
    ),
  );

  it.effect(
    "closes the change stream when support goes, and sends nothing after, though no view reads it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const env = EnvironmentId.make("factory");
          const harness = yield* makeHarness([env]);
          harness.setConfigs([[env, FACTORY]]);
          const atoms = [
            harness.factory.changes({ environmentId: env, input: {} }),
            ...harness.readsOf(env),
          ];
          const unmounts = atoms.map((atom) => harness.registry.mount(atom));
          yield* harness.emit(env, 4);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual(
            requestsOf(env, [WS_METHODS.factoryDeliveriesSubscribe, ...READS]),
          );
          // The views go away; the reads they made stay cached, the stream open, on their idle TTL.
          for (const unmount of unmounts) unmount();
          yield* harness.drain;
          expect(yield* harness.closed).toEqual([]);

          harness.setConfigs([]);
          yield* harness.drain;
          expect(yield* harness.closed).toEqual([env]);

          // A reconnect answering the same epoch, then a view opening again, reach nothing.
          yield* harness.reconnect(env, FACTORY);
          yield* harness.emit(env, 4);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual([]);
          const reopened = harness.mountReads(env);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual([]);
          expect(reopened.every((atom) => AsyncResult.isInitial(harness.registry.get(atom)))).toBe(
            true,
          );
        }),
      ),
  );

  it.effect(
    "sends nothing over a session to a server without Factory, while the view still offers it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const env = EnvironmentId.make("factory");
          const harness = yield* makeHarness([env]);
          harness.setConfigs([[env, FACTORY]]);
          harness.registry.mount(harness.factory.changes({ environmentId: env, input: {} }));
          harness.mountReads(env);
          yield* harness.emit(env, 4);
          yield* harness.drain;
          yield* harness.requests;

          // Reconnected to an older server, before its config replaces the one this client holds:
          // the reads that re-run on a new session and the stream's resubscription are held.
          yield* harness.reconnect(env, config({}));
          yield* harness.drain;
          expect(yield* harness.requests).toEqual([]);

          yield* harness.reconnect(env, FACTORY);
          yield* harness.drain;
          expect(yield* harness.requests).toEqual(
            requestsOf(env, [WS_METHODS.factoryDeliveriesSubscribe, ...READS]),
          );
        }),
      ),
  );
});
