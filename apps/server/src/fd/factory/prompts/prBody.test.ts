import { describe, expect, it } from "vite-plus/test";

import { pullRequestTextProblems } from "../git/publishedText.ts";
import { renderPullRequestTitle } from "./prBody.ts";

const commits = (...subjects: ReadonlyArray<string>) => subjects.map((subject) => ({ subject }));
const item = (title: string, key = "fd-aaaaaa") => ({ key, title });
const feat = commits("feat: add the export");

describe("renderPullRequestTitle", () => {
  it.each([
    ["a commit's type alone", commits("fix: write the header"), "fix: fd-aaaaaa Add the button"],
    ["its scope", commits("feat(web): add it"), "feat(web): fd-aaaaaa Add the button"],
    ["a breaking mark", commits("feat(api)!: drop it"), "feat(api)!: fd-aaaaaa Add the button"],
    [
      "the most significant of several types",
      commits("test: cover it", "feat: add it", "fix: repair it", "docs: note it"),
      "feat: fd-aaaaaa Add the button",
    ],
    [
      "a scope every commit of the type shares",
      commits("fix(web): a", "docs: b", "fix(web): c"),
      "fix(web): fd-aaaaaa Add the button",
    ],
    [
      "no scope when commits of the type differ",
      commits("feat(web): a", "feat(api): b"),
      "feat: fd-aaaaaa Add the button",
    ],
    [
      "a breaking mark from any commit",
      commits("feat: a", "chore(deps)!: b"),
      "feat!: fd-aaaaaa Add the button",
    ],
  ])("takes %s from the delivery's commits", (_name, subjects, expected) => {
    expect(renderPullRequestTitle(item("Add the button"), subjects)).toBe(expected);
  });

  it("shortens the preserved long sample at a word boundary and keeps its key", () => {
    const title = renderPullRequestTitle(
      item(
        "Add an exported formatDuration(minutes) function in src/format-duration.js using built-in JavaScript only, with behavior tests and a concise README example. Keep the change small.",
        "fd-11nezn",
      ),
      feat,
    );
    expect(title).toBe("feat: fd-11nezn Add an exported formatDuration(minutes) function in");
    expect(pullRequestTextProblems({ title, body: "", key: "fd-11nezn" })).toEqual([]);
  });

  it("keeps the preserved sample's key and whole words under a scope too", () => {
    const title = renderPullRequestTitle(
      item(
        "fd-11nezn: Add an exported formatDuration(minutes) function in src/format-duration.js using built-in JavaScript only, with behavior tests and a concise README example. Keep the change small.",
        "fd-11nezn",
      ),
      commits("feat(format): add the duration formatter"),
    );
    expect(title).toBe("feat(format): fd-11nezn Add an exported formatDuration(minutes) function");
    expect(pullRequestTextProblems({ title, body: "", key: "fd-11nezn" })).toEqual([]);
  });

  it("does not repeat a key the title opens with", () => {
    expect(renderPullRequestTitle(item("fd-aaaaaa: Add the button"), feat)).toBe(
      "feat: fd-aaaaaa Add the button",
    );
    // Only that key: a longer one that starts the same is the title's own text.
    expect(renderPullRequestTitle(item("fd-aaaaaa-2 is related"), feat)).toBe(
      "feat: fd-aaaaaa fd-aaaaaa-2 is related",
    );
  });

  it("keeps one line, the first with text, of a multiline title", () => {
    expect(
      renderPullRequestTitle(
        item("\n  Add   the\tbutton \r\nCo-authored-by: GitHub Copilot\n\nMore."),
        feat,
      ),
    ).toBe("feat: fd-aaaaaa Add the button");
  });

  it.each([
    ["a sentence's end", "Add the button.", "feat: fd-aaaaaa Add the button"],
    ["only punctuation", "...", "feat: fd-aaaaaa"],
    ["nothing", "", "feat: fd-aaaaaa"],
    ["blank lines", "\n \n", "feat: fd-aaaaaa"],
  ])("leaves no stray end for %s", (_name, title, expected) => {
    expect(renderPullRequestTitle(item(title), feat)).toBe(expected);
  });

  it("keeps only whole words, ending where the next would not fit", () => {
    const words = `${"a".repeat(30)} ${"b".repeat(25)} ${"c".repeat(10)}`;
    expect(renderPullRequestTitle(item(words), feat)).toBe(
      `feat: fd-aaaaaa ${"a".repeat(30)} ${"b".repeat(25)}`,
    );
    // One word short of the limit: the next, long as it is, stays out whole.
    const link = `Fix https://tracker.example.com/${"x".repeat(100)}`;
    expect(renderPullRequestTitle(item(link), feat)).toBe("feat: fd-aaaaaa Fix");
    // End punctuation does not count against the room it would leave.
    expect(renderPullRequestTitle(item(`${"x".repeat(56)}.`), feat)).toBe(
      `feat: fd-aaaaaa ${"x".repeat(56)}`,
    );
  });

  it.each([
    ["an unbroken identifier", "x".repeat(500)],
    ["a URL", `https://tracker.example.com/${"items/".repeat(20)}`],
    ["a word ending in a surrogate pair", `${"x".repeat(55)}😀`],
  ])("never cuts %s, leaving a first word that cannot fit to the gate", (_name, text) => {
    const title = renderPullRequestTitle(item(text), feat);
    expect(title).toBe(`feat: fd-aaaaaa ${text}`);
    expect(pullRequestTextProblems({ title, body: "", key: "fd-aaaaaa" })).toEqual([
      { field: "title", rule: "malformed_title" },
    ]);
  });

  it("gives up its scope when that is what lets the first word fit", () => {
    const word = "x".repeat(50);
    expect(renderPullRequestTitle(item(word), commits("feat(format): add it"))).toBe(
      `feat: fd-aaaaaa ${word}`,
    );
    const short = "x".repeat(30);
    expect(renderPullRequestTitle(item(short), commits("feat(format): add it"))).toBe(
      `feat(format): fd-aaaaaa ${short}`,
    );
  });

  it("gives up a scope that would crowd out the summary", () => {
    const scope = "s".repeat(40);
    expect(renderPullRequestTitle(item("Add the button"), commits(`feat(${scope}): a`))).toBe(
      "feat: fd-aaaaaa Add the button",
    );
  });

  it("falls back to a neutral type for commits with none, which the gate then refuses", () => {
    expect(renderPullRequestTitle(item("Add the button"), commits("Add the button"))).toBe(
      "chore: fd-aaaaaa Add the button",
    );
  });

  it("never cuts a key, leaving the gate to refuse one that cannot fit", () => {
    const key = `PROJ-${"1".repeat(80)}`;
    const title = renderPullRequestTitle(item("Add the button", key), feat);
    expect(title).toBe(`feat: ${key}`);
    expect(pullRequestTextProblems({ title, body: "", key })).toEqual([
      { field: "title", rule: "malformed_title" },
    ]);
  });

  it.each([
    ["names a provider", "Port the export to the Claude adapter", "ai_name"],
    ["credits an assistant", "Export. Co-authored-by: GitHub Copilot", "ai_name"],
    ["carries attribution", "Add the export, generated with a tool", "ai_attribution"],
  ])("leaves a title that %s for the gate to refuse", (_name, text, rule) => {
    const title = renderPullRequestTitle(item(text), feat);
    expect(pullRequestTextProblems({ title, body: "", key: "fd-aaaaaa" })).toEqual([
      { field: "title", rule },
    ]);
  });

  it("renders a parent's title like a single item's, over its whole branch's commits", () => {
    expect(
      renderPullRequestTitle(
        item("Add the export button", "fd-parent"),
        commits("feat: export the table", "fix: write the header row first"),
      ),
    ).toBe("feat: fd-parent Add the export button");
  });
});
