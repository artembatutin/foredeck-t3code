import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyThemeColorPreview,
  applyThemePalette,
  getThemeDefinition,
  getThemeColorsForMode,
  getStandardThemeColors,
  invalidateCustomThemes,
  resolveDesktopTheme,
  resolveThemeAppearance,
  themeAllowsSidebarArtwork,
  themeColorToHex,
} from "../../themePalette";
import { FOREDECK_THEME, FOREDECK_THEME_ID, FOREDECK_TOKENS } from "@t3tools/shared/fd/appearance";
import { applyForedeckThemeVariables } from ".";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  invalidateCustomThemes();
});

describe("Foredeck appearance", () => {
  it.each([false, true])(
    "defaults to Foredeck with the OS appearance (dark: %s)",
    async (systemDark) => {
      const getItem = vi.fn(() => null);
      const setItem = vi.fn();
      vi.stubGlobal("window", {
        localStorage: { getItem, setItem },
        matchMedia: () => ({ matches: systemDark }),
      });
      const { readThemePreference, readAppearanceModePreference } =
        await import("../../hooks/useTheme");
      const theme = readThemePreference();
      const appearanceMode = readAppearanceModePreference(theme);

      expect(theme).toBe(FOREDECK_THEME_ID);
      expect(appearanceMode).toBe("system");
      expect(resolveThemeAppearance(theme, systemDark, true, appearanceMode)).toBe(
        systemDark ? "dark" : "light",
      );
      expect(resolveDesktopTheme(theme, true, appearanceMode)).toBe("system");
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it.each(["light", "dark", "system", "t3-chat", "grove", FOREDECK_THEME_ID])(
    "keeps an explicitly saved %s theme",
    async (preference) => {
      vi.stubGlobal("window", {
        localStorage: { getItem: (key: string) => (key === "t3code:theme" ? preference : null) },
      });
      const { readThemePreference } = await import("../../hooks/useTheme");
      expect(readThemePreference()).toBe(preference);
    },
  );

  it("preserves a custom theme named foredeck on the existing preference keys", async () => {
    const storage: Record<string, string> = {
      "t3code:theme": "foredeck",
      "t3code:theme-appearance-mode": "dark",
      "t3code:themes:v1": JSON.stringify([
        {
          id: "foredeck",
          label: "Personal",
          appearance: "dark",
          colors: { canvas: "#123456", accent: "#abcdef" },
        },
      ]),
    };
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => storage[key] ?? null },
    });
    const { readThemePreference, readAppearanceModePreference } =
      await import("../../hooks/useTheme");
    const { getThemeDefinition: storedThemeDefinition } = await import("../../themePalette");
    expect(readThemePreference()).toBe("foredeck");
    expect(readAppearanceModePreference("foredeck")).toBe("dark");
    expect(themeColorToHex(storedThemeDefinition("foredeck")!.colors.canvas)).toBe("#123456");
  });

  it("maps both Foredeck variants while leaving standard light and dark palettes available", () => {
    expect(getThemeDefinition(FOREDECK_THEME_ID)).toBe(FOREDECK_THEME);
    expect(themeAllowsSidebarArtwork(FOREDECK_THEME_ID)).toBe(false);
    for (const appearance of ["light", "dark"] as const) {
      const colors = getThemeColorsForMode(FOREDECK_THEME, appearance)!;
      const source = FOREDECK_TOKENS.desktop.color[appearance];
      expect(colors.canvas).toBe(source.bg);
      expect(colors.sidebar).toBe(source["bg-raised"]);
      expect(colors.sidebarRowSelected).toBe(source["bg-selected"]);
      expect(colors.accent).toBe(source.accent);
      expect(colors.canvas).not.toBe(getStandardThemeColors(appearance).canvas);
    }
  });

  it("clears Foredeck-only roles when switching to a saved palette or preview", () => {
    const variables = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      classList: { toggle: vi.fn() },
      style: {
        setProperty: (name: string, value: string) => variables.set(name, value),
        removeProperty: (name: string) => variables.delete(name),
      },
    };
    vi.stubGlobal("document", { documentElement: root });
    applyThemePalette(FOREDECK_THEME_ID, "dark");
    expect(root.dataset.themeId).toBe(FOREDECK_THEME_ID);
    expect(variables.get("--app-theme-accent")).toBe(FOREDECK_THEME.variants!.dark!.accent);
    expect(variables.get("--success")).toBe(FOREDECK_TOKENS.desktop.color.dark.success);
    expect(variables.get("--info")).toBe(FOREDECK_TOKENS.desktop.color.dark.accent);
    expect(variables.get("--fd-destructive-fill-foreground")).toBe(
      FOREDECK_TOKENS.desktop.color.dark["text-on-accent"],
    );
    expect(variables.get("--fd-brand-period")).toBe(
      FOREDECK_TOKENS.desktop.color.dark["accent-alt"],
    );

    applyThemePalette("grove", "dark");
    expect(variables.has("--success")).toBe(false);
    expect(variables.has("--fd-scrim")).toBe(false);
    expect(variables.has("--fd-brand-period")).toBe(false);
    applyForedeckThemeVariables(FOREDECK_THEME_ID, "light");
    applyThemeColorPreview(FOREDECK_THEME.colors, "light");
    expect(variables.has("--success")).toBe(false);
    expect(variables.has("--fd-scrim")).toBe(false);
  });
});
