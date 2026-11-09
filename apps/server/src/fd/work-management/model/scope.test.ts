import { assert, describe, it } from "@effect/vitest";

import { appendNote } from "../documents/taskFiles.ts";
import {
  workItemContentFingerprint,
  workItemLinkScope,
  workItemNotes,
  workItemScopeFingerprint,
} from "./scope.ts";

const item = (
  body: string,
  overrides: Partial<{
    readonly kind: "markdown" | "github" | "jira";
    readonly title: string;
    readonly bodyTruncated: boolean;
    readonly bodyFidelity: "exact" | "lossy";
  }> = {},
) => ({
  kind: "markdown" as const,
  title: "Add the export button",
  body,
  bodyTruncated: false,
  bodyFidelity: "exact" as const,
  ...overrides,
});

const notes = "## Notes\n\n- 2026-10-20T10:40:00Z (owner) Looks right.\n";

describe("a read's own fingerprint", () => {
  it("wins over one worked out from its bounded text, which cannot see past the cut", () => {
    const bounded = item("Export", { bodyTruncated: true });
    assert.strictEqual(
      workItemScopeFingerprint({ ...bounded, scopeFingerprint: "whole" }),
      "whole",
    );
    assert.strictEqual(workItemScopeFingerprint(bounded), workItemContentFingerprint(bounded));
  });

  it("reads back what an item rendered for writing fingerprints", () => {
    const rendered = item("Export CSV.\n");
    assert.strictEqual(
      workItemScopeFingerprint(rendered),
      workItemScopeFingerprint({
        ...rendered,
        scopeFingerprint: workItemContentFingerprint(rendered),
      }),
    );
  });

  it("is kept by a link, and left out for a read its source could not make cleanly", () => {
    const read = { ...item("Export"), scopeFingerprint: "whole", invalid: null };
    assert.deepStrictEqual(workItemLinkScope(read), { scopeFingerprint: "whole" });
    assert.deepStrictEqual(
      workItemLinkScope({ ...read, invalid: { code: "broken", message: "Broken." } }),
      {},
    );
  });
});

