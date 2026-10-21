import { assert, describe, it } from "@effect/vitest";
import { WorkItemId, WorkNativeStatus } from "@t3tools/contracts/fd/work-management";
import * as Result from "effect/Result";

import {
  decodeTaskDocument,
  editTaskDocument,
  MAX_TASK_DOCUMENT_BYTES,
  renderTaskDocument,
  type TaskDocument,
  type TaskDocumentWriteRefused,
  TOO_LARGE_DIAGNOSTIC,
} from "./taskDocument.ts";

const id = "fd-7k3qa2";
const otherId = "fd-2m9x4c";
const TITLE = "Keep selected source after reconnect";
const ISO = "2026-10-21T12:00:00.000Z";

const FIELDS = [`id: ${id}`, `title: ${TITLE}`, "status: todo"];
const BODY = [
  "",
  "## Description",
  "The selected Work source should survive reconnect.",
  "",
  "## Acceptance criteria",
  "- [ ] Reconnect retains the selected source and filter.",
  "",
].join("\n");

const encode = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: ReadonlyArray<Uint8Array | ReadonlyArray<number>>) =>
  new Uint8Array(parts.flatMap((part) => [...part]));

/** A task file whose frontmatter has `rows`; line 1 is the opening delimiter. */
const task = (rows: ReadonlyArray<string>, body = BODY, newline = "\n") =>
  `${["---", ...rows, "---", ""].join(newline)}${body}`;
const replacing = (name: string, row: string) =>
  FIELDS.map((field) => (field.startsWith(`${name}:`) ? row : field));
const omitting = (name: string) => FIELDS.filter((field) => !field.startsWith(`${name}:`));

const problems = (document: TaskDocument) =>
  document.diagnostics.map(({ code, line, field }) => [code, line, field ?? null] as const);
const fieldsOf = (document: TaskDocument) => Object.fromEntries(document.fields);

const written = <A>(result: Result.Result<A, TaskDocumentWriteRefused>) => {
  if (Result.isFailure(result)) return assert.fail(result.failure.message);
  return result.success;
};
const refused = <A>(result: Result.Result<A, TaskDocumentWriteRefused>) => {
  if (Result.isSuccess(result)) return assert.fail("Expected the write to be refused.");
  return result.failure;
};

/** Asserts that the buffers differ only inside `[start, end)` of `before`. */
const assertChangedOnlyWithin = (
  before: Uint8Array,
  after: Uint8Array,
  start: number,
  end: number,
) => {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  assert.isAtLeast(prefix, start, "a byte before the span changed");
  assert.isAtMost(before.length - suffix, end, "a byte after the span changed");
};

/** The byte range of the first occurrence of `needle` in `text`. */
const byteSpan = (text: string, needle: string) => {
  const index = text.indexOf(needle);
  assert.isAtLeast(index, 0, needle);
  const start = encode(text.slice(0, index)).length;
  return [start, start + encode(needle).length] as const;
};

describe("decodeTaskDocument", () => {
  it("decodes a document into its item, its string fields and a revision of its exact bytes", () => {
    const bytes = encode(task(FIELDS));
    const document = decodeTaskDocument(bytes);
    assert.isTrue(document.editable);
    assert.deepStrictEqual(document.diagnostics, []);
    assert.strictEqual(document.bytes, bytes);
    assert.match(document.revision, /^sha256:[0-9a-f]{64}$/);
    assert.deepStrictEqual(document.item, {
      id,
      title: TITLE,
      status: "todo",
      body: BODY,
      revision: document.revision,
    });
    assert.deepStrictEqual(fieldsOf(document), { id, title: TITLE, status: "todo" });
  });

  it("keeps every native status writable", () => {
    for (const status of WorkNativeStatus.literals) {
      const document = decodeTaskDocument(encode(task(replacing("status", `status: ${status}`))));
      assert.strictEqual(document.item?.status, status);
      assert.isTrue(document.editable, status);
    }
  });

  it("lowercases an uppercase id so it names one identity", () => {
    const document = decodeTaskDocument(encode(task(replacing("id", `id: ${id.toUpperCase()}`))));
    assert.strictEqual(document.item?.id, id);
    assert.strictEqual(document.fields.get("id"), id.toUpperCase());
    assert.isTrue(document.editable);
  });

  it("reports the first line's break, for text appended to the body", () => {
    assert.strictEqual(decodeTaskDocument(encode(task(FIELDS))).newline, "\n");
    assert.strictEqual(
      decodeTaskDocument(encode(task(FIELDS, "\r\nBody\r\n", "\r\n"))).newline,
      "\r\n",
    );
    assert.strictEqual(decodeTaskDocument(encode("---\r\nid: x\n")).newline, "\r\n");
    assert.strictEqual(decodeTaskDocument(encode("no frontmatter")).newline, "\n");
    assert.strictEqual(decodeTaskDocument(new Uint8Array([0xff])).newline, "\n");
  });

  it("exposes string scalars as written and leaves lists, mappings and numbers out", () => {
    const document = decodeTaskDocument(
      encode(
        task([
          ...FIELDS,
          "labels: work, jira",
          "blocked_by: fd-9ab3de, fd-2m9x4c",
          'assignee: "Jane Doe"',
          `updated: ${ISO}`,
          "estimate: 3",
          "tags: [a, b]",
          "notes:",
          "  - keep me",
          "empty:",
        ]),
      ),
    );
    assert.deepStrictEqual(document.diagnostics, []);
    assert.isTrue(document.editable);
    assert.deepStrictEqual(fieldsOf(document), {
      id,
      title: TITLE,
      status: "todo",
      labels: "work, jira",
      blocked_by: "fd-9ab3de, fd-2m9x4c",
      assignee: "Jane Doe",
      updated: ISO,
    });
  });

  it("reads an unknown status as read-only unknown, never done", () => {
    const bytes = encode(task(replacing("status", "status: shipped")));
    const document = decodeTaskDocument(bytes);
    assert.strictEqual(document.item?.status, "unknown");
    assert.isFalse(document.editable);
    assert.deepStrictEqual(problems(document), [["unknown_status", 4, "status"]]);
    const refusal = refused(editTaskDocument(bytes, { status: "done" }));
    assert.strictEqual(refusal.reason, "read_only");
    assert.strictEqual(refusal.code, "unknown_status");
  });

  it("changes the revision with any single-byte change", () => {
    const bytes = encode(task(FIELDS));
    const { revision } = decodeTaskDocument(bytes);
    assert.strictEqual(decodeTaskDocument(bytes.slice()).revision, revision);
    for (let index = 0; index < bytes.length; index += 1) {
      const changed = bytes.slice();
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      assert.notStrictEqual(decodeTaskDocument(changed).revision, revision, `byte ${index}`);
    }
    assert.notStrictEqual(decodeTaskDocument(concat(bytes, [0x20])).revision, revision);
    assert.notStrictEqual(decodeTaskDocument(bytes.subarray(0, -1)).revision, revision);
  });
});

