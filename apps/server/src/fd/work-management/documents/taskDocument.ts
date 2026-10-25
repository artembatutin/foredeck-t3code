// @effect-diagnostics-next-line nodeBuiltinImport:off -- the codec hashes synchronously.
import * as NodeCrypto from "node:crypto";

import {
  isWorkNativeStatus,
  WorkItemId,
  WorkItemTitle,
  type WorkNativeStatus,
  type WorkStatus,
} from "@t3tools/contracts/fd/work-management";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type ParsedNode,
  Scalar,
} from "yaml";

import { parseTaskId, taskFilename } from "./taskFiles.ts";

/** Larger files are listed with a diagnostic and never parsed. */
export const MAX_TASK_DOCUMENT_BYTES = 1024 * 1024;
// Work fields are flat; nesting this deep only comes from generated or hostile files.
const MAX_FRONTMATTER_DEPTH = 32;
const MAX_YAML_ERRORS = 10;

const TaskDiagnosticCode = Schema.Literals([
  "too_large",
  "invalid_utf8",
  "missing_frontmatter",
  "unterminated_frontmatter",
  "conflict_markers",
  "yaml_syntax",
  "duplicate_key",
  "complex_key",
  "too_deep",
  "not_mapping",
  "alias",
  "merge_key",
  "missing_field",
  "invalid_field",
  "unsupported_form",
  "unknown_status",
]);
export type TaskDiagnosticCode = typeof TaskDiagnosticCode.Type;

/** Every task document has these frontmatter fields. */
const REQUIRED_FIELDS = ["id", "title", "status"] as const;
export type TaskField = (typeof REQUIRED_FIELDS)[number];

const isRequiredField = (name: string): name is TaskField =>
  REQUIRED_FIELDS.some((field) => field === name);

const READ_ONLY_GUIDANCE = "Work shows the file read-only until it is fixed in an external editor.";

const INVALID_FIELD: Record<TaskField, string> = {
  id: "must be `fd-` followed by six base32 characters (0-9 and a-z without i, l, o or u).",
  title: "must be nonblank single-line text of at most 512 characters.",
  status: "must be nonblank single-line text.",
};

const named = (field: string | undefined) => (field === undefined ? "A field" : `\`${field}\``);

const problemText = (code: TaskDiagnosticCode, field: TaskField | undefined): string => {
  switch (code) {
    case "too_large":
      return "The file is larger than 1 MiB.";
    case "invalid_utf8":
      return "The file is not valid UTF-8 text.";
    case "missing_frontmatter":
      return "The file does not start with a `---` frontmatter line.";
    case "unterminated_frontmatter":
      return "The frontmatter has no closing `---` line.";
    case "conflict_markers":
      return "The file contains unresolved merge conflict markers.";
    case "yaml_syntax":
      return "The frontmatter is not valid YAML.";
    case "duplicate_key":
      return field === undefined
        ? "The frontmatter repeats a key."
        : `The frontmatter repeats ${named(field)}.`;
    case "complex_key":
      return "The frontmatter uses a list, mapping, date or binary value as a key.";
    case "too_deep":
      return `The frontmatter nests deeper than ${MAX_FRONTMATTER_DEPTH} levels.`;
    case "not_mapping":
      return "The frontmatter is not a set of `key: value` fields.";
    case "alias":
      return field === undefined
        ? "The frontmatter uses a YAML anchor or alias."
        : `${named(field)} uses a YAML anchor or alias.`;
    case "merge_key":
      return "The frontmatter uses a `<<` merge key.";
    case "missing_field":
      return `${named(field)} is missing.`;
    case "invalid_field":
      return `${named(field)} ${field === undefined ? "has an unusable value." : INVALID_FIELD[field]}`;
    case "unsupported_form":
      return field === undefined
        ? "The fields are written in a YAML form Work cannot edit in place."
        : `${named(field)} is written in a YAML form Work cannot edit in place.`;
    case "unknown_status":
      return "`status` is not a status this version of Work knows.";
  }
};

export interface TaskDocumentDiagnostic {
  readonly code: TaskDiagnosticCode;
  /** 1-based line in the file. Problems with the whole file point at line 1. */
  readonly line: number;
  readonly field?: TaskField;
  readonly message: string;
}

const diagnostic = (
  code: TaskDiagnosticCode,
  line: number,
  field?: TaskField,
): TaskDocumentDiagnostic => ({
  code,
  line,
  ...(field === undefined ? {} : { field }),
  message: `${problemText(code, field)} ${READ_ONLY_GUIDANCE}`,
});

