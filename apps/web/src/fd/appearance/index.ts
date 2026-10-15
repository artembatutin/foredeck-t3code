import { FOREDECK_THEME_ID, FOREDECK_TOKENS } from "@t3tools/shared/fd/appearance";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

export { FOREDECK_THEME, FOREDECK_THEME_ID } from "@t3tools/shared/fd/appearance";

/** A fresh Foredeck install follows the platform without writing a preference. */
export function themeFollowsSystemByDefault(theme: string): boolean {
  return theme === "system" || theme === FOREDECK_THEME_ID;
}

const FOREDECK_VARIABLES = [
  "--success",
  "--success-foreground",
  "--info",
  "--info-foreground",
  "--fd-diff-addition-foreground",
  "--fd-diff-deletion-foreground",
  "--fd-destructive-fill-foreground",
  "--fd-brand-period",
  "--fd-scrim",
  "--fd-shadow-color-md",
  "--fd-shadow-color-lg",
  "--fd-shadow-color-xl",
  "--fd-shadow-color-left",
] as const;

/** Additional platform roles absent from the upstream theme-file contract. */
export function applyForedeckThemeVariables(theme: string, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement?.style;
  if (!style) return;
  if (theme !== FOREDECK_THEME_ID) {
    for (const variable of FOREDECK_VARIABLES) style.removeProperty(variable);
    return;
  }

  const colors = FOREDECK_TOKENS.desktop.color[appearance];
  const values = [
    colors.success,
    colors.success,
    colors.accent,
    colors.accent,
    colors["success-bright"],
    colors["danger-bright"],
    colors["text-on-accent"],
    colors["accent-alt"],
    colors.scrim,
    colors["shadow-color-md"],
    colors["shadow-color-lg"],
    colors["shadow-color-xl"],
    colors["shadow-color-left"],
  ];
  for (const [index, variable] of FOREDECK_VARIABLES.entries()) {
    style.setProperty(variable, values[index]!);
  }
}