describe("decodeTaskDocument diagnostics", () => {
  const fieldsThen = (...rows: ReadonlyArray<string>) => encode(task([...FIELDS, ...rows]));
  const aliasBomb = [
    'l0: &l0 ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]',
    ...Array.from({ length: 9 }, (_, level) => {
      const previous = `*l${level}`;
      return `l${level + 1}: &l${level + 1} [${Array(9).fill(previous).join(", ")}]`;
    }),
  ];
  const blockNesting = Array.from({ length: 40 }, (_, level) => `${"  ".repeat(level)}n${level}:`);
  const header = encode(task(FIELDS, "")).length;

  // [name, bytes, expected diagnostics, whether an item still decodes]
  const cases: ReadonlyArray<
    readonly [string, Uint8Array, ReadonlyArray<readonly [string, number, string | null]>, boolean]
  > = [
    [
      "invalid UTF-8 in the body",
      concat(encode(task(FIELDS, "\n## Description\nThe selected ")), [0xff], encode(" source\n")),
      [["invalid_utf8", 8, null]],
      false,
    ],
    [
      "invalid UTF-8 in a field",
      concat(encode(`---\nid: ${id}\ntitle: Caf`), [0xc3, 0x28], encode("\n")),
      [["invalid_utf8", 3, null]],
      false,
    ],
    [
      "a lead byte cut off by a line break",
      concat(encode(`---\nid: ${id}\ntitle: Caf`), [0xc3], encode("\nstatus: x\n")),
      [["invalid_utf8", 3, null]],
      false,
    ],
    [
      "a truncated sequence at the end",
      concat(encode(task(FIELDS, "\nlast line ")), [0xe2, 0x82]),
      [["invalid_utf8", 7, null]],
      false,
    ],
    [
      "a file of 1 MiB + 1 byte",
      encode(task(FIELDS, "x".repeat(MAX_TASK_DOCUMENT_BYTES - header + 1))),
      [["too_large", 1, null]],
      false,
    ],
    [
      "a duplicate title",
      fieldsThen("title: Another title"),
      [["duplicate_key", 5, "title"]],
      false,
    ],
    [
      "conflict markers in the body",
      encode(task(FIELDS, "\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> topic\n")),
      [["conflict_markers", 7, null]],
      true,
    ],
    [
      "conflict markers in the frontmatter",
      encode(
        task([
          `id: ${id}`,
          "<<<<<<< HEAD",
          "title: Mine",
          "=======",
          "title: Theirs",
          ">>>>>>> topic",
          "status: todo",
        ]),
      ),
      [["conflict_markers", 3, null]],
      false,
    ],
    [
      "8-character conflict markers",
      encode(task(FIELDS, "\n<<<<<<<< HEAD\nmine\n========\ntheirs\n>>>>>>>> topic\n")),
      [["conflict_markers", 7, null]],
      true,
    ],
    [
      "only the closing marker of a 9-character conflict",
      encode(task(FIELDS, "\nmine\n>>>>>>>>> topic\n")),
      [["conflict_markers", 8, null]],
      true,
    ],
    [
      "a complete set of 4-character conflict markers",
      encode(task(FIELDS, "\nIntro\n<<<< ours\nmine\n====\ntheirs\n>>>> topic\n")),
      [["conflict_markers", 8, null]],
      true,
    ],
    ["a missing id", encode(task(omitting("id"))), [["missing_field", 1, "id"]], false],
    ["a missing title", encode(task(omitting("title"))), [["missing_field", 1, "title"]], false],
    ["a missing status", encode(task(omitting("status"))), [["missing_field", 1, "status"]], false],
    [
      "a blank title",
      encode(task(replacing("title", 'title: "  "'))),
      [["invalid_field", 3, "title"]],
      false,
    ],
    [
      "an empty title",
      encode(task(replacing("title", "title:"))),
      [["invalid_field", 3, "title"]],
      false,
    ],
    [
      "an escaped multi-line title",
      encode(task(replacing("title", 'title: "First line\\nSecond line"'))),
      [["invalid_field", 3, "title"]],
      false,
    ],
    [
      "a literal multi-line title",
      encode(task(replacing("title", "title: |\n  First line\n  Second line"))),
      [["invalid_field", 3, "title"]],
      false,
    ],
    [
      "a numeric title",
      encode(task(replacing("title", "title: 2024"))),
      [["invalid_field", 3, "title"]],
      false,
    ],
    [
      "a UUID id",
      encode(task(replacing("id", "id: 7e2aa85e-9347-44ce-b019-cb8dfd365b20"))),
      [["invalid_field", 2, "id"]],
      false,
    ],
    [
      "a five-character id",
      encode(task(replacing("id", "id: fd-7k3qa"))),
      [["invalid_field", 2, "id"]],
      false,
    ],
    [
      "an id with an excluded letter",
      encode(task(replacing("id", "id: fd-7k3qai"))),
      [["invalid_field", 2, "id"]],
      false,
    ],
    [
      "a blank status",
      encode(task(replacing("status", 'status: ""'))),
      [["invalid_field", 4, "status"]],
      false,
    ],
    ["an alias bomb", fieldsThen(...aliasBomb), [["alias", 5, null]], true],
    [
      "deep flow nesting",
      fieldsThen(`nested: ${"[".repeat(40)}${"]".repeat(40)}`),
      [["too_deep", 5, null]],
      false,
    ],
    ["deep block nesting", fieldsThen(...blockNesting), [["too_deep", 37, null]], false],
    [
      "frontmatter that is not a mapping",
      encode(task([`- id: ${id}`, "- title: List"])),
      [["not_mapping", 2, null]],
      false,
    ],
    ["no frontmatter", encode(`# ${TITLE}\n`), [["missing_frontmatter", 1, null]], false],
    [
      "an unterminated frontmatter",
      encode(["---", ...FIELDS, "", "Body"].join("\n")),
      [["unterminated_frontmatter", 1, null]],
      false,
    ],
    ["invalid YAML", fieldsThen("labels: [unterminated"), [["yaml_syntax", 6, null]], false],
  ];

  it("reports each problem with its file line, keeping the original bytes", () => {
    for (const [name, bytes, expected, hasItem] of cases) {
      const original = bytes.slice();
      const document = decodeTaskDocument(bytes);
      assert.deepStrictEqual(problems(document), expected, name);
      assert.strictEqual(document.item !== undefined, hasItem, name);
      assert.isFalse(document.editable, name);
      assert.strictEqual(document.bytes, bytes, name);
      assert.deepStrictEqual(bytes, original, name);
      assert.match(document.revision, /^sha256:[0-9a-f]{64}$/, name);
      assert.isAbove(document.diagnostics[0]?.message.length ?? 0, 0, name);
    }
  });

  it("still exposes the string fields of a file whose item cannot be read", () => {
    const document = decodeTaskDocument(encode(task([...omitting("title"), "labels: work"])));
    assert.isUndefined(document.item);
    assert.deepStrictEqual(fieldsOf(document), { id, status: "todo", labels: "work" });
    assert.deepStrictEqual(fieldsOf(decodeTaskDocument(encode(`# ${TITLE}\n`))), {});
  });

  it("accepts a file of exactly 1 MiB", () => {
    const bytes = encode(task(FIELDS, "x".repeat(MAX_TASK_DOCUMENT_BYTES - header)));
    assert.strictEqual(bytes.byteLength, MAX_TASK_DOCUMENT_BYTES);
    assert.isTrue(decodeTaskDocument(bytes).editable);
  });

  it("reports an oversized file with the same diagnostic a source uses without reading it", () => {
    const document = decodeTaskDocument(new Uint8Array(MAX_TASK_DOCUMENT_BYTES + 1));
    assert.deepStrictEqual(document.diagnostics, [TOO_LARGE_DIAGNOSTIC]);
    assert.strictEqual(TOO_LARGE_DIAGNOSTIC.code, "too_large");
    assert.match(TOO_LARGE_DIAGNOSTIC.message, /larger than 1 MiB/);
  });

  it("keeps Markdown that only resembles short conflict markers editable", () => {
    const body = [
      "",
      "Heading",
      "===",
      "",
      ">>> nested quote",
      "",
      "<<< heredoc marker",
      "",
      "=========",
      ">>>>>> six-level quote",
      "<<<< opened but never separated",
      ">>>> closed",
      "",
      "Title",
      "=",
      "",
      "Subtitle",
      "==",
      "",
      "> quote",
      ">> nested quote",
      "",
      "< 5 ms latency",
      "<< shift left",
      "> quoted without a separator",
      ">> also without one",
      "",
    ].join("\n");
    const document = decodeTaskDocument(encode(task(FIELDS, body)));
    assert.deepStrictEqual(document.diagnostics, []);
    assert.isTrue(document.editable);
  });

  // Counting each key's line from the start of the file once made this take about 18 seconds;
  // it now takes well under one. The ceiling turns a return to quadratic work into a failure.
  it("decodes a key-heavy document and reports a line near its end", { timeout: 10_000 }, () => {
    const count = 40_000;
    const extra = Array.from({ length: count }, (_, index) => `k${index}: ${index}`);
    const clean = encode(task([...FIELDS, ...extra]));
    assert.isBelow(clean.byteLength, MAX_TASK_DOCUMENT_BYTES);
    const document = decodeTaskDocument(clean);
    assert.deepStrictEqual(document.diagnostics, []);
    assert.isTrue(document.editable);

    const repeated = decodeTaskDocument(encode(task([...FIELDS, ...extra, "status: done"])));
    assert.deepStrictEqual(problems(repeated), [["duplicate_key", 5 + count, "status"]]);
  });

  it("locates invalid UTF-8 at the end of a file of a million lines", () => {
    const bytes = new Uint8Array(MAX_TASK_DOCUMENT_BYTES).fill(0x0a);
    bytes[bytes.length - 1] = 0xff;
    assert.deepStrictEqual(problems(decodeTaskDocument(bytes)), [
      ["invalid_utf8", MAX_TASK_DOCUMENT_BYTES, null],
    ]);
  });

  it("refuses nesting deep enough to exhaust the parser's stack without throwing", () => {
    const depth = 20_000;
    const document = decodeTaskDocument(
      fieldsThen(`nested: ${"[".repeat(depth)}${"]".repeat(depth)}`),
    );
    assert.include(
      document.diagnostics.map(({ code }) => code),
      "too_deep",
    );
    assert.isUndefined(document.item);
  });

  it("decodes each document independently of the others", () => {
    const inputs = [
      encode(task(FIELDS)),
      ...cases.map(([, bytes]) => bytes),
      encode(task(replacing("status", "status: done"))),
    ];
    const alone = inputs.map((bytes) => decodeTaskDocument(bytes));
    const interleaved = inputs.toReversed().map((bytes) => decodeTaskDocument(bytes));
    assert.deepStrictEqual(interleaved.toReversed(), alone);
    assert.strictEqual(alone[0]?.item?.status, "todo");
    assert.strictEqual(alone.at(-1)?.item?.status, "done");
  });
});