/** The diagnostic of a file whose size alone exceeds the cap, for a source that never reads it. */
export const TOO_LARGE_DIAGNOSTIC: TaskDocumentDiagnostic = diagnostic("too_large", 1);

/**
 * Why an edit left the bytes alone or a new document was not rendered. Nothing is ever
 * reserialized to make a write fit.
 *
 * `read_only`: the document has a diagnostic (`code`, `line`) and is never rewritten.
 * `identity_change`: the edit would change the document's `id`.
 * `invalid_value`: the value cannot be written, or the written file would not decode to exactly
 * the requested values without a diagnostic (`code`, `line`).
 */
export class TaskDocumentWriteRefused extends Schema.TaggedError<TaskDocumentWriteRefused>()(
  "TaskDocumentWriteRefused",
  {
    reason: Schema.Literals(["read_only", "identity_change", "invalid_value"]),
    field: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(TaskDiagnosticCode),
    line: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const field = this.field !== undefined && isRequiredField(this.field) ? this.field : undefined;
    switch (this.reason) {
      case "read_only":
        return this.code === undefined
          ? READ_ONLY_GUIDANCE
          : `${problemText(this.code, field)} ${READ_ONLY_GUIDANCE}`;
      case "identity_change":
        return "An edit cannot change a task's `id`.";
      case "invalid_value":
        return this.code === undefined
          ? `${named(this.field)} cannot be written with this value.`
          : `The written file would be read-only: ${problemText(this.code, field)}`;
    }
  }
}

const refusal = (
  reason: TaskDocumentWriteRefused["reason"],
  details: { readonly field?: string | undefined; readonly diagnostic?: TaskDocumentDiagnostic },
) => {
  const field = details.field ?? details.diagnostic?.field;
  return Result.fail(
    new TaskDocumentWriteRefused({
      reason,
      ...(field === undefined ? {} : { field }),
      ...(details.diagnostic === undefined
        ? {}
        : { code: details.diagnostic.code, line: details.diagnostic.line }),
    }),
  );
};

export interface TaskItem {
  /** Frontmatter `id`, lowercased: the identity. The filename is a mutable locator. */
  readonly id: WorkItemId;
  readonly title: string;
  /** `unknown` for a status this version does not know, which leaves the item read-only. */
  readonly status: WorkStatus;
  /** Every byte after the closing delimiter line. Checkboxes in it never imply a status. */
  readonly body: string;
  readonly revision: string;
}

export interface TaskDocument {
  /** The bytes that were decoded, unchanged. */
  readonly bytes: Uint8Array;
  /** Digest of every byte, so any change is a new revision. */
  readonly revision: string;
  /** The first line's break, `\n` when it has none: what text appended to the body uses. */
  readonly newline: "\n" | "\r\n";
  /** Absent when a required field cannot be read. */
  readonly item: TaskItem | undefined;
  /**
   * Every top-level field whose value is a string scalar, as written. A list, mapping or
   * non-string value is simply not here; `taskFiles.ts` interprets the known optional fields.
   */
  readonly fields: ReadonlyMap<string, string>;
  /** Sorted by line. Each one makes the document read-only. */
  readonly diagnostics: ReadonlyArray<TaskDocumentDiagnostic>;
  /** Whether edits may patch these bytes: the item decoded without any diagnostic. */
  readonly editable: boolean;
}

type ScalarStyle = "plain" | "single" | "double";

const STYLES: Partial<Record<string, ScalarStyle>> = {
  [Scalar.PLAIN]: "plain",
  [Scalar.QUOTE_SINGLE]: "single",
  [Scalar.QUOTE_DOUBLE]: "double",
};

interface Entry {
  readonly value: unknown;
  /**
   * Offsets of a value written as one in-place flow scalar; absent for any other form. A blank
   * value (`key:`) has a zero-width span plus the spacing a scalar inserted there needs to be
   * read as the value: `before` separates it from the colon, `after` from a trailing comment.
   */
  readonly span:
    | {
        readonly start: number;
        readonly end: number;
        readonly style: ScalarStyle;
        readonly before: string;
        readonly after: string;
      }
    | undefined;
  /**
   * Offsets of the whole line, key through its line break, when the pair is written on exactly
   * one line that starts with the key; absent for any other form. Removing it removes the field.
   */
  readonly line: { readonly start: number; readonly end: number } | undefined;
}

interface FieldEntry extends Entry {
  readonly node: ParsedNode | null;
  readonly keyAnchored: boolean;
  /** Where the value, or a missing value's key, starts in the frontmatter. */
  readonly offset: number;
}

