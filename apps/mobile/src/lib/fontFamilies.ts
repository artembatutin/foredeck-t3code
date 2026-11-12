import { Platform } from "react-native";
import { getForedeckSystemFontFamily } from "../fd/appearance/index.ts";

// Native editor and markdown APIs use platform system families instead of a bundled display font.
export const FONT_FAMILIES = {
  regular: getForedeckSystemFontFamily("regular", Platform.OS),
  medium: getForedeckSystemFontFamily("medium", Platform.OS),
  bold: getForedeckSystemFontFamily("bold", Platform.OS),
} as const;
