/**
 * Atlassian Document Format to Markdown and back, for the subset Work edits: paragraphs,
 * headings, bullet, ordered and task lists (nested by indentation), code blocks, quotes, rules,
 * hard breaks, inline cards (as `<url>`) and the strong, em, code, strike and link marks.
 *
 * A body is exact only when writing its Markdown back yields the same document: `adfToMarkdown`
 * parses its own output and compares. Anything else (tables, media, mentions, colors, ...) marks
 * the body lossy, so Work never writes such a body back. Content without a text form becomes a
 * visible placeholder.
 */

export interface AdfMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface AdfNode {
  readonly type: string;
  readonly version?: number;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: ReadonlyArray<AdfMark>;
  readonly content?: ReadonlyArray<AdfNode>;
}

export interface AdfMarkdown {
  readonly markdown: string;
  readonly lossy: boolean;
}

const isNode = (value: unknown): value is AdfNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const stringAttr = (node: AdfNode | AdfMark, name: string): string | undefined => {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : undefined;
};

const orderOf = (list: AdfNode): number => {
  const order = list.attrs?.order;
  return typeof order === "number" && Number.isInteger(order) && order >= 0 ? order : 1;
};

// ---------------------------------------------------------------------------------------------
// ADF -> Markdown

/** Marks open in this order, so a link wraps emphasis and code is always innermost. */
const MARK_ORDER = ["link", "strong", "em", "strike"];
const sameMark = (a: AdfMark, b: AdfMark) =>
  a.type === b.type && (a.type !== "link" || stringAttr(a, "href") === stringAttr(b, "href"));