/** Where edits may write in an editable document's decoded text. */
interface Layout {
  readonly text: string;
  readonly newline: "\n" | "\r\n";
  readonly closingStart: number;
  readonly bodyStart: number;
  readonly closingTerminated: boolean;
  /** Top-level fields with string keys. */
  readonly entries: ReadonlyMap<string, Entry>;
}

type Parsed =
  | { readonly document: TaskDocument & { readonly item: TaskItem }; readonly layout: Layout }
  | { readonly document: TaskDocument; readonly layout: undefined };

const isWorkItemTitle = Schema.is(WorkItemTitle);

// In `u` mode a well-formed surrogate pair is one code point, so this matches only lone halves.
const LONE_SURROGATE = /\p{Cs}/u;
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LINE_BREAK = /[\r\n\u0085\p{Zl}\p{Zp}]/u;

const isSingleLineText = (value: string) => !LINE_BREAK.test(value) && !LONE_SURROGATE.test(value);

const isTaskTitle = (value: unknown): value is string =>
  isWorkItemTitle(value) && isSingleLineText(value);

const EMPTY_FIELDS: ReadonlyMap<string, string> = new Map();

/** A document's revision: the digest of every byte, whether or not the bytes decode. */
export const revisionOf = (bytes: Uint8Array) =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;

// A decoder per call: no state can carry from one document into the next.
const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

// LF never occurs inside a multibyte sequence, so the first line that fails alone holds the
// first invalid byte.
const firstInvalidLine = (bytes: Uint8Array) => {
  let line = 1;
  for (let start = 0; ; line += 1) {
    const lf = bytes.indexOf(0x0a, start);
    if (decodeUtf8(bytes.subarray(start, lf === -1 ? bytes.length : lf)) === undefined) break;
    if (lf === -1) break;
    start = lf + 1;
  }
  return line;
};

/**
 * Maps an offset in `text` to its 1-based line. The line breaks are listed once, on the first
 * lookup, and each lookup bisects them, so diagnostics cost no rescan of the file.
 */
