import { describe, expect, it } from "vite-plus/test";

import type { FactoryBranchCommit, FactoryBranchFacts } from "./branchFacts.ts";
import { evaluateSettle } from "./settle.ts";
import type { FactorySettleRule } from "./settle.ts";

const branch = "feature/item-7";

const commit = (overrides: Partial<FactoryBranchCommit> = {}): FactoryBranchCommit => ({
  sha: "a".repeat(40),
  subject: "feat(server): add branch facts",
  body: "Reads the worktree state the settle checks need.",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  committerName: "Ada Lovelace",
  committerEmail: "ada@example.com",
  ...overrides,
});

const facts = (overrides: Partial<FactoryBranchFacts> = {}): FactoryBranchFacts => ({
  branch,
  clean: true,
  baselineIsAncestor: true,
  commits: [commit()],
  ...overrides,
});

const rules = (input: FactoryBranchFacts) => {
  const result = evaluateSettle(input, branch);
  return result.status === "settled" ? [] : result.problems.map((problem) => problem.rule);
};

describe("evaluateSettle", () => {
  it("settles a clean branch with conventional, attribution-free commits on the baseline", () => {
    expect(evaluateSettle(facts(), branch)).toEqual({ status: "settled" });
    expect(
      evaluateSettle(
        facts({
          commits: [
            commit(),
            commit({ sha: "c".repeat(40), subject: "fix!: drop the legacy flag", body: "" }),
          ],
        }),
        branch,
      ),
    ).toEqual({ status: "settled" });
  });

  const repairable: ReadonlyArray<[FactorySettleRule, FactoryBranchFacts]> = [
    ["wrong_branch", facts({ branch: "main" })],
    ["wrong_branch", facts({ branch: null })],
    ["dirty_worktree", facts({ clean: false })],
    ["baseline_not_ancestor", facts({ baselineIsAncestor: false })],
    ["no_new_commit", facts({ commits: [] })],
    ["non_conventional_subject", facts({ commits: [commit({ subject: "Add branch facts" })] })],
    ["non_conventional_subject", facts({ commits: [commit({ subject: "feature: add facts" })] })],
    ["non_conventional_subject", facts({ commits: [commit({ subject: "feat:  " })] })],
    [
      "ai_name_in_subject",
      facts({ commits: [commit({ subject: "feat: tune the Codex adapter" })] }),
    ],
    ["ai_name_in_body", facts({ commits: [commit({ body: "Drafted with ChatGPT." })] })],
    ["ai_attribution", facts({ commits: [commit({ body: "Generated-by: a tool" })] })],
    ["ai_attribution", facts({ commits: [commit({ body: "Notes.\n\nassisted-by: a tool" })] })],
    ["ai_attribution", facts({ commits: [commit({ body: "This was Generated With a tool." })] })],
  ];

  it.each(repairable)("reports %s as its only, repairable problem", (rule, input) => {
    const result = evaluateSettle(input, branch);
    expect(result.status).toBe("repairable");
    expect(rules(input)).toEqual([rule]);
  });

  it("reports every problem together instead of stopping at the first", () => {
    const input = facts({
      branch: "main",
      clean: false,
      baselineIsAncestor: false,
      commits: [
        commit({ subject: "WIP gpt tweaks", body: "Co-authored-by: Claude\nGenerated-by: x" }),
      ],
    });
    expect(evaluateSettle(input, branch).status).toBe("repairable");
    expect(rules(input)).toEqual([
      "wrong_branch",
      "dirty_worktree",
      "baseline_not_ancestor",
      "non_conventional_subject",
      "ai_name_in_subject",
      "ai_name_in_body",
      "ai_attribution",
    ]);
    expect(rules(facts({ branch: null, commits: [] }))).toEqual(["wrong_branch", "no_new_commit"]);
  });

  it("names each offending commit with a bounded description", () => {
    const subject = `chore ${"x".repeat(500)}`;
    const result = evaluateSettle(
      facts({ commits: [commit({ sha: "d".repeat(40), subject })] }),
      branch,
    );
    if (result.status === "settled") throw new Error("expected a problem");
    const [problem] = result.problems;
    expect(problem?.description).toContain("d".repeat(12));
    expect(problem?.description).not.toContain("d".repeat(13));
    expect(problem?.description.length).toBeLessThan(160);
  });

  it.each([
    ["author name", { authorName: "Claude" }],
    ["author email", { authorEmail: "noreply@anthropic.com" }],
    ["committer name", { committerName: "devin-ai" }],
    ["committer email", { committerEmail: "bot@openai.com" }],
  ])("blocks at once on an AI %s even when every other rule passes", (_label, identity) => {
    const result = evaluateSettle(facts({ commits: [commit(identity)] }), branch);
    expect(result).toMatchObject({ status: "unrepairable", problems: [{ rule: "ai_identity" }] });
  });

  it("keeps repairable problems listed beside an AI identity", () => {
    const input = facts({ clean: false, commits: [commit({ authorName: "Codex" })] });
    expect(evaluateSettle(input, branch).status).toBe("unrepairable");
    expect(rules(input)).toEqual(["dirty_worktree", "ai_identity"]);
  });

  it.each(["feat: support gptq weights", "fix: handle codexes", "docs: thank Claudette"])(
    "ignores a listed name inside another word: %s",
    (subject) => {
      expect(evaluateSettle(facts({ commits: [commit({ subject })] }), branch)).toEqual({
        status: "settled",
      });
    },
  );

  it.each(["CLAUDE", "OpenAI", "Gpt-4", "the cognition tool", "(anthropic)"])(
    "matches a listed name case-insensitively at word boundaries: %s",
    (word) => {
      expect(rules(facts({ commits: [commit({ body: `Notes: ${word}.` })] }))).toEqual([
        "ai_name_in_body",
      ]);
    },
  );
});
