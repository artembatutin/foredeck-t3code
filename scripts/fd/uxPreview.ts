#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The launcher hands the installed app to the OS with Node's detached spawn; it outlives this process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { extractFile, uncache } from "@electron/asar";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

/**
 * The local development build, installed as Foredeck: an identity of its own (bundle, URL scheme,
 * profile and T3 home), built from the accepted lock's frozen closure and installed beside the
 * assistant preview without touching it. Its home is baked into the build, so Finder
 * opens it there; these helpers build, install, check and launch it, and judge every home and
 * launch input from strings alone, before anything is spawned.
 */

/**
 * The desktop app reads the version marker, product name, metadata key and assistant preview home
 * from `@t3tools/shared/fd/assistant`, which scripts may not import across the fd boundary;
 * `uxPreview.test.ts` keeps these copies equal to it.
 */
export const isUxPreviewVersion = (version: string) =>
  /^[^-+]+-(?:dev|uxpreview)\.\d{8}\.\d+$/.test(version);
export const UX_PREVIEW_HOME_METADATA_KEY = "t3codeUxPreviewHome";
export const ASSISTANT_PREVIEW_HOME = ".foredeck-assistant-preview";

export const UX_PREVIEW_APP_ID = "com.foredeck.ux.preview";
export const UX_PREVIEW_PRODUCT_NAME = "Foredeck";
export const UX_PREVIEW_PROTOCOL = "foredeck-ux-preview";
export const UX_PREVIEW_APP_PATH = `/Applications/${UX_PREVIEW_PRODUCT_NAME}.app`;
/** The build input naming the home a UX preview build bakes into its metadata. */
export const UX_PREVIEW_HOME_ENV = "T3CODE_UX_PREVIEW_HOME";
/** The accepted preview, which nothing here may write to. */
export const ACCEPTED_PREVIEW_APP_PATH = "/Applications/Foredeck Assistant Preview.app";

/** Inputs that would point a launch or a build at a development origin or credential. */
export const DEVELOPMENT_INPUTS = [
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "T3CODE_DEV_AUTH_TOKEN",
  "ELECTRON_RUN_AS_NODE",
] as const;

const UX_PREVIEW_EXECUTABLE = `Contents/MacOS/${UX_PREVIEW_PRODUCT_NAME}`;

/** `<base>-dev.<yyyymmdd>.<run>`, a marker the desktop app and build key on. */
export const uxPreviewVersion = (baseVersion: string, date: Date, run: number) =>
  `${baseVersion.split(/[-+]/)[0]}-dev.${date.toISOString().slice(0, 10).replaceAll("-", "")}.${run}`;

/** The home a UX preview built for `evidenceDir` runs on. */
export const uxPreviewHomeOf = (evidenceDir: string) =>
  `${evidenceDir.replace(/\/+$/, "")}/desktop-home`;

/** Where the build for `version` keeps its artifact and manifest. */
const buildDirOf = (evidenceDir: string, version: string) =>
  `${evidenceDir.replace(/\/+$/, "")}/ux-preview-build/${version}`;
const currentBuildOf = (evidenceDir: string) =>
  `${evidenceDir.replace(/\/+$/, "")}/ux-preview-build/current.json`;

const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Names a home by what it is, never by what it says. */
const describeHome = (home: string, userHome: string) =>
  overlaps(home, `${userHome}/.t3`)
    ? "the live T3 home"
    : overlaps(home, `${userHome}/${ASSISTANT_PREVIEW_HOME}`)
      ? "the assistant preview's home"
      : "another home";

/**
 * Why `home` cannot be a UX preview's home, from strings alone: it must be an absolute, normalized
 * path apart from the live T3 home and the assistant preview's. Nothing is read to decide.
 */
