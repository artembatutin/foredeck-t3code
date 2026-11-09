import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };
import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };
import {
  createStagePatchedDependencies,
  readWorkspaceConfig,
  resolveDesktopRuntimeDependencies,
  resolveMergedStageDependencies,
  STAGE_INSTALL_ARGS,
} from "../build-desktop-artifact.ts";
import { resolveCatalogDependencies } from "../lib/resolve-catalog.ts";
import {
  type FrozenStage,
  FROZEN_STAGE_INSTALL_ARGS,
  type PnpmLockfile,
  patchHashOf,
  planFrozenStage,
  readAcceptedLockfile,
  StageClosureError,
  verifyInstalledStage,
  verifyStageClosure,
  writeFrozenStage,
} from "./stageClosure.ts";

const encodeYaml = Schema.encodeSync(fromYaml(Schema.Unknown));
const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));

/**
 * A lock where the shipped root `pty` needs `addon`, which the workspace patches: a transitive
 * registered patch the direct-only filter drops. `pty` also offers a platform package optionally.
 */
const patch = "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+patched\n";
const patchHash = patchHashOf(patch);
const acceptedFixture = (): PnpmLockfile => ({
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  catalogs: { default: { kit: { specifier: "4.0.0", version: "4.0.0" } } },
  patchedDependencies: { "addon@7.1.1": patchHash, "unused@1.0.0": "f".repeat(64) },
  importers: {
    "apps/server": {
      dependencies: {
        pty: { specifier: "^1.2.0", version: "1.2.0" },
        kit: { specifier: "catalog:", version: "4.0.0" },
      },
    },
    "apps/desktop": { dependencies: { shell: { specifier: "44.0.0", version: "44.0.0" } } },
    "apps/web": { dependencies: { pty: { specifier: "^1.2.0", version: "1.3.0" } } },
  },
  packages: {
    "pty@1.2.0": { resolution: { integrity: "sha512-pty" } },
    "pty@1.3.0": { resolution: { integrity: "sha512-pty-next" } },
    "addon@7.1.1": { resolution: { integrity: "sha512-addon" } },
    "pty-darwin@1.2.0": { resolution: { integrity: "sha512-darwin" }, os: ["darwin"] },
    "kit@4.0.0": { resolution: { integrity: "sha512-kit" } },
    "shell@44.0.0": { resolution: { integrity: "sha512-shell" } },
    "unused@1.0.0": { resolution: { integrity: "sha512-unused" } },
  },
  snapshots: {
    "pty@1.2.0": {
      dependencies: { addon: `7.1.1(patch_hash=${patchHash})` },
      optionalDependencies: { "pty-darwin": "1.2.0" },
    },
    "pty@1.3.0": {},
    [`addon@7.1.1(patch_hash=${patchHash})`]: {},
    "pty-darwin@1.2.0": { optional: true },
    "kit@4.0.0": {},
    "shell@44.0.0": {},
    "unused@1.0.0": {},
  },
});
const workspacePatches = {
  "addon@7.1.1": "patches/addon@7.1.1.patch",
  "unused@1.0.0": "patches/unused@1.0.0.patch",
};
const roots = { pty: "^1.2.0", kit: "4.0.0" };

const plan = (lock = acceptedFixture()) => {
  const planned = planFrozenStage({
    lock,
    dependencies: roots,
    devDependencies: { shell: "44.0.0" },
    workspacePatches,
  });
  if ("problems" in planned) return assert.fail(planned.problems.join("; "));
  return planned;
};

/**
 * What pnpm records after a production install of the plan: the optional platform package skipped
 * on this host, and the development root not installed.
 */
const installedOf = (planned: FrozenStage): PnpmLockfile => {
  const {
    "pty-darwin@1.2.0": _skipped,
    "shell@44.0.0": _development,
    ...snapshots
  } = planned.lockfile.snapshots ?? {};
  const {
    "pty-darwin@1.2.0": _skippedPackage,
    "shell@44.0.0": _developmentPackage,
    ...packages
  } = planned.lockfile.packages ?? {};
  const { devDependencies: _dev, ...root } = planned.lockfile.importers["."] ?? {};
  return { ...planned.lockfile, importers: { ".": root }, snapshots, packages };
};

