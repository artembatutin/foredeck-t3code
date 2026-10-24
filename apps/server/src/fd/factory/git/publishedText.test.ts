import { describe, expect, it } from "vite-plus/test";

import type { FactoryBranchCommit } from "./branchFacts.ts";
import { carriesAiAttribution, namesAiTool } from "./publishedText.ts";
import { evaluateSettle } from "./settle.ts";

describe("namesAiTool", () => {
  it.each([
    "Fix the OpenCode adapter",
    "node tests/grok/verify.mjs",
    "Export support. Co-authored-by: GitHub Copilot",
    "Ask Gemini first",
    "the Antigravity provider",
    "drafted in Windsurf",
    "a Llama model",
    "Port the Cursor adapter",
    "runs cursor-agent",
    "Use the Cursor IDE",
    "Anysphere's editor",
    "Export support. Co-authored-by: Cursor <cursor@cursor.com>",
    "Co-Authored-By: cursor",
    "Co-authored-by: Ada <cursoragent@cursor.com>",
    "Made with Cursor",
    "Drafted using Cursor.",
    "see https://cursor.sh/docs",
    "Fixed with ChatGPT",
    "GPT-4 output",
  ])("finds a name in %j", (text) => {
    expect(namesAiTool(text)).toBe(true);
  });

  it.each([
    "Paginate with a database cursor",
    "Move the cursor to the end of the line",
    "Cursor-based pagination for the API",
    "Paginate with Cursor-based tokens",
    "Select text with the cursor",
    "Pass the cursor in the request",
    "Co-authored-by: Ada Lovelace <ada@example.com>\nMoves the cursor.",
    "support gptq weights",
    "thank Claudette",
    "handle codexes",
    "the team grokked the parser",
    "three llamas",
  ])("passes %j, which only resembles a name", (text) => {
    expect(namesAiTool(text)).toBe(false);
  });
});

describe("carriesAiAttribution", () => {
  it.each([
    "Generated-by: a tool",
    "  assisted-by: a tool",
    "This was generated with a tool.",
    "An AI-generated summary",
    "Written with AI",
    "Co-authored-by: AI Assistant <assistant@example.com>",
  ])("finds attribution in %j", (text) => {
    expect(carriesAiAttribution(text)).toBe(true);
  });

  it.each([
    "Co-authored-by: Ada Lovelace <ada@example.com>",
    "Describe generated files and the by-line",
  ])("passes %j", (text) => {
    expect(carriesAiAttribution(text)).toBe(false);
  });
});

describe("the settle check reads the same rules", () => {
  const settled = (body: string) => {
    const commit: FactoryBranchCommit = {
      sha: "a".repeat(40),
      subject: "feat(server): add the export",
      body,
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      committerName: "Ada Lovelace",
      committerEmail: "ada@example.com",
    };
    const result = evaluateSettle(
      { branch: "feature/item-7", clean: true, baselineIsAncestor: true, commits: [commit] },
      "feature/item-7",
    );
    return result.status === "settled" ? [] : result.problems.map(({ rule }) => rule);
  };

  it("refuses a commit crediting an assistant, and keeps a human co-author", () => {
    expect(settled("Co-authored-by: GitHub Copilot <copilot@example.com>")).toEqual([
      "ai_name_in_body",
    ]);
    expect(settled("Co-authored-by: AI Assistant <assistant@example.com>")).toEqual([
      "ai_attribution",
    ]);
    expect(settled("Co-authored-by: Ada Lovelace <ada@example.com>")).toEqual([]);
    expect(settled("Co-authored-by: Cursor <cursoragent@cursor.com>")).toEqual(["ai_name_in_body"]);
    expect(settled("Moves the cursor to the end of the line.")).toEqual([]);
  });
});