export function uxPreviewHomeProblems(home: string, userHome: string): Array<string> {
  if (!home.startsWith("/") || home.endsWith("/") || /(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(home)) {
    return ["the UX preview home must be an absolute, normalized path"];
  }
  const kind = describeHome(home, userHome);
  return kind === "another home" ? [] : [`the UX preview home overlaps ${kind}`];
}

export type UxPreviewLaunchPlan =
  | { readonly _tag: "Refused"; readonly reasons: ReadonlyArray<string> }
  | {
      readonly _tag: "Launch";
      readonly executable: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cleared: ReadonlyArray<string>;
    };

/**
 * How to start the installed UX preview, or why not, decided from strings before any spawn. An
 * inherited `T3CODE_HOME` naming any other home refuses the launch; development origins and
 * credentials are cleared, and listed; the child gets exactly the authorized home.
 */
export function planUxPreviewLaunch(input: {
  readonly home: string;
  readonly userHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appPath?: string;
}): UxPreviewLaunchPlan {
  const reasons = uxPreviewHomeProblems(input.home, input.userHome);
  const inherited = input.env.T3CODE_HOME?.trim();
  if (inherited !== undefined && inherited !== "" && inherited !== input.home) {
    reasons.push(
      `T3CODE_HOME names ${describeHome(inherited, input.userHome)}; unset it to launch the UX preview`,
    );
  }
  if (reasons.length > 0) return { _tag: "Refused", reasons };
  const dropped = new Set<string>([...DEVELOPMENT_INPUTS, "T3CODE_HOME"]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) {
    if (value !== undefined && !dropped.has(name)) env[name] = value;
  }
  env.T3CODE_HOME = input.home;
  return {
    _tag: "Launch",
    executable: `${input.appPath ?? UX_PREVIEW_APP_PATH}/${UX_PREVIEW_EXECUTABLE}`,
    env,
    cleared: DEVELOPMENT_INPUTS.filter((name) => (input.env[name] ?? "") !== ""),
  };
}

/**
 * The build's environment: the home to bake in, no development origin to bake in with it, and a
 * compile of this checkout. Removing the inherited origins is not enough, since the web build
 * merges `.env` and `.env.local` underneath and would restore them, so it is also told to bake
 * none (see `resolveWebBuildOrigins`). Inherited switches that package compiled output already on
 * disk are turned off, or a stale bundle would carry this commit's manifest and metadata.
 */
export function uxPreviewBuildEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const dropped = new Set<string>([...DEVELOPMENT_INPUTS, "T3CODE_HOME"]);
  const built: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !dropped.has(name)) built[name] = value;
  }
  built[UX_PREVIEW_HOME_ENV] = home;
  built.T3CODE_TELEMETRY_ENABLED = "false";
  built.T3CODE_SINGLE_ORIGIN_DEV = "1";
  built.T3CODE_DESKTOP_SKIP_BUILD = "false";
  built.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = "false";
  return built;
}

export const UxPreviewManifest = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  home: Schema.String,
  arch: Schema.String,
  appId: Schema.String,
  productName: Schema.String,
  protocol: Schema.String,
  artifact: Schema.Struct({ file: Schema.String, sha256: Schema.String }),
});
export type UxPreviewManifest = typeof UxPreviewManifest.Type;
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(UxPreviewManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(UxPreviewManifest));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const CurrentBuild = Schema.Struct({ version: Schema.String });
const decodeCurrentBuild = Schema.decodeEffect(Schema.fromJsonString(CurrentBuild));

/** What an installed or extracted app says it is. */
export interface UxPreviewIdentity {
  readonly bundleId: string | null;
  readonly productName: string | null;
  readonly version: string | null;
  readonly schemes: ReadonlyArray<string>;
  readonly commit: string | null;
  readonly home: string | null;
  readonly updateFeed: boolean;
}

/** Every way `observed` differs from the UX preview `expected` describes; empty when it is it. */
export function uxPreviewIdentityProblems(
  observed: UxPreviewIdentity,
  expected: Pick<UxPreviewManifest, "version" | "commit" | "home">,
): Array<string> {
  const problems: Array<string> = [];
  const differs = (name: string, got: string | null, want: string) => {
    if (got !== want) problems.push(`${name} is ${got ?? "missing"}, not ${want}`);
  };
  differs("bundle id", observed.bundleId, UX_PREVIEW_APP_ID);
  differs("product name", observed.productName, UX_PREVIEW_PRODUCT_NAME);
  differs("version", observed.version, expected.version);
  differs("commit", observed.commit, expected.commit);
  differs("home", observed.home, expected.home);
  if (observed.schemes.length !== 1 || observed.schemes[0] !== UX_PREVIEW_PROTOCOL) {
    problems.push(`URL schemes are [${observed.schemes.join(", ")}], not [${UX_PREVIEW_PROTOCOL}]`);
  }
  if (observed.updateFeed) problems.push("it carries an update feed");
  return problems;
}

