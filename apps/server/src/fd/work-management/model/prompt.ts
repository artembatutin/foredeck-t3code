import {
  type WorkItemDetail,
  type WorkThreadMode,
  workItemRefString,
} from "@t3tools/contracts/fd/work-management";

import { truncateText } from "./bounds.ts";

/**
 * The first message of a thread started from a Work item, and the branch it works on. Both are
 * pure so the exact text an agent receives is tested, not inferred.
 */

/** What a started thread reads about its item; links and capabilities are not prompt material. */
export type WorkPromptItem = Omit<WorkItemDetail, "links" | "capabilities">;

export const PROMPT_BODY_MAX_CHARS = 16_000;
export const PROMPT_COMMENTS_MAX = 10;
export const PROMPT_COMMENT_MAX_CHARS = 2_000;
const TITLE_MAX_CHARS = 100;
const BRANCH_SLUG_MAX_CHARS = 40;

/** The key a branch name can carry: `fd-7k3qa2`, `gh-123`, `PROJ-12`. */
export const workBranchKey = (item: Pick<WorkPromptItem, "kind" | "ref">): string =>
  item.kind === "github" ? `gh-${item.ref.itemId}` : item.ref.itemId;

/**
 * `work/<key>-<slug>`. The Jira key keeps its case so tracker automations recognize it; the slug
 * keeps only lowercase letters, digits and single dashes.
 */
export const workBranchName = (item: Pick<WorkPromptItem, "kind" | "ref" | "title">): string => {
  const slug = item.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX_CHARS)
    .replace(/-+$/, "");
  const key = workBranchKey(item);
  return slug.length === 0 ? `work/${key}` : `work/${key}-${slug}`;
};

/** `<key>: <title>`, cut to the thread title limit. */
export const workThreadTitle = (item: Pick<WorkPromptItem, "key" | "title">): string =>
  truncateText(`${item.key}: ${item.title}`, TITLE_MAX_CHARS).text;

const MODE_INSTRUCTIONS: Record<WorkThreadMode, string> = {
  scope:
    "Mode: scope. Investigate the item and reply with a plan, its risks and your confidence. Change no files. Post the plan once with work_comment.",
  plan: "Mode: plan. Write the implementation plan, then stop and ask before changing anything.",
  implement:
    "Mode: implement. Implement the item, verify it, and open exactly one pull request titled `<key>: ...` whose body references the item. Never open a second pull request for it.",
};

const field = (label: string, value: string | null | undefined): string | null =>
  value === null || value === undefined || value.length === 0 ? null : `${label}: ${value}`;

/**
 * The prompt for a thread started from `item`. `directory` is the Markdown source's directory,
 * whose frontmatter the thread must not edit in its worktree.
 */
export const renderWorkPrompt = (input: {
  readonly item: WorkPromptItem;
  readonly mode: WorkThreadMode;
  readonly directory?: string | undefined;
  readonly extra?: string | undefined;
}): string => {
  const { item, mode } = input;
  const header = [
    `Work item ${item.key} (${item.kind}): ${item.title}`,
    field("Link", item.url),
    field("File", item.locator),
    field("Status", item.nativeStatus?.name ?? item.status),
    field("Priority", item.priority),
    field("Labels", item.labels.join(", ")),
    field("Assignee", item.assignee?.label),
    field("Parent", item.parent),
    field("Blocked by", item.blockedBy.join(", ")),
  ].filter((line): line is string => line !== null);

  const body = truncateText(item.body, PROMPT_BODY_MAX_CHARS);
  const sections = [header.join("\n")];
  if (body.text.trim().length > 0) {
    sections.push(
      `Description:\n${body.text}${body.truncated || item.bodyTruncated ? "\n[description truncated; read the rest with work_read]" : ""}`,
    );
  }
  const recent = item.comments.slice(-PROMPT_COMMENTS_MAX);
  if (recent.length > 0) {
    sections.push(
      `Recent comments:\n${recent
        .map((comment) => {
          const text = truncateText(comment.body, PROMPT_COMMENT_MAX_CHARS);
          return `- ${comment.author?.label ?? "unknown"} (${comment.createdAt}): ${text.text}${text.truncated ? " [truncated]" : ""}`;
        })
        .join("\n")}`,
    );
  }
  sections.push(`work-item: ${workItemRefString(item.ref)}`);
  sections.push(MODE_INSTRUCTIONS[mode].replace("<key>", item.key));
  sections.push(
    [
      "Work tools:",
      "- Read the item again with work_read only when told it changed.",
      "- Report progress at milestones with work_comment.",
      "- Change its status with work_set_status: in_progress when you start, done only after verification.",
      ...(input.directory === undefined
        ? []
        : [
            `- Do not edit the frontmatter of ${input.directory}/*.md in your worktree; the work_* tools write the canonical copy.`,
          ]),
    ].join("\n"),
  );
  if (input.extra !== undefined && input.extra.trim().length > 0) sections.push(input.extra);
  return sections.join("\n\n");
};
