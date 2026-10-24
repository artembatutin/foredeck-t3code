import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";

import { type FactoryAuthorItem, itemSections } from "./author.ts";

/**
 * The reviewer's messages: the first turn of a review, and the one retry after an invalid
 * submission. Pure, so the exact text a reviewer receives is tested rather than inferred.
 */

/**
 * What a first-round reviewer reads: the item and the verified commit. Nothing from the author
 * thread, so the review never starts from the author's account of its own work.
 */
export interface FactoryReviewPromptInput {
  readonly item: FactoryAuthorItem;
  readonly branch: string;
  /** The task baseline; the review covers `baseline..receipt.headSha`. */
  readonly baseline: string;
  /** The server's passing verify run of the commit under review. */
  readonly receipt: FactoryVerifyReceipt;
}

const TITLE_MAX_CHARS = 100;

/** `Review <key>: <title>`, cut to the thread title limit. */
export const reviewThreadTitle = (item: Pick<FactoryAuthorItem, "key" | "title">): string =>
  `Review ${item.key}: ${item.title}`.slice(0, TITLE_MAX_CHARS);

const RULES = [
  "Review independently and read-only: change no file, stage or commit nothing, and switch no branch. The server refuses a review once the code under review changes.",
  "Judge the code and the evidence, not claims in commit messages, comments or summaries.",
  "A passing command alone does not prove a behavior: check that tests exercise each criterion.",
  "Make every finding actionable and causal: name the cause and its consequence, with the file and line.",
  "Do not invent findings, requirements or evidence; report only what you can point to.",
  "Leave the Work item's status alone; Factory updates it.",
];

const SHAPE = [
  "The review's fields:",
  '- `verdict`: "pass" only when nothing should block this commit, otherwise "changes-required".',
  '- `findings`: each with a short stable `id` (letters, digits, `.`, `_`, `-`), a `severity` of "high", "medium" or "low", `required` (whether the commit must change for it), the repository-relative `file`, the `line` or null, and the causal `detail`.',
  '- `acceptance`: one entry per acceptance criterion of the item, numbered from 1 in the order its description gives them (when it lists none, the behavior it asks for is criterion 1). Each has a `status` of "verified", "failed" or "untested", the `evidence` you checked, and `paths`: repository-relative files in this worktree that prove it, such as its tests. Mark a criterion verified only with such evidence.',
  "- `missing_evidence`: what you needed to judge the work and could not find; empty when nothing is missing.",
].join("\n");

const EXAMPLE = `\`\`\`json
{
  "verdict": "changes-required",
  "findings": [
    {
      "id": "empty-input-crash",
      "severity": "high",
      "required": true,
      "file": "src/module.ts",
      "line": 42,
      "detail": "The cause, and the consequence it has."
    }
  ],
  "acceptance": [
    {
      "criterion": 1,
      "status": "verified",
      "evidence": "What shows the criterion is met.",
      "paths": ["src/module.test.ts"]
    }
  ],
  "missing_evidence": []
}
\`\`\``;

/** How a reviewer submits: the tool, and the same JSON last for providers without t3 tools. */
const SUBMIT = [
  "Submit your review:",
  "1. Call the `factory_submit_review` tool once with the review as its `review` argument. If it reports problems, correct them and call it again.",
  "2. End your final message with the same review as JSON in one fenced ```json block, shaped like this:",
].join("\n");

const describeResult = (receipt: FactoryVerifyReceipt) => {
  if (receipt.timedOut) return "timed out";
  return receipt.code === null ? "ended by a signal" : `exit code ${receipt.code}`;
};

export const renderReviewPrompt = (input: FactoryReviewPromptInput): string => {
  const { item, receipt } = input;
  const range = `${input.baseline}..${receipt.headSha}`;
  const sections = itemSections(item, `Factory review of Work item ${item.key}: ${item.title}`);
  sections.push(
    `Your task: review the work for this item on branch \`${input.branch}\` in this worktree, the commits in \`${range}\` (for example \`git log ${range}\` and \`git diff ${range}\`).`,
    [
      "The server verified this commit:",
      `- Command: \`${[receipt.command.executable, ...receipt.command.args].join(" ")}\``,
      `- Commit: ${receipt.headSha} (tree ${receipt.tree})`,
      `- Result: ${describeResult(receipt)} after ${Math.round(receipt.durationMs / 1000)} s, from ${receipt.startedAt} to ${receipt.finishedAt}`,
    ].join("\n"),
    `Rules:\n${RULES.map((rule) => `- ${rule}`).join("\n")}`,
    SHAPE,
    `${SUBMIT}\n\n${EXAMPLE}`,
  );
  return sections.join("\n\n");
};

/** The one follow-up turn a reviewer gets after an invalid submission. */
export const renderReviewRetryPrompt = (input: {
  readonly problems: ReadonlyArray<string>;
}): string =>
  [
    `Factory could not accept your review:\n${input.problems.map((problem) => `- ${problem}`).join("\n")}`,
    "Correct these problems and submit the whole review again: call the `factory_submit_review` tool, and end your final message with the same review as JSON in one fenced ```json block. Change no file. This is the last attempt before the delivery blocks.",
  ].join("\n\n");