const lineIndex = (text: string) => {
  let breaks: Array<number> | undefined;
  return (offset: number) => {
    if (breaks === undefined) {
      breaks = [];
      for (let lf = text.indexOf("\n"); lf !== -1; lf = text.indexOf("\n", lf + 1)) breaks.push(lf);
    }
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((breaks[middle] ?? offset) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
};

const OPENING = /^﻿?---(\r?\n)/;
const MARKER_RUN = /^(<+|=+|>+)(?:[ \t]|$)/;

/**
 * The offset of the first merge conflict marker line, if any. Git writes 7-character markers by
 * default and any positive width for `conflict-marker-size`, longer ones for a conflict within
 * a conflict. A `<` or `>` line of 7 or more counts alone, since a half-resolved conflict may
 * keep only one. Narrower markers look like Markdown (`>` quotes, `=` underlines), so they
 * count only as a complete same-width open, separator and close sequence; a false match only
 * makes a file read-only. A separator alone never counts.
 */
const findConflictMarker = (text: string) => {
  const opened = new Map<number, number>();
  const separated = new Map<number, number>();
  let offset = 0;
  for (const line of text.split("\n")) {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    const run = MARKER_RUN.exec(content)?.[1];
    if (run !== undefined) {
      const width = run.length;
      if (run.startsWith("=")) {
        const open = opened.get(width);
        if (content === run && open !== undefined) separated.set(width, open);
      } else if (width >= 7) {
        return offset;
      } else if (run.startsWith("<")) {
        opened.set(width, offset);
      } else {
        const open = separated.get(width);
        if (open !== undefined) return open;
      }
    }
    offset += line.length + 1;
  }
  return undefined;
};

interface Frame {
  readonly newline: "\n" | "\r\n";
  readonly contentStart: number;
  readonly closingStart: number;
  readonly bodyStart: number;
  readonly closingTerminated: boolean;
}

/** Locates the frontmatter: a `---` first line and the next line that is exactly `---`. */
const findFrame = (text: string): Frame | "missing" | "unterminated" => {
  const opening = OPENING.exec(text);
  if (opening === null) return "missing";
  const newline = opening[1] === "\r\n" ? "\r\n" : "\n";
  const contentStart = opening[0].length;
  for (let lineStart = contentStart; lineStart < text.length;) {
    const lf = text.indexOf("\n", lineStart);
    const lineEnd = lf === -1 ? text.length : lf;
    const contentEnd = text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (contentEnd - lineStart === 3 && text.startsWith("---", lineStart)) {
      return {
        newline,
        contentStart,
        closingStart: lineStart,
        bodyStart: lf === -1 ? text.length : lf + 1,
        closingTerminated: lf !== -1,
      };
    }
    if (lf === -1) break;
    lineStart = lf + 1;
  }
  return "unterminated";
};

// `<<` stays an ordinary key even under `%YAML 1.1`. `scanTree` finds duplicate keys: the
// library compares collection keys by identity, and every key with every earlier one.
const YAML_OPTIONS = { uniqueKeys: false, merge: false, prettyErrors: false } as const;

const parseYaml = (source: string) => {
  try {
    return parseDocument(source, YAML_OPTIONS);
  } catch (error) {
    // The composer reports its own stack exhaustion; this only guards the remaining paths.
    return error instanceof RangeError ? ("too_deep" as const) : ("yaml_syntax" as const);
  }
};

/** A key whose equality is its value's: a string, number, boolean or null scalar. */
const isPlainKey = (node: ParsedNode): node is Scalar.Parsed =>
  isScalar(node) &&
  (node.value === null ||
    typeof node.value === "string" ||
    typeof node.value === "number" ||
    typeof node.value === "boolean");

// Equal values written differently, like `1` and `0x1`, are one key; so is NaN, unlike in `===`.
const keyIdentity = (value: unknown) => `${typeof value}:${String(value)}`;

/**
 * Finds the first of each problem anywhere in the frontmatter: a collection nested deeper than
 * allowed, an anchor or alias outside `skip`, a `<<` merge key, a key that is not a plain value
 * (a collection, timestamp or binary, whose duplicates cannot be told apart reliably) and a
 * duplicate key, with its name when it is a top-level field. Iterative, so a deep tree cannot
 * exhaust the stack here.
 */
const scanTree = (root: ParsedNode, skip: ReadonlySet<ParsedNode>) => {
  let tooDeep: number | undefined;
  let alias: number | undefined;
  let merge: number | undefined;
  let complexKey: number | undefined;
  let duplicate: { readonly offset: number; readonly name: unknown } | undefined;
  const earliest = (current: number | undefined, offset: number) =>
    current === undefined || offset < current ? offset : current;
  const stack: Array<readonly [ParsedNode, number]> = [[root, 1]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, depth] = next;
    if (!skip.has(node) && (isAlias(node) || node.anchor !== undefined)) {
      alias = earliest(alias, node.range[0]);
    }
    if (!isMap(node) && !isSeq(node)) continue;
    if (depth > MAX_FRONTMATTER_DEPTH) {
      tooDeep = earliest(tooDeep, node.range[0]);
      continue;
    }
    const keys = new Set<string>();
    for (const item of node.items) {
      const children = isPair(item) ? [item.key, item.value] : [item];
      for (const child of children) {
        if (child !== null) stack.push([child as ParsedNode, depth + 1]);
      }
      if (!isMap(node) || !isPair(item)) continue;
      const key = item.key as ParsedNode;
      if (isAlias(key)) continue;
      if (!isPlainKey(key)) {
        complexKey = earliest(complexKey, key.range[0]);
        continue;
      }
      if (key.value === "<<") merge = earliest(merge, key.range[0]);
      const identity = keyIdentity(key.value);
      if (keys.has(identity) && (duplicate === undefined || key.range[0] < duplicate.offset)) {
        duplicate = { offset: key.range[0], name: depth === 1 ? key.value : undefined };
      }
      keys.add(identity);
    }
  }
  return { tooDeep, alias, merge, complexKey, duplicate };
};

const byLine = (diagnostics: Array<TaskDocumentDiagnostic>) =>
  diagnostics.sort((left, right) => left.line - right.line);

/**
 * Decodes one file. Pure and total: every problem becomes a diagnostic, and nothing here
 * depends on any other document.
 */
const parse = (bytes: Uint8Array): Parsed => {
  const revision = revisionOf(bytes);
  let fields: ReadonlyMap<string, string> = EMPTY_FIELDS;
  let newline: TaskDocument["newline"] = "\n";
  const unreadable = (diagnostics: Array<TaskDocumentDiagnostic>): Parsed => ({
    document: {
      bytes,
      revision,
      newline,
      item: undefined,
      fields,
      diagnostics: byLine(diagnostics),
      editable: false,
    },
    layout: undefined,
  });

  if (bytes.byteLength > MAX_TASK_DOCUMENT_BYTES) return unreadable([diagnostic("too_large", 1)]);
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return unreadable([diagnostic("invalid_utf8", firstInvalidLine(bytes))]);
  }
  const firstBreak = text.indexOf("\n");
  newline = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : "\n";

  const lineAt = lineIndex(text);
  const diagnostics: Array<TaskDocumentDiagnostic> = [];
  const conflict = findConflictMarker(text);
  if (conflict !== undefined) diagnostics.push(diagnostic("conflict_markers", lineAt(conflict)));

  const frame = findFrame(text);
  if (frame === "missing") {
    return unreadable([...diagnostics, diagnostic("missing_frontmatter", 1)]);
  }
  if (frame === "unterminated") {
    return unreadable([...diagnostics, diagnostic("unterminated_frontmatter", 1)]);
  }
  // Markers inside the frontmatter make every value there ambiguous.
  if (conflict !== undefined && conflict < frame.closingStart) return unreadable(diagnostics);

  const source = text.slice(frame.contentStart, frame.closingStart);
  const lineOf = (offset: number) => lineAt(frame.contentStart + offset);
  const yaml = parseYaml(source);
  if (typeof yaml === "string") return unreadable([...diagnostics, diagnostic(yaml, 2)]);

  const contents = yaml.contents;
  if (yaml.errors.length > 0) {
    for (const error of yaml.errors.slice(0, MAX_YAML_ERRORS)) {
      const code = error.code === "RESOURCE_EXHAUSTION" ? "too_deep" : "yaml_syntax";
      diagnostics.push(diagnostic(code, lineOf(error.pos[0])));
    }
    return unreadable(diagnostics);
  }
  if (contents !== null && !isMap(contents)) {
    return unreadable([...diagnostics, diagnostic("not_mapping", lineOf(contents.range[0]))]);
  }

  const pairs = contents?.items ?? [];
  const flow = contents?.flow === true;
  if (contents !== null && flow) {
    diagnostics.push(diagnostic("unsupported_form", lineOf(contents.range[0])));
  }

  // A value Work can patch: one plain or quoted scalar on its key's line, with no tag or anchor
  // on either, or nothing at all after the key. Anything else would need reserializing.
  const inPlaceSpan = (key: Scalar.Parsed, value: ParsedNode | null): Entry["span"] => {
    if (flow || !isScalar(value) || value.tag !== undefined || value.anchor !== undefined) {
      return undefined;
    }
    if (key.tag !== undefined || key.anchor !== undefined) return undefined;
    if (source.slice(key.range[0], value.range[1]).includes("\n")) return undefined;
    const start = frame.contentStart + value.range[0];
    const end = frame.contentStart + value.range[1];
    if (end === start) {
      // `key:` with nothing written: the range sits where a value would start, right after
      // the colon or its trailing whitespace, and right before any comment.
      return {
        start,
        end,
        style: "plain",
        before: /\s/.test(text[start - 1] ?? "") ? "" : " ",
        after: text[start] === "#" ? " " : "",
      };
    }
    const style = STYLES[value.type ?? ""];
    return style === undefined ? undefined : { start, end, style, before: "", after: "" };
  };

  // The pair's own line, when the pair is the whole line: a block-mapping key starts its line,
  // and the value (a trailing comment aside) ends before the line break.
  const ownLine = (key: Scalar.Parsed, value: ParsedNode | null): Entry["line"] => {
    if (flow) return undefined;
    const pairStart = frame.contentStart + key.range[0];
    const pairEnd = frame.contentStart + (value?.range[1] ?? key.range[1]);
    const lineStart = text.lastIndexOf("\n", pairStart - 1) + 1;
    const lf = text.indexOf("\n", pairStart);
    if (lineStart !== pairStart || pairEnd > (lf === -1 ? text.length : lf)) return undefined;
    return { start: lineStart, end: lf === -1 ? text.length : lf + 1 };
  };

  const entries = new Map<string, FieldEntry>();
  const strings = new Map<string, string>();
  const fieldNodes = new Set<ParsedNode>();
  for (const { key, value } of pairs) {
    if (!isScalar(key) || typeof key.value !== "string") continue;
    if (isRequiredField(key.value)) {
      fieldNodes.add(key);
      if (value !== null) fieldNodes.add(value);
    }
    const scalar = isScalar(value) ? value.value : undefined;
    if (typeof scalar === "string") strings.set(key.value, scalar);
    else strings.delete(key.value);
    entries.set(key.value, {
      node: value,
      keyAnchored: key.anchor !== undefined,
      offset: value?.range[0] ?? key.range[0],
      value: scalar,
      span: inPlaceSpan(key, value),
      line: ownLine(key, value),
    });
  }
  fields = strings;

  if (contents !== null) {
    const scan = scanTree(contents, fieldNodes);
    if (scan.tooDeep !== undefined) {
      return unreadable([...diagnostics, diagnostic("too_deep", lineOf(scan.tooDeep))]);
    }
    if (scan.alias !== undefined) diagnostics.push(diagnostic("alias", lineOf(scan.alias)));
    if (scan.merge !== undefined) diagnostics.push(diagnostic("merge_key", lineOf(scan.merge)));
    if (scan.complexKey !== undefined) {
      diagnostics.push(diagnostic("complex_key", lineOf(scan.complexKey)));
    }
    // Which of two equal keys a reader keeps is unknowable, so nothing here is readable.
    if (scan.duplicate !== undefined) {
      const { offset, name } = scan.duplicate;
      const field = REQUIRED_FIELDS.find((known) => known === name);
      return unreadable([...diagnostics, diagnostic("duplicate_key", lineOf(offset), field)]);
    }
  }

  // Each required field yields its value, or undefined after recording why it has none.
  const read = <A>(field: TaskField, decode: (entry: FieldEntry) => A | undefined) => {
    const entry = entries.get(field);
    if (entry === undefined) {
      diagnostics.push(diagnostic("missing_field", 1, field));
      return undefined;
    }
    // Patching an anchored value would also change its aliases. An alias's value lives elsewhere
    // and is never expanded, so it cannot be read either.
    const line = () => lineOf(entry.offset);
    const anchored = entry.node?.anchor !== undefined || entry.keyAnchored;
    if (isAlias(entry.node) || anchored) diagnostics.push(diagnostic("alias", line(), field));
    if (isAlias(entry.node)) return undefined;
    const value = decode(entry);
    if (value === undefined) {
      diagnostics.push(diagnostic("invalid_field", line(), field));
    } else if (entry.span === undefined && !flow && !anchored) {
      diagnostics.push(diagnostic("unsupported_form", line(), field));
    }
    return value;
  };

  const id = read("id", ({ value }) =>
    typeof value === "string" ? parseTaskId(value) : undefined,
  );
  const title = read("title", ({ value }) => (isTaskTitle(value) ? value : undefined));
  const status = read("status", ({ value, offset }): WorkStatus | undefined => {
    if (typeof value !== "string" || value.trim() === "" || !isSingleLineText(value)) {
      return undefined;
    }
    if (isWorkNativeStatus(value)) return value;
    diagnostics.push(diagnostic("unknown_status", lineOf(offset), "status"));
    return "unknown";
  });

  if (id === undefined || title === undefined || status === undefined) {
    return unreadable(diagnostics);
  }
  const item: TaskItem = { id, title, status, body: text.slice(frame.bodyStart), revision };
  if (diagnostics.length > 0) {
    return {
      document: {
        bytes,
        revision,
        newline,
        item,
        fields,
        diagnostics: byLine(diagnostics),
        editable: false,
      },
      layout: undefined,
    };
  }
  return {
    document: { bytes, revision, newline, item, fields, diagnostics: [], editable: true },
    layout: {
      text,
      newline: frame.newline,
      closingStart: frame.closingStart,
      bodyStart: frame.bodyStart,
      closingTerminated: frame.closingTerminated,
      entries,
    },
  };
};

