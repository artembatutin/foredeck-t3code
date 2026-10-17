import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  CommandId,
  RepositoryTargetError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectRepository,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as RepositorySet from "./RepositorySet.ts";
import * as ClientCompatibility from "./ClientCompatibility.ts";
import * as CheckoutPolicy from "./CheckoutPolicy.ts";
import * as WorkspaceResolver from "./WorkspaceResolver.ts";

const layer = Layer.mergeAll(
  ProjectStore.layer,
  ProjectionStore.layer,
  RepositorySet.layerDefault,
  VcsProcess.layer,
).pipe(Layer.provide(Sqlite.layerMemory), Layer.provideMerge(NodeServices.layer));

it.layer(layer)("repository operation resolution", (it) => {
  it.effect(
    "targets independent files and Git mutations, preserving historical membership after removal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* VcsProcess.VcsProcess;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const threads = yield* ProjectionStore.ProjectionStoreV2;
        const workspace = yield* WorkspaceResolver.make;
        const resolver = workspace.forClient(true);
        const legacyResolver = workspace.forClient(false);
        const checkoutPolicy = yield* CheckoutPolicy.make;
        const compatibility = yield* ClientCompatibility.make;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "fd-repo-operations-" });
        const roots = [parent + "/client", parent + "/services/api", parent + "/tools"];
        const members: ProjectRepository[] = [];
        const run = (cwd: string, args: string[]) =>
          git.run({ operation: "test.repository", command: "git", cwd, args });
        for (const [index, cwd] of roots.entries()) {
          yield* fs.makeDirectory(cwd + "/src", { recursive: true });
          yield* run(cwd, ["init", "--initial-branch", `repo-${index}`]);
          yield* fs.writeFileString(cwd + "/src/index.ts", `initial ${index}\n`);
          yield* run(cwd, ["add", "."]);
          yield* run(cwd, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "test: initial files",
          ]);
          yield* fs.writeFileString(cwd + "/src/index.ts", `changed ${index}\n`);
          members.push({
            id: String(index),
            name: `Repository ${index}`,
            rootPath: yield* fs.realPath(cwd),
          });
        }
        const primary = members[0]!;
        const service = members[1]!;
        const projectId = ProjectId.make("repository-targets");
        const threadId = ThreadId.make("historical-targets");
        const instanceId = ProviderInstanceId.make("test");
        const now = yield* DateTime.now;
        const binding = {
          version: 1 as const,
          defaultCwd: primary.rootPath,
          repositories: members,
        };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("project-targets"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Targets",
            workspaceRoot: primary.rootPath,
            repositories: members,
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        });
        yield* threads.apply({
          id: EventId.make("thread-targets"),
          type: "thread.created",
          threadId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Targets",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            workspaceBinding: binding,
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
        assert.instanceOf(
          yield* compatibility.assertWorkspace(false, { projectId }).pipe(Effect.flip),
          RepositoryTargetError,
        );
        assert.instanceOf(
          yield* compatibility
            .assertCommand(false, {
              type: "thread.archive",
              commandId: CommandId.make("old-client"),
              threadId,
            })
            .pipe(Effect.flip),
          RepositoryTargetError,
        );
        yield* compatibility.assertWorkspace(true, { projectId, threadIds: [threadId] });
        assert.equal(
          (yield* resolver.resolveThreadPath(threadId, service.rootPath + "/src/index.ts"))?.target
            .repositoryId,
          service.id,
        );
        assert.equal(
          (yield* resolver.resolveThreadPath(threadId, "src/index.ts"))?.target.repositoryId,
          primary.id,
        );
        assert.instanceOf(
          yield* resolver.resolveThreadPath(threadId, parent + "/outside.png").pipe(Effect.flip),
          RepositoryTargetError,
        );
        // An old client must fail before reading files, mutating Git, or subscribing to status.
        assert.match(
          (yield* legacyResolver
            .run({ cwd: primary.rootPath }, () => Effect.die("legacy operation must not run"))
            .pipe(Effect.flip)).message,
          /Update this client/,
        );
        assert.match(
          (yield* legacyResolver
            .stream({ cwd: service.rootPath + "/src" }, () =>
              Stream.die("legacy subscription must not start"),
            )
            .pipe(Stream.runDrain, Effect.flip)).message,
          /Update this client/,
        );
        const alias = parent + "/service-alias";
        yield* fs.symlink(service.rootPath, alias);
        assert.match(
          (yield* legacyResolver.resolveInput({ cwd: alias + "/src" }).pipe(Effect.flip)).message,
          /Update this client/,
        );
        yield* fs.remove(alias);
        for (const input of [
          { threadId },
          { threadId, cwd: primary.rootPath },
          { threadId: "new-multi-draft", cwd: primary.rootPath },
        ]) {
          assert.match(
            (yield* legacyResolver.resolveTerminalInput(input).pipe(Effect.flip)).message,
            /Update this client/,
          );
        }
        const independentCwd = primary.rootPath + "-unrelated";
        assert.equal(
          (yield* legacyResolver.resolveInput({ cwd: independentCwd })).cwd,
          independentCwd,
        );
        assert.equal(
          (yield* legacyResolver.resolveTerminalInput({
            threadId: "ordinary-draft",
            cwd: independentCwd,
          })).cwd,
          independentCwd,
        );
        // Negotiated clients retain cwd-only access, even when another project shares the checkout.
        assert.equal(
          (yield* resolver.resolveInput({ cwd: primary.rootPath })).cwd,
          primary.rootPath,
        );
        assert.equal(
          (yield* resolver.resolveInput({ cwd: service.rootPath + "/src" })).cwd,
          service.rootPath + "/src",
        );
        const ordinaryProjectId = ProjectId.make("independent-checkout-owner");
        yield* projects.apply({
          sequence: 3,
          eventId: EventId.make("independent-project"),
          aggregateKind: "project",
          aggregateId: ordinaryProjectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: ordinaryProjectId,
            title: "Independent",
            workspaceRoot: service.rootPath,
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        });
        assert.equal(
          (yield* resolver.resolveInput({ cwd: service.rootPath })).cwd,
          service.rootPath,
        );
        yield* checkoutPolicy.assertWorktree(service.rootPath);
        yield* resolver.resolveTerminalInput({ threadId: "ordinary-draft", cwd: service.rootPath });
        const terminal = {
          threadId,
          cwd: service.rootPath + "/src",
          repositoryTarget: { type: "thread" as const, threadId, repositoryId: service.id },
        };
        assert.equal((yield* resolver.resolveTerminalInput(terminal)).cwd, terminal.cwd);
        assert.equal((yield* resolver.resolveTerminalInput({ threadId })).threadId, threadId);
        for (const invalid of [
          { threadId, cwd: terminal.cwd },
          { ...terminal, cwd: primary.rootPath },
          { ...terminal, worktreePath: primary.rootPath },
          {
            ...terminal,
            repositoryTarget: {
              ...terminal.repositoryTarget,
              threadId: ThreadId.make("unrelated"),
            },
          },
          {
            ...terminal,
            repositoryTarget: { type: "project" as const, projectId, repositoryId: service.id },
          },
        ]) {
          assert.instanceOf(
            yield* resolver.resolveTerminalInput(invalid).pipe(Effect.flip),
            RepositoryTargetError,
          );
        }
        const outside = parent + "/outside";
        yield* fs.makeDirectory(outside);
        yield* fs.symlink(outside, service.rootPath + "/escape");
        assert.match(
          (yield* resolver
            .resolveTerminalInput({ ...terminal, cwd: service.rootPath + "/escape" })
            .pipe(Effect.flip)).message,
          /outside the selected repository/,
        );
        yield* fs.remove(service.rootPath + "/escape");
        for (const repository of members) {
          const input = {
            cwd: repository.rootPath,
            repositoryTarget: { type: "thread" as const, threadId, repositoryId: repository.id },
          };
          const contents = yield* resolver.run(input, ({ cwd }) =>
            fs.readFileString(cwd + "/src/index.ts"),
          );
          assert.equal(contents, `changed ${repository.id}\n`);
          const branch = yield* resolver.run(input, ({ cwd }) =>
            run(cwd, ["branch", "--show-current"]),
          );
          assert.equal(branch.stdout.trim(), `repo-${repository.id}`);
        }
        const selected = {
          cwd: service.rootPath,
          repositoryTarget: { type: "thread" as const, threadId, repositoryId: service.id },
        };
        yield* resolver.run(selected, ({ cwd }) => run(cwd, ["add", "src/index.ts"]));
        yield* resolver.run(selected, ({ cwd }) =>
          run(cwd, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "test: selected service",
          ]),
        );
        assert.equal((yield* run(service.rootPath, ["status", "--porcelain"])).stdout.trim(), "");
        assert.include((yield* run(primary.rootPath, ["diff"])).stdout, "changed 0");
        assert.include((yield* run(members[2]!.rootPath, ["diff"])).stdout, "changed 2");
        assert.match(
          (yield* resolver.resolveInput({ ...selected, cwd: primary.rootPath }).pipe(Effect.flip))
            .message,
          /does not match/,
        );
        assert.match(
          (yield* resolver
            .resolve({ type: "thread", threadId, repositoryId: "outside" })
            .pipe(Effect.flip)).message,
          /not in its binding/,
        );
        yield* projects.apply({
          sequence: 2,
          eventId: EventId.make("project-targets-remove"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.meta-updated",
          payload: { projectId, repositories: [primary], updatedAt: DateTime.formatIso(now) },
        });
        yield* checkoutPolicy.assertWorktree(service.rootPath);
        yield* checkoutPolicy.assertWorktree(primary.rootPath);
        yield* checkoutPolicy.assertWorktree(parent + "/independent");
        assert.strictEqual(
          (yield* Effect.flip(
            checkoutPolicy.assertWorktree(
              primary.rootPath,
              { type: "project", projectId, repositoryId: primary.id },
              threadId,
            ),
          ))._tag,
          "RepositorySetError",
        );
        yield* checkoutPolicy.assertWorktree(
          primary.rootPath,
          { type: "project", projectId, repositoryId: primary.id },
          ThreadId.make("new-draft"),
        );
        yield* checkoutPolicy.assertWorktree(primary.rootPath, {
          type: "project",
          projectId,
          repositoryId: primary.id,
        });
        assert.strictEqual(
          (yield* Effect.flip(
            checkoutPolicy.assertWorktree(service.rootPath, {
              type: "project",
              projectId,
              repositoryId: primary.id,
            }),
          ))._tag,
          "RepositorySetError",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            checkoutPolicy.assertWorktree(primary.rootPath, {
              type: "thread",
              threadId,
              repositoryId: primary.id,
            }),
          ))._tag,
          "RepositorySetError",
        );
        assert.equal(
          (yield* resolver.resolve(selected.repositoryTarget)).rootPath,
          service.rootPath,
        );
        assert.match(
          (yield* resolver
            .resolve({ type: "project", projectId, repositoryId: service.id })
            .pipe(Effect.flip)).message,
          /not in its binding/,
        );
        yield* compatibility.assertWorkspace(false, { projectId });
        // Removing project membership does not change a historical conversation's protocol.
        assert.match(
          (yield* legacyResolver.resolveInput({ cwd: service.rootPath }).pipe(Effect.flip)).message,
          /Update this client/,
        );
        assert.equal(
          (yield* resolver.resolveInput({ cwd: service.rootPath })).cwd,
          service.rootPath,
        );
        assert.equal(
          (yield* resolver.resolveInput({ cwd: service.rootPath + "/src" })).cwd,
          service.rootPath + "/src",
        );
        assert.equal(
          (yield* resolver.resolveInput({ cwd: service.rootPath + "-unrelated" })).cwd,
          service.rootPath + "-unrelated",
        );
        assert.instanceOf(
          yield* compatibility.assertWorkspace(false, { threadIds: [threadId] }).pipe(Effect.flip),
          RepositoryTargetError,
        );
        yield* fs.remove(service.rootPath, { recursive: true });
        assert.match(
          (yield* resolver.resolve(selected.repositoryTarget).pipe(Effect.flip)).message,
          /unavailable/,
        );
        assert.equal(
          (yield* resolver.resolve({ type: "thread", threadId, repositoryId: primary.id }))
            .rootPath,
          primary.rootPath,
        );
      }),
  );
});
