import { resolveRuntimeWorkspace } from "./runtimeWorkspace.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as RepositorySet from "./RepositorySet.ts";

const layer = RepositorySet.layer.pipe(
  Layer.provide(Layer.merge(WorkspacePaths.layer, VcsDriverRegistry.layer)),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* VcsProcess.VcsProcess;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "fd-multirepo-" });
  const create = Effect.fn("multirepo.test.create")(function* (name: string) {
    const cwd = path.join(parent, name);
    yield* fs.makeDirectory(path.join(cwd, "src"), { recursive: true });
    yield* git.run({
      operation: "test.init",
      command: "git",
      args: ["init", "--initial-branch", name.replaceAll("/", "-")],
      cwd,
    });
    yield* fs.writeFileString(path.join(cwd, "src/index.ts"), name);
    return yield* fs.realPath(cwd);
  });
  return { fs, path, parent, create, repositories: yield* RepositorySet.RepositorySet };
});

it.layer(layer)("multirepo repository membership", (it) => {
  it.effect("resolves unrelated checkouts and keeps identical relative filenames independent", () =>
    Effect.gen(function* () {
      const { fs, path, create, repositories } = yield* fixture;
      const a = yield* create("apps/client");
      const b = yield* create("services/server");
      const c = yield* create("tools");
      const members = yield* repositories.normalize({
        defaultCwd: a,
        repositories: [
          { name: "Client", rootPath: a },
          { name: "Server", rootPath: b },
          { name: "Tools", rootPath: c },
        ],
      });
      const binding = { version: 1 as const, defaultCwd: a, repositories: members };
      const singleRuntime = yield* resolveRuntimeWorkspace({
        binding: { ...binding, defaultCwd: a + "/src", repositories: [members[0]!] },
        worktreePath: null,
        runtimeMode: "auto-accept-edits",
        capabilities: undefined,
      }).pipe(Effect.provideService(RepositorySet.RepositorySet, repositories));
      assert.equal(singleRuntime.cwd, a + "/src");
      assert.isUndefined(singleRuntime.repositories);
      for (const member of members) {
        const selected = yield* repositories.select(binding, member.id);
        assert.equal(
          yield* fs.readFileString(path.join(selected.rootPath, "src/index.ts")),
          path.relative(path.dirname(path.dirname(a)), member.rootPath),
        );
      }
      assert.equal(new Set(members.map((member) => member.id)).size, 3);
      const renamed = yield* repositories.normalize({
        defaultCwd: a,
        previous: members,
        repositories: [{ ...members[0]!, name: "Frontend" }, members[2]!],
      });
      assert.equal(renamed[0]?.id, members[0]?.id);
      assert.equal(renamed[1]?.id, members[2]?.id);
      assert.isTrue(yield* fs.exists(b));
      assert.equal((yield* repositories.select(binding, members[1]!.id)).rootPath, b);
    }),
  );

  it.effect(
    "normalizes symlinks and rejects duplicate aliases, overlapping roots, and unknown identities",
    () =>
      Effect.gen(function* () {
        const { fs, path, parent, create, repositories } = yield* fixture;
        const root = yield* create("parent");
        const nested = yield* create("parent/nested");
        const alias = path.join(parent, "alias");
        yield* fs.symlink(root, alias);
        const duplicate = yield* repositories
          .normalize({
            defaultCwd: root,
            repositories: [
              { name: "Root", rootPath: root },
              { name: "Alias", rootPath: alias },
            ],
          })
          .pipe(Effect.flip);
        assert.equal(duplicate.reason, "duplicate");
        const overlap = yield* repositories
          .normalize({
            defaultCwd: root,
            repositories: [
              { name: "Root", rootPath: root },
              { name: "Nested", rootPath: nested },
            ],
          })
          .pipe(Effect.flip);
        assert.equal(overlap.reason, "overlap");
        const identity = yield* repositories
          .normalize({
            defaultCwd: root,
            repositories: [{ id: "not-issued", name: "Root", rootPath: root }],
          })
          .pipe(Effect.flip);
        assert.equal(identity.reason, "identity");
        const normalized = yield* repositories.normalize({
          defaultCwd: alias,
          repositories: [{ name: "Root", rootPath: alias }],
        });
        assert.equal(normalized[0]?.rootPath, root);
      }),
  );

  it.effect(
    "keeps missing membership in multi-repo mode and fails only the selected missing checkout",
    () =>
      Effect.gen(function* () {
        const { fs, create, repositories } = yield* fixture;
        const a = yield* create("a");
        const b = yield* create("b");
        const members = yield* repositories.normalize({
          defaultCwd: a,
          repositories: [
            { name: "A", rootPath: a },
            { name: "B", rootPath: b },
          ],
        });
        const binding = { version: 1 as const, defaultCwd: a, repositories: members };

        yield* fs.remove(b, { recursive: true });
        const retained = yield* repositories.normalize({
          defaultCwd: a,
          previous: members,
          repositories: members,
        });
        assert.isTrue(RepositorySet.isMultiRepo(retained));
        assert.equal((yield* repositories.select(binding, members[0]!.id)).rootPath, a);
        assert.equal(
          (yield* repositories.select(binding, members[1]!.id).pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.equal(
          (yield* repositories.select(binding, "unknown").pipe(Effect.flip)).reason,
          "selection",
        );
        assert.equal(
          (yield* repositories.validate(binding).pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.equal(
          (yield* RepositorySet.assertCheckoutMode(retained, "worktree").pipe(Effect.flip)).reason,
          "worktree",
        );
        assert.equal(
          (yield* RepositorySet.assertCheckoutMode(retained, "rollback").pipe(Effect.flip)).reason,
          "rollback",
        );
        yield* RepositorySet.assertCheckoutMode([members[0]!], "worktree");
        yield* RepositorySet.assertCheckoutMode(undefined, "rollback");
      }),
  );

  it.effect("treats a monorepo as one repository and prevents moving a stable id", () =>
    Effect.gen(function* () {
      const { create, repositories } = yield* fixture;
      const root = yield* create("monorepo");
      const other = yield* create("other");
      const members = yield* repositories.normalize({
        defaultCwd: root + "/src",
        repositories: [{ name: "Monorepo", rootPath: root + "/src" }],
      });
      assert.equal(members[0]?.rootPath, root);
      assert.isFalse(RepositorySet.isMultiRepo(members));
      assert.equal(
        (yield* repositories
          .normalize({
            defaultCwd: other,
            previous: members,
            repositories: [{ ...members[0]!, rootPath: other }],
          })
          .pipe(Effect.flip)).reason,
        "identity",
      );
      assert.equal(
        (yield* repositories
          .normalize({
            defaultCwd: other,
            repositories: [{ name: "Wrong primary", rootPath: root }],
          })
          .pipe(Effect.flip)).reason,
        "primary",
      );
    }),
  );
});