const escapeText = (value: string) => value.replace(/[\\`*_~[\]<]/g, "\\$&");
const escapeHref = (value: string) => value.replace(/[\\()]/g, "\\$&");

/** Escapes what would otherwise start a block at the beginning of a line. */
const escapeLineStart = (line: string) =>
  line.replace(/^(\s*)([#>+-])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");

const codeSpan = (value: string): string => {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (value.startsWith(" ") && value.endsWith(" ") && value.trim().length > 0)
      ? " "
      : "";
  return `${fence}${pad}${value}${pad}${fence}`;
};

const indentLines = (value: string, prefix: string) =>
  value
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");

/** Reads an ADF document (or a plain string, as old payloads send) as Markdown. */
export const adfToMarkdown = (document: unknown): AdfMarkdown => {
  if (typeof document === "string") return { markdown: document, lossy: false };
  if (!isNode(document)) return { markdown: "", lossy: false };
  let lossy = false;
  const omitted = (type: string) => {
    lossy = true;
    return `[${type} omitted]`;
  };

  const inline = (nodes: ReadonlyArray<AdfNode> | undefined): string => {
    let out = "";
    const open: Array<AdfMark> = [];
    const closeTo = (keep: number) => {
      while (open.length > keep) {
        const mark = open.pop()!;
        if (mark.type === "link") out += `](${escapeHref(stringAttr(mark, "href") ?? "")})`;
        else out += mark.type === "strong" ? "**" : mark.type === "em" ? "_" : "~~";
      }
    };
    for (const node of nodes ?? []) {
      const marks = node.type === "text" ? (node.marks ?? []) : [];
      const spans = MARK_ORDER.flatMap((type) => marks.filter((mark) => mark.type === type));
      let keep = 0;
      while (keep < open.length && spans.some((mark) => sameMark(mark, open[keep]!))) keep += 1;
      closeTo(keep);
      for (const mark of spans) {
        if (open.some((current) => sameMark(current, mark))) continue;
        out +=
          mark.type === "link"
            ? "["
            : mark.type === "strong"
              ? "**"
              : mark.type === "em"
                ? "_"
                : "~~";
        open.push(mark);
      }
      switch (node.type) {
        case "text": {
          const value = node.text ?? "";
          out += marks.some((mark) => mark.type === "code") ? codeSpan(value) : escapeText(value);
          break;
        }
        case "hardBreak":
          out += "\n";
          break;
        case "inlineCard": {
          const url = stringAttr(node, "url");
          out += url === undefined ? omitted("card") : `<${url}>`;
          break;
        }
        // These read as text; the round-trip check below reports them lossy.
        case "mention":
          out += escapeText(`@${(stringAttr(node, "text") ?? "someone").replace(/^@/, "")}`);
          break;
        case "emoji":
          out += escapeText(stringAttr(node, "text") ?? stringAttr(node, "shortName") ?? "");
          break;
        default:
          out += omitted(node.type);
      }
    }
    closeTo(0);
    return out;
  };

  const paragraph = (nodes: ReadonlyArray<AdfNode> | undefined) =>
    inline(nodes).split("\n").map(escapeLineStart).join("\n");

  const blocks = (
    nodes: ReadonlyArray<AdfNode> | undefined,
    separator: (next: AdfNode) => string,
  ) =>
    (nodes ?? []).reduce((out, node) => {
      const rendered = block(node);
      if (rendered.length === 0) return out;
      return out.length === 0 ? rendered : `${out}${separator(node)}${rendered}`;
    }, "");

  /** The first line follows the marker; the rest indent to the column the parser expects. */
  const listItem = (marker: string, body: string, column = marker.length + 1) => {
    const [first = "", ...rest] = body.split("\n");
    const head = first.length === 0 ? marker : `${marker} ${first}`;
    return rest.length === 0
      ? head
      : `${head}\n${indentLines(rest.join("\n"), " ".repeat(column))}`;
  };

  const block = (node: AdfNode): string => {
    switch (node.type) {
      case "paragraph":
        return paragraph(node.content);
      case "heading": {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        return `${"#".repeat(level)} ${inline(node.content)}`;
      }
      case "bulletList":
      case "orderedList": {
        const order = orderOf(node);
        return (node.content ?? [])
          .map((item, index) => {
            const marker = node.type === "bulletList" ? "-" : `${order + index}.`;
            if (item.type !== "listItem") return listItem(marker, omitted(item.type));
            // A nested list follows its paragraph directly; other siblings need a blank line.
            const body = blocks(item.content, (next) =>
              next.type === "bulletList" || next.type === "orderedList" ? "\n" : "\n\n",
            );
            return listItem(marker, body);
          })
          .join("\n");
      }
      case "taskList":
        return (node.content ?? [])
          .map((item) => {
            if (item.type === "taskList") return indentLines(block(item), "  ");
            if (item.type !== "taskItem") return `- ${omitted(item.type)}`;
            const done = stringAttr(item, "state") === "DONE";
            return listItem(`- [${done ? "x" : " "}]`, paragraph(item.content), 2);
          })
          .join("\n");
      case "codeBlock": {
        const language = stringAttr(node, "language") ?? "";
        const code = (node.content ?? []).map((child) => child.text ?? "").join("");
        const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `${fence}${language}\n${code}\n${fence}`;
      }
      case "blockquote":
        return blocks(node.content, () => "\n\n")
          .split("\n")
          .map((line) => (line.length === 0 ? ">" : `> ${line}`))
          .join("\n");
      case "rule":
        return "---";
      default:
        return omitted(node.type);
    }
  };

  const markdown = blocks(document.content, () => "\n\n");
  if (!lossy && !sameDocument(document, markdownToAdf(markdown))) lossy = true;
  return { markdown, lossy };
};

// ---------------------------------------------------------------------------------------------
// Markdown -> ADF

const text = (value: string, marks: ReadonlyArray<AdfMark>): AdfNode =>
  marks.length === 0 ? { type: "text", text: value } : { type: "text", text: value, marks };

const isPunctuation = (char: string | undefined) =>
  char !== undefined && /[!-/:-@[-`{-~]/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

/** The end of the backtick code span opening at `start`, or -1. */
const codeSpanEnd = (source: string, start: number): number => {
  const run = /^`+/.exec(source.slice(start))![0].length;
  const close = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, "g");
  close.lastIndex = start + run;
  const match = close.exec(source);
  return match === null ? -1 : match.index + run;
};

const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;

/** `[text](href)` at `start`: the text, the unescaped href and the end index. */
const linkAt = (source: string, start: number) => {
  let depth = 0;
  let index = start;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "`") {
      const end = codeSpanEnd(source, index);
      if (end > 0) index = end - 1;
    } else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) break;
  }
  if (index >= source.length || source[index + 1] !== "(") return undefined;
  let href = "";
  for (let at = index + 2; at < source.length; at += 1) {
    const char = source[at]!;
    if (char === ")") {
      return href.length === 0
        ? undefined
        : { label: source.slice(start + 1, index), href, end: at + 1 };
    }
    if (/\s/.test(char)) return undefined;
    if (char === "\\" && isPunctuation(source[at + 1])) {
      href += source[at + 1];
      at += 1;
    } else href += char;
  }
  return undefined;
};

