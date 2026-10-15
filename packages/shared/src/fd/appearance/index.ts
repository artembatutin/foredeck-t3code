import type { ThemeColors, ThemeDefinition } from "../../themePalettes.js";
import { FOREDECK_TOKENS } from "./tokens.ts";

export { FOREDECK_TOKENS } from "./tokens.ts";

export const FOREDECK_THEME_ID = "__fd-foredeck";

/** Opaque theme roles also feed native surfaces and the existing theme editor. */
function mix(foreground: string, background: string, amount: number) {
  const channel = (color: string, offset: number) =>
    Number.parseInt(color.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(channel(foreground, offset) * amount + channel(background, offset) * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function desktopColors(appearance: "light" | "dark"): ThemeColors {
  const c = FOREDECK_TOKENS.desktop.color[appearance];
  return {
    canvas: c.bg,
    chrome: c["bg-raised"],
    toolbar: mix(c["bg-raised"], c.bg, 0.72),
    toolbarForeground: c.text,
    toolbarBorder: c.border,
    toolbarControl: c["bg-raised"],
    toolbarControlForeground: c.text,
    toolbarControlHover: c["bg-hover"],
    surface: c["bg-raised"],
    surfaceRaised: c["bg-raised"],
    surfaceOverlay: c["bg-raised"],
    text: c.text,
    textMuted: c["text-muted"],
    border: c.border,
    input: c["border-strong"],
    focus: c.accent,
    accent: c.accent,
    accentForeground: c["text-on-accent"],
    secondary: c["bg-hover"],
    secondaryForeground: c.text,
    muted: c["bg-sunken"],
    mutedForeground: c["text-muted"],
    placeholder: c["text-faint"],
    secondaryLabel: c["text-faint"],
    iconMuted: c["text-muted"],
    error: c.danger,
    errorForeground: c["danger-bright"],
    errorSurface: mix(c.danger, c.bg, 0.1),
    warning: c.warning,
    warningForeground: c.warning,
    warningSurface: mix(c.warning, c.bg, 0.1),
    update: c.accent,
    updateForeground: c.accent,
    updateSurface: c["bg-hover"],
    accentSurface: c["bg-hover"],
    accentSurfaceForeground: c.text,
    messageSurface: c["bg-raised"],
    messageForeground: c.text,
    messageAction: c["accent-dim"],
    messageActionForeground: c["text-on-accent"],
    messageActionHover: c["accent-hover"],
    codeBackground: c["bg-sunken"],
    codeForeground: c.text,
    searchMatchBackground: mix(c.warning, c.bg, 0.18),
    searchMatchForeground: c.text,
    searchMatchActiveBackground: mix(c.warning, c.bg, 0.4),
    searchMatchActiveForeground: c.text,
    sidebar: c["bg-raised"],
    sidebarForeground: c.text,
    sidebarMutedForeground: c["text-muted"],
    sidebarControlSurface: c.bg,
    sidebarRowHover: c["bg-hover"],
    sidebarRowActive: c["bg-selected"],
    sidebarRowSelected: c["bg-selected"],
    sidebarBorder: c.border,
    terminalBackground: c["bg-sunken"],
    terminalForeground: c.text,
    terminalCursor: c.accent,
    terminalSelection: c["bg-selected"],
    terminalScrollbar: c["border-strong"],
    terminalScrollbarHover: c["text-muted"],
  };
}

function mobileColors(appearance: "light" | "dark"): ThemeColors {
  const c = FOREDECK_TOKENS.mobile.color[appearance];
  const overlay = appearance === "dark" ? "#ffffff" : "#000000";
  const hover = mix(overlay, c.bg, appearance === "dark" ? 0.12 : 0.08);
  const fill = mix(overlay, c.bg, appearance === "dark" ? 0.08 : 0.06);
  return {
    canvas: c.bg,
    chrome: c.bg,
    toolbar: c.surface,
    toolbarForeground: c.text,
    toolbarBorder: c.border,
    toolbarControl: c.surface,
    toolbarControlForeground: c.text,
    toolbarControlHover: hover,
    surface: c.surface,
    surfaceRaised: c.sunken,
    surfaceOverlay: c.surface,
    text: c.text,
    textMuted: c.muted,
    border: c.border,
    input: c.borderStrong,
    focus: c.accent,
    accent: c.accent,
    accentForeground: c.onAccent,
    secondary: fill,
    secondaryForeground: c.text,
    muted: c.sunken,
    mutedForeground: c.muted,
    placeholder: c.faint,
    secondaryLabel: c.faint,
    iconMuted: c.muted,
    error: c.danger,
    errorForeground: c.status.failed.fg,
    errorSurface: c.status.failed.bg,
    warning: c.status.needsYou.dot,
    warningForeground: c.status.needsYou.fg,
    warningSurface: c.status.needsYou.bg,
    update: c.accent,
    updateForeground: c.text,
    updateSurface: fill,
    accentSurface: fill,
    accentSurfaceForeground: c.text,
    messageSurface: c.surface,
    messageForeground: c.text,
    messageAction: c.accent,
    messageActionForeground: c.onAccent,
    messageActionHover: c.accent,
    codeBackground: c.sunken,
    codeForeground: c.text,
    searchMatchBackground: c.status.needsYou.bg,
    searchMatchForeground: c.status.needsYou.fg,
    searchMatchActiveBackground: c.status.needsYou.dot,
    searchMatchActiveForeground: appearance === "dark" ? c.bg : c.text,
    sidebar: c.bg,
    sidebarForeground: c.text,
    sidebarMutedForeground: c.muted,
    sidebarControlSurface: c.surface,
    sidebarRowHover: hover,
    sidebarRowActive: mix(overlay, c.bg, appearance === "dark" ? 0.18 : 0.12),
    sidebarRowSelected: mix(overlay, c.bg, appearance === "dark" ? 0.18 : 0.12),
    sidebarBorder: c.border,
    terminalBackground: c.bg,
    terminalForeground: c.text,
    terminalCursor: c.accent,
    terminalSelection: hover,
    terminalScrollbar: c.borderStrong,
    terminalScrollbarHover: c.muted,
  };
}

export const FOREDECK_DESKTOP_LIGHT_THEME_COLORS = desktopColors("light");
export const FOREDECK_DESKTOP_DARK_THEME_COLORS = desktopColors("dark");
export const FOREDECK_MOBILE_LIGHT_THEME_COLORS = mobileColors("light");
export const FOREDECK_MOBILE_DARK_THEME_COLORS = mobileColors("dark");

export const FOREDECK_THEME: ThemeDefinition = {
  id: FOREDECK_THEME_ID,
  label: "Foredeck",
  appearance: "light",
  colors: FOREDECK_DESKTOP_LIGHT_THEME_COLORS,
  variants: { dark: FOREDECK_DESKTOP_DARK_THEME_COLORS },
};
