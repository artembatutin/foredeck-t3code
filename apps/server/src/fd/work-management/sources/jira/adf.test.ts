import { describe, expect, it } from "@effect/vitest";

import { type AdfNode, adfToMarkdown, markdownToAdf } from "./adf.ts";

const roundTrip = (markdown: string) => adfToMarkdown(markdownToAdf(markdown));

const text = (value: string, marks?: AdfNode["marks"]): AdfNode =>
  marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks };
const paragraph = (...content: Array<AdfNode>): AdfNode => ({ type: "paragraph", content });
const item = (...content: Array<AdfNode>): AdfNode => ({ type: "listItem", content });
const doc = (...content: Array<AdfNode>): AdfNode => ({ type: "doc", version: 1, content });

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

  it("writes a valid ADF document", () => {
    expect(markdownToAdf("# Title\n\nBody\n\n- [ ] task\n\n-\n\n>")).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
        paragraph(text("Body")),
        {
          type: "taskList",
          attrs: { localId: "work-2" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "work-1", state: "TODO" },
              content: [text("task")],
            },
          ],
        },
        // An empty item still holds a paragraph, an empty quote still holds a block.
        { type: "bulletList", content: [item({ type: "paragraph", content: [] })] },
        { type: "blockquote", content: [{ type: "paragraph", content: [] }] },
      ],
    });
    expect(markdownToAdf("")).toEqual(doc());
  });

  it("drops marks ADF does not allow beside code", () => {
    expect(markdownToAdf("**`a`** [`b`](https://x.test)").content).toEqual([
      paragraph(
        text("a", [{ type: "code" }]),
        text(" "),
        text("b", [{ type: "link", attrs: { href: "https://x.test" } }, { type: "code" }]),
      ),
    ]);
  });

  it("terminates on fences that are spaced, unterminated or trailed by spaces", () => {
    expect(markdownToAdf("``` js\nconst a = 1;\n```").content).toEqual([
      { type: "codeBlock", attrs: { language: "js" }, content: [text("const a = 1;")] },
    ]);
    expect(markdownToAdf("before\n```\nnever closed\n\nstill code").content).toEqual([
      paragraph(text("before")),
      { type: "codeBlock", content: [text("never closed\n\nstill code")] },
    ]);
    expect(markdownToAdf("```   \ncode\n```   \nafter").content).toEqual([
      { type: "codeBlock", content: [text("code")] },
      paragraph(text("after")),
    ]);
    expect(markdownToAdf("```").content).toEqual([{ type: "codeBlock", content: [] }]);
  });

  it("terminates on lines that start no block and on bare markers", () => {
    expect(markdownToAdf("```js```\n* * *\n#nope\n1.").content).toEqual([
      paragraph(text("js", [{ type: "code" }])),
      {
        type: "bulletList",
        content: [
          item(
            { type: "paragraph", content: [] },
            {
              type: "bulletList",
              content: [
                item(
                  { type: "paragraph", content: [] },
                  { type: "bulletList", content: [item({ type: "paragraph", content: [] })] },
                ),
              ],
            },
          ),
        ],
      },
      paragraph(text("#nope")),
      { type: "orderedList", content: [item({ type: "paragraph", content: [] })] },
    ]);
  });

  it("keeps literal Markdown punctuation in both directions", () => {
    const literal = [
      "*stars* _under_ `tick` ~~strike~~ [x](y) <https://a.test> back\\slash",
      "# hash",
      "> quote",
      "- dash",
      "+ plus",
      "1. number",
      "---",
    ];
    const body = doc(...literal.map((line) => paragraph(text(line))));
    const result = adfToMarkdown(body);
    expect(result.lossy).toBe(false);
    expect(result.markdown).toBe(
      [
        "\\*stars\\* \\_under\\_ \\`tick\\` \\~\\~strike\\~\\~ \\[x\\](y) \\<https://a.test> back\\\\slash",
        "\\# hash",
        "\\> quote",
        "\\- dash",
        "\\+ plus",
        "1\\. number",
        "\\---",
      ].join("\n\n"),
    );
    expect(markdownToAdf(result.markdown).content).toEqual(body.content);
  });

  it("nests lists by indentation", () => {
    const markdown = "1. one\n   - inner\n     - [ ] not a task here\n2. two";
    expect(markdownToAdf(markdown).content).toEqual([
      {
        type: "orderedList",
        content: [
          item(paragraph(text("one")), {
            type: "bulletList",
            content: [
              item(paragraph(text("inner")), {
                type: "bulletList",
                content: [item(paragraph(text("[ ] not a task here")))],
              }),
            ],
          }),
          item(paragraph(text("two"))),
        ],
      },
    ]);
    // The task text reads back escaped, so it stays text.
    expect(roundTrip(markdown)).toEqual({
      markdown: "1. one\n   - inner\n     - \\[ \\] not a task here\n2. two",
      lossy: false,
    });
  });

  it("nests task lists and keeps an ordered list's start", () => {
    const markdown = "- [ ] open\n  - [x] nested\n- [x] done\n\n3. third\n4. fourth";
    const [tasks, ordered] = markdownToAdf(markdown).content!;
    expect(tasks!.content!.map((child) => [child.type, child.attrs?.state])).toEqual([
      ["taskItem", "TODO"],
      ["taskList", undefined],
      ["taskItem", "DONE"],
    ]);
    expect(tasks!.content![1]!.content![0]).toMatchObject({
      type: "taskItem",
      attrs: { state: "DONE" },
      content: [text("nested")],
    });
    expect(ordered).toMatchObject({ type: "orderedList", attrs: { order: 3 } });
    expect(roundTrip(markdown)).toEqual({ markdown, lossy: false });
  });

  it("keeps combined marks", () => {
    const marks = (markdown: string) =>
      markdownToAdf(markdown).content![0]!.content!.map((node) => [
        node.text,
        (node.marks ?? []).map((mark) => mark.type).toSorted(),
      ]);
    expect(marks("**_both_**")).toEqual([["both", ["em", "strong"]]]);
    expect(marks("[**bold link**](https://x.test)")).toEqual([["bold link", ["link", "strong"]]]);
    expect(marks("_~~gone~~_")).toEqual([["gone", ["em", "strike"]]]);
    expect(marks("**a _b_ c**")).toEqual([
      ["a ", ["strong"]],
      ["b", ["em", "strong"]],
      [" c", ["strong"]],
    ]);

    const body = doc(
      paragraph(
        text("a", [{ type: "strong" }, { type: "em" }]),
        text("b", [{ type: "em" }]),
        text("c", [{ type: "strike" }, { type: "em" }, { type: "strong" }]),
        text(" "),
        text("d", [{ type: "link", attrs: { href: "https://x.test" } }, { type: "strong" }]),
        text("e", [{ type: "link", attrs: { href: "https://x.test" } }]),
      ),
    );
    const result = adfToMarkdown(body);
    expect(result).toEqual({
      markdown: "**_a_**_b**~~c~~**_ [**d**e](https://x.test)",
      lossy: false,
    });
  });

  it("round-trips inline cards and reports mentions lossy", () => {
    const card = doc(
      paragraph(text("see "), { type: "inlineCard", attrs: { url: "https://x.test/A-1" } }),
    );
    expect(adfToMarkdown(card)).toEqual({ markdown: "see <https://x.test/A-1>", lossy: false });
    expect(markdownToAdf("see <https://x.test/A-1>").content).toEqual(card.content);

    // `@Ann` cannot become the account mention again.
    expect(
      adfToMarkdown(
        doc(paragraph(text("hi "), { type: "mention", attrs: { id: "acc-1", text: "@Ann" } })),
      ),
    ).toEqual({ markdown: "hi @Ann", lossy: true });
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

  it("reports each kind of unsupported content lossy", () => {
    const unsupported: ReadonlyArray<AdfNode> = [
      { type: "table", content: [] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m", type: "file" } }] },
      { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("note"))] },
      { type: "someFutureNode" },
      paragraph({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }),
      paragraph({ type: "status", attrs: { text: "DONE", color: "green" } }),
      paragraph({ type: "date", attrs: { timestamp: "1700000000000" } }),
      paragraph(text("red", [{ type: "textColor", attrs: { color: "#ff0000" } }])),
      paragraph(text("under", [{ type: "underline" }])),
      // Content that reads fine but would not write back the same.
      paragraph(text("word"), text("part", [{ type: "em" }])),
      paragraph(text("a"), { type: "hardBreak" }, { type: "hardBreak" }, text("b")),
      { type: "bulletList", content: [item(paragraph(text("a")))] },
    ];
    for (const node of unsupported) {
      const body =
        node.type === "bulletList"
          ? doc(node, { type: "bulletList", content: [item(paragraph(text("b")))] })
          : doc(node);
      expect(adfToMarkdown(body).lossy, JSON.stringify(node)).toBe(true);
    }
  });

  it("ignores ids and empty paragraphs when judging fidelity", () => {
    const body = doc(
      { type: "paragraph", attrs: { localId: "p1" }, content: [text("kept")] },
      { type: "paragraph", content: [] },
      {
        type: "taskList",
        attrs: { localId: "jira-list" },
        content: [
          {
            type: "taskItem",
            attrs: { localId: "jira-item", state: "DONE" },
            content: [text("t")],
          },
        ],
      },
    );
    expect(adfToMarkdown(body)).toEqual({ markdown: "kept\n\n- [x] t", lossy: false });
  });

  it("reads plain strings and missing bodies", () => {
    expect(adfToMarkdown("plain")).toEqual({ markdown: "plain", lossy: false });
    expect(adfToMarkdown(null)).toEqual({ markdown: "", lossy: false });
  });
});