describe("workItemScopeFingerprint", () => {
  it("ignores line ends, trailing whitespace on a line and blank lines at the end", () => {
    const plain = workItemScopeFingerprint(item("Export CSV.\n- From the toolbar"));
    assert.strictEqual(
      workItemScopeFingerprint(item("Export CSV.  \r\n- From the toolbar\t\r\n\r\n\n")),
      plain,
    );
    // Whitespace that changes what the text says still counts.
    assert.notStrictEqual(
      workItemScopeFingerprint(item("  Export CSV.\n- From the toolbar")),
      plain,
    );
    assert.notStrictEqual(
      workItemScopeFingerprint(item("Export CSV.\n\n- From the toolbar")),
      plain,
    );
  });

  it("changes with the title, a cut body or a lossy one", () => {
    const plain = workItemScopeFingerprint(item("Export CSV."));
    assert.notStrictEqual(workItemScopeFingerprint(item("Export CSV.", { title: "Other" })), plain);
    assert.notStrictEqual(
      workItemScopeFingerprint(item("Export CSV.", { bodyTruncated: true })),
      plain,
    );
    assert.notStrictEqual(
      workItemScopeFingerprint(item("Export CSV.", { bodyFidelity: "lossy" })),
      plain,
    );
  });

  it("leaves a Markdown task's Notes out, wherever Work's locator finds them", () => {
    const plain = workItemScopeFingerprint(item("Export CSV.\n"));
    assert.strictEqual(workItemScopeFingerprint(item(`Export CSV.\n\n${notes}`)), plain);
    assert.strictEqual(
      workItemScopeFingerprint(item(`Export CSV.\n\n${notes}- 2026-10-21T08:00:00Z (bot) More.\n`)),
      plain,
    );
    // The section ends at the next heading: what follows it is still the task's.
    assert.strictEqual(
      workItemScopeFingerprint(item(`Export CSV.\n\n${notes}\n## Later\nAlso PDF.`)),
      workItemScopeFingerprint(item("Export CSV.\n\n## Later\nAlso PDF.")),
    );
    // A heading inside a code fence is prose, as Work reads it.
    assert.notStrictEqual(
      workItemScopeFingerprint(item("Export CSV.\n\n```\n## Notes\n```\n")),
      plain,
    );
  });

  describe("a comment, whatever the body it lands in", () => {
    const line = "- 2026-10-20T10:40:00Z (owner) Progress.";
    const later = "- 2026-10-21T08:00:00Z (bot) More.";

    it.each<[string, string]>([
      ["empty", ""],
      ["blank", "\n\n"],
      ["whitespace", "   "],
      ["a line with no end", "Export CSV."],
      ["a line", "Export CSV.\n"],
      ["trailing blank lines", "Export CSV.\n\n\n"],
      ["a last line of spaces", "Export CSV.\n   "],
      ["Windows line ends", "Export CSV.\r\n- From the toolbar\r\n"],
      ["headings", "# Export\n\nCSV.\n\n## Later\nAlso PDF.\n"],
      ["a closed fence", "Export.\n```\nCSV.\n```\n"],
      ["a closed fence and no line end", "Export.\n```\nCSV.\n```"],
      ["a closed fence holding a Notes heading", "```\n## Notes\n- x\n```\n"],
      ["an open fence", "Export.\n```\nCSV.\n"],
      ["an open fence after a blank line", "Export.\n\n```\nCSV.\n"],
      ["an open fence after blank lines", "Export.\n\n\n```\nCSV.\n"],
      ["an open fence alone", "```"],
      ["an open fence opening it", "```\nCSV.\n"],
      ["an open fence after blank lines opening it", "\n\n```\nCSV.\n"],
      ["an open fence after spaces", "   \n```\nCSV.\n"],
      ["an open tilde fence", "Export.\n~~~\nCSV.\n"],
      ["an open fence with Windows line ends", "Export.\r\n```\r\nCSV.\r\n"],
      ["an open fence in a list", "Export.\n- ```js\n  CSV.\n"],
      ["an open fence after a closed one", "```\na\n```\nb\n```\nCSV.\n"],
      ["an open fence holding a heading", "Export.\n```\n## Later\nCSV.\n"],
      ["Notes at the end", `Export.\n\n${notes}`],
      ["Notes before a heading", `Export.\n\n${notes}\n## Later\nAlso PDF.\n`],
      ["Notes before an open fence", `Export.\n\n${notes}\n\`\`\`\nCSV.\n`],
      ["a closed fence under Notes", `Export.\n\n${notes}\`\`\`\nlog\n\`\`\`\n`],
      ["an empty Notes", "Export.\n\n## Notes\n"],
    ])("changes nothing of a body of %s", (_name, body) => {
      const plain = workItemScopeFingerprint(item(body));
      const once = appendNote(body, line);
      assert.notStrictEqual(once, body);
      assert.strictEqual(workItemScopeFingerprint(item(once)), plain);
      assert.strictEqual(workItemScopeFingerprint(item(appendNote(once, later))), plain);
    });
  });

  it("reads a comment ahead of a fence that never closes as no change, and an edit in it as one", () => {
    const line = "- 2026-10-20T10:40:00Z (owner) Progress.";
    const body = "Export.\n```\nMust write CSV.\n";
    const commented = appendNote(body, line);
    const plain = workItemScopeFingerprint(item(body));
    assert.strictEqual(workItemScopeFingerprint(item(commented)), plain);
    assert.notStrictEqual(
      workItemScopeFingerprint(item(commented.replace("Must write CSV.", "Must write PDF."))),
      plain,
    );
    // A writer replacing what the item says keeps its comments, not the text it replaces.
    assert.strictEqual(workItemNotes(item(commented)), `## Notes\n${line}\n\n`);
  });

  it("keeps a Notes heading in a tracker's body, whose comments live apart", () => {
    for (const kind of ["github", "jira"] as const) {
      assert.notStrictEqual(
        workItemScopeFingerprint(item(`Export CSV.\n\n${notes}`, { kind })),
        workItemScopeFingerprint(item("Export CSV.\n", { kind })),
      );
    }
  });
});

describe("workItemNotes", () => {
  it("is a Markdown task's Notes section as written, and nothing elsewhere", () => {
    assert.strictEqual(workItemNotes(item(`Export CSV.\n\n${notes}`)), notes);
    assert.strictEqual(workItemNotes(item(`Export CSV.\n\n${notes}## Later\n`)), notes);
    assert.strictEqual(workItemNotes(item("Export CSV.\n")), "");
    assert.strictEqual(workItemNotes(item(`Export CSV.\n\n${notes}`, { kind: "github" })), "");
  });
});