const verify = (
  planned: FrozenStage,
  installed: PnpmLockfile,
  hashes = { "addon@7.1.1": patchHash },
) =>
  verifyStageClosure({
    accepted: acceptedFixture(),
    plan: planned,
    stageLockfile: planned.lockfile,
    installed,
    patchHashes: hashes,
  });

const problemsOf = (result: ReturnType<typeof verify>) =>
  "problems" in result ? [...result.problems] : assert.fail("The stage verified.");

it("keeps the shipped roots' accepted versions and every transitive patch the direct filter drops", () => {
  const planned = plan();
  assert.deepStrictEqual(planned.lockfile.importers["."], {
    dependencies: {
      kit: { specifier: "4.0.0", version: "4.0.0" },
      pty: { specifier: "^1.2.0", version: "1.2.0" },
    },
    devDependencies: { shell: { specifier: "44.0.0", version: "44.0.0" } },
  });
  // Only what the roots reach: not the web importer's newer `pty`, nor the unused patched package.
  assert.deepStrictEqual(Object.keys(planned.lockfile.snapshots ?? {}), [
    `addon@7.1.1(patch_hash=${patchHash})`,
    "kit@4.0.0",
    "pty-darwin@1.2.0",
    "pty@1.2.0",
    "shell@44.0.0",
  ]);
  assert.deepStrictEqual(planned.lockfile.patchedDependencies, { "addon@7.1.1": patchHash });
  assert.deepStrictEqual(planned.patchFiles, { "addon@7.1.1": "patches/addon@7.1.1.patch" });
  assert.deepStrictEqual(planned.required, [
    `addon@7.1.1(patch_hash=${patchHash})`,
    "kit@4.0.0",
    "pty@1.2.0",
  ]);
  assert.deepStrictEqual(createStagePatchedDependencies(workspacePatches, roots), {});
  // Resolution inputs a frozen install never consults stay out of the stage's lockfile.
  assert.notProperty(planned.lockfile, "catalogs");
  assert.notProperty(planned.lockfile, "overrides");
  assert.notProperty(planned.lockfile, "packageExtensionsChecksum");
});

it("refuses roots and entries the accepted lock does not resolve, rather than resolve them", () => {
  const unresolved = planFrozenStage({
    lock: acceptedFixture(),
    dependencies: { pty: "^1.3.0", fresh: "1.0.0" },
    devDependencies: {},
    workspacePatches,
  });
  assert.deepStrictEqual(unresolved, {
    problems: [
      "pty@^1.3.0 is not resolved by the accepted lock",
      "fresh@1.0.0 is not resolved by the accepted lock",
    ],
  });
  const lock = acceptedFixture();
  const { [`addon@7.1.1(patch_hash=${patchHash})`]: _gone, ...snapshots } = lock.snapshots ?? {};
  const broken = planFrozenStage({
    lock: { ...lock, snapshots },
    dependencies: roots,
    devDependencies: {},
    workspacePatches,
  });
  assert.deepStrictEqual(broken, {
    problems: [`addon@7.1.1(patch_hash=${patchHash}) has no entry in the accepted lock`],
  });
  const unregistered = planFrozenStage({
    lock,
    dependencies: roots,
    devDependencies: {},
    workspacePatches: {},
  });
  assert.deepStrictEqual(unregistered, {
    problems: ["addon@7.1.1 is patched in the accepted lock but registers no patch file"],
  });
});

it("verifies a stage that installed the plan, an optional platform package skipped", () => {
  const planned = plan();
  assert.deepStrictEqual(verify(planned, installedOf(planned)), {
    roots: 2,
    installedSnapshots: 3,
    patches: { "addon@7.1.1": patchHash },
  });
});

