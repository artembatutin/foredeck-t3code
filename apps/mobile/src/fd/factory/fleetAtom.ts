import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { FactoryFleetEnvironment } from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FactoryDelivery } from "@t3tools/contracts/fd/factory";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

/** What the mobile fleet reads; the app passes its workspace connections and Factory atoms. */
export interface MobileFleetSources {
  readonly environmentsAtom: Atom.Atom<
    ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly connectionState: EnvironmentConnectionPhase;
    }>
  >;
  readonly supported: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  /** The environment's deliveries across its projects. */
  readonly deliveries: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<
    AsyncResult.AsyncResult<{ readonly deliveries: ReadonlyArray<FactoryDelivery> }, unknown>
  >;
}

/**
 * The fleet across the environments that serve Factory. Deliveries are read only while an
 * environment is connected: a server's config outlives its connection, and a read made while it
 * reconnects waits forever holding what it read before, so it would show stale rows or never
 * finish loading. A Factory environment that is not connected is listed as such instead, and
 * read again once it reconnects.
 */
export const createMobileFleetAtom = (sources: MobileFleetSources) =>
  Atom.make((get) => {
    const environments: Array<FactoryFleetEnvironment> = [];
    const failed: Array<EnvironmentId> = [];
    const disconnected: Array<EnvironmentId> = [];
    let loading = false;
    const known = [...get(sources.environmentsAtom)].sort((left, right) =>
      left.environmentId < right.environmentId
        ? -1
        : left.environmentId > right.environmentId
          ? 1
          : 0,
    );
    for (const { environmentId, connectionState } of known) {
      if (!get(sources.supported(environmentId))) continue;
      if (connectionState !== "connected") {
        disconnected.push(environmentId);
        continue;
      }
      const result = get(sources.deliveries(environmentId));
      const deliveries = Option.getOrNull(AsyncResult.value(result))?.deliveries ?? null;
      if (result._tag === "Failure") failed.push(environmentId);
      else if (deliveries === null) loading = true;
      environments.push({ environmentId, supported: true, deliveries });
    }
    return { environments, loading, failed, disconnected };
  }).pipe(Atom.withLabel("factory:fleet"));
