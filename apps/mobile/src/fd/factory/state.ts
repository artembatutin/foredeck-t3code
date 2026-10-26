import {
  createFactoryEnvironmentAtoms,
  createFactoryFleetAtom,
} from "@t3tools/client-runtime/fd/factory";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { workspaceConnections } from "../../state/workspace";

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

/** Active deliveries across the connected environments that serve Factory. */
export const factoryFleetAtom = createFactoryFleetAtom({
  environmentsAtom: workspaceConnections.environmentsAtom,
  supported: factoryEnvironment.supported,
  deliveries: (environmentId) => factoryEnvironment.deliveries({ environmentId, input: {} }),
});