const DELIMITERS = [
  { delimiter: "**", mark: "strong" },
  { delimiter: "~~", mark: "strike" },
  { delimiter: "_", mark: "em" },
  { delimiter: "*", mark: "em" },
] as const;

/** Where `delimiter`, opened just before `from`, closes, or -1. */
const closerAt = (source: string, from: number, delimiter: string): number => {
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") {
      const end = codeSpanEnd(source, index);
      if (end > 0) index = end - 1;
      continue;
    }
    if (!source.startsWith(delimiter, index)) continue;
    // A single `*` or `_` skips a doubled run, which belongs to a nested span.
    if (delimiter.length === 1 && source[index + 1] === delimiter) {
      index += 1;
      continue;
    }
    if (index === from || isSpace(source[index - 1])) continue;
    if (delimiter === "_" && isWordChar(source[index + 1])) continue;
    return index;
  }
  return -1;
};

/** A `**`, `~~`, `_` or `*` span opening at `index`. */
const spanAt = (source: string, index: number) => {
  for (const { delimiter, mark } of DELIMITERS) {
    if (!source.startsWith(delimiter, index)) continue;
    const after = index + delimiter.length;
    if (isSpace(source[after])) continue;
    if (delimiter === "_" && isWordChar(source[index - 1])) continue;
    const close = closerAt(source, after, delimiter);
    if (close >= 0) {
      return { mark, inner: source.slice(after, close), end: close + delimiter.length };
    }
  }
  return undefined;
};

const withMark = (marks: ReadonlyArray<AdfMark>, mark: AdfMark): ReadonlyArray<AdfMark> =>
  marks.some((current) => current.type === mark.type)
    ? marks.map((current) => (current.type === mark.type ? mark : current))
    : [...marks, mark];

/** ADF allows `code` only alongside `link`. */
const codeMarks = (marks: ReadonlyArray<AdfMark>): ReadonlyArray<AdfMark> => [
  ...marks.filter((mark) => mark.type === "link"),
  { type: "code" },
];

/** Inline Markdown: escapes, code spans, links, `<url>` cards and `**`, `_`/`*`, `~~` spans. */
const parseInline = (source: string, marks: ReadonlyArray<AdfMark> = []): Array<AdfNode> => {
  const nodes: Array<AdfNode> = [];
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) nodes.push(text(buffer, marks));
    buffer = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\" && isPunctuation(source[index + 1])) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(source.slice(index))![0].length;
      const end = codeSpanEnd(source, index);
      if (end < 0) {
        buffer += "`".repeat(run);
        index += run;
        continue;
      }
      let code = source.slice(index + run, end - run);
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
        code = code.slice(1, -1);
      }
      flush();
      if (code.length > 0) nodes.push(text(code, codeMarks(marks)));
      index = end;
      continue;
    }
    if (char === "[") {
      const link = linkAt(source, index);
      if (link !== undefined) {
        flush();
        nodes.push(
          ...parseInline(link.label, withMark(marks, { type: "link", attrs: { href: link.href } })),
        );
        index = link.end;
        continue;
      }
    }
    if (char === "<") {
      AUTOLINK.lastIndex = index;
      const card = AUTOLINK.exec(source);
      if (card !== null) {
        flush();
        nodes.push({ type: "inlineCard", attrs: { url: card[1]! } });
        index += card[0].length;
        continue;
      }
    }
    const span = spanAt(source, index);
    if (span !== undefined) {
      flush();
      nodes.push(...parseInline(span.inner, withMark(marks, { type: span.mark })));
      index = span.end;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
};

type Context = "doc" | "quote" | "item" | "task";

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE = /^ {0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:( +)(.*))?$/;
const TASK = /^\[([ xX])\](?: +(.*))?$/;

interface ItemStart {
  readonly kind: "bullet" | "ordered" | "task";
  readonly number: number;
  readonly column: number;
  readonly rest: string;
  readonly done: boolean;
}

