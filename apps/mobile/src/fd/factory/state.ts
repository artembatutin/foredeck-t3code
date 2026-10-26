import {
  createFactoryEnvironmentAtoms,
  type FactoryFleetEnvironment,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";

/** Factory reads and guarded commands for this mobile client. */
export const factoryEnvironment = createFactoryEnvironmentAtoms(
  connectionAtomRuntime,
  environmentServerConfigsAtom,
);

/** Whether any environment's server advertises Factory. */
export const factoryAnySupportedAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom).keys()].some((environmentId) =>
    get(factoryEnvironment.supported(environmentId)),
  ),
).pipe(Atom.withLabel("factory:any-supported"));

/**
 * Every Factory environment's deliveries, read without a project, so each refetches on its
 * environment's change epoch and stays idle where Factory is not served.
 */
export const factoryFleetAtom = Atom.make((get) => {
  const environments: Array<FactoryFleetEnvironment> = [];
  const failed: Array<EnvironmentId> = [];
  let loading = false;
  for (const environmentId of [...get(environmentServerConfigsAtom).keys()].sort()) {
    if (!get(factoryEnvironment.supported(environmentId))) continue;
    const result = get(factoryEnvironment.deliveries({ environmentId, input: {} }));
    const deliveries = Option.getOrNull(AsyncResult.value(result))?.deliveries ?? null;
    if (result._tag === "Failure") failed.push(environmentId);
    else if (deliveries === null) loading = true;
    environments.push({ environmentId, supported: true, deliveries });
  }
  return { environments, loading, failed };
}).pipe(Atom.withLabel("factory:fleet"));
