import { assert, describe, it } from "@effect/vitest";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

import {
  appendNote,
  fileItemId,
  formatCommaList,
  formatNoteLine,
  isTaskFileName,
  mintTaskId,
  parseCommaList,
  parseNotes,
  parseOptionalFields,
  parseTaskId,
  TASK_ID_PATTERN,
  taskFilename,
} from "./taskFiles.ts";

const ISO = "2026-10-21T12:00:00.000Z";
const isWorkItemId = Schema.is(WorkItemId);

describe("task ids", () => {
  it("mints lowercase Crockford ids from the first four random bytes", () => {
    assert.strictEqual(mintTaskId(new Uint8Array([0, 0, 0, 0])), "fd-000000");
    assert.strictEqual(mintTaskId(new Uint8Array([0xff, 0xff, 0xff, 0xff])), "fd-zzzzzz");
    // The top two bits are dropped, so these differ only in bits the id ignores.
    assert.strictEqual(
      mintTaskId(new Uint8Array([0x3f, 0xff, 0xff, 0xff, 0x12])),
      mintTaskId(new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    );
    const seen = new Set<string>();
    for (let value = 0; value < 4096; value += 1) {
      const id = mintTaskId(new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]));
      assert.match(id, TASK_ID_PATTERN);
      assert.notMatch(id, /[ilou]/);
      seen.add(id);
    }
    assert.strictEqual(seen.size, 4096);
  });

  it("lowercases ids and refuses any other shape", () => {
    assert.strictEqual(parseTaskId("FD-7K3QA2"), "fd-7k3qa2");
    assert.strictEqual(parseTaskId("fd-7k3qa2"), "fd-7k3qa2");
    for (const value of [
      "fd-7k3qa",
      "fd-7k3qa2x",
      "fd-7k3qai",
      "fd_7k3qa2",
      "7k3qa2",
      " fd-7k3qa2",
    ]) {
      assert.isUndefined(parseTaskId(value), value);
    }
  });

  it("names files by id and ASCII slug", () => {
    const id = WorkItemId.make("fd-7k3qa2");
    assert.strictEqual(
      taskFilename(id, "Keep selected source"),
      "fd-7k3qa2-keep-selected-source.md",
    );
    assert.strictEqual(taskFilename(id, "Café ünïcode 🚀 测试"), "fd-7k3qa2-cafe-unicode.md");
    assert.strictEqual(taskFilename(id, "🚀 测试"), "fd-7k3qa2.md");
    assert.strictEqual(
      taskFilename(id, `${"word ".repeat(40)}end`),
      `fd-7k3qa2-${"word-".repeat(12).slice(0, -1)}.md`,
    );
  });

  it("gives a file without a readable id a stable hashed item id", () => {
    const names = ["tâche un.md", "two words.md", `${"x".repeat(70)}.md`, "-leading.md"];
    const ids = names.map(fileItemId);
    for (const id of ids) {
      assert.match(id, /^file-[0-9a-f]{12}$/);
      assert.isTrue(isWorkItemId(id), id);
    }
    assert.strictEqual(new Set(ids).size, names.length);
    assert.strictEqual(fileItemId("tâche un.md"), ids[0]);
  });

  it("indexes only visible .md files", () => {
    for (const name of ["fd-7k3qa2.md", "notes.md", "a.md", "fd-7k3qa2-keep.md"]) {
      assert.isTrue(isTaskFileName(name), name);
    }
    for (const name of [
      ".md",
      ".hidden.md",
      "draft.md.tmp",
      "draft.md~",
      ".draft.md.swp",
      "fd-7k3qa2.MD",
      "fd-7k3qa2.markdown",
      "fd-7k3qa2.md.a1b2c3",
      "README",
    ]) {
      assert.isFalse(isTaskFileName(name), name);
    }
  });
});

