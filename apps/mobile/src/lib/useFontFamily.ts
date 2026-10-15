import { Platform } from "react-native";
import { getForedeckSystemFontFamily } from "../fd/appearance/index.ts";

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 */
export function useFontFamily(weight: "regular" | "medium" | "bold"): string {
  return getForedeckSystemFontFamily(weight, Platform.OS);
}
