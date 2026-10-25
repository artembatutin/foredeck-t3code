import { type EnvironmentId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import type { FactoryDeliveryRefInput } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import * as EnvironmentSupervisor from "../../connection/supervisor.ts";
import {
  EnvironmentRpcUnavailableError,
  request,
  requestGuarded,
  subscribeDynamic,
} from "../../rpc/client.ts";
import type { RpcSession } from "../../rpc/session.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
} from "../../state/runtime.ts";
import { serverFactorySupport } from "./model.ts";

interface EnvironmentTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

/** Whether a session's server advertises Factory, from the config the session connected with. */
const sessionServesFactory = (session: RpcSession) =>
  session.initialConfig.pipe(
    Effect.map((config) => serverFactorySupport(config) !== undefined),
    Effect.orElseSucceed(() => false),
  );

/**
 * Factory reads and writes for one client. Nothing Factory reaches an environment unless its
 * server advertises Factory, both in this client's view of the server's config and in the config
 * of the session that would carry the request: just after a reconnect the view can still hold the
 * previous server's config. On any other environment a read stays idle and a write fails before
 * it is sent, checked when it would go out rather than when it was queued, and the change stream
 * closes when support goes, even while no view reads it.
 *
 * Every read refetches when the environment's Factory epoch moves, so a change made anywhere
 * (another client, an agent, the delivery's own worker) reaches every view without polling.
 * Writes are guarded by `permissionAtom`, rechecked against the destination's grants when they
 * run; their results arrive through the epoch the server moves after commit.
 */
