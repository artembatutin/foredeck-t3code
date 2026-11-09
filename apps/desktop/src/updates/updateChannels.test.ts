import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("keeps UX previews off the nightly label and, packaged without a feed, on latest", () => {
    expect(isNightlyDesktopVersion("0.0.45-uxpreview.20261102.1")).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.45-uxpreview.20261102.1")).toBe("latest");
    expect(isNightlyDesktopVersion("0.0.45-dev.20261103.1")).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.45-dev.20261103.1")).toBe("latest");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
