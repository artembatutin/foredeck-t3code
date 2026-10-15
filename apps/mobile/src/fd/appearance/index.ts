import {
  FOREDECK_THEME_ID,
  FOREDECK_TOKENS,
  FOREDECK_MOBILE_LIGHT_THEME_COLORS,
  FOREDECK_MOBILE_DARK_THEME_COLORS,
} from "@t3tools/shared/fd/appearance";
import { MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";

export { FOREDECK_THEME_ID };

/** The stock appearance owns Uniwind's light/dark variants; saved palettes keep named variants. */
export const MOBILE_REGISTERED_THEME_IDS = MOBILE_THEME_IDS.filter(
  (themeId) => themeId !== FOREDECK_THEME_ID,
);

export function getForedeckMobileThemeColors(appearance: "light" | "dark") {
  return appearance === "dark"
    ? FOREDECK_MOBILE_DARK_THEME_COLORS
    : FOREDECK_MOBILE_LIGHT_THEME_COLORS;
}

/** Existing working/input utilities keep their meaning with Foredeck's restrained tones. */
export function getForedeckAdaptiveVariables(appearance: "light" | "dark") {
  const c = FOREDECK_TOKENS.mobile.color[appearance];
  return {
    "--color-adaptive-sky-500-a12-a16": c.fill,
    "--color-adaptive-sky-500-a10-400-a10": c.fill,
    "--color-adaptive-sky-500-a25-400-a25": c.border,
    "--color-adaptive-sky-600-400": c.accent,
    "--color-adaptive-sky-700-300": c.text,
    "--color-adaptive-indigo-600-300": c.status.needsYou.fg,
  };
}

const type = FOREDECK_TOKENS.mobile.typography.style;
export const FOREDECK_MOBILE_TYPOGRAPHY = {
  micro: { fontSize: type.badge.fontSize, lineHeight: type.badge.lineHeight },
  caption: { fontSize: type.pillSmall.fontSize, lineHeight: type.pillSmall.lineHeight },
  label: { fontSize: type.meta.fontSize, lineHeight: type.meta.lineHeight },
  footnote: { fontSize: type.rowContext.fontSize, lineHeight: type.rowContext.lineHeight },
  body: { fontSize: type.markdownBody.fontSize, lineHeight: type.markdownBody.lineHeight },
  headline: { fontSize: type.heading.fontSize, lineHeight: type.heading.lineHeight },
  title: { fontSize: type.title.fontSize, lineHeight: type.title.lineHeight },
  largeTitle: {
    fontSize: type.markdownHeadings[0],
    lineHeight: Math.round(type.markdownHeadings[0] * 1.28),
  },
  display: { fontSize: type.tabRootTitle.fontSize, lineHeight: type.tabRootTitle.lineHeight },
} as const;

export function getForedeckSystemFontFamily(
  weight: "regular" | "medium" | "bold",
  platform: string,
) {
  return platform === "ios" ? "System" : weight === "medium" ? "sans-serif-medium" : "sans-serif";
}