it("fails on a drifted transitive resolution", () => {
  const planned = plan();
  const installed = installedOf(planned);
  const drifted: PnpmLockfile = {
    ...installed,
    snapshots: {
      ...installed.snapshots,
      "pty@1.2.0": { dependencies: { addon: `7.1.2(patch_hash=${patchHash})` } },
      [`addon@7.1.2(patch_hash=${patchHash})`]: {},
    },
    packages: { ...installed.packages, "addon@7.1.2": { resolution: { integrity: "sha512-x" } } },
  };
  assert.includeMembers(problemsOf(verify(planned, drifted)), [
    "pty@1.2.0 differs from the accepted lock",
    `addon@7.1.2(patch_hash=${patchHash}) is not in the accepted lock`,
    "addon@7.1.2 is not resolved as the accepted lock resolves it",
  ]);
  const reresolved: PnpmLockfile = {
    ...installed,
    packages: { ...installed.packages, "kit@4.0.0": { resolution: { integrity: "sha512-other" } } },
  };
  assert.deepStrictEqual(problemsOf(verify(planned, reresolved)), [
    "kit@4.0.0 is not resolved as the accepted lock resolves it",
  ]);
});

it("fails on a drifted patch: changed file bytes, or the package installed unpatched", () => {
  const planned = plan();
  assert.deepStrictEqual(
    problemsOf(verify(planned, installedOf(planned), { "addon@7.1.1": patchHashOf(`${patch}\n`) })),
    ["addon@7.1.1's patch file has drifted"],
  );
  const installed = installedOf(planned);
  const { [`addon@7.1.1(patch_hash=${patchHash})`]: _patched, ...rest } = installed.snapshots ?? {};
  const unpatched: PnpmLockfile = {
    ...installed,
    snapshots: { ...rest, "addon@7.1.1": {}, "pty@1.2.0": { dependencies: { addon: "7.1.1" } } },
  };
  assert.includeMembers(problemsOf(verify(planned, unpatched)), [
    "addon@7.1.1 is not in the accepted lock",
    `addon@7.1.1(patch_hash=${patchHash}) was not installed`,
    "addon@7.1.1 was installed without its registered patch",
  ]);
});

