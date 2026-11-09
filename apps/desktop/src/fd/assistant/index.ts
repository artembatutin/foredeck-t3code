// @effect-diagnostics nodeBuiltinImport:off - The build's own metadata is read once, synchronously, before the desktop runtime exists.
import * as NodeFS from "node:fs";
import {
  isAssistantPreviewVersion,
  isUxPreviewVersion,
  UX_PREVIEW_HOME_METADATA_KEY,
} from "@t3tools/shared/fd/assistant";
import type * as Path from "effect/Path";

/** Installed previews keep Chromium locks and sessions alongside their isolated server state. */
export function previewProfilePath(input: {
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly stateDir: string;
  readonly path: Pick<Path.Path, "join">;
}): string | null {
  return input.isPackaged &&
    (isAssistantPreviewVersion(input.appVersion) || isUxPreviewVersion(input.appVersion))
    ? input.path.join(input.stateDir, "desktop-profile")
    : null;
}

/**
 * The home a packaged UX preview was built for, from its own package metadata, so a Finder launch
 * needs no wrapper. `undefined` for every other build, and when the metadata names none.
 */
export function readUxPreviewBuildHome(input: {
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly appPath: string;
  readonly path: Pick<Path.Path, "join">;
}): string | undefined {
  if (!input.isPackaged || !isUxPreviewVersion(input.appVersion)) return undefined;
  try {
    const metadata: unknown = JSON.parse(
      NodeFS.readFileSync(input.path.join(input.appPath, "package.json"), "utf8"),
    );
    const home =
      typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>)[UX_PREVIEW_HOME_METADATA_KEY]
        : undefined;
    return typeof home === "string" ? home : undefined;
  } catch {
    return undefined;
  }
}

export type UxPreviewHomeDecision =
  | { readonly _tag: "Ordinary" }
  | { readonly _tag: "Home"; readonly home: string }
  | {
      readonly _tag: "Refused";
      readonly reason: "missing-home" | "conflicting-home" | "development-origin";
      readonly home: string | null;
    };

/**
 * Which home a desktop build runs on, decided from strings alone before anything reads state. A
 * packaged UX preview runs only on the absolute home baked into it: an inherited `T3CODE_HOME`
 * naming any other, or a development origin, refuses the launch rather than open another
 * install's database. Every other build is left as it was.
 */
export function resolveUxPreviewHome(input: {
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly buildHome: string | undefined;
  readonly inheritedHome: string | undefined;
  readonly developmentOrigin: boolean;
}): UxPreviewHomeDecision {
  if (!input.isPackaged || !isUxPreviewVersion(input.appVersion)) return { _tag: "Ordinary" };
  const home = input.buildHome?.trim() ?? "";
  if (!home.startsWith("/")) return { _tag: "Refused", reason: "missing-home", home: null };
  if (input.developmentOrigin) return { _tag: "Refused", reason: "development-origin", home };
  const inherited = input.inheritedHome?.trim();
  if (inherited !== undefined && inherited.length > 0 && inherited !== home) {
    return { _tag: "Refused", reason: "conflicting-home", home };
  }
  return { _tag: "Home", home };
}
