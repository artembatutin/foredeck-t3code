// @effect-diagnostics nodeBuiltinImport:off - The stubbed ditto copies a fixture app synchronously, as the real one would.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { createPackage } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import Plist from "plist";

import { resolveBuildOptions } from "../build-desktop-artifact.ts";
import { loadRepoEnv, resolveWebBuildOrigins } from "../lib/public-config.ts";

import {
  ACCEPTED_PREVIEW_APP_PATH,
  ASSISTANT_PREVIEW_HOME,
  isUxPreviewVersion,
  buildUxPreview,
  checkUxPreview,
  installUxPreview,
  launchUxPreview,
  planUxPreviewLaunch,
  UX_PREVIEW_APP_ID,
  UX_PREVIEW_APP_PATH,
  UX_PREVIEW_HOME_METADATA_KEY,
  UX_PREVIEW_PRODUCT_NAME,
  UX_PREVIEW_PROTOCOL,
  type UxPreviewIdentity,
  uxPreviewIdentityProblems,
  uxPreviewBuildEnv,
  UxPreviewLauncher,
  type UxPreviewManifest,
  uxPreviewVersion,
} from "./uxPreview.ts";

const userHome = "/Users/alice";
const evidenceDir = "/evidence/ux";
const home = "/evidence/ux/desktop-home";
const commit = "5c73e2b8d6003767fced1fe2ae265757aabfdadd";
const version = "0.0.45-dev.20261102.1";
/** A build from before development builds were named Foredeck; it keeps the same home guard. */
const legacyVersion = "0.0.45-uxpreview.20261102.1";
const dateOf = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const noon = dateOf("2026-11-02T12:00:00Z");

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
}

const exited = (exitCode: number, stdout = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

/** Answers each command with `answer`, recording it; anything it does not answer exits 0. */
const processes = (
  spawned: Array<Spawned>,
  answer: (command: Spawned) => {
    readonly exitCode?: number;
    readonly stdout?: string;
  } = () => ({}),
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const standard = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: Record<string, string | undefined> };
      };
      const recorded = {
        command: standard.command,
        args: standard.args,
        env: standard.options.env,
      };
      spawned.push(recorded);
      const { exitCode = 0, stdout = "" } = answer(recorded);
      return Effect.sync(() => exited(exitCode, stdout));
    }),
  );

const launcher = (launched: Array<{ readonly executable: string; readonly env: object }>) =>
  Layer.succeed(
    UxPreviewLauncher,
    UxPreviewLauncher.of({
      spawnDetached: (input) => Effect.sync(() => void launched.push(input)),
    }),
  );

/** A filesystem that records every call and holds nothing. */
const watchedFileSystem = (touched: Array<string>) => {
  const noop = FileSystem.makeNoop({});
  return Layer.succeed(
    FileSystem.FileSystem,
    new Proxy(noop, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function"
          ? (...args: Array<unknown>) => {
              touched.push(String(key));
              return value.apply(target, args);
            }
          : value;
      },
    }),
  );
};

const identity = (overrides: Partial<UxPreviewIdentity> = {}): UxPreviewIdentity => ({
  bundleId: UX_PREVIEW_APP_ID,
  productName: UX_PREVIEW_PRODUCT_NAME,
  version,
  schemes: [UX_PREVIEW_PROTOCOL],
  commit,
  home,
  updateFeed: false,
  ...overrides,
});

