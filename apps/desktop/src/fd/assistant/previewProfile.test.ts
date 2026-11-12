import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isNightlyDesktopVersion } from "../../updates/updateChannels.ts";
import { previewProfilePath, readUxPreviewBuildHome, resolveUxPreviewHome } from "./index.ts";

describe("installed preview isolation", () => {
  const input = {
    isPackaged: true,
    appVersion: "0.0.45-preview.20261017.1",
    stateDir: "/preview/userdata",
  };

  it.effect("separates the browser profile for each preview home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(previewProfilePath({ ...input, path })).toBe("/preview/userdata/desktop-profile");
      expect(previewProfilePath({ ...input, path, stateDir: "/another/userdata" })).toBe(
        "/another/userdata/desktop-profile",
      );
      for (const appVersion of ["0.0.45-dev.20261103.1", "0.0.45-uxpreview.20261102.1"]) {
        expect(previewProfilePath({ ...input, path, appVersion })).toBe(
          "/preview/userdata/desktop-profile",
        );
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("preserves normal installs and development profiles", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(previewProfilePath({ ...input, path, appVersion: "0.0.45" })).toBeNull();
      expect(previewProfilePath({ ...input, path, isPackaged: false })).toBeNull();
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe.each([
  { kind: "a development build", appVersion: "0.0.45-dev.20261103.1" },
  { kind: "an earlier UX preview build", appVersion: "0.0.45-uxpreview.20261102.1" },
])("a UX preview's own home, as $kind", ({ appVersion }) => {
  const packaged = { isPackaged: true, appVersion };

  it.effect("is read from the build's package metadata, and only for a packaged UX preview", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-ux-preview-app-" });
      yield* fileSystem.writeFileString(
        path.join(appPath, "package.json"),
        JSON.stringify({ t3codeUxPreviewHome: "/evidence/desktop-home" }),
      );
      expect(readUxPreviewBuildHome({ ...packaged, appPath, path })).toBe("/evidence/desktop-home");
      expect(
        readUxPreviewBuildHome({
          ...packaged,
          appVersion: "0.0.45-preview.20261017.1",
          appPath,
          path,
        }),
      ).toBeUndefined();
      expect(
        readUxPreviewBuildHome({ ...packaged, appVersion: "0.0.45", appPath, path }),
      ).toBeUndefined();
      expect(
        readUxPreviewBuildHome({ ...packaged, isPackaged: false, appPath, path }),
      ).toBeUndefined();
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-ux-preview-app-" });
      expect(readUxPreviewBuildHome({ ...packaged, appPath: empty, path })).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("compares strings only, refusing any other inherited home", () => {
    const decide = (inheritedHome: string | undefined, developmentOrigin = false) =>
      resolveUxPreviewHome({
        ...packaged,
        buildHome: "/evidence/desktop-home",
        inheritedHome,
        developmentOrigin,
      });
    expect(decide(undefined)).toEqual({ _tag: "Home", home: "/evidence/desktop-home" });
    expect(decide(" /evidence/desktop-home ")).toEqual({
      _tag: "Home",
      home: "/evidence/desktop-home",
    });
    expect(decide("/Users/alice/.t3")).toMatchObject({ reason: "conflicting-home" });
    expect(decide("/evidence/desktop-home/")).toMatchObject({ reason: "conflicting-home" });
    expect(decide(undefined, true)).toMatchObject({ reason: "development-origin" });
    expect(
      resolveUxPreviewHome({
        ...packaged,
        appVersion: "0.0.45",
        buildHome: undefined,
        inheritedHome: "/Users/alice/.t3",
        developmentOrigin: false,
      }),
    ).toEqual({ _tag: "Ordinary" });
    expect(
      resolveUxPreviewHome({
        ...packaged,
        appVersion: "0.0.45-preview.20261017.2",
        buildHome: "/evidence/desktop-home",
        inheritedHome: "/Users/alice/.t3",
        developmentOrigin: false,
      }),
    ).toEqual({ _tag: "Ordinary" });
  });
});

it("keeps UX preview and development builds off the nightly label", () => {
  expect(isNightlyDesktopVersion("0.0.45-uxpreview.20261102.1")).toBe(false);
  expect(isNightlyDesktopVersion("0.0.45-dev.20261103.1")).toBe(false);
});
