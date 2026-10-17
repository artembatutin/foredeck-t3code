import type {
  CheckpointScopeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2Run,
  RepositoryTurnCheckpoint,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as CheckpointService from "../../orchestration-v2/CheckpointService.ts";

/** Repository scopes share turn ordinals while keeping refs and file identities separate. */
export const make = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const scopes = Effect.fn("RepositoryCheckpoints.scopes")(function* (
    root: OrchestrationV2CheckpointScope,
  ) {
    const members = root.repositories ?? [];
    if (members.length < 2) return [root];
    return yield* Effect.forEach(members, (repository, index) =>
      Effect.gen(function* () {
        if (index === 0) return root;
        const { repositories: _repositories, ...base } = root;
        return {
          ...base,
          id: yield* ids.allocate.checkpointScope({
            threadId: root.threadId,
            name: `repository:${repository.id}`,
          }),
          repository,
          cwd: repository.rootPath,
          kind: "manual" as const,
          parentScopeId: root.id,
          ordinalWithinParent: index,
          advancesAppRunCount: false,
        };
      }),
    );
  });
  return {
    captureBaselines: Effect.fn("RepositoryCheckpoints.captureBaselines")(function* (
      root: OrchestrationV2CheckpointScope,
      ordinal: number,
    ) {
      yield* Effect.forEach(
        yield* scopes(root),
        (scope) =>
          checkpoints.captureBaseline({ scope, ordinalWithinScope: ordinal }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Repository checkpoint baseline unavailable", {
                    repositoryId: scope.repository?.id,
                    scopeId: scope.id,
                  }),
            ),
          ),
        { concurrency: 2, discard: true },
      );
    }),
    captureAdditional: Effect.fn("RepositoryCheckpoints.captureAdditional")(function* (input: {
      readonly root: OrchestrationV2CheckpointScope;
      readonly run: OrchestrationV2Run;
      readonly capturedAt: DateTime.Utc;
      readonly recorded: ReadonlyArray<{
        readonly scopeId: CheckpointScopeId;
        readonly ordinal: number;
        readonly status: OrchestrationV2Checkpoint["status"];
      }>;
    }) {
      return yield* Effect.forEach(
        (yield* scopes({
          ...input.root,
          runId: input.run.id,
          nodeId: input.run.rootNodeId ?? input.root.nodeId,
          providerThreadId: input.run.providerThreadId,
        })).slice(1),
        (scope) =>
          Effect.gen(function* () {
            const baselineOrdinals = [...new Set([0, Math.max(0, input.run.ordinal - 1)])];
            const baselines = yield* Effect.forEach(
              baselineOrdinals.filter(
                (ordinal) =>
                  !input.recorded.some(
                    (entry) => entry.scopeId === scope.id && entry.ordinal === ordinal,
                  ),
              ),
              (ordinalWithinScope) =>
                checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope }),
            );
            const checkpoint = yield* checkpoints.capture({
              scope,
              runId: input.run.id,
              nodeId: scope.nodeId,
              ordinalWithinScope: input.run.ordinal,
              appRunOrdinal: input.run.ordinal,
              capturedAt: input.capturedAt,
            });
            return { scope, checkpoints: [...baselines, checkpoint], checkpoint };
          }),
        { concurrency: 2 },
      );
    }),
  };
});

/** A captured end ref does not imply that its baseline or file summary is available. */
export function turnSummary(input: {
  readonly scope: OrchestrationV2CheckpointScope;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly baselines: ReadonlyArray<OrchestrationV2Checkpoint>;
  readonly recorded: ReadonlyArray<{
    readonly scopeId: CheckpointScopeId;
    readonly ordinal: number;
    readonly status: OrchestrationV2Checkpoint["status"];
  }>;
}): RepositoryTurnCheckpoint | undefined {
  if (input.scope.repository === undefined) return undefined;
  const previousOrdinal = Math.max(0, input.checkpoint.ordinalWithinScope - 1);
  const baselineStatus =
    input.recorded.find(
      (entry) => entry.scopeId === input.scope.id && entry.ordinal === previousOrdinal,
    )?.status ??
    input.baselines.find((checkpoint) => checkpoint.ordinalWithinScope === previousOrdinal)
      ?.status ??
    "missing";
  const filesAvailable =
    baselineStatus === "ready" &&
    input.checkpoint.status === "ready" &&
    input.checkpoint.filesAvailable !== false;
  return {
    repository: input.scope.repository,
    checkpointId: input.checkpoint.id,
    scopeId: input.scope.id,
    status: input.checkpoint.status,
    baselineStatus,
    filesAvailable,
    files: filesAvailable ? input.checkpoint.files : [],
  };
}
