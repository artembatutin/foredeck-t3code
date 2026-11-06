// @effect-diagnostics-next-line nodeBuiltinImport:off -- a filename is hashed synchronously.
import * as NodeCrypto from "node:crypto";

import {
  type WorkComment,
  type WorkItemId,
  WorkPriority,
} from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { COMMENT_MAX_CHARS, truncateText } from "../model/bounds.ts";

/**
 * Pure helpers for the Markdown task-file grammar: ids, filenames, comma lists, the optional
 * frontmatter fields and the `## Notes` comment section. The codec in `taskDocument.ts` owns
 * bytes and diagnostics; this module interprets the values it exposes.
 */

/** `fd-` and six lowercase Crockford base32 digits (no i, l, o or u): a Markdown item id. */
export const TASK_ID_PATTERN = /^fd-[0-9a-hjkmnp-tv-z]{6}$/;

const CROCKFORD_DIGITS = "0123456789abcdefghjkmnpqrstvwxyz";
const MAX_SLUG_LENGTH = 60;
/** Caps mirror the summary contract so a hand-edited file never fails to encode. */
const MAX_LABELS = 32;
const MAX_BLOCKERS = 50;

/** Crockford is case-insensitive, so the lowercased value is the identity. */
export const parseTaskId = (value: string): WorkItemId | undefined => {
  const lowered = value.toLowerCase();
  return TASK_ID_PATTERN.test(lowered) ? (lowered as WorkItemId) : undefined;
};

/** An id from 30 random bits: the first four bytes, with the top two bits dropped. */
export const mintTaskId = (randomBytes: Uint8Array): WorkItemId => {
  let bits = 0;
  for (let index = 0; index < 4; index += 1) bits = ((bits << 8) | (randomBytes[index] ?? 0)) >>> 0;
  bits &= 0x3fffffff;
  let digits = "";
  for (let shift = 25; shift >= 0; shift -= 5) digits += CROCKFORD_DIGITS[(bits >>> shift) & 31];
  return `fd-${digits}` as WorkItemId;
};

/**
 * A read-only id for a file whose frontmatter cannot be read and whose stem is not an item id:
 * `file-` and twelve hex digits of the filename's SHA-256. The file stays listed under a stable
 * id, and the summary's `key` carries the filename itself.
 */
export const fileItemId = (filename: string): WorkItemId =>
  `file-${NodeCrypto.createHash("sha256").update(filename).digest("hex").slice(0, 12)}` as WorkItemId;

// ASCII only: the filename is a hint, and accents or scripts that do not reduce to ASCII are
// dropped rather than risking normalization or portability differences between filesystems.
const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");

/** `<id>-<slug>.md`, or `<id>.md` when nothing of the title survives slugging. */
export const taskFilename = (id: WorkItemId, title: string): string => {
  const slug = slugify(title);
  return slug === "" ? `${id}.md` : `${id}-${slug}.md`;
};

/**
 * Whether a directory entry is indexed. Only `.md` files are; dotfiles are not, and editor
 * or atomic-write artefacts (`*.tmp`, `*.swp`, `*~`, `<name>.md.<random>/`) never end in
 * `.md`, so the suffix test alone excludes them.
 */
export const isTaskFileName = (name: string): boolean =>
  name.endsWith(".md") && name.length > ".md".length && !name.startsWith(".");

/** Splits on commas, trims each entry and drops empty ones. */
export const parseCommaList = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

export const formatCommaList = (values: ReadonlyArray<string>): string => values.join(", ");

export interface TaskOptionalFields {
  readonly priority: WorkPriority | null;
  readonly labels: ReadonlyArray<string>;
  readonly assignee: string | null;
  readonly parent: WorkItemId | null;
  readonly blockedBy: ReadonlyArray<WorkItemId>;
  /** Normalized ISO 8601 in UTC, so values compare lexicographically. */
  readonly created: string | null;
  readonly updated: string | null;
}

const isWorkPriority = Schema.is(WorkPriority);

// A date-like prefix first: `DateTime.make` would read a bare number as a year.
const isoTimestamp = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  return Option.getOrNull(Option.map(DateTime.make(trimmed), DateTime.formatIso));
};

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)];

/**
 * Reads the optional fields leniently: an unusable value is treated as absent and never makes
 * the file read-only. Ids are lowercased; lists are deduplicated and capped.
 */
