import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/fd/factory";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";

/** Factory reads and guarded commands for this web client. */
export const factoryEnvironment = createFactoryEnvironmentAtoms(
  connectionAtomRuntime,
  environmentServerConfigsAtom,
);
