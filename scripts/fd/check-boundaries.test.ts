// @effect-diagnostics nodeBuiltinImport:off - Exercises real Git index and linked-worktree behavior in disposable repositories.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { checkBoundaries } from "./check-boundaries.ts";

let root: string;
const policyPath = "scripts/fd/integration-files.json";
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), content);
};
const stage = (path: string, content: string) => {
  write(path, content);
  git("add", "--", path);
};
const allow = (path: string, reason = "Compose the example feature in the existing service.") =>
  stage(policyPath, JSON.stringify({ integrationFiles: { [path]: reason } }));

const installHook = (name: string) => {
  const script = NodeURL.fileURLToPath(new URL("./check-boundaries.ts", import.meta.url));
  write(
    `fixture-hooks/${name}`,
    `#!/usr/bin/env node\nconst cp = require("node:child_process");\nprocess.exit(cp.spawnSync(process.execPath, [${JSON.stringify(script)}, "--staged"], { stdio: "inherit" }).status ?? 1);\n`,
  );
  NodeFS.chmodSync(NodePath.join(root, "fixture-hooks", name), 0o755);
};

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fd-boundary-test-"));
  git("init", "--initial-branch=main");
  // These disposable repositories never use the contributor's hooks or identity.
  git("config", "core.hooksPath", NodePath.join(root, "fixture-hooks"));
  git("config", "commit.gpgSign", "false");
  git("config", "user.name", "Boundary Test Fixture");
  git("config", "user.email", "boundary-test@example.invalid");
  stage(policyPath, JSON.stringify({ integrationFiles: {} }));
  stage("apps/web/src/existing.ts", "export const original = true;\n");
  git("commit", "-m", "test: initialize boundary fixture");
  git("update-ref", "refs/remotes/upstream/main", "HEAD");
});

afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