export const parseOptionalFields = (fields: ReadonlyMap<string, string>): TaskOptionalFields => {
  const priority = fields.get("priority")?.trim().toLowerCase();
  const assignee = fields.get("assignee")?.trim();
  const blockedBy = parseCommaList(fields.get("blocked_by") ?? "").flatMap((entry) => {
    const id = parseTaskId(entry);
    return id === undefined ? [] : [id];
  });
  return {
    priority: isWorkPriority(priority) ? priority : null,
    labels: unique(parseCommaList(fields.get("labels") ?? "")).slice(0, MAX_LABELS),
    assignee: assignee === undefined || assignee === "" ? null : assignee,
    parent: parseTaskId(fields.get("parent") ?? "") ?? null,
    blockedBy: unique(blockedBy).slice(0, MAX_BLOCKERS),
    created: isoTimestamp(fields.get("created") ?? ""),
    updated: isoTimestamp(fields.get("updated") ?? ""),
  };
};

const NOTES_HEADING = "## Notes";
// The section runs to the next H1 or H2 line.
const SECTION_HEADING = /^#{1,2}(?:\s|$)/;
const NOTE_PREFIX = /^- (\S+) \(/;

/**
 * `- <ISO> (<author>) <text>`. The author ends at its balancing parenthesis, so a label like
 * `Pat (bot)` and text with parentheses both read back.
 */
const parseNoteLine = (line: string) => {
  const prefix = NOTE_PREFIX.exec(line);
  if (prefix === null) return undefined;
  let depth = 1;
  let index = prefix[0].length;
  while (index < line.length && depth > 0) {
    const char = line[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    index += 1;
  }
  const label = line.slice(prefix[0].length, index - 1);
  const rest = line.slice(index);
  if (depth !== 0 || label === "" || (rest !== "" && !rest.startsWith(" "))) return undefined;
  return { createdAt: prefix[1] ?? "", label, text: rest.slice(1) };
};

interface NotesSection {
  /** Where the heading line starts. */
  readonly start: number;
  /** The end of the heading's text, before its line break. */
  readonly headingEnd: number;
  /** The first offset after the heading line. */
  readonly contentStart: number;
  /** Where the next section's heading starts, or the end of the body. */
  readonly end: number;
}

const lineContent = (body: string, start: number, end: number) =>
  body[end - 1] === "\r" ? body.slice(start, end - 1) : body.slice(start, end);

// A CommonMark code fence opens with three or more backticks or tildes indented at most three
// spaces, possibly as the first thing in a list item; a backtick fence's info string holds no
// backtick. It closes with the marker alone, at any indentation since the opener may sit in a
// list item whose content is indented further.
const FENCE_OPEN = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)? {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

const fenceOpener = (content: string) => {
  const match = FENCE_OPEN.exec(content);
  if (match === null) return undefined;
  const [, marker = "", info = ""] = match;
  return marker.startsWith("`") && info.includes("`") ? undefined : marker;
};

interface BodyLine {
  readonly start: number;
  /** The end of the content, before any line break. */
  readonly end: number;
  /** The first offset after the line break, or the end of the text. */
  readonly next: number;
  readonly content: string;
  /** Inside a fenced code block, its fence lines included: never a heading or a note. */
  readonly fenced: boolean;
  readonly opensFence: boolean;
  /** The line that closes a fence; a note may be inserted after it. */
  readonly closesFence: boolean;
}

/** The text's lines with their offsets and whether a code fence encloses them. */
const bodyLines = function* (text: string): Generator<BodyLine, void> {
  let fence: string | undefined;
  let offset = 0;
  for (;;) {
    const lf = text.indexOf("\n", offset);
    const lineEnd = lf === -1 ? text.length : lf;
    const content = lineContent(text, offset, lineEnd);
    let fenced = fence !== undefined;
    let opensFence = false;
    let closesFence = false;
    if (fence === undefined) {
      const marker = fenceOpener(content);
      if (marker !== undefined) {
        fence = marker;
        fenced = true;
        opensFence = true;
      }
    } else {
      const marker = FENCE_CLOSE.exec(content)?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
        closesFence = true;
      }
    }
    yield {
      start: offset,
      end: offset + content.length,
      next: lf === -1 ? text.length : lf + 1,
      content,
      fenced,
      opensFence,
      closesFence,
    };
    if (lf === -1) return;
    offset = lf + 1;
  }
};

/** Locates the `## Notes` section; headings inside fenced code blocks are prose, not sections. */
const findNotes = (body: string): NotesSection | undefined => {
  let section: Omit<NotesSection, "end"> | undefined;
  for (const line of bodyLines(body)) {
    if (line.fenced) continue;
    if (section === undefined) {
      if (line.content.trimEnd() === NOTES_HEADING) {
        section = {
          start: line.start,
          headingEnd: line.start + line.content.trimEnd().length,
          contentStart: line.next,
        };
      }
    } else if (SECTION_HEADING.test(line.content)) {
      return { ...section, end: line.start };
    }
  }
  return section === undefined ? undefined : { ...section, end: body.length };
};

/**
 * The body without its `## Notes` section, and that section as written, heading included: the
 * comments Work keeps in a task file, apart from what the task says. `notes` is empty when the
 * body has no such section.
 */
export const splitNotes = (body: string): { readonly rest: string; readonly notes: string } => {
  const section = findNotes(body);
  if (section === undefined) return { rest: body, notes: "" };
  return {
    rest: body.slice(0, section.start) + body.slice(section.end),
    notes: body.slice(section.start, section.end),
  };
};

/**
 * Comments from the `## Notes` section, one per `- <ISO> (<author>) <text>` line, in file
 * order. The id is the 1-based position; other lines in the section, and lines inside a code
 * fence, are not comments. A body longer than the wire allows is cut to fit.
 */
export const parseNotes = (body: string): ReadonlyArray<WorkComment> => {
  const section = findNotes(body);
  if (section === undefined) return [];
  const comments: Array<WorkComment> = [];
  // The heading line is never fenced, so the section's fence state starts closed.
  for (const line of bodyLines(body.slice(section.contentStart, section.end))) {
    if (line.fenced) continue;
    const note = parseNoteLine(line.content);
    if (note === undefined || isoTimestamp(note.createdAt) === null) continue;
    comments.push({
      id: String(comments.length + 1),
      author: { id: note.label, label: note.label },
      body: truncateText(note.text, COMMENT_MAX_CHARS).text,
      createdAt: note.createdAt,
      updatedAt: null,
    });
  }
  return comments;
};

/**
 * Appends a note line after the last nonblank line of the `## Notes` section that is outside
 * a code fence. Without a section, one is created at the end of the body, or just before an
 * unterminated fence that would otherwise swallow it. Every other byte of the body is kept.
 * `newline` is the document's line break; it defaults to what the body itself uses.
 */
export const appendNote = (
  body: string,
  line: string,
  newline: "\n" | "\r\n" = body.includes("\r\n") ? "\r\n" : "\n",
): string => {
  const section = findNotes(body);
  if (section === undefined) {
    let openAt: number | undefined;
    for (const current of bodyLines(body)) {
      if (current.opensFence) openAt = current.start;
      else if (current.closesFence) openAt = undefined;
    }
    let prefix = openAt === undefined ? body : body.slice(0, openAt);
    const rest = openAt === undefined ? "" : body.slice(openAt);
    if (prefix !== "" && !prefix.endsWith("\n")) prefix += newline;
    if (prefix !== "" && !/\n\r?\n$/.test(prefix)) prefix += newline;
    const separator = rest === "" ? "" : newline;
    return `${prefix}${NOTES_HEADING}${newline}${line}${newline}${separator}${rest}`;
  }
  let insertAt = section.headingEnd;
  for (const current of bodyLines(body.slice(section.contentStart, section.end))) {
    if (current.content.trim() !== "" && (!current.fenced || current.closesFence)) {
      insertAt = section.contentStart + current.end;
    }
  }
  return `${body.slice(0, insertAt)}${newline}${line}${body.slice(insertAt)}`;
};

const singleLine = (value: string) => value.replace(/\s*(?:\r\n|\r|\n)\s*/g, " ").trim();

/** Who wrote a note when the actor has no usable label. */
const ANONYMOUS_AUTHOR = "someone";

/** A comment's text as a note line carries it: line breaks collapsed to spaces, trimmed. */
export const noteText = (text: string): string => singleLine(text);

/**
 * `- <ISO> (<author>) <text>`, with line breaks collapsed to spaces. The author ends at its
 * balancing parenthesis when read back, so parentheses in the label become brackets, and a
 * blank label gets a stand-in so the line still reads back as a note.
 */
export const formatNoteLine = (createdAt: string, label: string, text: string): string => {
  const author = singleLine(label.replaceAll("(", "[").replaceAll(")", "]"));
  return `- ${createdAt} (${author === "" ? ANONYMOUS_AUTHOR : author}) ${noteText(text)}`;
};