it.layer(NodeServices.layer)("the copies of the desktop app's UX preview identity", (it) => {
  it.effect("match @t3tools/shared/fd/assistant, which scripts may not import", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
      const shared = yield* fileSystem.readFileString(
        path.join(repoRoot, "packages/shared/src/fd/assistant/index.ts"),
      );
      const marker = String.raw`/^[^-+]+-(?:dev|uxpreview)\.\d{8}\.\d+$/`;
      assert.include(shared, marker);
      assert.include(isUxPreviewVersion.toString(), marker);
      assert.include(shared, `UX_PREVIEW_HOME_METADATA_KEY = "${UX_PREVIEW_HOME_METADATA_KEY}"`);
      assert.include(shared, `ASSISTANT_PREVIEW_HOME = "${ASSISTANT_PREVIEW_HOME}"`);
      assert.include(shared, `UX_PREVIEW_PRODUCT_NAME = "${UX_PREVIEW_PRODUCT_NAME}"`);
      assert.include(shared, 'UX_PREVIEW_PRODUCT_NAME = "Foredeck"');
      assert.strictEqual(UX_PREVIEW_PRODUCT_NAME, "Foredeck");
      // The shared copy's own check, as written there, judges each version as the script's does.
      const sharedSource = /isUxPreviewVersion = \(version: string\) =>\s*\/(.+)\/\.test/.exec(
        shared,
      )?.[1];
      assert.isDefined(sharedSource);
      const sharedCheck = new RegExp(sharedSource!);
      for (const accepted of [version, legacyVersion]) {
        assert.isTrue(isUxPreviewVersion(accepted), accepted);
        assert.isTrue(sharedCheck.test(accepted), accepted);
      }
      for (const refused of [
        "0.0.45",
        "0.0.45-nightly.20261101.3",
        "0.0.45-preview.20261017.2",
        "0.0.45-dev.2026110.1",
        "0.0.45-uxpreview.2026110.1",
        "0.0.45-dev",
        "1.2.3-foo-dev.20261102.1",
        "0.0.45-dev.20261102.1+meta",
      ]) {
        assert.isFalse(isUxPreviewVersion(refused), refused);
        assert.isFalse(sharedCheck.test(refused), refused);
      }
    }),
  );
});

it("names a development build with the dev marker and its UTC date", () => {
  assert.strictEqual(
    uxPreviewVersion("0.0.45", dateOf("2026-11-02T23:00:00Z"), 1),
    "0.0.45-dev.20261102.1",
  );
  assert.strictEqual(
    uxPreviewVersion("0.0.45-nightly.20261101.3", dateOf("2026-11-02T00:00:00Z"), 2),
    "0.0.45-dev.20261102.2",
  );
});

it("checks identity, version, commit and home, naming each difference", () => {
  assert.deepStrictEqual(uxPreviewIdentityProblems(identity(), { version, commit, home }), []);
  assert.deepStrictEqual(
    uxPreviewIdentityProblems(
      identity({
        bundleId: "com.foredeck.assistant.preview",
        productName: "Foredeck Assistant Preview",
        version: "0.0.45-preview.20261017.2",
        schemes: [],
        commit: "0123456789ab",
        home: `${userHome}/.foredeck-assistant-preview`,
        updateFeed: true,
      }),
      { version, commit, home },
    ),
    [
      "bundle id is com.foredeck.assistant.preview, not com.foredeck.ux.preview",
      "product name is Foredeck Assistant Preview, not Foredeck",
      `version is 0.0.45-preview.20261017.2, not ${version}`,
      `commit is 0123456789ab, not ${commit}`,
      `home is ${userHome}/.foredeck-assistant-preview, not ${home}`,
      "URL schemes are [], not [foredeck-ux-preview]",
      "it carries an update feed",
    ],
  );
  assert.deepStrictEqual(
    uxPreviewIdentityProblems(identity({ home: null, commit: null }), { version, commit, home }),
    [`commit is missing, not ${commit}`, `home is missing, not ${home}`],
  );
});

const conflicting = [
  { name: "the live home", env: { T3CODE_HOME: `${userHome}/.t3` }, kind: "the live T3 home" },
  {
    name: "the live home's userdata",
    env: { T3CODE_HOME: `${userHome}/.t3/userdata` },
    kind: "the live T3 home",
  },
  {
    name: "the assistant preview's home",
    env: { T3CODE_HOME: `${userHome}/.foredeck-assistant-preview` },
    kind: "the assistant preview's home",
  },
  {
    name: "another home",
    env: { T3CODE_HOME: "/evidence/ux/desktop-home-old" },
    kind: "another home",
  },
] as const;

it.effect.each(conflicting)(
  "refuses an inherited T3CODE_HOME naming $name, spawning and reading nothing",
  ({ env, kind }) =>
    Effect.gen(function* () {
      const spawned: Array<Spawned> = [];
      const launched: Array<{ readonly executable: string; readonly env: object }> = [];
      const touched: Array<string> = [];
      const refused = yield* Effect.flip(
        launchUxPreview({ evidenceDir, userHome, env: { PATH: "/usr/bin", ...env } }).pipe(
          Effect.provide(
            Layer.mergeAll(processes(spawned), launcher(launched), watchedFileSystem(touched)),
          ),
        ),
      );
      assert.strictEqual(refused.step, "launch");
      assert.deepStrictEqual(refused.problems, [
        `T3CODE_HOME names ${kind}; unset it to launch the UX preview`,
      ]);
      assert.deepStrictEqual(spawned, []);
      assert.deepStrictEqual(launched, []);
      assert.deepStrictEqual(touched, []);
    }),
);