export class UxPreviewError extends Schema.TaggedError<UxPreviewError>()("UxPreviewError", {
  step: Schema.Literals(["home", "build", "install", "check", "launch"]),
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `UX preview ${this.step} refused: ${this.problems.join("; ")}.`;
  }
}

const refuse = (step: UxPreviewError["step"], problems: ReadonlyArray<string>) =>
  Effect.fail(new UxPreviewError({ step, problems }));

/** Starts the app detached from this process, so it outlives the helper. */
export class UxPreviewLauncher extends Context.Service<
  UxPreviewLauncher,
  {
    readonly spawnDetached: (input: {
      readonly executable: string;
      readonly env: Readonly<Record<string, string>>;
    }) => Effect.Effect<void, UxPreviewError>;
  }
>()("@t3tools/scripts/fd/uxPreview/UxPreviewLauncher") {}

export const layerNodeLauncher = Layer.succeed(
  UxPreviewLauncher,
  UxPreviewLauncher.of({
    spawnDetached: ({ executable, env }) =>
      Effect.try({
        try: () =>
          NodeChildProcess.spawn(executable, [], { env, detached: true, stdio: "ignore" }).unref(),
        catch: () => new UxPreviewError({ step: "launch", problems: ["the app did not start"] }),
      }),
  }),
);

/** Runs a command to its end and returns its output; a nonzero exit fails naming `label`. */
const run = (
  step: UxPreviewError["step"],
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly inherit?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: false }),
        stdout: options.inherit === true ? "inherit" : "pipe",
        stderr: options.inherit === true ? "inherit" : "pipe",
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* refuse(step, [`${label} exited with ${Number(exitCode)}`]);
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PlatformError: () => refuse(step, [`${label} could not start`]),
    }),
  );

const sha256Of = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFile(path)).pipe(
    Effect.map((bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex")),
  );

const readManifest = (evidenceDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { version } = yield* decodeCurrentBuild(
      yield* fileSystem.readFileString(currentBuildOf(evidenceDir)),
    );
    return yield* decodeManifest(
      yield* fileSystem.readFileString(`${buildDirOf(evidenceDir, version)}/manifest.json`),
    );
  }).pipe(
    Effect.catchTags({
      PlatformError: () => refuse("check", ["no UX preview build is recorded for this evidence"]),
      SchemaError: () => refuse("check", ["the recorded UX preview build is unreadable"]),
    }),
  );

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** Reads what an app bundle says it is: its Info.plist, its package metadata and update feed. */
export const observeUxPreviewApp = (appPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = Plist.parse(
      yield* fileSystem.readFileString(`${appPath}/Contents/Info.plist`),
    ) as Record<string, unknown>;
    const unreadable = new UxPreviewError({
      step: "check",
      problems: ["its app archive is unreadable"],
    });
    const archive = `${appPath}/Contents/Resources/app.asar`;
    const decoded = yield* Effect.try({
      // The archive reader caches each path's header, and an install replaces the app at a path
      // it has already read, so the header is read afresh.
      try: () => {
        uncache(archive);
        return extractFile(archive, "package.json").toString("utf8");
      },
      catch: () => unreadable,
    }).pipe(
      Effect.flatMap(decodeJson),
      Effect.catchTags({ SchemaError: () => Effect.fail(unreadable) }),
    );
    const metadata: Record<string, unknown> =
      typeof decoded === "object" && decoded !== null ? { ...decoded } : {};
    const urlTypes = Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes : [];
    return {
      bundleId: stringOrNull(info.CFBundleIdentifier),
      productName: stringOrNull(info.CFBundleName),
      version: stringOrNull(info.CFBundleShortVersionString),
      schemes: urlTypes.flatMap((type: { readonly CFBundleURLSchemes?: unknown }) =>
        Array.isArray(type.CFBundleURLSchemes) ? type.CFBundleURLSchemes.map(String) : [],
      ),
      commit: stringOrNull(metadata.t3codeCommitHash),
      home: stringOrNull(metadata[UX_PREVIEW_HOME_METADATA_KEY]),
      updateFeed: yield* fileSystem.exists(`${appPath}/Contents/Resources/app-update.yml`),
    } satisfies UxPreviewIdentity;
  }).pipe(
    Effect.catchTags({
      PlatformError: () => refuse("check", [`${appPath} is not a readable app`]),
    }),
  );