describe("comma lists and optional fields", () => {
  it("round-trips comma lists, trimming and dropping empty entries", () => {
    assert.deepStrictEqual(parseCommaList(" work ,jira,, ,sync"), ["work", "jira", "sync"]);
    assert.deepStrictEqual(parseCommaList(""), []);
    assert.strictEqual(formatCommaList(["work", "jira"]), "work, jira");
    assert.deepStrictEqual(parseCommaList(formatCommaList(["work", "jira"])), ["work", "jira"]);
  });

  it("reads the known optional fields leniently", () => {
    const fields = parseOptionalFields(
      new Map([
        ["priority", " High "],
        ["labels", "work, jira, work"],
        ["assignee", " Jane Doe "],
        ["parent", "FD-9AB3DE"],
        ["blocked_by", "fd-2m9x4c, nonsense, FD-2M9X4C, fd-7k3qa2"],
        ["created", "2026-01-02"],
        ["updated", ISO],
      ]),
    );
    assert.deepStrictEqual(fields, {
      priority: "high",
      labels: ["work", "jira"],
      assignee: "Jane Doe",
      parent: WorkItemId.make("fd-9ab3de"),
      blockedBy: [WorkItemId.make("fd-2m9x4c"), WorkItemId.make("fd-7k3qa2")],
      created: "2026-01-02T00:00:00.000Z",
      updated: ISO,
    });
  });

  it("treats unusable optional values as absent", () => {
    const fields = parseOptionalFields(
      new Map([
        ["priority", "urgent"],
        ["labels", " , ,"],
        ["assignee", "   "],
        ["parent", "not-an-id"],
        ["blocked_by", "nope"],
        ["created", "yesterday"],
        ["updated", "1700000000"],
      ]),
    );
    assert.deepStrictEqual(fields, {
      priority: null,
      labels: [],
      assignee: null,
      parent: null,
      blockedBy: [],
      created: null,
      updated: null,
    });
    assert.deepStrictEqual(parseOptionalFields(new Map()), fields);
  });

  it("caps labels and blockers at what the summary contract carries", () => {
    const labels = Array.from({ length: 40 }, (_, index) => `l${index}`);
    const blockers = Array.from({ length: 60 }, (_, index) =>
      `fd-${index.toString(32).padStart(6, "0")}`.replaceAll(/[ilou]/g, "z"),
    );
    const fields = parseOptionalFields(
      new Map([
        ["labels", labels.join(", ")],
        ["blocked_by", blockers.join(", ")],
      ]),
    );
    assert.strictEqual(fields.labels.length, 32);
    assert.strictEqual(fields.blockedBy.length, 50);
  });
});