describe("editTaskDocument fields", () => {
  const crlf = `﻿${task(FIELDS, "\r\nBody line\r\n", "\r\n")}`;

  it("patches only the title's bytes in a BOM and CRLF document", () => {
    const before = encode(crlf);
    const document = written(editTaskDocument(before, { title: "Keep source on reconnect" }));
    assert.deepStrictEqual(
      document.bytes,
      encode(crlf.replace(`title: ${TITLE}`, "title: Keep source on reconnect")),
    );
    assertChangedOnlyWithin(before, document.bytes, ...byteSpan(crlf, TITLE));
    assert.deepStrictEqual(document.bytes.subarray(0, 3), new Uint8Array([0xef, 0xbb, 0xbf]));
    assert.strictEqual(document.item?.title, "Keep source on reconnect");
    assert.isTrue(document.editable);
  });

  it("keeps a trailing comment on the patched line", () => {
    const text = task([...omitting("status"), "status: todo # moved by hand"]);
    const before = encode(text);
    const document = written(editTaskDocument(before, { status: "in_progress" }));
    assert.deepStrictEqual(
      document.bytes,
      encode(text.replace("status: todo #", "status: in_progress #")),
    );
    const [start] = byteSpan(text, "todo # moved");
    assertChangedOnlyWithin(before, document.bytes, start, start + "todo".length);
    assert.strictEqual(document.item?.status, "in_progress");

    const quoted = task(replacing("title", `title: "${TITLE}" # shown in lists`));
    const retitled = written(editTaskDocument(encode(quoted), { title: "Shorter" }));
    assert.deepStrictEqual(retitled.bytes, encode(quoted.replace(`"${TITLE}" #`, '"Shorter" #')));
  });

  it("keeps unknown keys, comments and key order around several patches", () => {
    const rows = (title: string, status: string) => [
      "# Planning notes stay with the task.",
      "owner: platform # team",
      'labels: [sync, "reconnect"]',
      `id: ${id}`,
      `title: ${title}`,
      "notes:",
      "  - keep me",
      "  - nested: {depth: 2}",
      `status: ${status}`,
      "estimate: 3",
    ];
    const before = encode(task(rows(TITLE, "todo")));
    const document = written(
      editTaskDocument(before, { title: "Keep source", status: "in_progress" }),
    );
    assert.deepStrictEqual(document.bytes, encode(task(rows("Keep source", "in_progress"))));
    assert.deepStrictEqual(document.item, {
      id,
      title: "Keep source",
      status: "in_progress",
      body: BODY,
      revision: document.revision,
    });
    assert.deepStrictEqual(fieldsOf(document), {
      owner: "platform",
      id,
      title: "Keep source",
      status: "in_progress",
    });
  });

  it("writes each scalar style, escaping only what that style needs", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['"Fix \\"quoted\\" path"', 'Say "hi" \\ back', '"Say \\"hi\\" \\\\ back"'],
      ["'It''s fine'", "Don't stop", "'Don''t stop'"],
      ["'It''s fine'", "Tab\there", "'Tab\there'"],
      ["'It''s fine'", "Bell\u0007", '"Bell\\u0007"'],
      ["Plain title", "Still plain", "Still plain"],
      ["Plain title", "Status: done # not a comment", '"Status: done # not a comment"'],
      ["Plain title", "123", '"123"'],
      ["Plain title", "yes", '"yes"'],
      ["Plain title", "#hashtag", '"#hashtag"'],
      ["Plain title", "  padded  ", '"  padded  "'],
      ["Plain title", "Café ünïcode 🚀", "Café ünïcode 🚀"],
    ];
    for (const [source, title, rendered] of cases) {
      const text = task(replacing("title", `title: ${source}`));
      const before = encode(text);
      const document = written(editTaskDocument(before, { title }));
      assert.deepStrictEqual(
        document.bytes,
        encode(text.replace(`title: ${source}`, `title: ${rendered}`)),
        title,
      );
      assertChangedOnlyWithin(before, document.bytes, ...byteSpan(text, source));
      assert.strictEqual(document.item?.title, title);
    }
  });

  it("leaves the bytes identical when no value changes", () => {
    const before = encode(task(FIELDS));
    const document = written(editTaskDocument(before, { id, title: TITLE, status: "todo" }));
    assert.deepStrictEqual(document.bytes, before);
  });

  it("inserts a missing optional field before the closing delimiter in the file's newline style", () => {
    const before = encode(crlf);
    const document = written(editTaskDocument(before, { fields: { priority: "high" } }));
    const expected = `﻿${task([...FIELDS, "priority: high"], "\r\nBody line\r\n", "\r\n")}`;
    assert.deepStrictEqual(document.bytes, encode(expected));
    const closing = byteSpan(crlf, "---\r\n\r\nBody")[0];
    assertChangedOnlyWithin(before, document.bytes, closing, closing);
    assert.strictEqual(document.fields.get("priority"), "high");
    assert.deepStrictEqual(document.item, {
      id,
      title: TITLE,
      status: "todo",
      body: "\r\nBody line\r\n",
      revision: document.revision,
    });

    const lf = written(
      editTaskDocument(encode(task(FIELDS)), {
        fields: { labels: "work, jira", priority: "Needs: quotes", updated: ISO },
      }),
    );
    assert.deepStrictEqual(
      lf.bytes,
      encode(
        task([...FIELDS, "labels: work, jira", 'priority: "Needs: quotes"', `updated: "${ISO}"`]),
      ),
    );
    assert.strictEqual(lf.fields.get("labels"), "work, jira");
    assert.strictEqual(lf.fields.get("updated"), ISO);
  });

  it("patches an existing optional field in place", () => {
    const text = task([...FIELDS, "priority: low # triage", `updated: ${ISO}`]);
    const later = "2026-10-22T08:30:00.000Z";
    const document = written(
      editTaskDocument(encode(text), { fields: { priority: "high", updated: later } }),
    );
    assert.deepStrictEqual(
      document.bytes,
      encode(text.replace("low #", "high #").replace(`updated: ${ISO}`, `updated: "${later}"`)),
    );
    assert.strictEqual(document.fields.get("updated"), later);
    const refusal = refused(
      editTaskDocument(encode(task([...FIELDS, "tags: [a]"])), { fields: { tags: "b" } }),
    );
    assert.strictEqual(refusal.reason, "invalid_value");
    assert.strictEqual(refusal.field, "tags");
  });

  it("writes into a blank optional field in place, keeping its line and trailing comment", () => {
    const text = task([...FIELDS, "updated:", "assignee: ", "labels: # none", "parent:\t# fixme"]);
    const document = written(
      editTaskDocument(encode(text), {
        fields: { updated: ISO, assignee: "Sam", labels: "work, sync", parent: otherId },
      }),
    );
    assert.deepStrictEqual(
      document.bytes,
      encode(
        task([
          ...FIELDS,
          `updated: "${ISO}"`,
          "assignee: Sam",
          "labels: work, sync # none",
          `parent:\t${otherId} # fixme`,
        ]),
      ),
    );
    assert.deepStrictEqual(
      [...document.fields].filter(([name]) => !FIELDS.some((row) => row.startsWith(`${name}:`))),
      [
        ["updated", ISO],
        ["assignee", "Sam"],
        ["labels", "work, sync"],
        ["parent", otherId],
      ],
    );
    assert.isTrue(document.editable);

    const crlf = task([...FIELDS, "updated:"], "\r\nBody\r\n", "\r\n");
    assert.deepStrictEqual(
      written(editTaskDocument(encode(crlf), { fields: { updated: ISO } })).bytes,
      encode(task([...FIELDS, `updated: "${ISO}"`], "\r\nBody\r\n", "\r\n")),
    );
    const unterminated = `---\n${FIELDS.join("\n")}\nupdated:\n---`;
    assert.deepStrictEqual(
      written(editTaskDocument(encode(unterminated), { fields: { updated: ISO } })).bytes,
      encode(`---\n${FIELDS.join("\n")}\nupdated: "${ISO}"\n---`),
    );
    // A blank key is still removable, and a blank required field stays unreadable.
    assert.deepStrictEqual(
      written(
        editTaskDocument(encode(task([...FIELDS, "updated:"])), { fields: { updated: null } }),
      ).bytes,
      encode(task(FIELDS)),
    );
    const blankTitle = decodeTaskDocument(encode(task(replacing("title", "title:"))));
    assert.deepStrictEqual(problems(blankTitle), [["invalid_field", 3, "title"]]);
  });

  it("removes an optional field's own line and refuses any other form", () => {
    const text = task([...FIELDS, "priority: low # triage", "labels: work, jira"]);
    const document = written(editTaskDocument(encode(text), { fields: { priority: null } }));
    assert.deepStrictEqual(document.bytes, encode(task([...FIELDS, "labels: work, jira"])));
    assert.isFalse(document.fields.has("priority"));
    assert.strictEqual(document.fields.get("labels"), "work, jira");

    const last = task([...FIELDS, "priority: low"], "\r\nBody\r\n", "\r\n");
    const trailing = written(editTaskDocument(encode(last), { fields: { priority: null } }));
    assert.deepStrictEqual(trailing.bytes, encode(task(FIELDS, "\r\nBody\r\n", "\r\n")));

    const untouched = encode(task(FIELDS));
    assert.deepStrictEqual(
      written(editTaskDocument(untouched, { fields: { missing: null } })).bytes,
      untouched,
    );

    for (const rows of [
      ["notes:", "  - keep me"],
      ["summary: |", "  Two", "  lines"],
      ["? summary", ": value"],
    ]) {
      const name = rows[0]?.replace(/^\? |:.*$/g, "") ?? "";
      const refusal = refused(
        editTaskDocument(encode(task([...FIELDS, ...rows])), { fields: { [name]: null } }),
      );
      assert.strictEqual(refusal.reason, "invalid_value", rows.join("|"));
      assert.strictEqual(refusal.field, name);
    }
  });

  it("keeps required fields and identity out of optional-field writes", () => {
    const before = encode(task(FIELDS));
    assert.strictEqual(
      refused(editTaskDocument(before, { fields: { id: otherId } })).reason,
      "identity_change",
    );
    assert.strictEqual(
      refused(editTaskDocument(before, { fields: { id: null } })).reason,
      "identity_change",
    );
    for (const fields of [
      { title: "Other" },
      { status: "done" },
      { "Bad Name": "x" },
      { note: "a\nb" },
    ]) {
      assert.strictEqual(refused(editTaskDocument(before, { fields })).reason, "invalid_value");
    }
  });

  it("refuses values that cannot be written", () => {
    const before = encode(task(FIELDS));
    const invalid: ReadonlyArray<readonly [string, Parameters<typeof editTaskDocument>[1]]> = [
      ["title", { title: "Two\nlines" }],
      ["title", { title: " " }],
      ["title", { title: "x".repeat(513) }],
      // A caller that skipped contract decoding still cannot write an unknown status.
      ["status", { status: "shipped" as WorkNativeStatus }],
    ];
    for (const [field, edit] of invalid) {
      const refusal = refused(editTaskDocument(before, edit));
      assert.strictEqual(refusal.reason, "invalid_value", field);
      assert.strictEqual(refusal.field, field);
    }
  });
});

