import { type WorkItemDetail, workItemRefString } from "@t3tools/contracts/fd/work-management";

/**
 * The first message of an author thread: the Work item it implements and Looper's author rules,
 * condensed. Pure, so the exact text an author receives is tested rather than inferred.
 */

/** What an author reads about its item. */
export type FactoryAuthorItem = Pick<
  WorkItemDetail,
  "ref" | "key" | "title" | "url" | "locator" | "body" | "bodyTruncated"
>;

const BODY_MAX_CHARS = 16_000;
const TITLE_MAX_CHARS = 100;

const truncate = (text: string, max: number) =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

/** `<key>: <title>`, cut to the thread title limit. */
export const authorThreadTitle = (item: Pick<FactoryAuthorItem, "key" | "title">): string =>
  truncate(`${item.key}: ${item.title}`, TITLE_MAX_CHARS).text;

const RULES = [
  "Implement only this task; do not widen its scope.",
  "Add durable regression tests for the behavior and its meaningful failure cases.",
  "Never weaken, skip or delete checks or tests, and never adjust expected results to hide a bug.",
  "Run focused checks while you work. The server runs the project's full verification after you finish.",
  "Review your own diff before you commit.",
  "Commit with Conventional Commits (`type(scope): summary`) and leave the worktree clean: nothing staged, modified or untracked.",
  "Never push, merge, switch branches, edit outside this worktree or rewrite existing commits.",
  "Never name an AI agent, model or provider in commits, and add no AI attribution (Generated-by, Assisted-by, generated with, AI co-authors).",
  "Leave the Work item's status alone; Factory updates it.",
  "Stop and say so when you need credentials you do not have or a decision only the owner can make.",
];

/** The item's heading line, then its link, file and Work reference, then its description. */
export const itemSections = (item: FactoryAuthorItem, heading: string): Array<string> => {
  const header = [
    heading,
    ...(item.url === null ? [] : [`Link: ${item.url}`]),
    ...(item.locator === undefined ? [] : [`File: ${item.locator}`]),
    `work-item: ${workItemRefString(item.ref)}`,
  ];
  const sections = [header.join("\n")];
  const body = truncate(item.body, BODY_MAX_CHARS);
  if (body.text.trim().length > 0) {
    sections.push(
      `Description:\n${body.text}${body.truncated || item.bodyTruncated ? "\n[description truncated; read the rest with work_read]" : ""}`,
    );
  }
  return sections;
};

export const renderAuthorPrompt = (input: {
  readonly item: FactoryAuthorItem;
  readonly branch: string;
}): string => {
  const { item } = input;
  const sections = itemSections(
    item,
    `Factory author task for Work item ${item.key}: ${item.title}`,
  );
  sections.push(
    `Your task: implement this Work item on branch \`${input.branch}\` in this worktree.`,
  );
  const rules = [
    ...RULES,
    // The worktree's copy of a Markdown task file is not the canonical one.
    ...(item.locator === undefined ? [] : [`Do not edit \`${item.locator}\` in this worktree.`]),
  ];
  sections.push(`Rules:\n${rules.map((rule) => `- ${rule}`).join("\n")}`);
  sections.push(
    "Finish with a summary that maps each acceptance criterion to the committed test paths that check it, and label anything unverified.",
  );
  return sections.join("\n\n");
};
