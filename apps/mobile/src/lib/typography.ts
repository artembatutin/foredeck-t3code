import { FOREDECK_MOBILE_TYPOGRAPHY } from "../fd/appearance/index.ts";

export const MOBILE_TYPOGRAPHY = FOREDECK_MOBILE_TYPOGRAPHY;

export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const;

/** Class names share the same scaled CSS variables as native text roles. */
export const MOBILE_TEXT_CLASSES = {
  micro: "text-3xs",
  caption: "text-2xs",
  label: "text-xs",
  footnote: "text-sm",
  body: "text-base",
  headline: "text-lg",
  title: "text-xl",
  largeTitle: "text-2xl",
  display: "text-3xl",
} as const satisfies Record<keyof typeof MOBILE_TYPOGRAPHY, string>;
