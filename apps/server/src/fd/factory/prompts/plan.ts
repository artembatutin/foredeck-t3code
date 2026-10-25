import type { FactoryStageName } from "@t3tools/contracts/fd/factory";

import { type FactoryAuthorItem, itemSections } from "./author.ts";

/**
 * The planner's messages: the first, with the parent Work item and Looper's plan rules condensed,
 * and the retry turns. Pure, so the exact text a planner receives is tested rather than inferred.
 */

const TITLE_MAX_CHARS = 100;

/** `Plan <key>: <title>`, cut to the thread title limit. */
export const planThreadTitle = (item: Pick<FactoryAuthorItem, "key" | "title">): string =>
  `Plan ${item.key}: ${item.title}`.slice(0, TITLE_MAX_CHARS);

const RULES = [
  "Inspect only: read the repository and the item, and change no file, stage or commit nothing, and switch no branch.",
  "Split the work into bounded vertical tasks, each a reviewable change that leaves the branch working, listed in the order they should land.",
  "Give every task testable acceptance criteria: each states a behavior a focused test can observe.",
  "Give every acceptance criterion exactly one test plan entry, naming it by its 1-based number, with the check that proves it and the test paths that will hold it.",
  'Set risk to "high" for work on security, persistence or migrations, concurrency, cross-module contracts, or where the architecture is ambiguous; otherwise "normal".',
  "Never invent requirements, decisions, tickets or evidence: plan only what the item asks for, and name in the note what needs the owner's decision.",
  "Leave the Work item's status alone; Factory updates it.",
];

const SHAPE = [
  "The plan's fields:",
  '- `tasks`: the tasks in delivery order. Each has an `id` unique in the plan (letters, digits, `.`, `_`, `-`, at most 64 characters), a `title`, a `kind` of "feature", "fix", "refactor", "tests", "migration", "docs" or "chore", a `summary`, its `acceptance` criteria (at least one), its `testPlan`, its `likelyPaths` and its `risk`.',
  "- Each `testPlan` entry has the `criterion` it proves (1 for the first acceptance criterion), the `check`, and `paths`: the test files that will hold it.",
  "- Paths are repository-relative with forward slashes, without `.` or `..` segments, and outside `.git`.",
  "- `note`: optional; what the owner should know. When the item needs no tasks or cannot be planned, submit an empty `tasks` list with a note saying why.",
].join("\n");

const EXAMPLE = `\`\`\`json
{
  "tasks": [
    {
      "id": "export-csv",
      "title": "Export the current table as CSV",
      "kind": "feature",
      "summary": "What the task changes and why.",
      "acceptance": ["The export button downloads the visible rows as CSV."],
      "testPlan": [
        {
          "criterion": 1,
          "check": "A test exports two rows and reads back the CSV.",
          "paths": ["src/export.test.ts"]
        }
      ],
      "likelyPaths": ["src/export.ts"],
      "risk": "normal"
    }
  ],
  "note": "Anything the owner should decide."
}
\`\`\``;

/** How a planner submits: the tool, and the same JSON last for providers without t3 tools. */
const SUBMIT = [
  "Submit your plan:",
  "1. Call the `factory_submit_plan` tool once with the plan as its `plan` argument. If it reports problems, correct them and call it again.",
  "2. End your final message with the same plan as JSON in one fenced ```json block, shaped like this:",
].join("\n");

export const renderPlanPrompt = (input: {
  readonly item: FactoryAuthorItem;
  readonly branch: string;
}): string => {
  const { item } = input;
  const sections = itemSections(item, `Factory plan for Work item ${item.key}: ${item.title}`);
  sections.push(
    `Your task: plan how to deliver this Work item as tasks that Factory builds one after another on branch \`${input.branch}\` in this worktree. The owner approves the plan before any task starts.`,
    `Rules:\n${RULES.map((rule) => `- ${rule}`).join("\n")}`,
    SHAPE,
    `${SUBMIT}\n\n${EXAMPLE}`,
  );
  return sections.join("\n\n");
};

const RESUBMIT =
  "call the `factory_submit_plan` tool, and end your final message with the same plan as JSON in one fenced ```json block. Change no file.";

/**
 * A follow-up asking the planner for its whole plan again: after an invalid fallback plan, the
 * round's one retry, listing its problems; on a resume, a new round's first submission, naming the
 * checkpoint and the problems of the plan the delivery blocked on, if any.
 */
export const renderPlanRetryPrompt = (input: {
  readonly problems: ReadonlyArray<string>;
  /** Set on a resume: the checkpoint the delivery resumes from. */
  readonly checkpoint: FactoryStageName | null;
}): string => {
  const problems = input.problems.map((problem) => `- ${problem}`).join("\n");
  if (input.checkpoint === null) {
    return [
      `Factory could not accept your plan:\n${problems}`,
      `Correct these problems and submit the whole plan again: ${RESUBMIT} This is the last attempt before the delivery blocks.`,
    ].join("\n\n");
  }
  return [
    `Factory is resuming this delivery from its \`${input.checkpoint}\` checkpoint and needs your plan again.`,
    ...(problems === "" ? [] : [`Your last plan had these problems:\n${problems}`]),
    `Submit the whole plan again, following the rules of your first message: ${RESUBMIT}`,
  ].join("\n\n");
};
