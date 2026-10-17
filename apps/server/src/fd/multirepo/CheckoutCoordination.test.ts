import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  MessageId,
  type ApplicationProjectEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as CheckoutCoordination from "./CheckoutCoordination.ts";

const layer = Layer.mergeAll(
  GitVcsDriver.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  VcsDriverRegistry.layer,
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "fd-mutation-test-" }),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("shared checkout mutations", (it) => {
  it.effect(
    "serializes nested paths without blocking other repositories and guards active historical bindings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const threads = yield* ProjectionStore.ProjectionStoreV2;
        const coordination = yield* CheckoutCoordination.make;
        const workflow = yield* GitWorkflowService.make.pipe(
          Effect.provide(
            Layer.mock(GitManager.GitManager)({ withCheckoutMutation: coordination.withMutation }),
          ),
        );
        const temporary = yield* fs.makeTempDirectoryScoped({
          prefix: "fd-checkout-coordination-",
        });
        const members = [
          { id: "one", name: "App", rootPath: temporary + "/app" },
          { id: "two", name: "Service", rootPath: temporary + "/service" },
        ];
        const first = members[0]!;
        const second = members[1]!;
        const execute = (cwd: string, args: string[]) =>
          git.execute({ operation: "test.coordination", cwd, args });
        const commit = (cwd: string, message: string) =>
          execute(cwd, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            message,
          ]);
        for (const member of members) {
          yield* fs.makeDirectory(member.rootPath + "/src", { recursive: true });
          member.rootPath = yield* fs.realPath(member.rootPath);
          yield* execute(member.rootPath, ["init", "--initial-branch", member.id]);
          yield* fs.writeFileString(member.rootPath + "/src/index.ts", member.id + "\n");
          yield* execute(member.rootPath, ["add", "."]);
          yield* commit(member.rootPath, "test: initial files");
        }
        // A single checkout must not acquire the new shared-checkout lock.
        yield* coordination.withMutation(
          { cwd: first.rootPath, operation: "single-outer" },
          coordination.withMutation(
            { cwd: first.rootPath, operation: "single-inner" },
            Effect.void,
          ),
        );
        const at = yield* DateTime.now;
        const projectId = ProjectId.make("shared");
        const base = {
          sequence: 1,
          eventId: EventId.make("project"),
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(at),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        const project: ApplicationProjectEvent = {
          ...base,
          type: "project.created",
          payload: {
            projectId,
            title: "Shared",
            workspaceRoot: first.rootPath,
            repositories: members,
            defaultModelSelection: null,
            scripts: [],
            createdAt: base.occurredAt,
            updatedAt: base.occurredAt,
          },
        };
        yield* projects.apply(project);
        const firstEntered = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const firstDone = yield* Ref.make(false);
        const mutation = { cwd: first.rootPath, operation: "commit" };
        const firstFiber = yield* coordination
          .withMutation(
            mutation,
            Effect.gen(function* () {
              yield* fs.writeFileString(first.rootPath + "/first.txt", "first\n");
              yield* execute(first.rootPath, ["add", "first.txt"]);
              yield* Deferred.succeed(firstEntered, undefined);
              yield* Deferred.await(firstRelease);
              yield* commit(first.rootPath, "test: first mutation");
              yield* Ref.set(firstDone, true);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstEntered);
        const secondFiber = yield* coordination
          .withMutation(
            { ...mutation, cwd: first.rootPath + "/src" },
            Effect.gen(function* () {
              assert.isTrue(yield* Ref.get(firstDone));
              yield* fs.writeFileString(first.rootPath + "/second.txt", "second\n");
              yield* execute(first.rootPath, ["add", "second.txt"]);
              yield* commit(first.rootPath, "test: second mutation");
            }),
          )
          .pipe(Effect.forkChild);
        yield* coordination.withMutation(
          { cwd: second.rootPath, operation: "branch", changesBranch: true },
          git.createRef({ cwd: second.rootPath, refName: "independent", switchRef: true }),
        );
        assert.isFalse(yield* Ref.get(firstDone));
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        assert.equal(
          (yield* execute(first.rootPath, [
            "show",
            "--format=",
            "--name-only",
            "HEAD~1",
          ])).stdout.trim(),
          "first.txt",
        );
        assert.equal(
          (yield* execute(first.rootPath, [
            "show",
            "--format=",
            "--name-only",
            "HEAD",
          ])).stdout.trim(),
          "second.txt",
        );

        const threadId = ThreadId.make("active-shared");
        const providerInstanceId = ProviderInstanceId.make("test");
        const modelSelection = { instanceId: providerInstanceId, model: "test" };
        yield* threads.apply({
          id: EventId.make("thread"),
          type: "thread.created",
          threadId,
          occurredAt: at,
          payload: {
            id: threadId,
            projectId,
            title: "Active shared work",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            workspaceBinding: { version: 1, defaultCwd: first.rootPath, repositories: members },
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const run = {
          id: RunId.make("active"),
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: at,
          startedAt: at,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* threads.apply({
          id: EventId.make("run"),
          type: "run.updated",
          threadId,
          occurredAt: at,
          payload: run,
        });
        // Current project membership changes cannot remove an active thread's checkout guard.
        yield* projects.apply({
          ...base,
          sequence: 2,
          eventId: EventId.make("remove"),
          type: "project.meta-updated",
          payload: { projectId, repositories: [first], updatedAt: base.occurredAt },
        });
        const switchInput = { cwd: second.rootPath, refName: "two" };
        const error = yield* workflow.switchRef(switchInput).pipe(Effect.flip);
        assert.include(error.message, "Active shared work");
        assert.include(
          (yield* workflow
            .createRef({ cwd: second.rootPath, refName: "blocked", switchRef: true })
            .pipe(Effect.flip)).message,
          "Active shared work",
        );
        yield* workflow.createRef({ cwd: second.rootPath, refName: "later", switchRef: false });
        assert.equal(
          (yield* execute(second.rootPath, ["branch", "--show-current"])).stdout.trim(),
          "independent",
        );
        yield* threads.apply({
          id: EventId.make("completed"),
          type: "run.updated",
          threadId,
          occurredAt: at,
          payload: { ...run, status: "completed", completedAt: at },
        });
        yield* workflow.switchRef(switchInput);
        assert.equal(
          (yield* execute(second.rootPath, ["branch", "--show-current"])).stdout.trim(),
          "two",
        );
      }),
  );
});
