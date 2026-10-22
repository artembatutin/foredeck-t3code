import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSettingsWriteScope,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFavicon from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentity from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

const layer = Layer.mergeAll(
  RuntimeLayer.layerProjectService,
  ProjectStore.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provide(ProjectEnrichment.layer),
  Layer.provide(
    Layer.merge(
      Layer.succeed(ProjectFavicon.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
      Layer.succeed(RepositoryIdentity.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provide(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fd-membership-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("project repository integration", (it) => {
  it.effect(
    "updates membership through the ordinary project service and preserves its primary directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* VcsProcess.VcsProcess;
        const projects = yield* ProjectService.ProjectService;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fd-member-project-" });
        const a = root + "/a";
        const b = root + "/b";
        for (const cwd of [a, b]) {
          yield* fs.makeDirectory(cwd);
          yield* git.run({ operation: "test.init", command: "git", args: ["init"], cwd });
        }
        const projectId = ProjectId.make("ordinary-mutation");
        yield* projects.create({
          commandId: CommandId.make("create"),
          projectId,
          title: "Project",
          workspaceRoot: a,
        });
        const configured = yield* projects.update({
          commandId: CommandId.make("add"),
          projectId,
          repositories: [
            { name: "A", rootPath: a },
            { name: "B", rootPath: b },
          ],
        });
        assert.equal(configured.repositories?.length, 2);
        assert.equal(configured.workspaceRoot, a);
        assert.deepEqual(
          Option.getOrThrow(yield* projects.getShell(projectId)).repositories,
          configured.repositories,
        );
        const ownerId = ProjectId.make("other-project-owner");
        const c = root + "/c";
        yield* fs.makeDirectory(c);
        yield* git.run({ operation: "test.init", command: "git", args: ["init"], cwd: c });
        yield* projects.create({
          commandId: CommandId.make("create-owner"),
          projectId: ownerId,
          title: "Independent",
          workspaceRoot: c,
        });
        const overlap = yield* projects
          .update({
            commandId: CommandId.make("overlap"),
            projectId,
            repositories: [...configured.repositories!, { name: "Other project", rootPath: c }],
          })
          .pipe(Effect.flip);
        assert.equal(overlap._tag, "RepositorySetError");
        assert.include(overlap.message, "another project");
        const primary = configured.repositories![0]!;
        yield* fs.remove(b, { recursive: true });
        const single = yield* projects.update({
          commandId: CommandId.make("remove"),
          projectId,
          repositories: [],
        });
        assert.deepEqual(single.repositories, [primary]);
        const moved = yield* projects.update({
          commandId: CommandId.make("move"),
          projectId,
          workspaceRoot: root,
        });
        assert.deepEqual(moved.repositories, []);
        assert.equal(Option.getOrThrow(yield* projects.getById(projectId)).workspaceRoot, root);
        assert.include(
          requiredScopesForProjectMutation({
            type: "project.update",
            commandId: CommandId.make("authorized"),
            projectId,
            repositories: [],
          }),
          AuthSettingsWriteScope,
        );
      }),
  );

  it.effect(
    "rejects entering multi-repo mode when a historical worktree thread still belongs to the project",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* VcsProcess.VcsProcess;
        const projects = yield* ProjectService.ProjectService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fd-worktree-transition-" });
        const roots = [root + "/a", root + "/b"];
        for (const cwd of roots) {
          yield* fs.makeDirectory(cwd);
          yield* git.run({ operation: "test.init", command: "git", args: ["init"], cwd });
        }
        const projectId = ProjectId.make("worktree-transition");
        const threadId = ThreadId.make("old-worktree");
        const instanceId = ProviderInstanceId.make("test");
        const now = yield* DateTime.now;
        yield* projects.create({
          commandId: CommandId.make("create-worktree-project"),
          projectId,
          title: "Project",
          workspaceRoot: roots[0]!,
        });
        yield* projections.apply({
          id: EventId.make("old-worktree-created"),
          type: "thread.created",
          threadId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Existing worktree",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "feature/existing",
            worktreePath: root + "/existing-worktree",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: now,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const error = yield* projects
          .update({
            commandId: CommandId.make("transition"),
            projectId,
            repositories: roots.map((rootPath, index) => ({ name: String(index), rootPath })),
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "RepositorySetError");
        assert.include(error.message, "worktree threads");
        assert.equal(
          (yield* projections.getThread(threadId)).worktreePath,
          root + "/existing-worktree",
        );
        assert.deepEqual(Option.getOrThrow(yield* projects.getById(projectId)).repositories, []);
      }),
  );
});
