import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("fd branding", () => {
  it("uses foredeck-t3 without desktop-injected branding", async () => {
    Reflect.deleteProperty(globalThis, "window");
    const branding = await import("../../branding");
    expect(branding.APP_BASE_NAME).toBe("foredeck-t3");
  });
});