it.effect.each([
  { name: "the live home", evidence: `${userHome}/.t3` },
  { name: "the assistant preview's home", evidence: `${userHome}/.foredeck-assistant-preview` },
  { name: "a relative path", evidence: "evidence/ux" },
])("refuses a preview home inside $name before any spawn or read", ({ evidence }) =>
  Effect.gen(function* () {
    const spawned: Array<Spawned> = [];
    const launched: Array<{ readonly executable: string; readonly env: object }> = [];
    const touched: Array<string> = [];
    const layers = Layer.mergeAll(
      processes(spawned),
      launcher(launched),
      watchedFileSystem(touched),
    );
    const launch = yield* Effect.flip(
      launchUxPreview({ evidenceDir: evidence, userHome, env: {} }).pipe(Effect.provide(layers)),
    );
    assert.strictEqual(launch.step, "launch");
    const build = yield* Effect.flip(
      buildUxPreview({
        repoRoot: "/repo",
        evidenceDir: evidence,
        userHome,
        env: {},
        baseVersion: "0.0.45",
        date: noon,
        run: 1,
        arch: "arm64",
      }).pipe(Effect.provide(layers)),
    );
    assert.strictEqual(build.step, "home");
    assert.deepStrictEqual(spawned, []);
    assert.deepStrictEqual(launched, []);
    assert.deepStrictEqual(touched, []);
  }),
);

it("clears development origins and credentials and hands the child exactly its home", () => {
  assert.strictEqual(UX_PREVIEW_APP_PATH, "/Applications/Foredeck.app");
  const plan = planUxPreviewLaunch({
    home,
    userHome,
    env: {
      PATH: "/usr/bin",
      HOME: userHome,
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      VITE_HTTP_URL: "http://localhost:3773",
      VITE_WS_URL: "ws://localhost:3773",
      T3CODE_DEV_AUTH_TOKEN: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      T3CODE_HOME: home,
    },
  });
  assert.deepStrictEqual(plan, {
    _tag: "Launch",
    executable: "/Applications/Foredeck.app/Contents/MacOS/Foredeck",
    env: { PATH: "/usr/bin", HOME: userHome, T3CODE_HOME: home },
    cleared: [
      "VITE_DEV_SERVER_URL",
      "VITE_HTTP_URL",
      "VITE_WS_URL",
      "T3CODE_DEV_AUTH_TOKEN",
      "ELECTRON_RUN_AS_NODE",
    ],
  });
});

