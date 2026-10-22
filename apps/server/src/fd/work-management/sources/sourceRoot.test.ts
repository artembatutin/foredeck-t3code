// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { WorkProjectDirectory } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";

import { directoriesOverlap, parseSourceDirectory, resolveSourceRoute } from "./sourceRoot.ts";

describe("parseSourceDirectory", () => {
  it("accepts only canonical project-relative directories", () => {
    for (const directory of ["work", "work/tasks", "docs/.work", "Backlog Items/2026"]) {
      assert.deepStrictEqual(parseSourceDirectory(directory), Result.succeed(directory));
    }
    const cases = [
      ["", "project_root"],
      [".", "project_root"],
      ["./", "project_root"],
      ["work/..", "project_root"],
      [".git", "git_metadata"],
      [".git/x", "git_metadata"],
      ["work/.GIT/hooks", "git_metadata"],
      ["../out", "outside_project"],
      ["work/../../out", "outside_project"],
      ["/tmp/work", "outside_project"],
      ["C:/work", "outside_project"],
      ["\\\\server\\share", "outside_project"],
      ["work/", "not_normalized"],
      ["./work", "not_normalized"],
      ["work//tasks", "not_normalized"],
      ["work/./tasks", "not_normalized"],
      ["work/../notes", "not_normalized"],
      ["work\\tasks", "not_normalized"],
      ["work\ntasks", "not_normalized"],
    ] as const;
    for (const [directory, problem] of cases) {
      assert.deepStrictEqual(parseSourceDirectory(directory), Result.fail(problem), directory);
    }
  });
});

describe("directoriesOverlap", () => {
  it("matches equal and nested directories, ignoring case, but not siblings", () => {
    assert.isTrue(directoriesOverlap("work", "work"));
    assert.isTrue(directoriesOverlap("work", "work/tasks"));
    assert.isTrue(directoriesOverlap("work/tasks", "work"));
    assert.isTrue(directoriesOverlap("Work", "work/tasks"));
    assert.isFalse(directoriesOverlap("work", "workshop"));
    assert.isFalse(directoriesOverlap("work/tasks", "work/notes"));
  });
});

describe("resolveSourceRoute", () => {
  const listing = (root: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return (yield* fileSystem.readDirectory(root, { recursive: true })).toSorted();
    });

  it.effect("resolves against the canonical root and refuses aliases without writing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "work-source-root-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "work-outside-" });
      const canonicalRoot = yield* fileSystem.realPath(root);
      yield* fileSystem.makeDirectory(NodePath.join(root, "work", "tasks"), { recursive: true });
      yield* fileSystem.makeDirectory(NodePath.join(root, "src"));
      yield* fileSystem.writeFileString(NodePath.join(root, "notes.md"), "notes\n");
      yield* fileSystem.symlink(outside, NodePath.join(root, "escape"));
      yield* fileSystem.symlink(NodePath.join(root, "src"), NodePath.join(root, "alias"));
      // A nested clone's directory and a submodule's `.git` file mark other repositories.
      yield* fileSystem.makeDirectory(NodePath.join(root, "vendor", ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(NodePath.join(root, "modules", "lib"), { recursive: true });
      yield* fileSystem.writeFileString(
        NodePath.join(root, "modules", "lib", ".git"),
        "gitdir: ../../.git/modules/lib\n",
      );
      const before = yield* listing(root);

      const resolve = (directory: string) =>
        resolveSourceRoute(root, WorkProjectDirectory.make(directory), Effect.void);
      assert.deepStrictEqual(yield* resolve("work/tasks"), {
        projectRoot: canonicalRoot,
        path: NodePath.join(canonicalRoot, "work", "tasks"),
        exists: true,
      });
      assert.deepStrictEqual(yield* resolve("work/new/deeper"), {
        projectRoot: canonicalRoot,
        path: NodePath.join(canonicalRoot, "work", "new", "deeper"),
        exists: false,
      });

      const rejected = [
        ["escape", "alias"],
        ["escape/inner", "alias"],
        ["alias", "alias"],
        ["WORK", "alias"],
        ["work/Tasks", "alias"],
        ["notes.md", "not_directory"],
        ["notes.md/inner", "not_directory"],
        ["vendor", "nested_repository"],
        ["vendor/tasks", "nested_repository"],
        ["modules/lib", "nested_repository"],
        ["modules/lib/tasks", "nested_repository"],
      ] as const;
      for (const [directory, problem] of rejected) {
        const error = yield* resolve(directory).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WorkSourceRootRejected", directory);
        if (error._tag === "WorkSourceRootRejected") assert.strictEqual(error.problem, problem);
      }
      assert.deepStrictEqual(yield* listing(root), before);
      assert.deepStrictEqual(yield* listing(outside), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with a file error when the project root is gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "work-source-root-" });
      const error = yield* resolveSourceRoute(
        NodePath.join(root, "missing"),
        WorkProjectDirectory.make("work"),
        Effect.void,
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkSourceFileError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
