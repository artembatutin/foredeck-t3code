import type { FactoryReviewSummary, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import type { WorkItemDetail } from "@t3tools/contracts/fd/work-management";

import type { FactoryBranchCommit } from "../git/branchFacts.ts";
import { conventionalSubject, PULL_REQUEST_TITLE_MAX_CHARS } from "../git/publishedText.ts";
import { commandLine, describeResult } from "./review.ts";

/**
 * A delivery's pull request text: plain language naming the Work item and the evidence behind
 * each accepted task. The template names no agent, model or provider and carries no attribution,
 * but the item's text and the verify command appear as they are, so the rendered text is checked
 * with `evaluatePublication` before anything is published. Pure, so the exact text is tested rather
 * than inferred.
 */

/** What the pull request says about its item. */
export type FactoryPullRequestItem = Pick<WorkItemDetail, "key" | "title" | "url">;

/** What an approval rests on. */
export interface FactoryPullRequestEvidence {
  /** The passing verify run of the approved commit. */
  readonly receipt: FactoryVerifyReceipt;
  /** The accepted review of that commit, and the round it closed. */
  readonly review: { readonly round: number; readonly summary: FactoryReviewSummary };
}

/** An accepted task, a parent's child item among them, and what its approval rests on. */
export interface FactoryPullRequestTask extends FactoryPullRequestEvidence {
  readonly title: string;
}

// The host's limit, which the stacked action's body override shares.
const BODY_MAX_CHARS = 65_536;
const COMMAND_MAX_CHARS = 500;
/** What a title keeps for its summary before it gives up its scope. */
const MIN_SUMMARY_CHARS = 24;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A title on one line, so a line of an item's text cannot read as a trailer of the body. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The type a pull request of several commits takes: the first of these any of them has. */
const TYPE_ORDER = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "docs",
  "test",
  "build",
  "ci",
  "style",
  "chore",
];

/**
 * The Conventional prefix the settled commits add up to: the type of the most significant, the
 * scope when all commits of that type share one, and the breaking mark when any commit has it.
 */
const titlePrefix = (commits: ReadonlyArray<Pick<FactoryBranchCommit, "subject">>) => {
  const parsed = commits.flatMap(({ subject }) => {
    const match = conventionalSubject.exec(subject);
    return match === null ? [] : [{ type: match[1], scope: match[2], breaking: match[3] === "!" }];
  });
  const type = TYPE_ORDER.find((candidate) => parsed.some((c) => c.type === candidate)) ?? "chore";
  const ofType = parsed.filter((commit) => commit.type === type);
  const scope = ofType[0]?.scope;
  const breaking = parsed.some((commit) => commit.breaking) ? "!" : "";
  return {
    scoped:
      scope !== undefined && ofType.every((commit) => commit.scope === scope)
        ? `${type}(${scope})${breaking}`
        : `${type}${breaking}`,
    bare: `${type}${breaking}`,
  };
};

/** Punctuation a title does not end on, which a sentence or a cut can leave. */
const withoutEnd = (text: string) => text.replace(/[\s.,;:!?-]+$/, "");

/**
 * The whole words of `text` that fit in `max` characters; empty when not even the first does. A cut
 * word reads as another word, and a cut identifier or address names something else.
 */
const wholeWords = (text: string, max: number) => {
  if (text.length <= max) return text;
  const space = text.slice(0, max + 1).lastIndexOf(" ");
  return space > 0 ? withoutEnd(text.slice(0, space)) : "";
};

/** A title that opens with its own key does not say it twice. */
const withoutKey = (text: string, key: string) =>
  text.startsWith(key) && !/^[\w-]/.test(text.slice(key.length))
    ? text.slice(key.length).replace(/^[:\s-]+/, "")
    : text;

/**
 * `<type>(<scope>): <key> <summary>`, on one line and short: the type and scope from the delivery's
 * settled commits, the summary from the first line of the item's title, kept to the whole words that
 * fit. The key is never cut, and a scope that would crowd out the summary goes first. A title that
 * still cannot fit stays whole and over the limit, for the publication gate to refuse. A parent's
 * title is its item's, over its whole branch's commits.
 */
export const renderPullRequestTitle = (
  item: Pick<FactoryPullRequestItem, "key" | "title">,
  commits: ReadonlyArray<Pick<FactoryBranchCommit, "subject">>,
): string => {
  const { scoped, bare } = titlePrefix(commits);
  const firstLine = item.title.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const summary = withoutEnd(withoutKey(oneLine(firstLine), item.key));
  const head = (prefix: string) => `${prefix}: ${item.key}`;
  const room = (prefix: string) => PULL_REQUEST_TITLE_MAX_CHARS - head(prefix).length - 1;
  const preferred =
    head(scoped).length <= PULL_REQUEST_TITLE_MAX_CHARS - MIN_SUMMARY_CHARS ? scoped : bare;
  if (summary.length === 0 || room(bare) <= 0) return head(preferred);
  for (const prefix of [preferred, bare]) {
    const words = wholeWords(summary, room(prefix));
    if (words.length > 0) return `${head(prefix)} ${words}`;
  }
  return `${head(bare)} ${summary}`;
};

const evidenceLines = ({ receipt, review }: FactoryPullRequestEvidence, indent: string) => {
  const { high, medium, low } = review.summary.findings;
  return [
    `${indent}- Verified commit: \`${receipt.headSha}\``,
    `${indent}- Verify command: \`${cut(commandLine(receipt), COMMAND_MAX_CHARS)}\`, ${describeResult(receipt)}`,
    `${indent}- Review: ${review.summary.verdict} in round ${review.round}, with ${high} high, ${medium} medium and ${low} low severity findings`,
  ];
};

const taskLines = (task: FactoryPullRequestTask, index: number) =>
  [`${index + 1}. ${oneLine(task.title)}`, ...evidenceLines(task, "   ")].join("\n");

/**
 * The item, with its link when it has one, then each accepted task with its evidence. A parent's
 * tasks are its child items in plan order, and its `branch`, the whole branch's verify and
 * integrate review, comes before them: a body cut to the host's limit loses its end.
 */
export const renderPullRequestBody = (input: {
  readonly item: FactoryPullRequestItem;
  readonly tasks: ReadonlyArray<FactoryPullRequestTask>;
  readonly branch?: FactoryPullRequestEvidence;
}): string => {
  const { item, branch } = input;
  const heading = [
    `Work item ${item.key}: ${oneLine(item.title)}`,
    ...(item.url === null ? [] : [`Link: ${item.url}`]),
  ];
  const tasks = input.tasks.map(taskLines).join("\n");
  const sections =
    branch === undefined
      ? [heading.join("\n"), `Accepted tasks:\n\n${tasks}`]
      : [
          heading.join("\n"),
          `Whole branch, verified and reviewed by every child's criteria:\n\n${evidenceLines(branch, "").join("\n")}`,
          `Child items, in order:\n\n${tasks}`,
        ];
  return cut(sections.join("\n\n"), BODY_MAX_CHARS);
};