const itemStart = (line: string, context: Context): ItemStart | undefined => {
  const match = ITEM.exec(line);
  if (match === null) return undefined;
  const [, indent, marker, digits, spaces = " ", rest = ""] = match;
  const width = spaces.length <= 4 ? spaces.length : 1;
  const column = indent!.length + marker!.length + width;
  const body = spaces.length <= 4 ? rest : `${spaces.slice(1)}${rest}`;
  const task = digits === undefined ? TASK.exec(body) : null;
  if (context === "task") {
    return task === null
      ? undefined
      : { kind: "task", number: 1, column, rest: task[2] ?? "", done: task[1] !== " " };
  }
  if (task !== null && context === "doc") {
    return { kind: "task", number: 1, column, rest: task[2] ?? "", done: task[1] !== " " };
  }
  return digits === undefined
    ? { kind: "bullet", number: 1, column, rest: body, done: false }
    : { kind: "ordered", number: Number(digits), column, rest: body, done: false };
};

const leadingSpaces = (line: string) => /^ */.exec(line)![0].length;
const isBlank = (line: string) => line.trim().length === 0;

const emptyParagraph = (): AdfNode => ({ type: "paragraph", content: [] });

/** Writes Markdown in the subset above as an ADF document. */
export const markdownToAdf = (markdown: string): AdfNode => {
  let localIds = 0;
  const localId = () => `work-${(localIds += 1)}`;

  // ADF allows headings, rules, quotes and task lists only at the top level (task lists also
  // nest in task lists), and only text in task items; elsewhere those lines read as text.
  const startsBlock = (line: string, context: Context) =>
    itemStart(line, context) !== undefined ||
    (context !== "task" && FENCE.test(line)) ||
    (context === "doc" && (HEADING.test(line) || RULE.test(line) || QUOTE.test(line)));

  // Every branch consumes at least the line it starts on, so parsing always terminates.
  const parseBlocks = (lines: ReadonlyArray<string>, context: Context): Array<AdfNode> => {
    const out: Array<AdfNode> = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        index += 1;
        continue;
      }
      const fence = context === "task" ? null : FENCE.exec(line);
      if (fence !== null) {
        const [, indent, open, language] = fence;
        const close = new RegExp(
          `^ {0,3}${open![0] === "`" ? "`" : "~"}{${open!.length},}[ \\t]*$`,
        );
        const code: Array<string> = [];
        index += 1;
        while (index < lines.length && !close.test(lines[index]!)) {
          const codeLine = lines[index]!;
          code.push(codeLine.slice(Math.min(indent!.length, leadingSpaces(codeLine))));
          index += 1;
        }
        index += 1;
        const value = code.join("\n");
        out.push({
          type: "codeBlock",
          ...(language ? { attrs: { language } } : {}),
          content: value.length === 0 ? [] : [{ type: "text", text: value }],
        });
        continue;
      }
      const heading = context === "doc" ? HEADING.exec(line) : null;
      if (heading !== null) {
        out.push({
          type: "heading",
          attrs: { level: heading[1]!.length },
          content: parseInline(heading[2] ?? ""),
        });
        index += 1;
        continue;
      }
      if (context === "doc" && RULE.test(line)) {
        out.push({ type: "rule" });
        index += 1;
        continue;
      }
      if (context === "doc" && QUOTE.test(line)) {
        const quoted: Array<string> = [];
        while (index < lines.length && QUOTE.test(lines[index]!)) {
          quoted.push(lines[index]!.replace(/^ {0,3}> ?/, ""));
          index += 1;
        }
        const content = parseBlocks(quoted, "quote");
        out.push({
          type: "blockquote",
          content: content.length === 0 ? [emptyParagraph()] : content,
        });
        continue;
      }
      const first = itemStart(line, context);
      if (first !== undefined) {
        const items: Array<AdfNode> = [];
        let start: ItemStart | undefined = first;
        while (start !== undefined) {
          // The item's own lines: its first line, then lines indented to its content column,
          // with blank lines kept when more indented content follows.
          const body = [start.rest];
          index += 1;
          while (index < lines.length) {
            const next = lines[index]!;
            if (isBlank(next)) {
              let ahead = index;
              while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
              if (ahead >= lines.length || leadingSpaces(lines[ahead]!) < start.column) break;
            } else if (leadingSpaces(next) < start.column) break;
            body.push(next.slice(Math.min(start.column, leadingSpaces(next))));
            index += 1;
          }
          if (start.kind === "task") {
            const [head, ...nested] = parseBlocks(body, "task");
            const inline: Array<AdfNode> = [];
            const tail: Array<AdfNode> = [];
            for (const child of head === undefined ? [] : [head, ...nested]) {
              if (child.type === "taskList") tail.push(child);
              else {
                if (inline.length > 0) inline.push({ type: "hardBreak" });
                inline.push(...(child.content ?? []));
              }
            }
            items.push({
              type: "taskItem",
              attrs: { localId: localId(), state: start.done ? "DONE" : "TODO" },
              content: inline,
            });
            items.push(...tail);
          } else {
            const content = parseBlocks(body, "item");
            if (content[0]?.type !== "paragraph" && content[0]?.type !== "codeBlock") {
              content.unshift(emptyParagraph());
            }
            items.push({ type: "listItem", content });
          }
          // Blank lines between items keep the list going when the next item is the same kind.
          let ahead = index;
          while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
          const next = ahead < lines.length ? itemStart(lines[ahead]!, context) : undefined;
          start = next?.kind === first.kind ? next : undefined;
          if (start !== undefined) index = ahead;
        }
        out.push(
          first.kind === "task"
            ? { type: "taskList", attrs: { localId: localId() }, content: items }
            : first.kind === "bullet"
              ? { type: "bulletList", content: items }
              : {
                  type: "orderedList",
                  ...(first.number === 1 ? {} : { attrs: { order: first.number } }),
                  content: items,
                },
        );
        continue;
      }
      const paragraph: Array<string> = [line.trimStart()];
      index += 1;
      while (
        index < lines.length &&
        !isBlank(lines[index]!) &&
        !startsBlock(lines[index]!, context)
      ) {
        paragraph.push(lines[index]!.trimStart());
        index += 1;
      }
      const content: Array<AdfNode> = [];
      paragraph.forEach((part, at) => {
        if (at > 0) content.push({ type: "hardBreak" });
        content.push(...parseInline(part));
      });
      out.push({ type: "paragraph", content });
    }
    return out;
  };

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", version: 1, content: parseBlocks(lines, "doc") };
};