describe("notes", () => {
  const note = (createdAt: string, label: string, text: string) => ({
    author: { id: label, label },
    body: text,
    createdAt,
    updatedAt: null,
  });

  it("formats note lines on one line", () => {
    assert.strictEqual(
      formatNoteLine(ISO, "Artem", "First line\nsecond\r\n  third"),
      `- ${ISO} (Artem) First line second third`,
    );
    assert.strictEqual(formatNoteLine(ISO, "a\nb", "x"), `- ${ISO} (a b) x`);
  });

  it("stands in for a blank author so the note still reads back", () => {
    for (const label of ["", "  ", "\n"]) {
      const line = formatNoteLine(ISO, label, "x");
      assert.strictEqual(line, `- ${ISO} (someone) x`);
      assert.deepStrictEqual(parseNotes(`## Notes\n${line}\n`), [
        { id: "1", ...note(ISO, "someone", "x") },
      ]);
    }
  });

  it("keeps an author with unbalanced parentheses readable", () => {
    for (const label of ["Pat (", "Pat )", "((Pat)", "Pat (bot))", ")("]) {
      const line = formatNoteLine(ISO, label, "text");
      const [comment, ...rest] = parseNotes(`## Notes\n${line}\n`);
      assert.deepStrictEqual(rest, []);
      assert.strictEqual(comment?.body, "text", label);
      assert.strictEqual(comment?.author?.label, label.replaceAll("(", "[").replaceAll(")", "]"));
    }
    assert.strictEqual(formatNoteLine(ISO, "Pat (bot)", "x"), `- ${ISO} (Pat [bot]) x`);
  });

  it("cuts a comment body longer than the wire allows", () => {
    const long = `${"a".repeat(16_000)}😀tail`;
    const [comment] = parseNotes(`## Notes\n${formatNoteLine(ISO, "Artem", long)}\n`);
    assert.strictEqual(comment?.body.length, 16_000);
    assert.strictEqual(comment?.body, "a".repeat(16_000));
    const straddling = `${"a".repeat(15_999)}😀tail`;
    const [cut] = parseNotes(`## Notes\n${formatNoteLine(ISO, "Artem", straddling)}\n`);
    assert.strictEqual(cut?.body, "a".repeat(15_999));
  });

  it("ignores headings and note lines inside fenced code blocks", () => {
    const fenced = [
      "Intro",
      "```md",
      "## Notes",
      `- ${ISO} (Nobody) inside a fence`,
      "```",
      "~~~",
      "## Notes",
      "~~~",
      "## Notes",
      `- ${ISO} (Artem) First`,
      "````",
      "## Later",
      `- ${ISO} (Nobody) fenced inside the section`,
      "```",
      "still fenced: a shorter fence does not close a longer one",
      "````",
      `- ${ISO} (Artem) Second`,
      "## Later",
      `- ${ISO} (Nobody) after the section`,
      "",
    ].join("\n");
    assert.deepStrictEqual(parseNotes(fenced), [
      { id: "1", ...note(ISO, "Artem", "First") },
      { id: "2", ...note(ISO, "Artem", "Second") },
    ]);
    const line = formatNoteLine(ISO, "Artem", "Third");
    assert.strictEqual(
      appendNote(fenced, line),
      fenced.replace(`- ${ISO} (Artem) Second\n`, `- ${ISO} (Artem) Second\n${line}\n`),
    );
    // Only a `## Notes` heading inside a fence: there is no section, so one is created.
    const onlyFenced = "```\n## Notes\n```\n";
    assert.deepStrictEqual(parseNotes(onlyFenced), []);
    assert.strictEqual(appendNote(onlyFenced, line), `${onlyFenced}\n## Notes\n${line}\n`);
  });

  it("appends after a closed fence and before an unterminated one", () => {
    const line = formatNoteLine(ISO, "Artem", "Next");
    const closed = "## Notes\n- a (b) first\n```\ncode\n```\n";
    assert.strictEqual(appendNote(closed, line), `${closed.slice(0, -1)}\n${line}\n`);
    const open = "## Notes\n- a (b) first\n```\ncode\n";
    assert.strictEqual(appendNote(open, line), `## Notes\n- a (b) first\n${line}\n\`\`\`\ncode\n`);
  });

  it("creates the section before an unterminated fence so the note is never swallowed", () => {
    const line = formatNoteLine(ISO, "Artem", "First");
    const second = formatNoteLine(ISO, "Artem", "Second");
    const open = "Intro\n```\ncode\n";
    const once = appendNote(open, line);
    assert.strictEqual(once, `Intro\n\n## Notes\n${line}\n\n\`\`\`\ncode\n`);
    assert.deepStrictEqual(
      parseNotes(once).map((comment) => comment.body),
      ["First"],
    );
    const twice = appendNote(once, second);
    assert.deepStrictEqual(
      parseNotes(twice).map((comment) => comment.body),
      ["First", "Second"],
    );
    assert.strictEqual(twice, `Intro\n\n## Notes\n${line}\n${second}\n\n\`\`\`\ncode\n`);
    // The only heading sits in a fence that never closes.
    const fencedHeading = appendNote("```\n## Notes\n", line);
    assert.strictEqual(fencedHeading, `## Notes\n${line}\n\n\`\`\`\n## Notes\n`);
    assert.deepStrictEqual(
      parseNotes(fencedHeading).map((comment) => comment.body),
      ["First"],
    );
    // A fence that closes, in a list item or not, is no obstacle.
    assert.strictEqual(
      appendNote("- ```js\n  code\n  ```\n", line),
      `- \`\`\`js\n  code\n  \`\`\`\n\n## Notes\n${line}\n`,
    );
  });

  it("recognizes fences the way CommonMark does", () => {
    const inList = [
      "- ```js",
      "  ## Notes",
      `  - ${ISO} (Nobody) fenced`,
      "  ```",
      "## Notes",
      `- ${ISO} (Artem) Real`,
      "",
    ].join("\n");
    assert.deepStrictEqual(
      parseNotes(inList).map((comment) => comment.body),
      ["Real"],
    );
    const backtickInfo = ["``` foo ` bar", "## Notes", `- ${ISO} (Artem) Real`, ""].join("\n");
    assert.deepStrictEqual(
      parseNotes(backtickInfo).map((comment) => comment.body),
      ["Real"],
    );
    const tildeInfo = ["~~~ foo ` bar", "## Notes", `- ${ISO} (Artem) Fenced`, ""].join("\n");
    assert.deepStrictEqual(parseNotes(tildeInfo), []);
  });

  it("starts a section with the document's line break when the body has none of its own", () => {
    const line = formatNoteLine(ISO, "Artem", "First");
    assert.strictEqual(appendNote("", line, "\r\n"), `## Notes\r\n${line}\r\n`);
    assert.strictEqual(appendNote("Intro", line, "\r\n"), `Intro\r\n\r\n## Notes\r\n${line}\r\n`);
    assert.strictEqual(appendNote("Intro\r\n", line), `Intro\r\n\r\n## Notes\r\n${line}\r\n`);
  });

  it("reads comments back from the Notes section only", () => {
    const body = [
      "Intro",
      "- 2026-01-01T00:00:00.000Z (Nobody) not under Notes",
      "",
      "## Notes",
      "Free text that is not a comment.",
      `- ${ISO} (Artem) First note`,
      "- not-a-date (Artem) skipped",
      "- 2026-10-22T08:00:00.000Z (Pat (bot)) Second (with parens)",
      "",
      "## Later",
      "- 2026-10-23T08:00:00.000Z (Artem) another section",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseNotes(body), [
      { id: "1", ...note(ISO, "Artem", "First note") },
      { id: "2", ...note("2026-10-22T08:00:00.000Z", "Pat (bot)", "Second (with parens)") },
    ]);
    assert.deepStrictEqual(parseNotes(""), []);
    assert.deepStrictEqual(parseNotes("## Notes\n"), []);
    assert.deepStrictEqual(parseNotes("### Notes\n- x (y) z\n"), []);
  });

  it("appends under an existing heading, before the next section", () => {
    const line = formatNoteLine(ISO, "Artem", "Third");
    const body = ["## Notes", "- a (b) first", "", "## Later", "text", ""].join("\n");
    assert.strictEqual(
      appendNote(body, line),
      ["## Notes", "- a (b) first", line, "", "## Later", "text", ""].join("\n"),
    );
    assert.strictEqual(
      appendNote("## Notes\n- a (b) first\n", line),
      `## Notes\n- a (b) first\n${line}\n`,
    );
    assert.strictEqual(appendNote("## Notes", line), `## Notes\n${line}`);
    assert.strictEqual(appendNote("## Notes\n\n", line), `## Notes\n${line}\n\n`);
    assert.strictEqual(
      appendNote("Intro\r\n\r\n## Notes\r\n- a (b) first\r\n", line),
      `Intro\r\n\r\n## Notes\r\n- a (b) first\r\n${line}\r\n`,
    );
  });

  it("creates the heading at the end of a body without one", () => {
    const line = formatNoteLine(ISO, "Artem", "First");
    assert.strictEqual(appendNote("", line), `## Notes\n${line}\n`);
    assert.strictEqual(appendNote("Intro", line), `Intro\n\n## Notes\n${line}\n`);
    assert.strictEqual(appendNote("Intro\n", line), `Intro\n\n## Notes\n${line}\n`);
    assert.strictEqual(appendNote("Intro\n\n", line), `Intro\n\n## Notes\n${line}\n`);
    assert.strictEqual(appendNote("Intro\r\n", line), `Intro\r\n\r\n## Notes\r\n${line}\r\n`);
  });

  it("round-trips appended notes in order", () => {
    let body = "Intro\n";
    const lines = [
      formatNoteLine(ISO, "Artem", "First"),
      formatNoteLine("2026-10-22T08:00:00.000Z", "Pat", "Second\nline"),
    ];
    for (const line of lines) body = appendNote(body, line);
    assert.deepStrictEqual(parseNotes(body), [
      { id: "1", ...note(ISO, "Artem", "First") },
      { id: "2", ...note("2026-10-22T08:00:00.000Z", "Pat", "Second line") },
    ]);
  });
});
