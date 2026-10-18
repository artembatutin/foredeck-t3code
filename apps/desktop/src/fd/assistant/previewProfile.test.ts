import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { previewProfilePath } from "./index.ts";

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
