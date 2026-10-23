import { describe, expect, it } from "vite-plus/test";

import { validateWorkSearch } from "./WorkRouteView";

describe("validateWorkSearch", () => {
  it("keeps known values and drops everything else", () => {
    expect(
      validateWorkSearch({
        project: "env:project",
        source: "s1",
        view: "done",
        q: "sync",
        item: "s1:fd-7k3qa2",
        extra: "ignored",
      }),
    ).toEqual({
      project: "env:project",
      source: "s1",
      view: "done",
      q: "sync",
      item: "s1:fd-7k3qa2",
    });
    expect(validateWorkSearch({ view: "everything", q: 3, item: "" })).toEqual({});
  });

  it("bounds free text from the URL", () => {
    expect(validateWorkSearch({ q: "x".repeat(500) }).q?.length).toBe(200);
  });
});
