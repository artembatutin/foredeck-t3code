import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  RepositoryTargetError,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectRepository,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointRefUnavailableError } from "../../checkpointing/Errors.ts";
import * as CheckpointService from "../../orchestration-v2/CheckpointService.ts";
import * as CheckpointCaptureService from "../../orchestration-v2/CheckpointCaptureService.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as RepositoryCheckpoints from "./RepositoryCheckpoints.ts";

const threadId = ThreadId.make("repository-history");
const providerInstanceId = ProviderInstanceId.make("test");
const providerThreadId = ProviderThreadId.make("history-provider");
const driver = ProviderDriverKind.make("test");
const modelSelection = { instanceId: providerInstanceId, model: "test" };
const gitLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const storeLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(gitLayer),
  Layer.provide(NodeServices.layer),
);
const checkpointLayer = CheckpointService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(storeLayer, IdAllocator.layer, NodeCrypto.layer)),
);
const queryLayer = CheckpointDiffQuery.layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        return Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: (id) =>
            projections
              .getCheckpointContext(id)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: id, cause }),
                ),
              ),
        });
      }),
    ),
  ),
);

it.effect("keeps repository snapshots separate through partial failure, restart and replay", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* VcsProcess.VcsProcess;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fd-multirepo-history-" });
    const members: ProjectRepository[] = [];
    for (const [index, suffix] of ["app", "services/api", "tools"].entries()) {
      const cwd = directory + "/" + suffix;
      yield* fs.makeDirectory(cwd + "/src", { recursive: true });
      const git = (args: string[]) =>
        vcs.run({ operation: "test.history", command: "git", cwd, args });
      yield* git(["init", "--initial-branch", `branch-${index}`]);
      yield* fs.writeFileString(cwd + "/src/index.ts", `original ${index}\n`);
      yield* git(["add", "."]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "test: initial files",
      ]);
      members.push({
        id: String(index),
        name: `Repository ${index}`,
        rootPath: yield* fs.realPath(cwd),
      });
    }
    const primary = members[0]!;
    const service = members[1]!;
    const tools = members[2]!;
    const now = yield* DateTime.now;
    const events = yield* Ref.make<OrchestrationV2DomainEvent[]>([]);
    const emit = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* projections.apply(event);
        yield* Ref.update(events, (previous) => [...previous, event]);
      });
    const captureLayer = CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            return Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.gen(function* () {
                  for (const event of input.events) yield* projections.apply(event);
                  yield* Ref.update(events, (previous) => [...previous, ...input.events]);
                  return {
                    committed: true,
                    cancelledEffectCount: 0,
                    storedEvents: [],
                    receipt: {
                      commandId: input.commandId,
                      threadId: input.threadId,
                      commandType: input.commandType,
                      acceptedAt: input.acceptedAt,
                      status: "accepted" as const,
                      resultSequence: 1,
                      error: null,
                    },
                  };
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new EventSink.EventSinkWriteError({
                        eventCount: input.events.length,
                        commandId: input.commandId,
                        cause,
                      }),
                  ),
                ),
            });
          }),
        ),
      ),
    );
    const session = (name: string) =>
      Layer.mergeAll(captureLayer, queryLayer).pipe(
        Layer.provideMerge(checkpointLayer),
        Layer.provideMerge(
          ProjectionStore.layer.pipe(
            Layer.provide(Sqlite.layerFromPath(directory + "/" + name + ".sqlite")),
          ),
        ),
      );
    const startTurn = (ordinal: number) =>
      Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const repositoryCheckpoints = yield* RepositoryCheckpoints.make;
        const runId = RunId.make(`history-${ordinal}`);
        const nodeId = NodeId.make(`history-${ordinal}`);
        const scope = yield* checkpoints.prepareRootRunScope({
          threadId,
          runId,
          rootNodeId: nodeId,
          providerThreadId,
          cwd: primary.rootPath,
          repositories: members,
          createdAt: now,
        });
        const run: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message-${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: ordinal === 2 ? "failed" : "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* emit({
          id: EventId.make(`run-${ordinal}`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: run,
        });
        yield* emit({
          id: EventId.make(`node-${ordinal}`),
          type: "node.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "waiting",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: scope.id,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* emit({
          id: EventId.make(`scope-${ordinal}`),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          occurredAt: now,
          payload: scope,
        });
        yield* repositoryCheckpoints.captureBaselines(scope, ordinal - 1);
        return { threadId, runId, scopeId: scope.id };
      });
    yield* Effect.gen(function* () {
      const captures = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      yield* emit({
        id: EventId.make("thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("history-project"),
          title: "History",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          workspaceBinding: { version: 1, defaultCwd: primary.rootPath, repositories: members },
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* emit({
        id: EventId.make("provider"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: NodeId.make("history-1"),
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const first = yield* startTurn(1);
      for (const member of members)
        yield* fs.writeFileString(member.rootPath + "/src/index.ts", `first ${member.id}\n`);
      yield* fs.rename(tools.rootPath, tools.rootPath + "-offline");
      yield* captures.execute(first);
      const snapshot = yield* projections.getThreadProjection(threadId);
      const item = snapshot.turnItems.find((item) => item.type === "checkpoint");
      assert.isDefined(item);
      if (item?.type !== "checkpoint") return yield* Effect.die("missing checkpoint summary");
      assert.deepEqual(
        item.repositoryCheckpoints?.map((entry) => [
          entry.repository.id,
          entry.status,
          entry.filesAvailable,
        ]),
        [
          [primary.id, "ready", true],
          [service.id, "ready", true],
          [tools.id, "missing", false],
        ],
      );
      assert.lengthOf(snapshot.checkpointScopes, 3);
      for (const member of [primary, service]) {
        const diff = yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 1,
          repositoryId: member.id,
        });
        assert.include(diff.diff, `+first ${member.id}`);
        assert.notInclude(diff.diff, `+first ${member === primary ? service.id : primary.id}`);
      }
      assert.instanceOf(
        yield* query
          .getFullThreadDiff({ threadId, toTurnCount: 1, repositoryId: tools.id })
          .pipe(Effect.flip),
        CheckpointRefUnavailableError,
      );
      for (const repositoryId of [undefined, "unknown"])
        assert.instanceOf(
          yield* query
            .getFullThreadDiff({
              threadId,
              toTurnCount: 1,
              ...(repositoryId === undefined ? {} : { repositoryId }),
            })
            .pipe(Effect.flip),
          RepositoryTargetError,
        );
      const before = (yield* Ref.get(events)).length;
      yield* captures.execute(first);
      assert.equal((yield* Ref.get(events)).length, before);
    }).pipe(Effect.provide(session("state")), Effect.scoped);

    yield* fs.rename(tools.rootPath + "-offline", tools.rootPath);
    yield* Effect.gen(function* () {
      const captures = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const second = yield* startTurn(2);
      for (const member of members)
        yield* fs.writeFileString(member.rootPath + "/src/index.ts", `second ${member.id}\n`);
      yield* captures.execute(second);
      const snapshot = yield* projections.getThreadProjection(threadId);
      const item = snapshot.turnItems.find(
        (item) => item.type === "checkpoint" && item.runId === second.runId,
      );
      if (item?.type !== "checkpoint")
        return yield* Effect.die("missing second checkpoint summary");
      assert.equal(item.repositoryCheckpoints?.[2]?.status, "ready");
      assert.equal(item.repositoryCheckpoints?.[2]?.baselineStatus, "missing");
      assert.isFalse(item.repositoryCheckpoints?.[2]?.filesAvailable);
      for (const fromTurnCount of [0, 1])
        assert.instanceOf(
          yield* query
            .getTurnDiff({ threadId, fromTurnCount, toTurnCount: 2, repositoryId: tools.id })
            .pipe(Effect.flip),
          CheckpointRefUnavailableError,
        );
      const serviceDiff = yield* query.getTurnDiff({
        threadId,
        fromTurnCount: 1,
        toTurnCount: 2,
        repositoryId: service.id,
      });
      assert.include(serviceDiff.diff, `-first ${service.id}`);
      assert.include(serviceDiff.diff, `+second ${service.id}`);
      yield* fs.writeFileString(primary.rootPath + "/src/index.ts", "uncaptured external edit\n");
      const history = yield* query.getFullThreadDiff({
        threadId,
        toTurnCount: 2,
        repositoryId: primary.id,
      });
      assert.include(history.diff, `-original ${primary.id}`);
      assert.include(history.diff, `+second ${primary.id}`);
      assert.notInclude(history.diff, "uncaptured");
      yield* fs.rename(service.rootPath, service.rootPath + "-offline");
      assert.equal(
        (yield* Effect.exit(
          query.getFullThreadDiff({ threadId, toTurnCount: 2, repositoryId: service.id }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* query.getFullThreadDiff({ threadId, toTurnCount: 2, repositoryId: primary.id }))
          .diff,
        history.diff,
      );
      yield* fs.rename(service.rootPath + "-offline", service.rootPath);
    }).pipe(Effect.provide(session("state")), Effect.scoped);

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const event of yield* Ref.get(events)) yield* projections.apply(event);
      const context = yield* projections.getCheckpointContext(threadId);
      assert.deepEqual(context.repositories, members);
      assert.lengthOf(context.checkpointScopes, 3);
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      assert.include(
        (yield* query.getFullThreadDiff({ threadId, toTurnCount: 2, repositoryId: service.id }))
          .diff,
        `+second ${service.id}`,
      );
      assert.instanceOf(
        yield* query
          .getFullThreadDiff({ threadId, toTurnCount: 2, repositoryId: tools.id })
          .pipe(Effect.flip),
        CheckpointRefUnavailableError,
      );
    }).pipe(Effect.provide(session("replay")), Effect.scoped);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, gitLayer))),
);