/**
 * Decodes a task document's bytes into its item, its string fields and diagnostics. Never
 * throws, and interprets only the three required fields: other keys are exposed as written,
 * and comments and aliases are not expanded.
 */
export const decodeTaskDocument = (bytes: Uint8Array): TaskDocument => parse(bytes).document;

const encoder = new TextEncoder();

const DOUBLE_QUOTED_ESCAPES: Partial<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
};

const doubleQuoted = (value: string) =>
  `"${value.replace(
    /[\\"\p{Cc}\p{Zl}\p{Zp}]/gu,
    (char) =>
      DOUBLE_QUOTED_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}"`;

/**
 * Whether `value` reads back as exactly this string when written plain. YAML 1.1 readers count
 * too, so `yes` or `1:20` are quoted for other tools reading the same file.
 */
const isPlainSafe = (value: string) => {
  if (value === "" || value !== value.trim() || UNPRINTABLE.test(value)) return false;
  const probe = parseDocument(`value: ${value}\n`, { ...YAML_OPTIONS, compat: "yaml-1.1" });
  if (probe.errors.length > 0 || probe.warnings.length > 0 || !isMap(probe.contents)) return false;
  const node = probe.contents.items[0]?.value;
  return (
    probe.contents.items.length === 1 &&
    isScalar(node) &&
    node.type === Scalar.PLAIN &&
    node.value === value &&
    node.comment === undefined &&
    node.anchor === undefined &&
    node.tag === undefined
  );
};

