import { type EnvironmentId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import type { FactoryDeliveryRefInput } from "@t3tools/contracts/fd/factory";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentRpcKey,
} from "../../state/runtime.ts";
import { serverFactorySupport } from "./model.ts";

interface EnvironmentTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

/**
 * Factory reads and writes for one client. A read exists only while its environment's server
 * advertises Factory: on any other (an older server, or one whose config has not arrived) it
 * stays idle and builds no query, so neither a request nor the change stream reaches a server
 * that does not serve them. Every read refetches when the environment's Factory epoch moves, so
 * a change made anywhere (another client, an agent, the delivery's own worker) reaches every view
 * without polling. Writes are guarded by `permissionAtom`, rechecked against the destination's
 * grants when they run; their results arrive through the epoch the server moves after commit.
 */
export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  /** Whether the environment's server advertises Factory; surfaces gate their entry points on it. */
  const supported = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => serverFactorySupport(get(serverConfigsAtom).get(environmentId)) !== undefined,
    ).pipe(Atom.withLabel(`factory:supported:${environmentId}`)),
  );

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

  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:factory:changes",
    tag: WS_METHODS.factoryDeliveriesSubscribe,
    // A resubscribe answers the current epoch again; only a move refetches, and a reconnect
    // already re-runs every read.
    transform: Stream.changes,
  });
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes({ environmentId, input: {} });

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

  return {
    supported,
    changes: supportedOnly("factory:changes", changes),
    /** One project's deliveries, or the environment's without a project, newest first. */
    deliveries: supportedOnly(
      "factory:deliveries",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:deliveries",
        tag: WS_METHODS.factoryDeliveriesList,
        staleTimeMs: 30_000,
        refreshTrigger,
      }),
    ),
    delivery: supportedOnly(
      "factory:delivery",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:delivery",
        tag: WS_METHODS.factoryDeliveriesGet,
        staleTimeMs: 15_000,
        refreshTrigger,
      }),
    ),
    settings: supportedOnly(
      "factory:settings",
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:factory:settings",
        tag: WS_METHODS.factorySettingsGet,
        staleTimeMs: 30_000,
        refreshTrigger,
      }),
    ),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:factory:start",
      tag: WS_METHODS.factoryDeliveriesStart,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          lane(environmentId, "item", input.itemRef.sourceId, input.itemRef.itemId),
      },
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:factory:stop",
      tag: WS_METHODS.factoryDeliveriesStop,
      scheduler,
      concurrency: byDelivery,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:factory:resume",
      tag: WS_METHODS.factoryDeliveriesResume,
      scheduler,
      concurrency: byDelivery,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:factory:cancel",
      tag: WS_METHODS.factoryDeliveriesCancel,
      scheduler,
      concurrency: byDelivery,
    }),
    setSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:factory:set-settings",
      tag: WS_METHODS.factorySettingsSet,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => lane(environmentId, "settings", input.projectId),
      },
    }),
  };
}
