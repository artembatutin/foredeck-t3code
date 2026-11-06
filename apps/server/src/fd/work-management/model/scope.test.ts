import { assert, describe, it } from "@effect/vitest";

import { workItemNotes, workItemScopeFingerprint } from "./scope.ts";

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