describe("editTaskDocument refusals", () => {
  const readOnly: ReadonlyArray<
    readonly [string, string, ReadonlyArray<readonly [string, number, string | null]>, boolean]
  > = [
    [
      "a block-scalar title",
      task(replacing("title", "title: >-\n  Keep selected source")),
      [["unsupported_form", 3, "title"]],
      true,
    ],
    [
      "a title continued on the next line",
      task(replacing("title", "title: Keep selected\n  source")),
      [["unsupported_form", 3, "title"]],
      true,
    ],
    [
      "a title on the line after its key",
      task(replacing("title", "title:\n  Keep selected source")),
      [["unsupported_form", 4, "title"]],
      true,
    ],
    [
      "a tagged status",
      task(replacing("status", "status: !!str todo")),
      [["unsupported_form", 4, "status"]],
      true,
    ],
    [
      "a flow-mapped frontmatter",
      task([`{id: ${id}, title: Keep, status: todo}`]),
      [["unsupported_form", 2, null]],
      true,
    ],
    [
      "a flow-mapped status",
      task(replacing("status", "status: {name: todo}")),
      [["invalid_field", 4, "status"]],
      false,
    ],
    [
      "an anchored title",
      task([...replacing("title", `title: &title ${TITLE}`), "title_copy: *title"]),
      [
        ["alias", 3, "title"],
        ["alias", 5, null],
      ],
      true,
    ],
    [
      "an aliased title",
      task([`ref: &ref ${TITLE}`, ...replacing("title", "title: *ref")]),
      [
        ["alias", 2, null],
        ["alias", 4, "title"],
      ],
      false,
    ],
    ["a merge key", task([...FIELDS, "<<: {title: Merged title}"]), [["merge_key", 5, null]], true],
    [
      "a merge key from an alias",
      task(["base: &base {title: Merged title}", ...FIELDS, "<<: *base"]),
      [
        ["alias", 2, null],
        ["merge_key", 6, null],
      ],
      true,
    ],
    [
      "a duplicate status",
      task([...FIELDS, "status: done"]),
      [["duplicate_key", 5, "status"]],
      false,
    ],
    [
      "a title repeated with a quoted key",
      task([...FIELDS, '"title": Other title']),
      [["duplicate_key", 5, "title"]],
      false,
    ],
    [
      "a merge key in a nested mapping",
      task([...FIELDS, "metadata:", "  <<: {x: y}"]),
      [["merge_key", 6, null]],
      true,
    ],
    [
      "a merge key in a list item",
      task([...FIELDS, "items:", "  - <<: {x: y}"]),
      [["merge_key", 6, null]],
      true,
    ],
    [
      "a merge key in a flow mapping",
      task([...FIELDS, "extra: {<<: {a: 1}}"]),
      [["merge_key", 5, null]],
      true,
    ],
    [
      "duplicate list keys",
      task([...FIELDS, "? [x, y]", ": 1", "? [x, y]", ": 2"]),
      [["complex_key", 5, null]],
      true,
    ],
    ["a mapping key", task([...FIELDS, "? {a: 1}", ": value"]), [["complex_key", 5, null]], true],
    [
      "a date key",
      task([...FIELDS, "!!timestamp 2001-12-14: release"]),
      [["complex_key", 5, null]],
      true,
    ],
    [
      "duplicate NaN keys",
      task([...FIELDS, ".nan: first", ".NaN: second"]),
      [["duplicate_key", 6, null]],
      false,
    ],
    [
      "a duplicate nested key",
      task([...FIELDS, "metadata:", "  owner: a", "  owner: b"]),
      [["duplicate_key", 7, null]],
      false,
    ],
    // `git merge-file --marker-size=2` and `--marker-size=1` write these.
    [
      "a complete set of 2-character conflict markers",
      task(FIELDS, "\nIntro\n<< ours\nmine\n==\ntheirs\n>> theirs\n"),
      [["conflict_markers", 8, null]],
      true,
    ],
    [
      "a complete set of 1-character conflict markers",
      task(FIELDS, "\nIntro\n< ours\nmine\n=\ntheirs\n> theirs\n"),
      [["conflict_markers", 8, null]],
      true,
    ],
    [
      "a diff3 set of 2-character conflict markers",
      task(FIELDS, "\n<<\nmine\n|| base\noriginal\n==\ntheirs\n>>\n"),
      [["conflict_markers", 7, null]],
      true,
    ],
  ];

  it("keeps keys that differ only in type distinct", () => {
    const text = task([...FIELDS, "1: number", '"1": text', "true: boolean", '"true": text']);
    const document = decodeTaskDocument(encode(text));
    assert.deepStrictEqual(document.diagnostics, []);
    assert.isTrue(document.editable);
  });

  it("disables form edits with the reason and refuses patches without touching the bytes", () => {
    for (const [name, text, expected, hasItem] of readOnly) {
      const bytes = encode(text);
      const original = bytes.slice();
      const document = decodeTaskDocument(bytes);
      assert.deepStrictEqual(problems(document), expected, name);
      assert.strictEqual(document.item !== undefined, hasItem, name);
      assert.isFalse(document.editable, name);
      for (const edit of [
        { status: "done" as const },
        { title: "Other" },
        { body: "New body\n" },
        { fields: { priority: "high" } },
        { fields: { priority: null } },
      ]) {
        const refusal = refused(editTaskDocument(bytes, edit));
        assert.strictEqual(refusal.reason, "read_only", name);
        assert.strictEqual(refusal.code, expected[0]?.[0], name);
        assert.strictEqual(refusal.line, expected[0]?.[1], name);
      }
      assert.deepStrictEqual(bytes, original, name);
    }
  });

  it("keeps the readable value of a block-scalar title", () => {
    const document = decodeTaskDocument(
      encode(task(replacing("title", "title: >-\n  Keep selected source"))),
    );
    assert.strictEqual(document.item?.title, "Keep selected source");
  });

  it("rejects a patch that would change the id", () => {
    const bytes = encode(task(FIELDS));
    const original = bytes.slice();
    for (const changed of [otherId, "not-an-id"]) {
      const refusal = refused(editTaskDocument(bytes, { id: changed, title: "Other" }));
      assert.strictEqual(refusal.reason, "identity_change");
      assert.strictEqual(refusal.field, "id");
    }
    assert.deepStrictEqual(bytes, original);
    const sameId = written(editTaskDocument(bytes, { id: id.toUpperCase(), title: "Other" }));
    assert.strictEqual(sameId.item?.id, id);
    assert.strictEqual(sameId.item?.title, "Other");
  });
});