/** Writes a single-line string in the scalar's existing style when that style can hold it. */
const renderScalar = (value: string, style: ScalarStyle) => {
  if (style === "plain" && isPlainSafe(value)) return value;
  if (style === "single" && !UNPRINTABLE.test(value.replaceAll("\t", ""))) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return doubleQuoted(value);
};

/** A field to set (a string) or remove (`null`). */
type FieldPatch = readonly [name: string, value: string | null];

/**
 * Replaces each changed field's scalar bytes, inserts missing fields before the closing
 * delimiter, removes the line of each field set to `null`, and replaces the body, then reads
 * the result back. Everything else keeps its bytes. A result that would not decode to exactly
 * the requested values is refused.
 */
const applyEdit = (
  parsed: Extract<Parsed, { layout: Layout }>,
  fields: ReadonlyArray<FieldPatch>,
  body: string | undefined,
): Result.Result<TaskDocument, TaskDocumentWriteRefused> => {
  const { document, layout } = parsed;
  const patches: Array<{ readonly start: number; readonly end: number; readonly text: string }> =
    [];
  let inserted = "";
  for (const [name, value] of fields) {
    const entry = layout.entries.get(name);
    if (value === null) {
      if (entry === undefined) continue;
      if (entry.line === undefined) return refusal("invalid_value", { field: name });
      patches.push({ start: entry.line.start, end: entry.line.end, text: "" });
    } else if (entry === undefined) {
      inserted += `${name}: ${renderScalar(value, "plain")}${layout.newline}`;
    } else if (entry.value !== value) {
      if (entry.span === undefined) return refusal("invalid_value", { field: name });
      const { span } = entry;
      const text = `${span.before}${renderScalar(value, span.style)}${span.after}`;
      patches.push({ start: span.start, end: span.end, text });
    }
  }
  if (inserted !== "") {
    patches.push({ start: layout.closingStart, end: layout.closingStart, text: inserted });
  }

  let text = layout.text;
  if (body !== undefined) {
    const separator = layout.closingTerminated || body === "" ? "" : layout.newline;
    text = `${text.slice(0, layout.bodyStart)}${separator}${body}`;
  }
  // Every patch lies before the body, and later patches go first so earlier offsets hold.
  for (const patch of patches.toSorted((left, right) => right.start - left.start)) {
    text = `${text.slice(0, patch.start)}${patch.text}${text.slice(patch.end)}`;
  }

  const next = parse(encoder.encode(text));
  if (next.layout === undefined) {
    const [problem] = next.document.diagnostics;
    return refusal("invalid_value", {
      field: problem?.field ?? (body === undefined ? undefined : "body"),
      ...(problem === undefined ? {} : { diagnostic: problem }),
    });
  }
  if (next.document.item.id !== document.item.id) {
    return refusal("identity_change", { field: "id" });
  }
  for (const [name, value] of fields) {
    const written = next.layout.entries.get(name);
    if (value === null ? written !== undefined : written?.value !== value) {
      return refusal("invalid_value", { field: name });
    }
  }
  if (next.document.item.body !== (body ?? document.item.body)) {
    return refusal("invalid_value", { field: "body" });
  }
  return Result.succeed(next.document);
};