/** Checks the app at `appPath` is the recorded build, failing with every difference. */
export const checkUxPreview = (input: {
  readonly evidenceDir: string;
  readonly appPath?: string;
}) =>
  Effect.gen(function* () {
    const manifest = yield* readManifest(input.evidenceDir);
    const observed = yield* observeUxPreviewApp(input.appPath ?? UX_PREVIEW_APP_PATH);
    const problems = uxPreviewIdentityProblems(observed, manifest);
    if (problems.length > 0) return yield* refuse("check", problems);
    return { manifest, observed };
  });

/**
 * Builds the UX preview from this clean checkout for `evidenceDir`'s home: the artifact build
 * bakes the home in and verifies its frozen closure, and the manifest records what it built.
 */
export const buildUxPreview = (input: {
  readonly repoRoot: string;
  readonly evidenceDir: string;
  readonly userHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baseVersion: string;
  readonly date: Date;
  readonly run: number;
  readonly arch: "arm64" | "x64";
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = uxPreviewHomeOf(input.evidenceDir);
    const homeProblems = uxPreviewHomeProblems(home, input.userHome);
    if (homeProblems.length > 0) return yield* refuse("home", homeProblems);
    const version = uxPreviewVersion(input.baseVersion, input.date, input.run);
    const outputDir = buildDirOf(input.evidenceDir, version);
    if (yield* fileSystem.exists(outputDir)) {
      return yield* refuse("build", [`${version} was built already; choose another --run`]);
    }
    const git = (args: ReadonlyArray<string>) =>
      run("build", `git ${args[0]}`, "git", args, { cwd: input.repoRoot });
    const clean = (yield* git(["status", "--porcelain=v1", "--untracked-files=all"])) === "";
    if (!clean) return yield* refuse("build", ["the checkout has uncommitted changes"]);
    const commit = (yield* git(["rev-parse", "--verify", "HEAD"])).trim();

    yield* run(
      "build",
      "the desktop artifact build",
      process.execPath,
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "mac",
        "--target",
        "zip",
        "--arch",
        input.arch,
        "--build-version",
        version,
        "--output-dir",
        outputDir,
      ],
      { cwd: input.repoRoot, env: uxPreviewBuildEnv(input.env, home), inherit: true },
    );
    if ((yield* git(["rev-parse", "--verify", "HEAD"])).trim() !== commit) {
      return yield* refuse("build", ["HEAD moved while the build ran"]);
    }
    const file = `foredeck-t3-${version}-${input.arch}.zip`;
    const manifest: UxPreviewManifest = {
      version,
      commit,
      home,
      arch: input.arch,
      appId: UX_PREVIEW_APP_ID,
      productName: UX_PREVIEW_PRODUCT_NAME,
      protocol: UX_PREVIEW_PROTOCOL,
      artifact: {
        file,
        sha256: yield* sha256Of(`${outputDir}/${file}`).pipe(
          Effect.catchTags({ PlatformError: () => refuse("build", [`${file} was not produced`]) }),
        ),
      },
    };
    yield* fileSystem.writeFileString(
      `${outputDir}/manifest.json`,
      `${yield* encodeManifest(manifest)}\n`,
    );
    yield* fileSystem.writeFileString(
      currentBuildOf(input.evidenceDir),
      `${yield* encodeJson({ version })}\n`,
    );
    return manifest;
  }).pipe(
    Effect.catchTags({
      PlatformError: () => refuse("build", ["a file could not be read or written"]),
      SchemaError: () => refuse("build", ["the build record could not be written"]),
    }),
  );

/**
 * Installs the recorded build as `/Applications/Foredeck.app`, after checking the extracted app
 * is that build. An app already there is replaced only when it is a UX preview.
 */
