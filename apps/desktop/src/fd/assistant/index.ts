import type * as Path from "effect/Path";

/** Installed previews keep Chromium locks and sessions alongside their isolated server state. */
export function previewProfilePath(input: {
  readonly isPackaged: boolean;
  readonly appVersion: string;
  readonly stateDir: string;
  readonly path: Pick<Path.Path, "join">;
}): string | null {
  return input.isPackaged && /-preview\.\d{8}\.\d+$/.test(input.appVersion)
    ? input.path.join(input.stateDir, "desktop-profile")
    : null;
}
