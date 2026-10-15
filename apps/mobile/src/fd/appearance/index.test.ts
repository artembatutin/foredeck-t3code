import { describe, expect, it } from "vite-plus/test";

import { renderUniwindThemesCSS } from "../../../scripts/generate-uniwind-themes.mts";
import { FOREDECK_THEME_ID } from "./index.ts";
import { getMobileThemeVariables, resolveMobileThemeIds } from "../../lib/mobileTheme";
import { getMobileThemeRuntimeVariables } from "../../lib/mobileThemeVariables";

describe("Foredeck mobile appearance", () => {
  it("starts unconfigured devices on Foredeck and keeps explicit saved palettes", () => {
    expect(resolveMobileThemeIds({})).toEqual({
      light: FOREDECK_THEME_ID,
      dark: FOREDECK_THEME_ID,
    });
    expect(resolveMobileThemeIds({ themeId: "t3-code" })).toEqual({
      light: "t3-code",
      dark: "t3-code",
    });
    expect(resolveMobileThemeIds({ lightThemeId: "ocean", darkThemeId: "iris" })).toEqual({
      light: "ocean",
      dark: "iris",
    });
  });

  it.each(["light", "dark"] as const)(
    "keeps %s native and generated surfaces in sync",
    (appearance) => {
      const variables = getMobileThemeVariables(FOREDECK_THEME_ID, appearance);
      expect(variables["--color-screen"]).toBe(appearance === "light" ? "#f2f2f7" : "#000000");
      expect(variables["--color-primary"]).toBe(variables["--color-foreground"]);
      for (const platform of ["ios", "android"]) {
        expect(getMobileThemeRuntimeVariables(FOREDECK_THEME_ID, appearance, platform)).toEqual(
          variables,
        );
      }
      const css = renderUniwindThemesCSS();
      const current = new RegExp(`@variant ${appearance} \\{([^}]+)\\}`, "u").exec(css)![1]!;
      const legacy = new RegExp(`@variant t3-code-${appearance} \\{([^}]+)\\}`, "u").exec(css)![1]!;
      expect(current).toContain(
        `--color-adaptive-sky-600-400: ${variables["--color-foreground"]};`,
      );
      expect(current).toContain(
        `--color-adaptive-indigo-600-300: ${variables["--color-warning-foreground"]};`,
      );
      expect(legacy).not.toContain(
        `--color-adaptive-sky-600-400: ${variables["--color-foreground"]};`,
      );
    },
  );
});