export const installUxPreview = (input: {
  readonly evidenceDir: string;
  readonly appPath?: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const appPath = input.appPath ?? UX_PREVIEW_APP_PATH;
    const manifest = yield* readManifest(input.evidenceDir);
    const buildDir = buildDirOf(input.evidenceDir, manifest.version);
    const archive = `${buildDir}/${manifest.artifact.file}`;
    if ((yield* sha256Of(archive)) !== manifest.artifact.sha256) {
      return yield* refuse("install", ["the build's archive is not the one recorded"]);
    }
    const extracted = `${buildDir}/extracted`;
    yield* fileSystem.remove(extracted, { recursive: true, force: true });
    yield* run("install", "ditto -x", "ditto", ["-x", "-k", archive, extracted]);
    const extractedApp = `${extracted}/${UX_PREVIEW_PRODUCT_NAME}.app`;
    const problems = uxPreviewIdentityProblems(yield* observeUxPreviewApp(extractedApp), manifest);
    if (problems.length > 0) return yield* refuse("install", problems);
    if (yield* fileSystem.exists(appPath)) {
      const present = yield* observeUxPreviewApp(appPath).pipe(
        Effect.catchTags({ UxPreviewError: () => Effect.succeed(null) }),
      );
      if (present?.bundleId !== UX_PREVIEW_APP_ID) {
        return yield* refuse("install", [`${appPath} holds another app; move it first`]);
      }
      yield* fileSystem.remove(appPath, { recursive: true });
    }
    yield* run("install", "ditto", "ditto", [extractedApp, appPath]);
    return yield* checkUxPreview({ evidenceDir: input.evidenceDir, appPath });
  }).pipe(
    Effect.catchTags({
      PlatformError: () => refuse("install", ["a file could not be read or written"]),
    }),
  );

/**
 * Launches the installed UX preview on its home. The plan is judged first, from strings: a refused
 * plan reads nothing and spawns nothing. Only then is the installed app checked and started.
 */
export const launchUxPreview = (input: {
  readonly evidenceDir: string;
  readonly userHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appPath?: string;
}) =>
  Effect.gen(function* () {
    const plan = planUxPreviewLaunch({
      home: uxPreviewHomeOf(input.evidenceDir),
      userHome: input.userHome,
      env: input.env,
      ...(input.appPath === undefined ? {} : { appPath: input.appPath }),
    });
    if (plan._tag === "Refused") return yield* refuse("launch", plan.reasons);
    const { manifest } = yield* checkUxPreview({
      evidenceDir: input.evidenceDir,
      ...(input.appPath === undefined ? {} : { appPath: input.appPath }),
    });
    if (manifest.home !== plan.env.T3CODE_HOME) {
      return yield* refuse("launch", ["the installed build runs on another home"]);
    }
    const launcher = yield* UxPreviewLauncher;
    yield* launcher.spawnDetached({ executable: plan.executable, env: plan.env });
    return plan;
  });

const evidenceDirFlag = Flag.String("evidence-dir").pipe(
  Flag.withDescription("The evidence directory; the preview's home is its desktop-home."),
);

const cli = Command.make(
  "ux-preview",
  {
    step: Argument.Literals("step", ["build", "install", "check", "launch"]).pipe(
      Argument.withDescription("build, install, check or launch the UX preview"),
    ),
    evidenceDir: evidenceDirFlag,
    run: Flag.Int("run").pipe(
      Flag.withDefault(1),
      Flag.withDescription("Build number of the day."),
    ),
    arch: Flag.Literals("arch", ["arm64", "x64"]).pipe(Flag.withDefault("arm64" as const)),
  },
  Effect.fn("uxPreview.main")(function* ({ step, evidenceDir, run: buildRun, arch }) {
    const env = yield* HostProcess.Environment;
    const userHome = yield* HostProcess.HomeDirectory;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
    const result =
      step === "build"
        ? yield* buildUxPreview({
            repoRoot,
            evidenceDir,
            userHome,
            env,
            baseVersion: serverPackageJson.version,
            date: DateTime.toDateUtc(yield* DateTime.now),
            run: buildRun,
            arch,
          })
        : step === "install"
          ? yield* installUxPreview({ evidenceDir })
          : step === "check"
            ? yield* checkUxPreview({ evidenceDir })
            : yield* launchUxPreview({ evidenceDir, userHome, env });
    yield* Console.log(yield* encodeJson({ step, result }));
  }),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, layerNodeLauncher)),
    NodeRuntime.runMain,
  );
}
