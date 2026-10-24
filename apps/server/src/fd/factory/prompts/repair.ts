import type { FactoryReview } from "@t3tools/contracts/fd/factory";

/** What the repair and later review prompts share. Pure, like every prompt. */

export type FactoryReviewFinding = FactoryReview["findings"][number];

/** `text` in a fenced block whose fence no backtick run inside it can close. */
export const fence = (text: string, info = ""): string => {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const marker = "`".repeat(longest + 1);
  return `${marker}${info}\n${text}\n${marker}`;
};

/** One finding as a list item: id, severity, location and detail. */
export const describeFinding = (finding: FactoryReviewFinding): string => {
  const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const flags = finding.required ? `${finding.severity}, required` : finding.severity;
  return `- \`${finding.id}\` (${flags}) at ${location}: ${finding.detail}`;
};

/** The author's rules for a repair turn; a later round is asked to rethink the cause. */
export const repairRules = (input: { readonly branch: string; readonly round: number }) => {
  const rules = [
    ...(input.round >= 2
      ? [
          `This is repair round ${input.round}: the earlier round did not fix it. Reassess the root cause before you change code again, and do not repeat a fix that did not work.`,
        ]
      : []),
    "Fix the cause, not the symptom. Never weaken, skip or delete checks or tests, and never adjust expected results to hide a bug.",
    "Add or update durable regression tests for what you fix.",
    "Run focused checks while you work. The server verifies the commit again after your turn.",
    `Work on \`${input.branch}\`: never push, merge, switch branches, edit outside this worktree or rewrite existing commits.`,
    "Commit with Conventional Commits (`type(scope): summary`) and leave the worktree clean: nothing staged, modified or untracked.",
    "Never name an AI agent, model or provider in commits, and add no AI attribution (Generated-by, Assisted-by, generated with, AI co-authors).",
    "Stop and say so when you need credentials you do not have or a decision only the owner can make.",
  ];
  return `Rules:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
};
