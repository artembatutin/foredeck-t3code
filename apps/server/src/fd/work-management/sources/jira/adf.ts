/**
 * Atlassian Document Format to Markdown and back, for the subset Work edits: paragraphs,
 * headings, lists, task lists, code blocks, quotes, rules, hard breaks and the strong, em, code,
 * strike and link marks; mentions and inline cards read as text and links. Anything else becomes
 * a visible placeholder and marks the body lossy, so Work never writes such a body back.
 */

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: ReadonlyArray<{
    readonly type: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }>;
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

const stringAttr = (node: AdfNode, name: string): string | undefined => {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : undefined;
};

/** Reads an ADF document (or a plain string, as old payloads send) as Markdown. */
export const adfToMarkdown = (document: unknown): AdfMarkdown => {
  if (typeof document === "string") return { markdown: document, lossy: false };
  if (!isNode(document)) return { markdown: "", lossy: false };
  let lossy = false;
  const omitted = (type: string) => {
    lossy = true;
    return `[${type} omitted]`;
  };

  const inline = (nodes: ReadonlyArray<AdfNode> | undefined): string =>
    (nodes ?? [])
      .map((node) => {
        switch (node.type) {
          case "text": {
            let text = node.text ?? "";
            for (const mark of node.marks ?? []) {
              switch (mark.type) {
                case "strong":
                  text = `**${text}**`;
                  break;
                case "em":
                  text = `_${text}_`;
                  break;
                case "code":
                  text = `\`${text}\``;
                  break;
                case "strike":
                  text = `~~${text}~~`;
                  break;
                case "link": {
                  const href = mark.attrs?.href;
                  if (typeof href === "string") text = `[${text}](${href})`;
                  break;
                }
                default:
                  // Colors, underline and the like change looks, not meaning.
                  break;
              }
            }
            return text;
          }
          case "hardBreak":
            return "\n";
          case "mention":
            return `@${(stringAttr(node, "text") ?? "someone").replace(/^@/, "")}`;
          case "inlineCard": {
            const url = stringAttr(node, "url");
            return url === undefined ? omitted("card") : `<${url}>`;
          }
          case "emoji":
            return stringAttr(node, "text") ?? omitted("emoji");
          default:
            return omitted(node.type);
        }
      })
      .join("");

  const block = (node: AdfNode, depth: number): string => {
    const indent = "  ".repeat(depth);
    switch (node.type) {
      case "paragraph":
        return inline(node.content);
      case "heading": {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        return `${"#".repeat(level)} ${inline(node.content)}`;
      }
      case "bulletList":
      case "orderedList":
        return (node.content ?? [])
          .map((item, index) => {
            const marker = node.type === "bulletList" ? "-" : `${index + 1}.`;
            return listItem(item, marker, depth);
          })
          .join("\n");
      case "taskList":
        return (node.content ?? [])
          .map((item) => {
            const done = stringAttr(item, "state") === "DONE";
            return `${indent}- [${done ? "x" : " "}] ${inline(item.content)}`;
          })
          .join("\n");
      case "codeBlock": {
        const language = stringAttr(node, "language") ?? "";
        const code = (node.content ?? []).map((child) => child.text ?? "").join("");
        return `\`\`\`${language}\n${code}\n\`\`\``;
      }
      case "blockquote":
        return (node.content ?? [])
          .map((child) => block(child, 0))
          .join("\n\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "rule":
        return "---";
      default:
        return omitted(node.type);
    }
  };

  const listItem = (item: AdfNode, marker: string, depth: number): string => {
    const indent = "  ".repeat(depth);
    const [first, ...rest] = item.content ?? [];
    const head =
      first === undefined
        ? ""
        : first.type === "paragraph"
          ? inline(first.content)
          : block(first, depth + 1);
    const tail = rest.map((child) =>
      child.type === "bulletList" || child.type === "orderedList"
        ? block(child, depth + 1)
        : `${indent}  ${block(child, depth + 1)}`,
    );
    return [`${indent}${marker} ${head}`, ...tail].join("\n");
  };

  const markdown = (document.content ?? []).map((node) => block(node, 0)).join("\n\n");
  return { markdown, lossy };
};

const text = (value: string, marks?: AdfNode["marks"]): AdfNode =>
  marks === undefined || marks.length === 0
    ? { type: "text", text: value }
    : { type: "text", text: value, marks };

/** Inline Markdown: `**strong**`, `_em_` / `*em*`, `` `code` ``, `~~strike~~`, `[text](url)`. */
const INLINE =
  /(\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])[_*]([^_*]+)[_*](?![\w*]))/g;

const inlineNodes = (line: string): ReadonlyArray<AdfNode> => {
  const nodes: Array<AdfNode> = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text(line.slice(last, match.index)));
    if (match[2] !== undefined) nodes.push(text(match[2], [{ type: "strong" }]));
    else if (match[3] !== undefined) nodes.push(text(match[3], [{ type: "strike" }]));
    else if (match[4] !== undefined) nodes.push(text(match[4], [{ type: "code" }]));
    else if (match[5] !== undefined && match[6] !== undefined) {
      nodes.push(text(match[5], [{ type: "link", attrs: { href: match[6] } }]));
    } else if (match[7] !== undefined) nodes.push(text(match[7], [{ type: "em" }]));
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(text(line.slice(last)));
  return nodes;
};

const paragraph = (lines: ReadonlyArray<string>): AdfNode => {
  const content: Array<AdfNode> = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...inlineNodes(line));
  });
  return { type: "paragraph", content };
};

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TASK_ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;

/** Writes Markdown in the subset above as an ADF document. */
export const markdownToAdf = (markdown: string): AdfNode => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: Array<AdfNode> = [];
  let index = 0;
  let taskId = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence !== null) {
      const code: Array<string> = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: code.length === 0 ? [] : [text(code.join("\n"))],
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      content.push({
        type: "heading",
        attrs: { level: heading[1]!.length },
        content: inlineNodes(heading[2]!),
      });
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      content.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: Array<string> = [];
      while (index < lines.length && lines[index]!.startsWith(">")) {
        quoted.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      content.push({ type: "blockquote", content: markdownToAdf(quoted.join("\n")).content ?? [] });
      continue;
    }
    if (TASK_ITEM.test(line)) {
      const items: Array<AdfNode> = [];
      while (index < lines.length && TASK_ITEM.test(lines[index]!)) {
        const [, state, body] = TASK_ITEM.exec(lines[index]!)!;
        taskId += 1;
        items.push({
          type: "taskItem",
          attrs: { localId: `task-${taskId}`, state: state === " " ? "TODO" : "DONE" },
          content: inlineNodes(body!),
        });
        index += 1;
      }
      content.push({ type: "taskList", attrs: { localId: `tasks-${taskId}` }, content: items });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: Array<AdfNode> = [];
      while (
        index < lines.length &&
        LIST_ITEM.test(lines[index]!) &&
        !TASK_ITEM.test(lines[index]!)
      ) {
        const [, , , body] = LIST_ITEM.exec(lines[index]!)!;
        items.push({ type: "listItem", content: [paragraph([body!])] });
        index += 1;
      }
      content.push({ type: ordered ? "orderedList" : "bulletList", content: items });
      continue;
    }
    const block: Array<string> = [];
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !/^(```|#{1,6}\s|>)/.test(lines[index]!) &&
      !LIST_ITEM.test(lines[index]!)
    ) {
      block.push(lines[index]!);
      index += 1;
    }
    content.push(paragraph(block));
  }
  return { type: "doc", attrs: { version: 1 }, content } as AdfNode & {
    readonly attrs: { version: number };
  };
};