describe("editTaskDocument body", () => {
  const frontmatter = `﻿${task(FIELDS, "", "\r\n")}`;

  it("replaces exactly the bytes after the closing delimiter", () => {
    const before = encode(`${frontmatter}\r\nOld body\r\n- [ ] Open item\r\n`);
    const body = "## Done\r\n- [x] Reconnect retains the selected source.\r\n";
    const document = written(editTaskDocument(before, { body }));
    assert.deepStrictEqual(document.bytes, encode(`${frontmatter}${body}`));
    const length = encode(frontmatter).length;
    assert.deepStrictEqual(document.bytes.subarray(0, length), before.subarray(0, length));
    assert.strictEqual(document.item?.body, body);
    assert.strictEqual(document.item?.status, "todo");
  });

  it("writes an empty body", () => {
    const document = written(
      editTaskDocument(encode(`${frontmatter}\r\nOld body\r\n`), { body: "" }),
    );
    assert.deepStrictEqual(document.bytes, encode(frontmatter));
    assert.strictEqual(document.item?.body, "");
  });

  it("never derives the status from checkboxes", () => {
    const before = encode(task(FIELDS, "- [ ] First\n- [ ] Second\n"));
    const document = written(editTaskDocument(before, { body: "- [x] First\n- [x] Second\n" }));
    assert.deepStrictEqual(document.bytes, encode(task(FIELDS, "- [x] First\n- [x] Second\n")));
    assert.strictEqual(document.item?.status, "todo");
    assert.strictEqual(decodeTaskDocument(document.bytes).item?.status, "todo");
  });

  it("separates a body from a closing delimiter at the end of the file", () => {
    const bare = ["---", ...FIELDS, "---"].join("\r\n");
    assert.strictEqual(decodeTaskDocument(encode(bare)).item?.body, "");
    const document = written(editTaskDocument(encode(bare), { body: "Notes\r\n" }));
    assert.deepStrictEqual(document.bytes, encode(`${bare}\r\nNotes\r\n`));
    assert.strictEqual(document.item?.body, "Notes\r\n");
  });

  it("patches a field, an optional field and the body together", () => {
    const document = written(
      editTaskDocument(encode(task(FIELDS)), {
        status: "done",
        body: "Shipped.\n",
        fields: { updated: ISO },
      }),
    );
    assert.deepStrictEqual(
      document.bytes,
      encode(task([...replacing("status", "status: done"), `updated: "${ISO}"`], "Shipped.\n")),
    );
  });

  it("refuses a body that would leave the document read-only", () => {
    const bytes = encode(task(FIELDS));
    const refusal = refused(
      editTaskDocument(bytes, { body: "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> x\n" }),
    );
    assert.strictEqual(refusal.reason, "invalid_value");
    assert.strictEqual(refusal.field, "body");
    assert.strictEqual(refusal.code, "conflict_markers");
  });
});

