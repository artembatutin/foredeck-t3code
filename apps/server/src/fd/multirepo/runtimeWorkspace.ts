import type {
  OrchestrationV2ProviderCapabilities,
  RuntimeMode,
  ThreadWorkspaceBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RepositorySet from "./RepositorySet.ts";

export class RuntimeWorkspaceError extends Schema.TaggedError<RuntimeWorkspaceError>()(
  "RuntimeWorkspaceError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** Validate before opening, resuming or switching a provider session. */
export const resolveRuntimeWorkspace = Effect.fn("multirepo.resolveRuntimeWorkspace")(
  function* (input: {
    readonly binding: ThreadWorkspaceBinding;
    readonly worktreePath: string | null;
    readonly runtimeMode: RuntimeMode;
    readonly capabilities: OrchestrationV2ProviderCapabilities | undefined;
  }) {
    const repositories = yield* RepositorySet.RepositorySet;
    const multi = RepositorySet.isMultiRepo(input.binding.repositories);
    if (multi) {
      if (input.worktreePath !== null)
        yield* RepositorySet.assertCheckoutMode(input.binding.repositories, "worktree");
      if (!input.capabilities?.multiRepository?.runtimeModes.includes(input.runtimeMode))
        return yield* new RuntimeWorkspaceError({
          detail:
            "This provider does not support multi-repository execution in the selected permission mode. Choose a compatible provider and mode.",
        });
    }
    yield* repositories.validate(input.binding);
    return {
      cwd: input.worktreePath ?? input.binding.defaultCwd,
      repositories: multi && input.worktreePath === null ? input.binding.repositories : undefined,
    };
  },
);