export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  /** Whether this client's view of the environment's server config advertises Factory. */
  const supported = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => serverFactorySupport(get(serverConfigsAtom).get(environmentId)) !== undefined,
    ).pipe(Atom.withLabel(`factory:supported:${environmentId}`)),
  );

  /** Whether a request may leave now for the environment the running effect targets. */
  const servedNow = Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    // Every atom effect runs with its registry in context; the shared helpers do not declare it.
    const registry = yield* Effect.serviceOption(AtomRegistry.AtomRegistry);
    if (
      Option.isNone(registry) ||
      !registry.value.get(supported(supervisor.target.environmentId))
    ) {
      return false;
    }
    const session = yield* SubscriptionRef.get(supervisor.session);
    return Option.isSome(session) && (yield* sessionServesFactory(session.value));
  });
  /** A read held while the destination does not serve Factory, so it stays idle. */
  const readWhenServed = <A, Err>(
    send: Effect.Effect<A, Err, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) => Effect.flatMap(servedNow, (served) => (served ? send : Effect.never));
  /** A write that fails, unsent, while the destination does not serve Factory. */
  const writeWhenServed = <A, Err>(
    send: Effect.Effect<A, Err, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) =>
    Effect.gen(function* () {
      if (yield* servedNow) return yield* send;
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: supervisor.target.environmentId,
        message: `${supervisor.target.label} does not offer Factory. Update its server to use Factory.`,
      });
    });

  const supportedOnly = <Input, A, Err>(
    label: string,
    read: (target: EnvironmentTarget<Input>) => Atom.Atom<AsyncResult.AsyncResult<A, Err>>,
  ) => {
    const family = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [EnvironmentId, Input];
      const target = { environmentId, input };
      // A refresh reaches the query only once a supported read built it, so it never builds one.
      let open = false;
      return Atom.readable(
        (get): AsyncResult.AsyncResult<A, Err> => {
          open = get(supported(environmentId));
          return open ? get(read(target)) : AsyncResult.initial();
        },
        (refresh) => {
          if (open) refresh(read(target));
        },
      ).pipe(Atom.withLabel(`${label}:${key}`));
    });
    return (target: EnvironmentTarget<Input>) => family(environmentRpcKey(target));
  };

  // Reading support ties the stream's life to it, which an outer read cannot: a dropped
  // dependency leaves this atom alive on its idle TTL, and a reconnect would subscribe again.
  const changes = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) =>
        get(supported(environmentId))
          ? followStreamInEnvironment(
              environmentId,
              subscribeDynamic(WS_METHODS.factoryDeliveriesSubscribe, (session) =>
                Effect.flatMap(sessionServesFactory(session), (served) =>
                  served ? Effect.succeed({}) : Effect.never,
                ),
              ),
            ).pipe(
              // A resubscribe answers the current epoch again; only a move refetches, and a
              // reconnect already re-runs every read.
              Stream.changes,
            )
          : Stream.never,
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:factory:changes:${environmentId}`),
      ),
  );
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes(environmentId);

  const scheduler = createAtomCommandScheduler();
  // Writes to one delivery, one item's start and one project's settings each run in order, so a
  // stop then a cancel, or two saves, reach the server as issued; other targets do not wait.
  const lane = (environmentId: EnvironmentId, ...target: ReadonlyArray<string>) =>
    JSON.stringify([environmentId, ...target]);
  const byDelivery = {
    mode: "serial",
    key: ({ environmentId, input }: EnvironmentTarget<FactoryDeliveryRefInput>) =>
      lane(environmentId, "delivery", input.deliveryId),
  } as const;
  /** Offers a command only where its grant is held and the destination advertises Factory. */
  const whereSupported = <
    Command extends {
      readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
    },
  >(
    command: Command,
  ) => {
    const available = Atom.family((environmentId: EnvironmentId | null) =>
      Atom.make(
        (get) =>
          environmentId !== null &&
          get(supported(environmentId)) &&
          get(command.permissionAtom(environmentId)),
      ),
    );
    // Factory's scopes are fixed per method, so availability does not depend on the input.
    return {
      ...command,
      permissionAtom: (environmentId: EnvironmentId | null) => available(environmentId),
    };
  };

  return {
    supported,
    changes: supportedOnly(
      "factory:changes",
      ({ environmentId }: EnvironmentTarget<Record<string, never>>) => changes(environmentId),
    ),
    /** One project's deliveries, or the environment's without a project, newest first. */
    deliveries: supportedOnly(
      "factory:deliveries",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:deliveries",
        tag: WS_METHODS.factoryDeliveriesList,
        execute: (input) => readWhenServed(request(WS_METHODS.factoryDeliveriesList, input)),
        staleTimeMs: 30_000,
        refreshTrigger,
      }),
    ),
    delivery: supportedOnly(
      "factory:delivery",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:delivery",
        tag: WS_METHODS.factoryDeliveriesGet,
        execute: (input) => readWhenServed(request(WS_METHODS.factoryDeliveriesGet, input)),
        staleTimeMs: 15_000,
        refreshTrigger,
      }),
    ),
    settings: supportedOnly(
      "factory:settings",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:settings",
        tag: WS_METHODS.factorySettingsGet,
        execute: (input) => readWhenServed(request(WS_METHODS.factorySettingsGet, input)),
        staleTimeMs: 30_000,
        refreshTrigger,
      }),
    ),
    start: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:start",
        tag: WS_METHODS.factoryDeliveriesStart,
        execute: (input) =>
          writeWhenServed(requestGuarded(WS_METHODS.factoryDeliveriesStart, input)),
        scheduler,
        concurrency: {
          mode: "serial",
          key: ({ environmentId, input }) =>
            lane(environmentId, "item", input.itemRef.sourceId, input.itemRef.itemId),
        },
      }),
    ),
    stop: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:stop",
        tag: WS_METHODS.factoryDeliveriesStop,
        execute: (input) =>
          writeWhenServed(requestGuarded(WS_METHODS.factoryDeliveriesStop, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    resume: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:resume",
        tag: WS_METHODS.factoryDeliveriesResume,
        execute: (input) =>
          writeWhenServed(requestGuarded(WS_METHODS.factoryDeliveriesResume, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    cancel: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:cancel",
        tag: WS_METHODS.factoryDeliveriesCancel,
        execute: (input) =>
          writeWhenServed(requestGuarded(WS_METHODS.factoryDeliveriesCancel, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    setSettings: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:set-settings",
        tag: WS_METHODS.factorySettingsSet,
        execute: (input) => writeWhenServed(requestGuarded(WS_METHODS.factorySettingsSet, input)),
        scheduler,
        concurrency: {
          mode: "serial",
          key: ({ environmentId, input }) => lane(environmentId, "settings", input.projectId),
        },
      }),
    ),
  };
}