describe("renderTaskDocument", () => {
  const itemId = WorkItemId.make(id);

  it("renders a document that decodes back to the same model", () => {
    const created = written(renderTaskDocument({ id: itemId, title: TITLE, status: "todo" }));
    assert.strictEqual(created.filename, "fd-7k3qa2-keep-selected-source-after-reconnect.md");
    assert.deepStrictEqual(created.bytes, encode(task(FIELDS, "")));
    const document = decodeTaskDocument(created.bytes);
    assert.deepStrictEqual(document.diagnostics, []);
    assert.isTrue(document.editable);
    assert.deepStrictEqual(document.item, {
      id,
      title: TITLE,
      status: "todo",
      body: "",
      revision: document.revision,
    });
  });

  it("inserts a template body once, as given", () => {
    const body = "## Description\n\n## Acceptance criteria\n- [ ] \n";
    const created = written(
      renderTaskDocument({ id: itemId, title: TITLE, status: "in_progress", body }),
    );
    assert.deepStrictEqual(
      created.bytes,
      encode(task(replacing("status", "status: in_progress"), body)),
    );
    assert.strictEqual(decodeTaskDocument(created.bytes).item?.body, body);
  });

  it("renders optional fields in a fixed order, quoting what other readers would misread", () => {
    const fields = {
      custom: "x",
      updated: ISO,
      labels: "work, jira",
      priority: "high",
      blocked_by: "fd-9ab3de, fd-2m9x4c",
      created: ISO,
      assignee: "yes",
    };
    const created = written(
      renderTaskDocument({ id: itemId, title: TITLE, status: "todo", fields }),
    );
    assert.deepStrictEqual(
      created.bytes,
      encode(
        task(
          [
            ...FIELDS,
            "priority: high",
            "labels: work, jira",
            'assignee: "yes"',
            "blocked_by: fd-9ab3de, fd-2m9x4c",
            `created: "${ISO}"`,
            `updated: "${ISO}"`,
            "custom: x",
          ],
          "",
        ),
      ),
    );
    const document = decodeTaskDocument(created.bytes);
    assert.isTrue(document.editable);
    assert.deepStrictEqual(fieldsOf(document), { id, title: TITLE, status: "todo", ...fields });
  });

  it("sanitizes the filename and round-trips any title", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["src/server: fix ../path", "fd-7k3qa2-src-server-fix-path.md"],
      ["Café ünïcode 🚀 测试", "fd-7k3qa2-cafe-unicode.md"],
      ["..hidden/.env leak", "fd-7k3qa2-hidden-env-leak.md"],
      ["\\\\server\\share\\..", "fd-7k3qa2-server-share.md"],
      ["🚀 测试", "fd-7k3qa2.md"],
      ["123", "fd-7k3qa2-123.md"],
      ["yes", "fd-7k3qa2-yes.md"],
      ['Say "hi" # now', "fd-7k3qa2-say-hi-now.md"],
      ["- [ ] looks like a list", "fd-7k3qa2-looks-like-a-list.md"],
      [`${"word ".repeat(40)}end`, `fd-7k3qa2-${"word-".repeat(12).slice(0, -1)}.md`],
    ];
    for (const [title, filename] of cases) {
      for (const status of WorkNativeStatus.literals) {
        const created = written(renderTaskDocument({ id: itemId, title, status }));
        assert.strictEqual(created.filename, filename, title);
        assert.match(created.filename, /^fd-[0-9a-hjkmnp-tv-z]{6}(?:-[a-z0-9]+)*\.md$/);
        const document = decodeTaskDocument(created.bytes);
        assert.deepStrictEqual(document.diagnostics, [], title);
        assert.deepStrictEqual(
          document.item,
          { id: itemId, title, status, body: "", revision: document.revision },
          title,
        );
      }
    }
  });

  it("refuses inputs whose rendered file would not decode to the same values", () => {
    const loneSurrogate = String.fromCharCode(0xd800);
    const header = written(renderTaskDocument({ id: itemId, title: TITLE, status: "todo" })).bytes
      .length;
    const cases: ReadonlyArray<
      readonly [Parameters<typeof renderTaskDocument>[0], string, string | undefined]
    > = [
      [{ id: itemId, title: "", status: "todo" }, "title", undefined],
      [{ id: itemId, title: "   ", status: "todo" }, "title", undefined],
      [{ id: itemId, title: "Two\nlines", status: "todo" }, "title", undefined],
      [{ id: itemId, title: "x".repeat(513), status: "todo" }, "title", undefined],
      [{ id: itemId, title: `Half ${loneSurrogate} pair`, status: "todo" }, "title", undefined],
      // Callers that skipped contract decoding still cannot render an unwritable identity or status.
      [{ id: itemId, title: TITLE, status: "shipped" as WorkNativeStatus }, "status", undefined],
      [{ id: "not-an-id" as WorkItemId, title: TITLE, status: "todo" }, "id", undefined],
      [{ id: id.toUpperCase() as WorkItemId, title: TITLE, status: "todo" }, "id", undefined],
      [{ id: itemId, title: TITLE, status: "todo", fields: { id: otherId } }, "id", undefined],
      [{ id: itemId, title: TITLE, status: "todo", fields: { title: "x" } }, "title", undefined],
      [{ id: itemId, title: TITLE, status: "todo", fields: { note: "a\nb" } }, "note", undefined],
      [
        { id: itemId, title: TITLE, status: "todo", fields: { "Bad Name": "x" } },
        "Bad Name",
        undefined,
      ],
      [
        {
          id: itemId,
          title: TITLE,
          status: "todo",
          body: "x".repeat(MAX_TASK_DOCUMENT_BYTES - header + 1),
        },
        "body",
        "too_large",
      ],
      [
        {
          id: itemId,
          title: TITLE,
          status: "todo",
          body: "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> topic\n",
        },
        "body",
        "conflict_markers",
      ],
      [
        { id: itemId, title: TITLE, status: "todo", body: `Half ${loneSurrogate} pair\n` },
        "body",
        undefined,
      ],
    ];
    for (const [input, field, code] of cases) {
      const refusal = refused(renderTaskDocument(input));
      assert.strictEqual(refusal.reason, "invalid_value", field);
      assert.strictEqual(refusal.field, field);
      assert.strictEqual(refusal.code, code, field);
    }
    const exactLimit = renderTaskDocument({
      id: itemId,
      title: TITLE,
      status: "todo",
      body: "x".repeat(MAX_TASK_DOCUMENT_BYTES - header),
    });
    assert.strictEqual(written(exactLimit).bytes.length, MAX_TASK_DOCUMENT_BYTES);
  });
});