const refuseReadOnly = (document: TaskDocument) => {
  const [problem] = document.diagnostics;
  return refusal("read_only", problem === undefined ? {} : { diagnostic: problem });
};

const OPTIONAL_FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** A field outside the three every document has, which an edit may set or remove. */
const isOptionalFieldName = (name: string) =>
  OPTIONAL_FIELD_NAME.test(name) && !isRequiredField(name);

/** A form save. Omitted fields keep their bytes. */
export interface TaskEdit {
  /** The id the editor loaded. It must still match; an edit never changes identity. */
  readonly id?: string;
  readonly title?: string;
  readonly status?: WorkNativeStatus;
  /** Replaces every byte after the closing delimiter line, exactly as given. */
  readonly body?: string;
  /**
   * Optional fields by name: a string patches the scalar in place or inserts the field before
   * the closing delimiter; `null` removes the field's line.
   */
  readonly fields?: Readonly<Record<string, string | null>>;
}

/**
 * Patches only the bytes of each changed field's scalar and, when given, the body. A read-only
 * document, a changed `id` or an unwritable value is refused with the bytes untouched.
 */
export const editTaskDocument = (
  bytes: Uint8Array,
  edit: TaskEdit,
): Result.Result<TaskDocument, TaskDocumentWriteRefused> => {
  const parsed = parse(bytes);
  if (parsed.layout === undefined) return refuseReadOnly(parsed.document);
  if (edit.id !== undefined && parseTaskId(edit.id) !== parsed.document.item.id) {
    return refusal("identity_change", { field: "id" });
  }
  if (edit.title !== undefined && !isTaskTitle(edit.title)) {
    return refusal("invalid_value", { field: "title" });
  }
  if (edit.status !== undefined && !isWorkNativeStatus(edit.status)) {
    return refusal("invalid_value", { field: "status" });
  }
  const fields: Array<FieldPatch> = [];
  if (edit.title !== undefined) fields.push(["title", edit.title]);
  if (edit.status !== undefined) fields.push(["status", edit.status]);
  for (const [name, value] of Object.entries(edit.fields ?? {})) {
    if (name === "id") return refusal("identity_change", { field: name });
    if (!isOptionalFieldName(name) || (value !== null && !isSingleLineText(value))) {
      return refusal("invalid_value", { field: name });
    }
    fields.push([name, value]);
  }
  return applyEdit(parsed, fields, edit.body);
};