it.layer(NodeServices.layer)("the UX preview helpers on disk", (it) => {
  /** An app bundle saying it is `app`, as electron-builder lays one out. */
  const writeApp = (appPath: string, app: UxPreviewIdentity) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resources = path.join(appPath, "Contents", "Resources");
      yield* fileSystem.makeDirectory(resources, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(appPath, "Contents", "Info.plist"),
        Plist.build({
          CFBundleIdentifier: app.bundleId ?? "",
          CFBundleName: app.productName ?? "",
          CFBundleShortVersionString: app.version ?? "",
          CFBundleURLTypes: [{ CFBundleURLName: "scheme", CFBundleURLSchemes: [...app.schemes] }],
        }),
      );
      const source = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-ux-asar-" });
      yield* fileSystem.writeFileString(
        path.join(source, "package.json"),
        JSON.stringify({
          version: app.version,
          t3codeCommitHash: app.commit,
          t3codeUxPreviewHome: app.home,
        }),
      );
      yield* Effect.promise(() => createPackage(source, path.join(resources, "app.asar")));
      if (app.updateFeed) {
        yield* fileSystem.writeFileString(
          path.join(resources, "app-update.yml"),
          "provider: github\n",
        );
      }
    });

  /** An evidence directory recording one build, whose archive is `archive`. */
  const recordBuild = (evidence: string, archive: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const buildDir = `${evidence}/ux-preview-build/${version}`;
      yield* fileSystem.makeDirectory(buildDir, { recursive: true });
      yield* fileSystem.writeFileString(`${buildDir}/foredeck-t3-${version}-arm64.zip`, archive);
      const manifest: UxPreviewManifest = {
        version,
        commit,
        home: `${evidence}/desktop-home`,
        arch: "arm64",
        appId: UX_PREVIEW_APP_ID,
        productName: UX_PREVIEW_PRODUCT_NAME,
        protocol: UX_PREVIEW_PROTOCOL,
        artifact: {
          file: `foredeck-t3-${version}-arm64.zip`,
          sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
        },
      };
      yield* fileSystem.writeFileString(`${buildDir}/manifest.json`, JSON.stringify(manifest));
      yield* fileSystem.writeFileString(
        `${evidence}/ux-preview-build/current.json`,
        JSON.stringify({ version }),
      );
      return manifest;
    });

  const scratch = Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.makeTempDirectoryScoped({ prefix: "fd-ux-preview-" }),
  );

  it.effect("builds from a clean checkout, baking the exact home into the build's metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const evidence = yield* scratch;
      const spawned: Array<Spawned> = [];
      const manifest = yield* buildUxPreview({
        repoRoot: "/repo",
        evidenceDir: evidence,
        userHome,
        env: {
          PATH: "/usr/bin",
          T3CODE_HOME: `${userHome}/.t3`,
          VITE_HTTP_URL: "http://localhost:3773",
          T3CODE_DEV_AUTH_TOKEN: "secret",
          // Left over from another build, these would package what is already on disk.
          T3CODE_DESKTOP_SKIP_BUILD: "true",
          T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
          T3CODE_SINGLE_ORIGIN_DEV: "0",
        },
        baseVersion: "0.0.45",
        date: noon,
        run: 1,
        arch: "arm64",
      }).pipe(
        Effect.provide(
          processes(spawned, (command) => {
            if (command.args[0] === "rev-parse") return { stdout: `${commit}\n` };
            if (command.args[0] === "scripts/build-desktop-artifact.ts") {
              const outputDir = command.args[command.args.indexOf("--output-dir") + 1]!;
              NodeFS.mkdirSync(outputDir, { recursive: true });
              NodeFS.writeFileSync(`${outputDir}/foredeck-t3-${version}-arm64.zip`, "zip");
            }
            return {};
          }),
        ),
      );
      const build = spawned.find(({ args }) => args[0] === "scripts/build-desktop-artifact.ts");
      assert.deepStrictEqual(build?.args, [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        "mac",
        "--target",
        "zip",
        "--arch",
        "arm64",
        "--build-version",
        version,
        "--output-dir",
        `${evidence}/ux-preview-build/${version}`,
      ]);
      // The artifact build reads that environment and those flags as it would on its own.
      const flag = (name: string) => {
        const at = build?.args.indexOf(name) ?? -1;
        return at === -1 ? Option.none() : Option.fromNullishOr(build?.args[at + 1]);
      };
      const options = yield* resolveBuildOptions({
        platform: flag("--platform") as Option.Option<"mac">,
        target: flag("--target"),
        arch: flag("--arch") as Option.Option<"arm64">,
        buildVersion: flag("--build-version"),
        outputDir: flag("--output-dir"),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: Object.fromEntries(
                Object.entries(build?.env ?? {}).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
            }),
          ),
        ),
      );
      assert.isFalse(options.skipBuild);
      assert.strictEqual(options.version, "0.0.45-dev.20261102.1");
      assert.strictEqual(options.platform, "mac");
      assert.strictEqual(options.target, "zip");
      // The home goes in as the build's input; no other home or development origin does, and
      // the build compiles this checkout rather than package what an earlier one left.
      assert.deepStrictEqual(build?.env, {
        PATH: "/usr/bin",
        T3CODE_UX_PREVIEW_HOME: `${evidence}/desktop-home`,
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_SINGLE_ORIGIN_DEV: "1",
        T3CODE_DESKTOP_SKIP_BUILD: "false",
        T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "false",
      });
      assert.deepStrictEqual(manifest, {
        version: "0.0.45-dev.20261102.1",
        commit,
        home: `${evidence}/desktop-home`,
        arch: "arm64",
        appId: "com.foredeck.ux.preview",
        productName: "Foredeck",
        protocol: "foredeck-ux-preview",
        artifact: {
          file: `foredeck-t3-${version}-arm64.zip`,
          sha256: NodeCrypto.createHash("sha256").update("zip").digest("hex"),
        },
      });
      assert.include(
        yield* fileSystem.readFileString(`${evidence}/ux-preview-build/${version}/manifest.json`),
        `"home":"${evidence}/desktop-home"`,
      );

      // The same build again, or one from a dirty checkout, builds nothing.
      const again = yield* Effect.flip(
        buildUxPreview({
          repoRoot: "/repo",
          evidenceDir: evidence,
          userHome,
          env: {},
          baseVersion: "0.0.45",
          date: noon,
          run: 1,
          arch: "arm64",
        }).pipe(Effect.provide(processes([]))),
      );
      assert.include(again.problems[0] ?? "", "was built already");
      const dirty: Array<Spawned> = [];
      const refused = yield* Effect.flip(
        buildUxPreview({
          repoRoot: "/repo",
          evidenceDir: evidence,
          userHome,
          env: {},
          baseVersion: "0.0.45",
          date: noon,
          run: 2,
          arch: "arm64",
        }).pipe(
          Effect.provide(
            processes(dirty, (command) =>
              command.args[0] === "status" ? { stdout: " M apps/web/src/main.tsx\n" } : {},
            ),
          ),
        ),
      );
      assert.deepStrictEqual(refused.problems, ["the checkout has uncommitted changes"]);
      assert.isFalse(dirty.some(({ args }) => args[0] === "scripts/build-desktop-artifact.ts"));
    }).pipe(Effect.scoped),
  );

  it.effect("bakes no development origin into the web build, whatever the env files say", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoRoot = yield* scratch;
      yield* fileSystem.writeFileString(
        `${repoRoot}/.env`,
        "VITE_HTTP_URL=http://127.0.0.1:3773\nVITE_WS_URL=ws://127.0.0.1:3773\n",
      );
      yield* fileSystem.writeFileString(
        `${repoRoot}/.env.local`,
        "VITE_WS_URL=ws://localhost:4000\nT3CODE_SINGLE_ORIGIN_DEV=0\n",
      );
      const inherited = { PATH: "/usr/bin", VITE_HTTP_URL: "http://localhost:3773" };

      // Without the build's own environment the files' origins would be baked in.
      assert.deepStrictEqual(
        resolveWebBuildOrigins(loadRepoEnv({ baseEnv: inherited, repoRoot })),
        {
          httpUrl: "http://localhost:3773",
          wsUrl: "ws://localhost:4000",
        },
      );

      const loaded = loadRepoEnv({ baseEnv: uxPreviewBuildEnv(inherited, home), repoRoot });
      // The files bring the origins back underneath the build's environment, as the web build
      // loads them, and still none is baked.
      assert.strictEqual(loaded.VITE_HTTP_URL, "http://127.0.0.1:3773");
      assert.strictEqual(loaded.VITE_WS_URL, "ws://localhost:4000");
      assert.deepStrictEqual(resolveWebBuildOrigins(loaded), {
        httpUrl: undefined,
        wsUrl: undefined,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("installs only the recorded build, never over another app, then checks it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* scratch;
      const evidence = `${root}/evidence`;
      const manifest = yield* recordBuild(evidence, "zip");
      const built = `${root}/built/Foredeck.app`;
      yield* writeApp(built, identity({ home: manifest.home }));
      const appPath = `${root}/Applications/Foredeck.app`;
      const spawned: Array<Spawned> = [];
      const extractedTo: Array<string> = [];
      const ditto = processes(spawned, ({ command, args }) => {
        if (command !== "ditto") return { exitCode: 1 };
        if (args[0] === "-x") {
          extractedTo.push(`${args[3]}/Foredeck.app`);
          NodeFS.cpSync(built, `${args[3]}/Foredeck.app`, { recursive: true });
        } else NodeFS.cpSync(args[0]!, args[1]!, { recursive: true });
        return {};
      });

      // Something else at the install path, the everyday app or the assistant preview included,
      // stays where it is.
      for (const bundleId of [
        "com.example.other",
        "com.t3tools.t3code",
        "com.foredeck.assistant.preview",
      ]) {
        yield* writeApp(appPath, identity({ bundleId, home: manifest.home }));
        const blocked = yield* Effect.flip(
          installUxPreview({ evidenceDir: evidence, appPath }).pipe(Effect.provide(ditto)),
        );
        assert.deepStrictEqual(blocked.problems, [`${appPath} holds another app; move it first`]);
        const kept = Plist.parse(
          yield* fileSystem.readFileString(`${appPath}/Contents/Info.plist`),
        ) as Record<string, unknown>;
        assert.strictEqual(kept.CFBundleIdentifier, bundleId);
        yield* fileSystem.remove(appPath, { recursive: true });
      }

      const installed = yield* installUxPreview({ evidenceDir: evidence, appPath }).pipe(
        Effect.provide(ditto),
      );
      assert.deepStrictEqual(installed.observed, identity({ home: manifest.home }));
      assert.strictEqual(installed.observed.productName, "Foredeck");
      assert.strictEqual(installed.observed.version, "0.0.45-dev.20261102.1");
      assert.isTrue(extractedTo.length > 0);
      assert.isTrue(extractedTo.every((app) => app.endsWith("/extracted/Foredeck.app")));

      // A prior development build at the path is replaced.
      yield* fileSystem.remove(appPath, { recursive: true });
      yield* writeApp(
        appPath,
        identity({ version: "0.0.44-dev.20261101.1", commit: "0123456789ab", home: manifest.home }),
      );
      const replaced = yield* installUxPreview({ evidenceDir: evidence, appPath }).pipe(
        Effect.provide(ditto),
      );
      assert.deepStrictEqual(replaced.observed, identity({ home: manifest.home }));
      assert.isFalse(
        spawned.some(({ args }) => args.some((arg) => arg.startsWith(ACCEPTED_PREVIEW_APP_PATH))),
      );

      // An archive that is not the recorded one is never extracted.
      yield* fileSystem.writeFileString(
        `${evidence}/ux-preview-build/${version}/${manifest.artifact.file}`,
        "another zip",
      );
      const swapped: Array<Spawned> = [];
      const refused = yield* Effect.flip(
        installUxPreview({ evidenceDir: evidence, appPath }).pipe(
          Effect.provide(processes(swapped)),
        ),
      );
      assert.deepStrictEqual(refused.problems, ["the build's archive is not the one recorded"]);
      assert.deepStrictEqual(swapped, []);
    }).pipe(Effect.scoped),
  );

  it.effect("checks an installed app against the recorded build", () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const evidence = `${root}/evidence`;
      const manifest = yield* recordBuild(evidence, "zip");
      const appPath = `${root}/${UX_PREVIEW_PRODUCT_NAME}.app`;
      yield* writeApp(appPath, identity({ home: manifest.home }));
      assert.deepStrictEqual(
        (yield* checkUxPreview({ evidenceDir: evidence, appPath })).observed,
        identity({ home: manifest.home }),
      );
      // An app installed under the earlier product name is not the recorded build.
      const stale = `${root}/stale/Foredeck.app`;
      yield* writeApp(
        stale,
        identity({
          home: manifest.home,
          productName: "Foredeck UX Preview",
          commit: "0123456789ab",
          updateFeed: true,
        }),
      );
      const refused = yield* Effect.flip(checkUxPreview({ evidenceDir: evidence, appPath: stale }));
      assert.deepStrictEqual(refused.problems, [
        "product name is Foredeck UX Preview, not Foredeck",
        `commit is 0123456789ab, not ${commit}`,
        "it carries an update feed",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("launches the checked app on its home, and nothing it has not checked", () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const evidence = `${root}/evidence`;
      const manifest = yield* recordBuild(evidence, "zip");
      const appPath = `${root}/${UX_PREVIEW_PRODUCT_NAME}.app`;
      const launched: Array<{ readonly executable: string; readonly env: object }> = [];
      const env = { PATH: "/usr/bin", VITE_DEV_SERVER_URL: "http://localhost:5173" };

      const missing = yield* Effect.flip(
        launchUxPreview({ evidenceDir: evidence, userHome, env, appPath }).pipe(
          Effect.provide(launcher(launched)),
        ),
      );
      assert.strictEqual(missing.step, "check");
      assert.deepStrictEqual(launched, []);

      yield* writeApp(appPath, identity({ home: manifest.home }));
      const plan = yield* launchUxPreview({ evidenceDir: evidence, userHome, env, appPath }).pipe(
        Effect.provide(launcher(launched)),
      );
      assert.deepStrictEqual(launched, [
        {
          executable: `${appPath}/Contents/MacOS/Foredeck`,
          env: { PATH: "/usr/bin", T3CODE_HOME: manifest.home },
        },
      ]);
      assert.deepStrictEqual(plan._tag === "Launch" ? plan.cleared : [], ["VITE_DEV_SERVER_URL"]);
    }).pipe(Effect.scoped),
  );
});
