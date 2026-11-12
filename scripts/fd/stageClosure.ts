// @effect-diagnostics nodeBuiltinImport:off - pnpm records a patch as the SHA-256 of its bytes, hashed here synchronously to compare.
import * as NodeCrypto from "node:crypto";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * A UX preview stage installs exactly what the accepted `pnpm-lock.yaml` resolved: roots,
 * transitive packages and patches are copied into the stage lockfile and installed with
 * `--frozen-lockfile` (so overrides and extensions are omitted; the repo lock stays untouched).
 * `verifyStageClosure` then compares what pnpm recorded with the accepted lock.
 */

const DependencyRef = Schema.Struct({ specifier: Schema.String, version: Schema.String });
const DependencyRefs = Schema.Record(Schema.String, DependencyRef);
const Importer = Schema.Struct({
  dependencies: Schema.optional(DependencyRefs),
  optionalDependencies: Schema.optional(DependencyRefs),
  devDependencies: Schema.optional(DependencyRefs),
});
const Catalogs = Schema.Record(Schema.String, DependencyRefs);

/** The parts of a lockfile the closure reads; packages and snapshots are copied whole. */
export const PnpmLockfile = Schema.Struct({
  lockfileVersion: Schema.String,
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  catalogs: Schema.optional(Catalogs),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  importers: Schema.Record(Schema.String, Importer),
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  snapshots: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type PnpmLockfile = typeof PnpmLockfile.Type;

const SnapshotEdges = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeSnapshotEdges = Schema.decodeUnknownSync(SnapshotEdges);
const decodeLockfileYaml = Schema.decodeEffect(fromYaml(PnpmLockfile));
const encodeYaml = Schema.encodeEffect(fromYaml(Schema.Unknown));

export class StageClosureError extends Schema.TaggedError<StageClosureError>()(
  "StageClosureError",
  {
    stage: Schema.Literals(["plan", "verify", "read"]),
    problems: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const shown = this.problems.slice(0, 8).join("; ");
    const more = this.problems.length > 8 ? ` (and ${this.problems.length - 8} more)` : "";
    return `The UX preview stage does not match the accepted lock (${this.stage}): ${shown}${more}.`;
  }
}

/** The importers whose resolution the desktop app ships. */
export const SHIPPED_IMPORTERS = ["apps/server", "apps/desktop"] as const;

/** A snapshot's dependency entry names either a version of that package or another key. */
const snapshotKeyOf = (name: string, reference: string): string | null => {
  if (reference.startsWith("link:")) return null;
  return /^(?:\d|file:|https?:)/.test(reference) ? `${name}@${reference}` : reference;
};

/** `name@version`, the key of `packages` and `patchedDependencies`, without peers or patches. */
export const packageKeyOf = (snapshotKey: string) => {
  const suffix = snapshotKey.indexOf("(");
  return suffix === -1 ? snapshotKey : snapshotKey.slice(0, suffix);
};

/** Hashes a patch file as pnpm records it in `patchedDependencies`. */
export const patchHashOf = (contents: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex");

const sorted = <V>(record: Readonly<Record<string, V>>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The version the accepted lock resolved for a stage root: the one the shipped importers record
 * under that specifier (a catalog entry read through its catalog), or a pinned version the lock
 * already holds, as a platform package an optional dependency brings. Never a version pnpm would
 * pick for the range today.
 */
export function resolveAcceptedRoot(
  lock: PnpmLockfile,
  name: string,
  specifier: string,
): { readonly version: string } | { readonly problem: string } {
  const versions = new Set<string>();
  // A workspace override pins the version and the importers record the pin as their specifier.
  // Honored only for the range whose floor is that pin, so another range is still refused.
  const pinned = lock.overrides?.[name];
  const recorded =
    pinned !== undefined && specifier.replace(/^[\^~]/, "") === pinned ? pinned : specifier;
  for (const importerId of SHIPPED_IMPORTERS) {
    const importer = lock.importers[importerId];
    for (const refs of [importer?.dependencies, importer?.optionalDependencies]) {
      const ref = refs?.[name];
      if (ref === undefined) continue;
      const resolved =
        ref.specifier === "catalog:" ? lock.catalogs?.default?.[name]?.specifier : ref.specifier;
      if (resolved === recorded) versions.add(ref.version);
    }
  }
  if (versions.size > 1) {
    return { problem: `${name}@${specifier} resolves to several versions in the accepted lock` };
  }
  const [version] = versions;
  if (version !== undefined) return { version };
  if (lock.snapshots?.[`${name}@${specifier}`] !== undefined) return { version: specifier };
  return { problem: `${name}@${specifier} is not resolved by the accepted lock` };
}

export interface FrozenStage {
  /** The stage's `pnpm-lock.yaml`, resolved entirely by the accepted lock. */
  readonly lockfile: PnpmLockfile;
  /** Registered patch files for the stage's workspace config, by `name@version`. */
  readonly patchFiles: Record<string, string>;
  /** Snapshots reached through required edges from the production roots: they must install. */
  readonly required: ReadonlyArray<string>;
}

/**
 * The stage's lockfile: the accepted lock's entries for every package the roots reach, through
 * required and optional edges alike, and the registered patch of every one of them. Fails naming
 * each root or entry the accepted lock does not resolve.
 */
export function planFrozenStage(input: {
  readonly lock: PnpmLockfile;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /** The workspace's `patchedDependencies`, mapping `name@version` to its patch file. */
  readonly workspacePatches: Readonly<Record<string, string>>;
}): FrozenStage | { readonly problems: ReadonlyArray<string> } {
  const { lock } = input;
  const problems: Array<string> = [];
  const roots = (dependencies: Readonly<Record<string, string>>) => {
    const refs: Record<string, { specifier: string; version: string }> = {};
    for (const [name, specifier] of Object.entries(dependencies)) {
      const root = resolveAcceptedRoot(lock, name, specifier);
      if ("problem" in root) problems.push(root.problem);
      else refs[name] = { specifier, version: root.version };
    }
    return sorted(refs);
  };
  const dependencies = roots(input.dependencies);
  const devDependencies = roots(input.devDependencies);

  const packages: Record<string, unknown> = {};
  const snapshots: Record<string, unknown> = {};
  const required = new Set<string>();
  const walk = (start: ReadonlyArray<string>, requiredOnly: boolean) => {
    const queue = [...start];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = lock.snapshots?.[key];
      const packageEntry = lock.packages?.[packageKeyOf(key)];
      if (snapshot === undefined || packageEntry === undefined) {
        problems.push(`${key} has no entry in the accepted lock`);
        continue;
      }
      if (requiredOnly) required.add(key);
      snapshots[key] = snapshot;
      packages[packageKeyOf(key)] = packageEntry;
      const edges = decodeSnapshotEdges(snapshot);
      const children = {
        ...edges.dependencies,
        ...(requiredOnly ? {} : edges.optionalDependencies),
      };
      for (const [name, reference] of Object.entries(children)) {
        const child = snapshotKeyOf(name, reference);
        if (child === null) problems.push(`${key} links ${name} from the workspace`);
        else queue.push(child);
      }
    }
  };
  const rootKeys = (refs: Record<string, { version: string }>) =>
    Object.entries(refs).map(([name, ref]) => snapshotKeyOf(name, ref.version) ?? name);
  walk([...rootKeys(dependencies), ...rootKeys(devDependencies)], false);
  walk(rootKeys(dependencies), true);

  const patchedDependencies: Record<string, string> = {};
  const patchFiles: Record<string, string> = {};
  for (const key of Object.keys(packages)) {
    const hash = lock.patchedDependencies?.[key];
    if (hash === undefined) continue;
    const file = input.workspacePatches[key];
    if (file === undefined) {
      problems.push(`${key} is patched in the accepted lock but registers no patch file`);
      continue;
    }
    patchedDependencies[key] = hash;
    patchFiles[key] = file;
  }
  if (problems.length > 0) return { problems: [...new Set(problems)] };

  return {
    lockfile: {
      lockfileVersion: lock.lockfileVersion,
      ...(lock.settings === undefined ? {} : { settings: lock.settings }),
      ...(Object.keys(patchedDependencies).length > 0
        ? { patchedDependencies: sorted(patchedDependencies) }
        : {}),
      importers: {
        ".": {
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
          ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}),
        },
      },
      packages: sorted(packages),
      snapshots: sorted(snapshots),
    },
    patchFiles: sorted(patchFiles),
    required: [...required].sort(),
  };
}

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

export interface StageClosureSummary {
  readonly roots: number;
  readonly installedSnapshots: number;
  readonly patches: Record<string, string>;
}

/**
 * Compares a generated stage with the accepted lock: the lockfile it installed from must be the
 * plan, every snapshot pnpm installed must be the accepted one with its package entry unchanged,
 * every required snapshot must be installed, and each registered patch, transitive ones included,
 * must hash to the identity the accepted lock records.
 */
export function verifyStageClosure(input: {
  readonly accepted: PnpmLockfile;
  readonly plan: FrozenStage;
  /** The stage's `pnpm-lock.yaml` once installed. */
  readonly stageLockfile: PnpmLockfile;
  /** What pnpm recorded as installed, `node_modules/.pnpm/lock.yaml`. */
  readonly installed: PnpmLockfile;
  /** The hash of each patch file in the stage, by `name@version`. */
  readonly patchHashes: Readonly<Record<string, string>>;
}): StageClosureSummary | { readonly problems: ReadonlyArray<string> } {
  const { accepted, plan, installed } = input;
  const problems: Array<string> = [];
  if (!sameJson(input.stageLockfile, plan.lockfile)) {
    problems.push("the stage's lockfile is not the one planned from the accepted lock");
  }
  const planned = plan.lockfile.importers["."];
  const installedRoot = installed.importers["."];
  for (const [name, ref] of Object.entries(planned?.dependencies ?? {})) {
    const got = installedRoot?.dependencies?.[name]?.version;
    if (got !== ref.version) problems.push(`root ${name} installed ${got ?? "nothing"}`);
  }
  for (const [key, snapshot] of Object.entries(installed.snapshots ?? {})) {
    const expected = accepted.snapshots?.[key];
    if (expected === undefined) problems.push(`${key} is not in the accepted lock`);
    else if (!sameJson(snapshot, expected)) problems.push(`${key} differs from the accepted lock`);
  }
  for (const [key, entry] of Object.entries(installed.packages ?? {})) {
    const expected = accepted.packages?.[key];
    if (expected === undefined || !sameJson(entry, expected)) {
      problems.push(`${key} is not resolved as the accepted lock resolves it`);
    }
  }
  for (const key of plan.required) {
    if (installed.snapshots?.[key] === undefined) problems.push(`${key} was not installed`);
  }
  const patches = plan.lockfile.patchedDependencies ?? {};
  for (const [key, hash] of Object.entries(patches)) {
    if (accepted.patchedDependencies?.[key] !== hash) {
      problems.push(`${key} is not patched as the accepted lock registers it`);
    }
    if (input.patchHashes[key] !== hash) problems.push(`${key}'s patch file has drifted`);
  }
  for (const [key, hash] of Object.entries(installed.patchedDependencies ?? {})) {
    if (patches[key] !== hash) problems.push(`${key} was installed with an unplanned patch`);
  }
  for (const key of Object.keys(installed.snapshots ?? {})) {
    const hash = accepted.patchedDependencies?.[packageKeyOf(key)];
    if (hash !== undefined && !key.includes(`patch_hash=${hash}`)) {
      problems.push(`${packageKeyOf(key)} was installed without its registered patch`);
    }
  }
  if (problems.length > 0) return { problems };
  return {
    roots: Object.keys(planned?.dependencies ?? {}).length,
    installedSnapshots: Object.keys(installed.snapshots ?? {}).length,
    patches: { ...patches },
  };
}

/** pnpm 12 writes its own package-manager lock as a first YAML document; the project's is last. */
const projectLockfileDocument = (text: string) =>
  text.split(/^---[ \t]*$/m).findLast((document) => document.trim() !== "") ?? text;

const readLockfile = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path)).pipe(
    Effect.map(projectLockfileDocument),
    Effect.flatMap(decodeLockfileYaml),
    Effect.mapError(
      () =>
        new StageClosureError({ stage: "read", problems: [`${path} is not a readable lockfile`] }),
    ),
  );

