import { type EnvironmentId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import type { FactoryDeliveryRefInput, FactorySupport } from "@t3tools/contracts/fd/factory";
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

/**
 * What a request needs its destination to serve: Factory, or Factory's planning (the plan gate's
 * actions and parent starts), which a server from before planning does not serve.
 */
type FactoryNeed = "factory" | "planning";

const serves = (support: FactorySupport | undefined, need: FactoryNeed) =>
  support !== undefined && (need === "factory" || support.planning);

/** Whether a session's server serves `need`, from the config the session connected with. */
const sessionServes = (session: RpcSession, need: FactoryNeed) =>
  session.initialConfig.pipe(
    Effect.map((config) => serves(serverFactorySupport(config), need)),
    Effect.orElseSucceed(() => false),
  );

/**
 * Factory reads and writes for one client. Nothing Factory reaches an environment unless its
 * server advertises Factory, both in this client's view of the server's config and in the config
 * of the session that would carry the request: just after a reconnect the view can still hold the
 * previous server's config. On any other environment a read stays idle and a write fails before
 * it is sent, checked when it would go out rather than when it was queued, and the change stream
 * closes when support goes, even while no view reads it. The plan gate's actions and a parent
 * start need planning advertised the same way, so on a server from before planning they fail
 * unsent rather than reach a server that would refuse them, or one that would start the item as
 * a single delivery.
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
  /** Whether this client's view of the environment's server config serves `need`. */
  const viewServes = (need: FactoryNeed) =>
    Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) =>
        serves(serverFactorySupport(get(serverConfigsAtom).get(environmentId)), need),
      ).pipe(Atom.withLabel(`factory:${need === "factory" ? "supported" : need}:${environmentId}`)),
    );
  const supported = viewServes("factory");
  const planning = viewServes("planning");
  const viewed = { factory: supported, planning } as const;

  /** Whether a request needing `need` may leave now for the environment the effect targets. */
  const servedNow = (need: FactoryNeed) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      // Every atom effect runs with its registry in context; the shared helpers do not declare it.
      const registry = yield* Effect.serviceOption(AtomRegistry.AtomRegistry);
      if (
        Option.isNone(registry) ||
        !registry.value.get(viewed[need](supervisor.target.environmentId))
      ) {
        return false;
      }
      const session = yield* SubscriptionRef.get(supervisor.session);
      return Option.isSome(session) && (yield* sessionServes(session.value, need));
    });
  /** A read held while the destination does not serve Factory, so it stays idle. */
  const readWhenServed = <A, Err>(
    send: Effect.Effect<A, Err, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) => Effect.flatMap(servedNow("factory"), (served) => (served ? send : Effect.never));
  /** A write that fails, unsent, while the destination does not serve what it needs. */
  const writeWhenServed = <A, Err>(
    need: FactoryNeed,
    send: Effect.Effect<A, Err, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) =>
    Effect.gen(function* () {
      if (yield* servedNow(need)) return yield* send;
      const { environmentId, label } = (yield* EnvironmentSupervisor.EnvironmentSupervisor).target;
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message:
          need === "factory"
            ? `${label} does not offer Factory. Update its server to use Factory.`
            : `${label} does not offer Factory planning. Update its server to plan deliveries.`,
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
                Effect.flatMap(sessionServes(session, "factory"), (served) =>
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
  /** Offers a command only where its grant is held and the destination serves what it needs. */
  const whereSupported = <
    Command extends {
      readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
    },
  >(
    command: Command,
    need: FactoryNeed = "factory",
  ) => {
    const available = Atom.family((environmentId: EnvironmentId | null) =>
      Atom.make(
        (get) =>
          environmentId !== null &&
          get(viewed[need](environmentId)) &&
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
    /** Whether this client's view of the environment's server config advertises planning. */
    planning,
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
    /**
     * A single start, or with `kind: "parent"` a parent's, which needs planning: offer it only
     * where `planning` holds. A server from before planning would refuse the kind, and a parent
     * start must never run as a single one.
     */
    start: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:start",
        tag: WS_METHODS.factoryDeliveriesStart,
        execute: (input) =>
          writeWhenServed(
            input.kind === "parent" ? "planning" : "factory",
            requestGuarded(WS_METHODS.factoryDeliveriesStart, input),
          ),
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
          writeWhenServed("factory", requestGuarded(WS_METHODS.factoryDeliveriesStop, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    resume: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:resume",
        tag: WS_METHODS.factoryDeliveriesResume,
        execute: (input) =>
          writeWhenServed("factory", requestGuarded(WS_METHODS.factoryDeliveriesResume, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    cancel: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:cancel",
        tag: WS_METHODS.factoryDeliveriesCancel,
        execute: (input) =>
          writeWhenServed("factory", requestGuarded(WS_METHODS.factoryDeliveriesCancel, input)),
        scheduler,
        concurrency: byDelivery,
      }),
    ),
    setSettings: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:set-settings",
        tag: WS_METHODS.factorySettingsSet,
        execute: (input) =>
          writeWhenServed("factory", requestGuarded(WS_METHODS.factorySettingsSet, input)),
        scheduler,
        concurrency: {
          mode: "serial",
          key: ({ environmentId, input }) => lane(environmentId, "settings", input.projectId),
        },
      }),
    ),
    /** Stores the owner's edit of the plan a delivery waits on at the plan gate. */
    updatePlan: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:update-plan",
        tag: WS_METHODS.factoryPlanUpdate,
        execute: (input) =>
          writeWhenServed("planning", requestGuarded(WS_METHODS.factoryPlanUpdate, input)),
        scheduler,
        concurrency: byDelivery,
      }),
      "planning",
    ),
    approvePlan: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:approve-plan",
        tag: WS_METHODS.factoryPlanApprove,
        execute: (input) =>
          writeWhenServed("planning", requestGuarded(WS_METHODS.factoryPlanApprove, input)),
        scheduler,
        concurrency: byDelivery,
      }),
      "planning",
    ),
    rejectPlan: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:reject-plan",
        tag: WS_METHODS.factoryPlanReject,
        execute: (input) =>
          writeWhenServed("planning", requestGuarded(WS_METHODS.factoryPlanReject, input)),
        scheduler,
        concurrency: byDelivery,
      }),
      "planning",
    ),
    replan: whereSupported(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:factory:replan",
        tag: WS_METHODS.factoryPlanReplan,
        execute: (input) =>
          writeWhenServed("planning", requestGuarded(WS_METHODS.factoryPlanReplan, input)),
        scheduler,
        concurrency: byDelivery,
      }),
      "planning",
    ),
  };
}
