import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";
import { RepositorySet, resolveRuntimeWorkspace } from "../fd/multirepo/index.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised when available, otherwise its first advertised mode. Remote
 * providers may offer only Full access in their hosted workspace.
 */
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : supportedRuntimeModes.includes("approval-required")
      ? "approval-required"
      : (supportedRuntimeModes[0] ?? "approval-required");
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | RepositorySet.RepositorySet
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const repositories = yield* RepositorySet.RepositorySet;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        if (input.thread.workspaceBinding !== undefined) {
          const binding = input.thread.workspaceBinding;
          const workspace = yield* Effect.gen(function* () {
            if (
              RepositorySet.isMultiRepo(binding.repositories) &&
              supportedRuntimeModes !== undefined &&
              supportedRuntimeModes.length > 0 &&
              !supportedRuntimeModes.includes(input.thread.runtimeMode)
            )
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                detail:
                  "The selected permission mode is unavailable for this multi-repository provider. Choose a supported mode.",
              });
            const capabilities =
              RepositorySet.isMultiRepo(binding.repositories) && instance !== undefined
                ? yield* instance.orchestrationAdapter.getCapabilities()
                : undefined;
            return yield* resolveRuntimeWorkspace({
              binding,
              worktreePath: input.thread.worktreePath,
              runtimeMode: input.thread.runtimeMode,
              capabilities,
            });
          }).pipe(
            Effect.provideService(RepositorySet.RepositorySet, repositories),
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: RepositorySet.isMultiRepo(binding.repositories)
              ? input.thread.runtimeMode
              : providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
            interactionMode: input.thread.interactionMode,
            ...workspace,
          });
        }
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.flatMap((policy) => {
              if (
                RepositorySet.isMultiRepo(policy.repositories) &&
                ((override.cwd !== undefined && override.cwd !== policy.cwd) ||
                  override.sandboxPolicy !== undefined)
              )
                return Effect.fail(
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    detail:
                      "A multi-repository thread's directories and sandbox roots cannot be overridden.",
                  }),
                );
              return Effect.succeed(
                ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  ...policy,
                  ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                  ...(override.approvalPolicy === undefined
                    ? {}
                    : { approvalPolicy: override.approvalPolicy }),
                  ...(override.sandboxPolicy === undefined
                    ? {}
                    : { sandboxPolicy: override.sandboxPolicy }),
                  ...(override.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: override.reasoningEffort }),
                }),
              );
            }),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