/** Reads and parses a repository's accepted lockfile. */
export const readAcceptedLockfile = (repoRoot: string) =>
  Effect.flatMap(Path.Path, (path) => readLockfile(path.join(repoRoot, "pnpm-lock.yaml")));

/** The install that applies the stage's lockfile as written, resolving nothing. */
export const FROZEN_STAGE_INSTALL_ARGS = ["install", "--frozen-lockfile", "--prod"] as const;

/**
 * Writes the frozen stage into `stageAppDir`: its lockfile and the patch files it registers,
 * copied byte for byte from the repository. Returns the plan, for the workspace config and the
 * verification after install.
 */
export const writeFrozenStage = Effect.fn("writeFrozenStage")(function* (input: {
  readonly repoRoot: string;
  readonly stageAppDir: string;
  readonly lock: PnpmLockfile;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly workspacePatches: Readonly<Record<string, string>>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plan = planFrozenStage(input);
  if ("problems" in plan) {
    return yield* new StageClosureError({ stage: "plan", problems: plan.problems });
  }
  yield* fileSystem.writeFileString(
    path.join(input.stageAppDir, "pnpm-lock.yaml"),
    yield* encodeYaml(plan.lockfile).pipe(
      Effect.mapError(
        () => new StageClosureError({ stage: "plan", problems: ["the stage lockfile"] }),
      ),
    ),
  );
  for (const file of Object.values(plan.patchFiles)) {
    const target = path.join(input.stageAppDir, file);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.copyFile(path.join(input.repoRoot, file), target);
  }
  return plan;
});

/** Reads what pnpm installed in the stage and verifies it; fails naming every difference. */
export const verifyInstalledStage = Effect.fn("verifyInstalledStage")(function* (input: {
  readonly stageAppDir: string;
  readonly accepted: PnpmLockfile;
  readonly plan: FrozenStage;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stageLockfile = yield* readLockfile(path.join(input.stageAppDir, "pnpm-lock.yaml"));
  const installed = yield* readLockfile(
    path.join(input.stageAppDir, "node_modules", ".pnpm", "lock.yaml"),
  );
  const patchHashes: Record<string, string> = {};
  for (const [key, file] of Object.entries(input.plan.patchFiles)) {
    patchHashes[key] = patchHashOf(
      yield* fileSystem
        .readFile(path.join(input.stageAppDir, file))
        .pipe(Effect.orElseSucceed(() => new Uint8Array())),
    );
  }
  const result = verifyStageClosure({ ...input, stageLockfile, installed, patchHashes });
  if ("problems" in result) {
    return yield* new StageClosureError({ stage: "verify", problems: result.problems });
  }
  return result;
});