// ---------------------------------------------------------------------------------------------
// Comparison

const KNOWN_MARKS = new Set(["strong", "em", "code", "strike", "link"]);

const normalizeMarks = (marks: ReadonlyArray<AdfMark> | undefined) =>
  (marks ?? [])
    .map((mark) =>
      mark.type === "link"
        ? { type: "link", href: stringAttr(mark, "href") ?? "" }
        : KNOWN_MARKS.has(mark.type)
          ? { type: mark.type }
          : { type: mark.type, attrs: mark.attrs ?? {} },
    )
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** The attributes that change what a node means; ids and layout hints are left out. */
const meaningfulAttrs = (node: AdfNode): unknown => {
  switch (node.type) {
    case "heading":
      return { level: node.attrs?.level };
    case "codeBlock":
      return { language: stringAttr(node, "language") || null };
    case "orderedList":
      return { order: orderOf(node) };
    case "taskItem":
      return { state: stringAttr(node, "state") };
    case "inlineCard":
      return { url: stringAttr(node, "url") };
    case "doc":
    case "paragraph":
    case "text":
    case "hardBreak":
    case "bulletList":
    case "listItem":
    case "taskList":
    case "blockquote":
    case "rule":
      return null;
    default:
      return node.attrs ?? null;
  }
};

/**
 * A comparable form of ADF content: adjacent text with equal marks merges, empty text and empty
 * paragraphs (Jira's spacing artifacts) drop out.
 */
const normalize = (nodes: ReadonlyArray<AdfNode> | undefined): Array<unknown> => {
  const out: Array<Record<string, unknown>> = [];
  for (const node of nodes ?? []) {
    if (node.type === "text") {
      if (!node.text) continue;
      const marks = normalizeMarks(node.marks);
      const previous = out.at(-1);
      if (previous?.type === "text" && JSON.stringify(previous.marks) === JSON.stringify(marks)) {
        previous.text = `${String(previous.text)}${node.text}`;
      } else out.push({ type: "text", text: node.text, marks });
      continue;
    }
    if (
      node.type === "paragraph" &&
      (node.content ?? []).every((child) => child.type === "text" && !child.text)
    ) {
      continue;
    }
    out.push({
      type: node.type,
      attrs: meaningfulAttrs(node),
      marks: normalizeMarks(node.marks),
      content: normalize(node.content),
    });
  }
  return out;
};

const sameDocument = (a: AdfNode, b: AdfNode) =>
  JSON.stringify(normalize(a.content)) === JSON.stringify(normalize(b.content));