describe("fd boundary checks on Git snapshots", () => {
  it("leaves ordinary unconfigured work and docs alone", () => {
    expect(checkBoundaries(root)).toEqual([]);
    stage("docs/example.md", "A documentation change.");
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("blocks additions, modifications, deletions and renames outside fd", () => {
    stage("apps/server/src/new-feature.ts", "export {};");
    stage("apps/web/src/existing.ts", "export const original = false;");
    expect(checkBoundaries(root)).toHaveLength(2);
    git("rm", "-f", "--", "apps/web/src/existing.ts");
    stage("apps/web/src/renamed.ts", "export const original = true;");
    expect(checkBoundaries(root)).toHaveLength(3);
  });

  it("allows cohesive fd features, shared packages and assets without scaffolding", () => {
    stage("apps/server/src/fd/example/index.ts", 'export { value } from "./internal.ts";');
    stage("apps/server/src/fd/example/internal.ts", "export const value = true;");
    stage("packages/fd-example/src/index.ts", "export const value = true;");
    stage("apps/web/public/fd/brand/logo.svg", "<svg/>");
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("rejects a flat fd dumping ground and the old namespace", () => {
    stage("apps/server/src/fd/example.ts", "export {};");
    stage("apps/web/src/foredeck/example/index.ts", "export {};");
    expect(checkBoundaries(root)).toHaveLength(2);
  });

  it("allows exact integration files with reasons, not neighboring files", () => {
    allow("apps/web/src/existing.ts");
    stage("apps/web/src/existing.ts", 'import "~/fd/example/index.ts";');
    expect(checkBoundaries(root)).toEqual([]);
    stage("apps/web/src/neighbor.ts", 'import "~/fd/example/index.ts";');
    expect(checkBoundaries(root).join("\n")).toContain("neighbor.ts");
  });

  it("rejects wildcard permissions and empty reasons", () => {
    allow("apps/web/src/*.ts");
    expect(() => checkBoundaries(root)).toThrow("exact path");
    allow("apps/web/src/existing.ts", " ");
    expect(() => checkBoundaries(root)).toThrow("nonempty reason");
  });

  it("fails closed without an upstream ref while still accepting fd-only work", () => {
    git("update-ref", "-d", "refs/remotes/upstream/main");
    stage("apps/web/src/fd/example/index.ts", "export {};");
    expect(checkBoundaries(root)).toEqual([]);
    stage("apps/web/src/existing.ts", "export const original = false;");
    expect(checkBoundaries(root).join("\n")).toContain("existing.ts");
  });

  it("checks route filenames literally and rejects fd source symlinks", () => {
    const route = "apps/mobile/app/[thread].tsx";
    allow(route);
    stage(route, 'import "../src/fd/example/private.ts";');
    expect(checkBoundaries(root).join("\n")).toContain("implementation files are private");
    const link = "apps/web/src/fd/example/index.ts";
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, link)), { recursive: true });
    NodeFS.symlinkSync("../../existing.ts", NodePath.join(root, link));
    git("add", "--", link);
    expect(checkBoundaries(root).join("\n")).toContain("source symlinks cannot be checked");
  });

  it("checks staged policy and contents even when working copies would pass", () => {
    stage("apps/web/src/existing.ts", 'import "~/fd/example/private.ts";');
    write("apps/web/src/existing.ts", 'import "~/fd/example/index.ts";');
    write(
      policyPath,
      JSON.stringify({ integrationFiles: { "apps/web/src/existing.ts": "Integration" } }),
    );
    expect(checkBoundaries(root).join("\n")).toContain("implementation files are private");
    expect(checkBoundaries(root).join("\n")).toContain("Declare this integration file");
  });

  it("protects internals even in a declared integration file", () => {
    allow("apps/web/src/existing.ts");
    stage("apps/web/src/existing.ts", 'export * from "~/fd/example/private.ts";');
    expect(checkBoundaries(root).join("\n")).toContain("implementation files are private");
  });

  it("allows same-feature internals, existing local services and other public feature entries", () => {
    stage(
      "apps/web/src/fd/example/index.ts",
      'import "./internal.ts"; import "../../existing.ts"; import "../other/index.ts"; import "@t3tools/shared/themePalettes";',
    );
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("checks lazy imports, reexports, require and type-only imports", () => {
    stage(
      "apps/web/src/fd/example/index.ts",
      'import("../other/private.ts"); export * from "../other/private.ts"; require(`../other/private.ts`); type T = import("../other/private.ts").T; import A = require("../other/private.ts");',
    );
    expect(checkBoundaries(root)).toHaveLength(5);
  });

  it("rejects computed loaders in fd instead of silently missing them", () => {
    stage(
      "apps/web/src/fd/example/index.ts",
      'const moduleName = "../other/private.ts"; import(moduleName);',
    );
    expect(checkBoundaries(root).join("\n")).toContain("literal module specifiers");
  });

  it("blocks cross-app source and shared packages importing apps", () => {
    stage("apps/web/src/fd/example/index.ts", 'import "../../../../server/src/service.ts";');
    stage("packages/fd-example/src/index.ts", 'import "@t3tools/web";');
    expect(checkBoundaries(root)).toHaveLength(2);
  });

  it("requires shared package imports instead of filesystem shortcuts", () => {
    stage(
      "apps/web/src/fd/example/index.ts",
      'import "../../../../../packages/shared/src/themePalettes.ts";',
    );
    expect(checkBoundaries(root).join("\n")).toContain("shared package exports");
  });

  it("allows a shared fd package entry but rejects its private subpaths", () => {
    stage("apps/web/src/fd/example/index.ts", 'import "@t3tools/fd-example";');
    expect(checkBoundaries(root)).toEqual([]);
    stage("apps/web/src/fd/example/index.ts", 'import "@t3tools/fd-example/private";');
    expect(checkBoundaries(root).join("\n")).toContain("implementation files are private");
  });

  it("accepts unchanged upstream updates and deletions but rejects fork resolutions", () => {
    const old = git("rev-parse", "HEAD");
    git("switch", "-c", "feature/upstream-fixture");
    stage("apps/server/src/upstream.ts", "export const value = 2;");
    git("rm", "--", "apps/web/src/existing.ts");
    git("commit", "-m", "test: update upstream fixture");
    git("update-ref", "refs/remotes/upstream/main", "HEAD");
    git("switch", "main");
    git("read-tree", "refs/remotes/upstream/main");
    expect(checkBoundaries(root)).toEqual([]);
    expect(git("rev-parse", "HEAD")).toBe(old);
    stage("apps/server/src/upstream.ts", "export const value = 3;");
    expect(checkBoundaries(root).join("\n")).toContain("declare this exact integration file");
  });

  it("checks committed branch changes separately from unstaged edits", () => {
    stage("apps/web/src/existing.ts", "export const original = false;");
    git("commit", "-m", "test: record invalid fixture change");
    write("apps/web/src/existing.ts", "export const original = true;");
    expect(checkBoundaries(root, "HEAD~1").join("\n")).toContain("existing.ts");
  });

  it("actually prevents a commit through the Git hook", () => {
    const head = git("rev-parse", "HEAD");
    installHook("pre-commit");
    stage("apps/web/src/existing.ts", "export const original = false;");
    const result = NodeChildProcess.spawnSync(
      "git",
      ["commit", "-m", "test: attempt invalid fixture change"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("declare this exact integration file");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("checks automatic merge commits while allowing an unchanged upstream merge", () => {
    git("switch", "-c", "feature/upstream-fixture");
    stage("apps/server/src/upstream.ts", "export const value = 2;");
    git("commit", "-m", "test: update upstream fixture");
    git("update-ref", "refs/remotes/upstream/main", "HEAD");
    git("switch", "main");
    stage("apps/web/src/fd/example/index.ts", "export {};");
    git("commit", "-m", "test: add fork fixture");
    installHook("pre-merge-commit");
    git("merge", "--no-edit", "feature/upstream-fixture");
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(checkBoundaries(root, "HEAD~1")).toEqual([]);
  });

  it("works in linked worktrees with spaces in their paths", () => {
    const main = root;
    const linked = NodePath.join(root, "linked checkout");
    git("worktree", "add", "-b", "feature/linked-fixture", linked);
    root = linked;
    try {
      stage("apps/web/src/fd/example/index.ts", "export {};");
      expect(checkBoundaries(linked)).toEqual([]);
      expect(NodeFS.statSync(NodePath.join(linked, ".git")).isFile()).toBe(true);
    } finally {
      root = main;
    }
  });
});
