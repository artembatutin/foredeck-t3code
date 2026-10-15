import { resolveTextScaleVariables } from "./appearancePreferences";
import { MOBILE_REGISTERED_THEME_IDS } from "../fd/appearance/index.ts";
import {
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

export type MobileUniwindThemeName =
  | MobileThemeAppearance
  | `${(typeof MOBILE_REGISTERED_THEME_IDS)[number]}-${MobileThemeAppearance}`;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | "dark" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...MOBILE_REGISTERED_THEME_IDS.flatMap((themeId) => [
    `${themeId}-light` as const,
    `${themeId}-dark` as const,
  ]),
];

export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID
    ? appearance
    : `${themeId === "material-you" ? "t3-code" : themeId}-${appearance}`;
}

/**
 * Plans imperative runtime work separately from theme selection. Palette
 * changes are handled by one root ScopedTheme render; only typography and the
 * native appearance override need imperative Uniwind/React Native updates.
 */
export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
