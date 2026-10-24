import { describe, expect, it } from "vite-plus/test";

import { renderFixCommitPrompt } from "./fixCommit.ts";

const branch = "work/fd-aaaaaa";
const baseline = "b".repeat(40);
const problems = [
  "Worktree has uncommitted or untracked changes.",
  "No commit was added since the baseline.",
];

describe("renderFixCommitPrompt", () => {
  it("names the checkpoint a resume picks up from, and asks not to start over", () => {
    const prompt = renderFixCommitPrompt({ problems, branch, baseline, checkpoint: "review" });
    expect(prompt).toContain(
      [
        `Factory is resuming this delivery from its \`review\` checkpoint and checked branch \`${branch}\` first. It found these problems:`,
        "- Worktree has uncommitted or untracked changes.",
        "- No commit was added since the baseline.",
        "",
        "Your work so far stays: once the branch settles, Factory verifies and reviews it again, so do not start the task over.",
      ].join("\n"),
    );
    expect(prompt).not.toContain("after your turn");
    // The repair rules are the settle check's own.
    expect(prompt).toContain("Fix only these problems, then stop:");
    expect(prompt).toContain(`amend or reword only commits after ${baseline}`);
  });

  it("speaks of the author's turn when no resume sent it", () => {
    const prompt = renderFixCommitPrompt({ problems, branch, baseline, checkpoint: null });
    expect(prompt.startsWith(`Factory checked branch \`${branch}\` after your turn`)).toBe(true);
    expect(prompt).not.toContain("checkpoint");
    expect(prompt).not.toContain("resuming");
  });
});
