import { describe, expect, it } from "vite-plus/test";
import { buildConnectingSplashDataUrl, getInitialWindowBackgroundColor } from "./index.ts";

describe("Foredeck desktop startup appearance", () => {
  it.each([
    [false, "#f7f7f8", "#202024"],
    [true, "#161618", "#f4f4f6"],
  ] as const)("matches the %s window and splash appearance", (dark, background, accent) => {
    const url = buildConnectingSplashDataUrl(dark);
    const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    expect(getInitialWindowBackgroundColor(dark)).toBe(background);
    expect(html).toContain(`background:${background}`);
    expect(html).toContain(`border-top-color:${accent}`);
    expect(html).toContain('role="status">Connecting to WSL…');
    expect(html).toContain("prefers-reduced-motion:reduce");
  });
});
