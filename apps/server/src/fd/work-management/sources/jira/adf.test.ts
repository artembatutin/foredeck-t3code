import { describe, expect, it } from "@effect/vitest";

import { adfToMarkdown, markdownToAdf } from "./adf.ts";

const roundTrip = (markdown: string) => adfToMarkdown(markdownToAdf(markdown));

describe("ADF and Markdown", () => {
  it("round-trips the supported subset exactly", () => {
    const markdown = [
      "# Plan",
      "Some **bold**, _em_, `code`, ~~gone~~ and [a link](https://example.com).",
      "- one\n- two",
      "1. first\n2. second",
      "- [ ] open task\n- [x] done task",
      "```ts\nconst a = 1;\n```",
      "> quoted",
      "---",
    ].join("\n\n");
    const result = roundTrip(markdown);
    expect(result.lossy).toBe(false);
    expect(result.markdown).toBe(markdown);
  });

  it("keeps hard breaks inside a paragraph", () => {
    expect(roundTrip("line one\nline two").markdown).toBe("line one\nline two");
  });

  it("marks content it cannot show as lossy, with a visible placeholder", () => {
    const result = adfToMarkdown({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "table", content: [] },
        { type: "paragraph", content: [{ type: "mention", attrs: { text: "@Ann" } }] },
      ],
    });
    expect(result.lossy).toBe(true);
    expect(result.markdown).toBe("Before\n\n[table omitted]\n\n@Ann");
  });

  it("reads plain strings and missing bodies", () => {
    expect(adfToMarkdown("plain")).toEqual({ markdown: "plain", lossy: false });
    expect(adfToMarkdown(null)).toEqual({ markdown: "", lossy: false });
  });
});
