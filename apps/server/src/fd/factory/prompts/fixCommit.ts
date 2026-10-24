/**
 * The one mechanical follow-up an author gets when its branch does not settle: each problem the
 * settle check found, and how to repair it without touching history before the task baseline.
 */
export const renderFixCommitPrompt = (input: {
  readonly problems: ReadonlyArray<string>;
  readonly branch: string;
  /** The task baseline; commits after it are the author's own. */
  readonly baseline: string | null;
}): string => {
  const own =
    input.baseline === null ? "your own commits for this task" : `commits after ${input.baseline}`;
  return [
    `Factory checked branch \`${input.branch}\` after your turn and found these problems:\n${input.problems.map((problem) => `- ${problem}`).join("\n")}`,
    [
      "Fix only these problems, then stop:",
      `- Work on \`${input.branch}\`: check it out again if the worktree left it, switch to no other branch, and never push or merge.`,
      "- Commit any remaining changes with a Conventional Commit subject (`type(scope): summary`) and leave the worktree clean.",
      `- To repair a commit message or identity, amend or reword only ${own}; never rewrite earlier commits.`,
      "- Never name an AI agent, model or provider in commits, and add no AI attribution.",
    ].join("\n"),
    "Reply with what you changed.",
  ].join("\n\n");
};