export interface NewTaskDocument {
  /** Suggested `<id>-<slug>.md`. The `id`, not the filename, identifies the item. */
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** Known optional fields render in this order; any other field follows in the order given. */
const OPTIONAL_FIELD_ORDER = [
  "priority",
  "labels",
  "assignee",
  "parent",
  "blocked_by",
  "created",
  "updated",
] as const;
const ORDERED_FIELDS: ReadonlySet<string> = new Set(OPTIONAL_FIELD_ORDER);

/**
 * Renders a new document. The template body is inserted once, here, and never re-applied. The
 * bytes are returned only when they decode, without a diagnostic, to exactly these values; an
 * oversized or conflicted body or a value UTF-8 cannot carry is refused instead.
 */
export const renderTaskDocument = (input: {
  readonly id: WorkItemId;
  readonly title: string;
  readonly status: WorkNativeStatus;
  readonly body?: string;
  readonly fields?: Readonly<Record<string, string>>;
}): Result.Result<NewTaskDocument, TaskDocumentWriteRefused> => {
  if (parseTaskId(input.id) !== input.id) return refusal("invalid_value", { field: "id" });
  if (!isTaskTitle(input.title)) return refusal("invalid_value", { field: "title" });
  if (!isWorkNativeStatus(input.status)) return refusal("invalid_value", { field: "status" });
  const given = Object.entries(input.fields ?? {});
  const fields = [
    ...OPTIONAL_FIELD_ORDER.flatMap((name) => given.filter(([key]) => key === name)),
    ...given.filter(([key]) => !ORDERED_FIELDS.has(key)),
  ];
  for (const [name, value] of fields) {
    if (!isOptionalFieldName(name) || !isSingleLineText(value)) {
      return refusal("invalid_value", { field: name });
    }
  }
  const body = input.body ?? "";
  const frontmatter = [
    "---",
    `id: ${input.id}`,
    `title: ${renderScalar(input.title, "plain")}`,
    `status: ${input.status}`,
    ...fields.map(([name, value]) => `${name}: ${renderScalar(value, "plain")}`),
    "---",
    "",
  ].join("\n");
  const bytes = encoder.encode(`${frontmatter}${body}`);

  const document = decodeTaskDocument(bytes);
  const [problem] = document.diagnostics;
  if (problem !== undefined) {
    return refusal("invalid_value", { field: problem.field ?? "body", diagnostic: problem });
  }
  const mismatch = (
    [
      ["id", document.item?.id, input.id],
      ["title", document.item?.title, input.title],
      ["status", document.item?.status, input.status],
      ["body", document.item?.body, body],
      ...fields.map(([name, value]) => [name, document.fields.get(name), value] as const),
    ] as const
  ).find(([, written, requested]) => written !== requested);
  if (mismatch !== undefined) return refusal("invalid_value", { field: mismatch[0] });

  return Result.succeed({ filename: taskFilename(input.id, input.title), bytes });
};

/** Stands in for the id a create mints: every valid id renders a title and body alike. */
const CONTENT_CHECK_ID = WorkItemId.make("fd-000000");

/**
 * Whether a Markdown source can create an item with this title and body exactly as given: the
 * render its create performs succeeds for them. The title must stay on one line and the body read
 * back unchanged, so a merge conflict marker line, half a surrogate pair or an oversized file is
 * refused. For a module that must know before it commits to creating the item.
 */
export const canWriteMarkdownItem = (input: {
  readonly title: string;
  readonly body: string;
}): boolean =>
  Result.isSuccess(
    renderTaskDocument({
      id: CONTENT_CHECK_ID,
      title: input.title,
      status: "todo",
      body: input.body,
    }),
  );
