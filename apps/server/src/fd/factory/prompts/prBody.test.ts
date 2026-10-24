import { describe, expect, it } from "vite-plus/test";

import { pullRequestTextProblems } from "./prBody.ts";

const neutral = {
  title: "fd-aaaaaa: Add the export button",
  body: "Work item fd-aaaaaa: Add the export button\n\nAccepted tasks:\n\n1. Add the export button",
};

describe("pullRequestTextProblems", () => {
  it("passes neutral text, and names only as whole words", () => {
    expect(pullRequestTextProblems(neutral)).toEqual([]);
    expect(
      pullRequestTextProblems({ ...neutral, body: `${neutral.body}\n- gptq quantizes weights` }),
    ).toEqual([]);
  });

  it.each([
    ["a name in the title", { ...neutral, title: "fd-1: Port the Codex adapter" }, "title"],
    ["a name in a command path", { ...neutral, body: "`node tests/codex/verify.mjs`" }, "body"],
    ["a name in a link", { ...neutral, body: "Link: https://github.com/openai/alpha" }, "body"],
  ] as const)("finds %s", (_, text, field) => {
    expect(pullRequestTextProblems(text)).toEqual([{ field, rule: "ai_name" }]);
  });

  it("finds attribution anywhere, with every problem in field order", () => {
    expect(
      pullRequestTextProblems({
        title: "fd-1: Export, generated with a tool",
        body: `${neutral.body}\n  Assisted-by: Claude`,
      }),
    ).toEqual([
      { field: "title", rule: "ai_attribution" },
      { field: "body", rule: "ai_name" },
      { field: "body", rule: "ai_attribution" },
    ]);
  });
});
