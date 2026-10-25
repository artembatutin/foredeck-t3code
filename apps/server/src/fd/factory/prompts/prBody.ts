import type { FactoryReviewSummary, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import type { WorkItemDetail } from "@t3tools/contracts/fd/work-management";

import { carriesAiAttribution, namesAiTool } from "../git/publishedText.ts";
import { commandLine, describeResult } from "./review.ts";

/**
 * A delivery's pull request text: plain language naming the Work item and the evidence behind
 * each accepted task. The template names no agent, model or provider and carries no attribution,
 * but the item's text and the verify command appear as written, so the rendered text is checked
 * with `pullRequestTextProblems` before anything is published. Pure, so the exact text is tested
 * rather than inferred.
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

// The host's limits, which the stacked action's title and body overrides share.
const TITLE_MAX_CHARS = 256;
const BODY_MAX_CHARS = 65_536;
const COMMAND_MAX_CHARS = 500;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** `<key>: <title>`, cut to the host's title limit. */
export const renderPullRequestTitle = (item: FactoryPullRequestItem): string =>
  cut(`${item.key}: ${item.title}`, TITLE_MAX_CHARS);

const evidenceLines = ({ receipt, review }: FactoryPullRequestEvidence, indent: string) => {
  const { high, medium, low } = review.summary.findings;
  return [
    `${indent}- Verified commit: \`${receipt.headSha}\``,
    `${indent}- Verify command: \`${cut(commandLine(receipt), COMMAND_MAX_CHARS)}\`, ${describeResult(receipt)}`,
    `${indent}- Review: ${review.summary.verdict} in round ${review.round}, with ${high} high, ${medium} medium and ${low} low severity findings`,
  ];
};

const taskLines = (task: FactoryPullRequestTask, index: number) =>
  [`${index + 1}. ${task.title}`, ...evidenceLines(task, "   ")].join("\n");

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
    `Work item ${item.key}: ${item.title}`,
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

/** A rule the rendered title or body breaks; Factory publishes neither while one does. */
export interface FactoryPullRequestTextProblem {
  readonly field: "title" | "body";
  readonly rule: "ai_name" | "ai_attribution";
}

/** What keeps the rendered text from being published, in field order; empty when nothing does. */
export const pullRequestTextProblems = (text: {
  readonly title: string;
  readonly body: string;
}): ReadonlyArray<FactoryPullRequestTextProblem> =>
  (["title", "body"] as const).flatMap((field) => [
    ...(namesAiTool(text[field]) ? [{ field, rule: "ai_name" as const }] : []),
    ...(carriesAiAttribution(text[field]) ? [{ field, rule: "ai_attribution" as const }] : []),
  ]);
