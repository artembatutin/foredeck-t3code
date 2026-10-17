import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../../connection/registry.ts";
import type { createEnvironmentRpcCommand } from "../../state/runtime.ts";

export function createRepositoryCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  createCommand: typeof createEnvironmentRpcCommand,
) {
  return {
    setRepositories: createCommand(runtime, {
      label: "project:repositories",
      tag: WS_METHODS.projectsSetRepositories,
    }),
  };
}
