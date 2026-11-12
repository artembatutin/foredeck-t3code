import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/foredeck-t3.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/foredeck-t3.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it("uses foredeck-t3 for visible branding while retaining the release stage", () => {
    assert.deepEqual(
      DesktopEnvironment.resolveDesktopAppBranding({ isDevelopment: true, appVersion: "0.0.45" }),
      { baseName: "foredeck-t3", stageLabel: "Dev", displayName: "foredeck-t3 (Dev)" },
    );
    assert.deepEqual(
      DesktopEnvironment.resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.0.45-nightly.20261015.1",
      }),
      { baseName: "foredeck-t3", stageLabel: "Nightly", displayName: "foredeck-t3 (Nightly)" },
    );
  });

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});

it.effect("installed assistant previews default to an isolated home without a launch wrapper", () =>
  Effect.gen(function* () {
    const preview = yield* makeEnvironment({
      isPackaged: true,
      appVersion: "0.0.45-preview.20261017.2",
    });
    assert.equal(preview.baseDir, "/Users/alice/.foredeck-assistant-preview");
    assert.equal(preview.stateDir, "/Users/alice/.foredeck-assistant-preview/userdata");
    const explicit = yield* makeEnvironment(
      { isPackaged: true, appVersion: "0.0.45-preview.20261017.2" },
      { T3CODE_HOME: "/isolated/custom" },
    );
    assert.equal(explicit.baseDir, "/isolated/custom");
    const ordinary = yield* makeEnvironment({ isPackaged: true });
    assert.equal(ordinary.baseDir, "/Users/alice/.t3");
  }),
);

describe.each([
  { kind: "a development build", appVersion: "0.0.45-dev.20261103.1" },
  { kind: "an earlier UX preview build", appVersion: "0.0.45-uxpreview.20261102.1" },
])("an installed UX preview, as $kind", ({ appVersion }) => {
  const uxPreview = {
    isPackaged: true,
    appVersion,
    uxPreviewHome: "/evidence/desktop-home",
  } satisfies Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
  const refusal = (
    overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>,
    env: Record<string, string | undefined> = {},
  ) =>
    makeEnvironment({ ...uxPreview, ...overrides }, env).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.isTrue(DesktopEnvironment.isDesktopUxPreviewHomeRefusedError(error));
        return error as DesktopEnvironment.DesktopUxPreviewHomeRefusedError;
      }),
    );

  it.effect("runs on the home its build names, with no wrapper, named Foredeck", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(uxPreview);
      assert.equal(environment.baseDir, "/evidence/desktop-home");
      assert.equal(environment.stateDir, "/evidence/desktop-home/userdata");
      assert.equal(environment.serverSettingsPath, "/evidence/desktop-home/userdata/settings.json");
      assert.equal(environment.isDevelopment, false);
      assert.deepEqual(environment.branding, {
        baseName: "Foredeck",
        stageLabel: "Alpha",
        displayName: "Foredeck",
      });
      assert.equal(environment.displayName, "Foredeck");
      // The same home inherited exactly is no conflict.
      const inherited = yield* makeEnvironment(uxPreview, {
        T3CODE_HOME: "/evidence/desktop-home",
      });
      assert.equal(inherited.baseDir, "/evidence/desktop-home");
    }),
  );

  it.effect.each([
    { name: "the live home", home: "/Users/alice/.t3" },
    { name: "the assistant preview's home", home: "/Users/alice/.foredeck-assistant-preview" },
    { name: "another isolated home", home: "/evidence/desktop-home-old" },
  ])("refuses an inherited T3CODE_HOME naming $name before any state path exists", ({ home }) =>
    Effect.gen(function* () {
      const error = yield* refusal({}, { T3CODE_HOME: home });
      assert.equal(error.reason, "conflicting-home");
      assert.equal(error.home, "/evidence/desktop-home");
      assert.include(error.message, "runs only on /evidence/desktop-home");
      // Named by what it is, never by what the inherited value says.
      assert.notInclude(error.message, home);
    }),
  );

  it.effect("refuses a development origin, and a build that names no home of its own", () =>
    Effect.gen(function* () {
      const development = yield* refusal({}, { VITE_DEV_SERVER_URL: "http://localhost:5173" });
      assert.equal(development.reason, "development-origin");
      for (const uxPreviewHome of [undefined, "", "relative/home"]) {
        const missing = yield* refusal({ uxPreviewHome });
        assert.equal(missing.reason, "missing-home");
        assert.isNull(missing.home);
      }
    }),
  );

  it.effect("leaves assistant previews, ordinary installs and unpackaged runs as they were", () =>
    Effect.gen(function* () {
      const assistant = yield* makeEnvironment({
        isPackaged: true,
        appVersion: "0.0.45-preview.20261017.2",
        uxPreviewHome: "/evidence/desktop-home",
      });
      assert.equal(assistant.baseDir, "/Users/alice/.foredeck-assistant-preview");
      assert.equal(assistant.branding.stageLabel, "Nightly");
      const ordinary = yield* makeEnvironment(
        { isPackaged: true, uxPreviewHome: "/evidence/desktop-home" },
        { T3CODE_HOME: "/Users/alice/.t3" },
      );
      assert.equal(ordinary.baseDir, "/Users/alice/.t3");
      const unpackaged = yield* makeEnvironment({ appVersion }, { T3CODE_HOME: "/tmp/t3" });
      assert.equal(unpackaged.baseDir, "/tmp/t3");
    }),
  );
});
