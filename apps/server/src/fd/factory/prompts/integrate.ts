import type { FactoryPlanTask, FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";

import { type FactoryAuthorItem, itemSections } from "./author.ts";
import { reviewInstructionSections, verifiedCommitSection } from "./review.ts";

/**
 * The integrate reviewer's first message: a parent's whole branch against where it started, after
 * a fresh verify, judged by every approved task's acceptance criteria. Pure, so the exact text a
 * reviewer receives is tested rather than inferred.
 */

/** What an integrate reviewer reads: the parent item, its approved tasks and the verified commit. */
export interface FactoryIntegratePromptInput {
  readonly rulesOverride?: string | undefined;
  readonly item: FactoryAuthorItem;
  readonly branch: string;
  /** The ref the delivery created its branch from. */
  readonly baseRef: string;
  /** The commit the branch started at; the review covers `base..receipt.headSha`. */
  readonly base: string;
  /** The server's passing verify run of the branch's HEAD, run for this review. */
  readonly receipt: FactoryVerifyReceipt;
  /** The parent's approved tasks, in plan order. */
  readonly tasks: ReadonlyArray<Pick<FactoryPlanTask, "id" | "title" | "acceptance">>;
}

/**
 * The criteria an integrate review judges: every task's, numbered from 1 across the tasks in plan
 * order, so the first task's come first.
 */
export const integrateCriteria = (tasks: FactoryIntegratePromptInput["tasks"]) =>
  tasks
    .flatMap((task) => task.acceptance.map((text) => ({ taskId: task.id, text })))
    .map((entry, index) => ({ criterion: index + 1, ...entry }));

const TITLE_MAX_CHARS = 100;

/** `Integrate <key>: <title>`, cut to the thread title limit. */
export const integrateThreadTitle = (item: Pick<FactoryAuthorItem, "key" | "title">): string =>
  `Integrate ${item.key}: ${item.title}`.slice(0, TITLE_MAX_CHARS);

/** Each task with its criteria, numbered across the plan. */
const taskSections = (tasks: FactoryIntegratePromptInput["tasks"]) => {
  const criteria = integrateCriteria(tasks);
  return tasks.map((task, index) =>
    [
      `Task ${index + 1} of ${tasks.length}, \`${task.id}\`: ${task.title}`,
      ...criteria
        .filter(({ taskId }) => taskId === task.id)
        .map(({ criterion, text }) => `- Criterion ${criterion}: ${text}`),
    ].join("\n"),
  );
};

export const renderIntegratePrompt = (input: FactoryIntegratePromptInput): string => {
  const { item, receipt, tasks } = input;
  const range = `${input.base}..${receipt.headSha}`;
  const count = integrateCriteria(tasks).length;
  const sections = itemSections(
    item,
    `Factory integrate review of Work item ${item.key}: ${item.title}`,
  );
  sections.push(
    `Your task: review the whole branch \`${input.branch}\` in this worktree against where it started, commit ${input.base} (created from \`${input.baseRef}\`): the commits in \`${range}\` (for example \`git log ${range}\` and \`git diff ${range}\`). Each task below was reviewed on its own as it landed; judge the branch as one change, and check every task's criteria against this commit, as the later tasks may have broken an earlier one's.`,
    verifiedCommitSection(receipt),
    `The approved tasks in plan order, with their acceptance criteria numbered across the plan:\n\n${taskSections(tasks).join("\n\n")}`,
    ...reviewInstructionSections(
      `one entry for each criterion numbered above, 1 to ${count}, with that number as its \`criterion\``,
      input.rulesOverride,
    ),
  );
  return sections.join("\n\n");
};