it.layer(NodeServices.layer)("a frozen stage on disk", (it) => {
  const repoWith = (lock: PnpmLockfile) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-closure-repo-" });
      yield* fileSystem.makeDirectory(path.join(repoRoot, "patches"));
      yield* fileSystem.writeFileString(path.join(repoRoot, "patches/addon@7.1.1.patch"), patch);
      yield* fileSystem.writeFileString(path.join(repoRoot, "patches/unused@1.0.0.patch"), "x");
      yield* fileSystem.writeFileString(path.join(repoRoot, "pnpm-lock.yaml"), encodeYaml(lock));
      const stageAppDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "fd-closure-stage-",
      });
      return { repoRoot, stageAppDir };
    });

  it.effect(
    "writes the planned lockfile and only the patches it registers, leaving the repo's lock",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repoRoot, stageAppDir } = yield* repoWith(acceptedFixture());
        const lockBefore = yield* fileSystem.readFileString(path.join(repoRoot, "pnpm-lock.yaml"));
        const accepted = yield* readAcceptedLockfile(repoRoot);
        const planned = yield* writeFrozenStage({
          repoRoot,
          stageAppDir,
          lock: accepted,
          dependencies: roots,
          devDependencies: { shell: "44.0.0" },
          workspacePatches,
        });
        assert.deepStrictEqual(
          decodeYaml(yield* fileSystem.readFileString(path.join(stageAppDir, "pnpm-lock.yaml"))),
          planned.lockfile,
        );
        assert.deepStrictEqual(yield* fileSystem.readDirectory(path.join(stageAppDir, "patches")), [
          "addon@7.1.1.patch",
        ]);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(stageAppDir, "patches/addon@7.1.1.patch")),
          patch,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(repoRoot, "pnpm-lock.yaml")),
          lockBefore,
        );
        // The install applies that lockfile as written; the ordinary stage's install is unchanged.
        assert.deepStrictEqual(FROZEN_STAGE_INSTALL_ARGS, [
          "install",
          "--frozen-lockfile",
          "--prod",
        ]);
        assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);

        // What pnpm then records as installed is read back and judged.
        const pnpmDir = path.join(stageAppDir, "node_modules", ".pnpm");
        yield* fileSystem.makeDirectory(pnpmDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(pnpmDir, "lock.yaml"),
          encodeYaml(installedOf(planned)),
        );
        const verified = yield* verifyInstalledStage({ stageAppDir, accepted, plan: planned });
        assert.deepStrictEqual(verified.patches, { "addon@7.1.1": patchHash });

        yield* fileSystem.writeFileString(
          path.join(stageAppDir, "patches/addon@7.1.1.patch"),
          "drift",
        );
        const refused = yield* Effect.flip(
          verifyInstalledStage({ stageAppDir, accepted, plan: planned }),
        );
        assert.instanceOf(refused, StageClosureError);
        assert.deepStrictEqual([...refused.problems], ["addon@7.1.1's patch file has drifted"]);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a stage pnpm installed no record for", () =>
    Effect.gen(function* () {
      const { repoRoot, stageAppDir } = yield* repoWith(acceptedFixture());
      const accepted = yield* readAcceptedLockfile(repoRoot);
      const planned = yield* writeFrozenStage({
        repoRoot,
        stageAppDir,
        lock: accepted,
        dependencies: roots,
        devDependencies: {},
        workspacePatches,
      });
      const refused = yield* Effect.flip(
        verifyInstalledStage({ stageAppDir, accepted, plan: planned }),
      );
      assert.strictEqual(refused.stage, "read");
    }).pipe(Effect.scoped),
  );

  it.effect("carries the accepted lock's patched node-pty into the macOS stage it plans", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
      const workspace = yield* readWorkspaceConfig();
      const catalog = workspace.catalog ?? {};
      const dependencies = resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: resolveCatalogDependencies(
          serverPackageJson.dependencies,
          catalog,
          "apps/server",
        ),
        desktopDependencies: resolveDesktopRuntimeDependencies(
          desktopPackageJson.dependencies,
          catalog,
        ),
        arch: "arm64",
        fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
      });
      const accepted = yield* readAcceptedLockfile(repoRoot);
      const planned = planFrozenStage({
        lock: accepted,
        dependencies,
        devDependencies: { electron: desktopPackageJson.dependencies.electron },
        workspacePatches: workspace.patchedDependencies ?? {},
      });
      if ("problems" in planned) return assert.fail(planned.problems.join("; "));

      const hash = "f2fe901c61cde17986240002d05c172d5d0272d83ffaab8d0ebeb922763be414";
      const nodePty = `node-pty@1.2.0-beta.15(patch_hash=${hash})`;
      assert.deepStrictEqual(planned.lockfile.importers["."]?.dependencies?.["node-pty"], {
        specifier: "^1.2.0-beta.15",
        version: `1.2.0-beta.15(patch_hash=${hash})`,
      });
      assert.deepStrictEqual(planned.lockfile.snapshots?.[nodePty], accepted.snapshots?.[nodePty]);
      assert.include(planned.required, nodePty);
      assert.strictEqual(planned.lockfile.patchedDependencies?.["node-pty@1.2.0-beta.15"], hash);
      assert.strictEqual(
        planned.patchFiles["node-pty@1.2.0-beta.15"],
        "patches/node-pty@1.2.0-beta.15.patch",
      );
      assert.strictEqual(
        patchHashOf(
          yield* fileSystem.readFile(path.join(repoRoot, "patches/node-pty@1.2.0-beta.15.patch")),
        ),
        hash,
      );
      // Every registered patch the closure reaches, never fewer than the direct filter keeps.
      const direct = createStagePatchedDependencies(
        workspace.patchedDependencies ?? {},
        dependencies,
      );
      assert.includeMembers(Object.keys(planned.patchFiles), Object.keys(direct));
      for (const key of Object.keys(planned.lockfile.packages ?? {})) {
        const registered = accepted.patchedDependencies?.[key];
        if (registered !== undefined) {
          assert.strictEqual(planned.lockfile.patchedDependencies?.[key], registered, key);
        }
      }
      // The node-pty a fresh resolution of `^1.2.0-beta.15` could pick is not what ships.
      assert.deepStrictEqual(
        planFrozenStage({
          lock: accepted,
          dependencies: { "node-pty": "^1.2.0" },
          devDependencies: {},
          workspacePatches: workspace.patchedDependencies ?? {},
        }),
        { problems: ["node-pty@^1.2.0 is not resolved by the accepted lock"] },
      );
    }),
  );
});
