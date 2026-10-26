import { describe, expect, it } from "vite-plus/test";

import { factoryOpenPaletteAction } from "./palette";

describe("factoryOpenPaletteAction", () => {
  it("offers nothing while no environment advertises Factory", () => {
    expect(factoryOpenPaletteAction({ supported: false, open: async () => {} })).toEqual([]);
  });

  it("opens the Factory view where some environment advertises Factory", async () => {
    let opened = 0;
    const actions = factoryOpenPaletteAction({
      supported: true,
      open: async () => {
        opened += 1;
      },
    });
    expect(actions.map((action) => action.title)).toEqual(["Open Factory"]);
    await actions[0]!.run();
    expect(opened).toBe(1);
  });
});
