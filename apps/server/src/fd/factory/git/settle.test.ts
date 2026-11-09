import { describe, expect, it } from "vite-plus/test";

import type { FactoryBranchCommit, FactoryBranchFacts } from "./branchFacts.ts";
import { evaluatePublication, evaluateSavedPullRequest, evaluateSettle } from "./settle.ts";
import type { FactoryPublicationFacts, FactorySettleRule } from "./settle.ts";

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
    [
      "ai_attribution",
      facts({ commits: [commit({ body: "Notes were generated\nwith a tool." })] }),
    ],
    [
      "ai_attribution",
      facts({
        commits: [commit({ subject: "feat: add branch facts (Generated-by: automation)" })],
      }),
    ],
    [
      "ai_attribution",
      facts({ commits: [commit({ body: "Implementation Assisted-by: automation." })] }),
    ],
    ["ai_attribution", facts({ commits: [commit({ body: "Notes.\n\n  Generated-by: a tool" })] })],
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
    ["author called Cursor", { authorName: "Cursor" }],
    ["committer called Cursor", { committerName: "Cursor" }],
    ["author called AI Assistant", { authorName: "AI Assistant" }],
    ["committer called AI Assistant", { committerName: "AI Assistant" }],
    ["author address", { authorEmail: "assistant@example.com" }],
    ["committer address", { committerEmail: "cursor@example.com" }],
  ])("blocks at once on an AI %s even when every other rule passes", (_label, identity) => {
    const result = evaluateSettle(facts({ commits: [commit(identity)] }), branch);
    expect(result).toMatchObject({ status: "unrepairable", problems: [{ rule: "ai_identity" }] });
  });

  it("keeps repairable problems listed beside an AI identity", () => {
    const input = facts({ clean: false, commits: [commit({ authorName: "Codex" })] });
    expect(evaluateSettle(input, branch).status).toBe("unrepairable");
    expect(rules(input)).toEqual(["dirty_worktree", "ai_identity"]);
  });

  it.each([
    "feat: support gptq weights",
    "fix: handle codexes",
    "docs: thank Claudette",
    "docs: describe generated files and the by-line",
  ])("settles words that only resemble a listed name or attribution: %s", (subject) => {
    expect(evaluateSettle(facts({ commits: [commit({ subject })] }), branch)).toEqual({
      status: "settled",
    });
  });

  it.each(["CLAUDE", "OpenAI", "Gpt-4", "the cognition tool", "(anthropic)"])(
    "matches a listed name case-insensitively at word boundaries: %s",
    (word) => {
      expect(rules(facts({ commits: [commit({ body: `Notes: ${word}.` })] }))).toEqual([
        "ai_name_in_body",
      ]);
    },
  );
});

describe("evaluatePublication", () => {
  const text = {
    title: "feat: fd-1 Add branch facts",
    body: "Work item fd-1: Add branch facts",
    key: "fd-1",
  };
  /** By default a push lands on `origin` under the branch's own name. */
  const gate = (
    overrides: Partial<FactoryBranchFacts> = {},
    expectedBranch = branch,
    ancestry: ReadonlyArray<FactoryBranchCommit> | null = [],
    target: FactoryPublicationFacts["target"] = { remoteName: "origin", branch: expectedBranch },
  ) =>
    evaluatePublication({ facts: { ...facts(overrides), target, ancestry }, expectedBranch, text });
  const onCommit = (rule: string) => [{ target: "commit", rule, commit: "a".repeat(12) }];

  it("passes a neutral branch, conventional commits, and human and legal trailers", () => {
    expect(gate()).toEqual([]);
    for (const body of [
      "Co-authored-by: Ada Lovelace <ada@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com>",
      "Refs: fd-1\nCloses #123",
      "Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
      "The body.\n\nRefs: fd-1\nCo-authored-by: Ai Nguyen <ai.nguyen@example.com>\nSigned-off-by: Ai Nguyen <ai.nguyen@example.com>",
      "Co-authored-by: Ada Cursor <ada@example.com>",
      "Signed-off-by: Ada Cursor <ada@example.com>",
      "The body.\n\nCo-authored-by: Ada Cursor <ada@example.com>\nSigned-off-by: Ada Cursor <ada@example.com>",
      "Co-authored-by:\n Ada Lovelace <ada@example.com>",
      "Co-authored-by:\r\n Ai Nguyen <ai.nguyen@example.com>",
      "Signed-off-by:\n\tAda Cursor <ada@example.com>",
      "Co-authored-by: Ada Lovelace <ada@example.com>, Grace Hopper <grace@example.com>",
      "Co-authored-by: Ada Lovelace <ada@example.com> and Ai Nguyen <ai.nguyen@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com>\nSigned-off-by: Ada Cursor <ada@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com> (tested on Linux)",
      "Co-authored-by : Ada Cursor <ada@example.com>\nSigned-off-by\t: Ai Nguyen <ai.nguyen@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Grace Hopper <grace@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
      "Helped-by: Ada Cursor <ada@example.com>\nSigned-off-by: Ada Lovelace <ada@example.com>",
      "Co-authored-by: ada+cursor@example.com",
      "Co-authored-by: ada+ai@example.com\nSigned-off-by: Ada Lovelace <ada+cursor@example.com>",
      "Co-authored-by:\n ada+cursor@example.com",
      "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: ada+cursor@example.com",
      "Suggested-by: Ada Cursor <ada@example.com>",
      "Reported-by: Ai Nguyen <ai.nguyen@example.com>",
      "Reported-by : ada+cursor@example.com\nSuggested-by:\n Ada Lovelace <ada@example.com>",
      "Signed-off-by: Ada Lovelace <ada@example.com> Suggested-by: Ai Nguyen <ai.nguyen@example.com>",
    ]) {
      expect(gate({ commits: [commit({ body })] })).toEqual([]);
    }
  });

  it.each([
    ["a subject that is not conventional", { subject: "Add it" }, "non_conventional_subject"],
    ["a name in a subject", { subject: "feat: tune Codex" }, "ai_name_in_subject"],
    ["a co-author naming a tool", { body: "Co-authored-by: Claude" }, "ai_name_in_body"],
    ["a sign-off by a tool", { body: "Signed-off-by: Cursor" }, "ai_name_in_body"],
    ["generated attribution", { body: "Generated-by: a tool" }, "ai_attribution"],
    ["a trailer of generated work", { body: "Made-with: a tool" }, "ai_attribution"],
    ["an assistant co-author", { body: "Co-authored-by: AI Assistant" }, "ai_attribution"],
    ["an author naming a tool", { authorName: "Claude" }, "ai_identity"],
    ["a committer's address", { committerEmail: "bot@openai.com" }, "ai_identity"],
    ["an author called Cursor", { authorName: "Cursor" }, "ai_identity"],
    ["a committer called Cursor", { committerName: "Cursor" }, "ai_identity"],
    ["an author called AI Assistant", { authorName: "AI Assistant" }, "ai_identity"],
    ["a committer called AI Assistant", { committerName: "AI Assistant" }, "ai_identity"],
    ["a sign-off by an assistant", { body: "Signed-off-by: AI Assistant" }, "ai_attribution"],
    [
      "the editor beside a person",
      { body: "Co-authored-by: Ada Lovelace and Cursor <ada@example.com>" },
      "ai_name_in_body",
    ],
    [
      "a person's name on the editor's address",
      { body: "Signed-off-by: Ada Cursor <cursor@example.com>" },
      "ai_name_in_body",
    ],
    ["a co-author called Ai and no more", { body: "Co-authored-by: Ai" }, "ai_attribution"],
    [
      "a person's name on an assistant's address",
      { body: "Co-authored-by: Ai Nguyen <assistant@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor credited on the next line",
      { body: "Co-authored-by:\n Cursor <editor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "the editor credited on the next line after a tab",
      { body: "Co-authored-by:\n\tCursor <editor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "the editor credited on the next CRLF line",
      { body: "Co-authored-by:\r\n Cursor <editor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "an assistant signing off on the next line",
      { body: "Signed-off-by:\n AI Assistant <assistant@example.com>" },
      "ai_attribution",
    ],
    [
      "an assistant signing off on the next CRLF line after a tab",
      { body: "Signed-off-by:\r\n\tAI Assistant <assistant@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor after a person's address",
      { body: "Co-authored-by: Ada Lovelace <ada@example.com> and Cursor" },
      "ai_name_in_body",
    ],
    [
      "the editor as a second addressed party",
      { body: "Co-authored-by: Ada Lovelace <ada@example.com>, Cursor <cursor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "an assistant after a person's address",
      { body: "Co-authored-by: Ada Lovelace <ada@example.com> and AI Assistant" },
      "ai_attribution",
    ],
    [
      "an assistant after a person's address, on the next line",
      { body: "Co-authored-by: Ada Lovelace <ada@example.com>\n and AI Assistant" },
      "ai_attribution",
    ],
    [
      "the editor credited with a space before the colon",
      { body: "Co-authored-by : Cursor <editor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "an assistant signing off with a space before the colon",
      { body: "Signed-off-by : AI Assistant <helper@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor credited with a tab before the colon, on the next line",
      { body: "Co-authored-by\t:\n Cursor <editor@example.com>" },
      "ai_name_in_body",
    ],
    [
      "the editor's credit folded into a person's sign-off",
      {
        body: "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Cursor <editor@example.com>",
      },
      "ai_name_in_body",
    ],
    [
      "the editor's credit after a person's sign-off on one line",
      {
        body: "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: Cursor <editor@example.com>",
      },
      "ai_name_in_body",
    ],
    [
      "an assistant's credit folded into a person's sign-off",
      {
        body: "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: AI Assistant <helper@example.com>",
      },
      "ai_attribution",
    ],
    ["the editor's help", { body: "Helped-by: Cursor <e@example.com>" }, "ai_name_in_body"],
    [
      "an assistant's help",
      { body: "Helped-by: AI Assistant <helper@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor after a person's bare address",
      { body: "Co-authored-by: ada+cursor@example.com and Cursor" },
      "ai_name_in_body",
    ],
    [
      "an assistant after a person's bare address",
      { body: "Co-authored-by: ada+ai@example.com, AI Assistant <helper@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor's suggestion",
      { body: "Suggested-by: Cursor <e@example.com>" },
      "ai_name_in_body",
    ],
    ["the editor's report", { body: "Reported-by: Cursor <e@example.com>" }, "ai_name_in_body"],
    [
      "an assistant's suggestion",
      { body: "Suggested-by: AI Assistant <helper@example.com>" },
      "ai_attribution",
    ],
    [
      "an assistant's report",
      { body: "Reported-by: AI Assistant <helper@example.com>" },
      "ai_attribution",
    ],
    [
      "the editor's suggestion with a tab before the colon",
      { body: "Suggested-by\t: Cursor <e@example.com>" },
      "ai_name_in_body",
    ],
    [
      "the editor's report on the next line",
      { body: "Reported-by:\n Cursor <e@example.com>" },
      "ai_name_in_body",
    ],
    [
      "the editor's report after a person's sign-off on one line",
      { body: "Signed-off-by: Ada Lovelace <ada@example.com> Reported-by: Cursor <e@example.com>" },
      "ai_name_in_body",
    ],
    [
      "an assistant's suggestion folded into a person's sign-off",
      {
        body: "Signed-off-by: Ada Lovelace <ada@example.com>\n Suggested-by: AI Assistant <helper@example.com>",
      },
      "ai_attribution",
    ],
    [
      "the editor's credit folded into a person's suggestion",
      { body: "Suggested-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Cursor" },
      "ai_name_in_body",
    ],
  ])("refuses %s on any commit", (_name, overrides, rule) => {
    expect(gate({ commits: [commit(overrides)] })).toEqual(onCommit(rule));
    // A later commit passing changes nothing, and neither does an earlier one.
    expect(gate({ commits: [commit({ sha: "b".repeat(40) }), commit(overrides)] })).toEqual(
      onCommit(rule),
    );
  });

  it.each([
    ["Ada Cursor", "ada@example.com"],
    ["Ai Nguyen", "ai.nguyen@example.com"],
  ])("passes a person called %s, in either role", (name, email) => {
    expect(gate({ commits: [commit({ authorName: name, authorEmail: email })] })).toEqual([]);
    expect(gate({ commits: [commit({ committerName: name, committerEmail: email })] })).toEqual([]);
  });

  describe("what else the push would publish", () => {
    const ancestor = (overrides: Partial<FactoryBranchCommit>) =>
      commit({ sha: "b".repeat(40), ...overrides });
    const onAncestor = (rule: string) => [{ target: "ancestor", rule, commit: "b".repeat(12) }];

    it("passes a compliant commit from before the delivery", () => {
      expect(gate({}, branch, [ancestor({ subject: "chore: an unpushed base" })])).toEqual([]);
    });

    it.each([
      ["a malformed subject", { subject: "wip" }, "non_conventional_subject"],
      ["a name in its subject", { subject: "feat: tune Codex" }, "ai_name_in_subject"],
      ["a tool's credit", { body: "Co-authored-by: Claude" }, "ai_name_in_body"],
      ["generated attribution", { body: "Generated-by: a tool" }, "ai_attribution"],
      ["a tool's identity", { committerName: "Cursor" }, "ai_identity"],
      [
        "a folded tool credit",
        { body: "Co-authored-by:\n Cursor <e@example.com>" },
        "ai_name_in_body",
      ],
      [
        "an assistant after a person's address",
        { body: "Co-authored-by: Ada Lovelace <ada@example.com> and AI Assistant" },
        "ai_attribution",
      ],
      [
        "a spaced credit key",
        { body: "Co-authored-by : Cursor <editor@example.com>" },
        "ai_name_in_body",
      ],
      [
        "a tool's credit inside a person's sign-off",
        { body: "Signed-off-by: Ada <ada@example.com>\n Co-authored-by: Cursor" },
        "ai_name_in_body",
      ],
      ["a tool's help", { body: "Helped-by: Cursor <e@example.com>" }, "ai_name_in_body"],
      ["a tool's suggestion", { body: "Suggested-by: Cursor <e@example.com>" }, "ai_name_in_body"],
      [
        "an assistant's report",
        { body: "Reported-by: AI Assistant <helper@example.com>" },
        "ai_attribution",
      ],
    ])("refuses one with %s, beside the delivery's own passing", (_name, overrides, rule) => {
      expect(gate({}, branch, [ancestor(overrides)])).toEqual(onAncestor(rule));
    });

    it("says so when what the destination holds could not be read", () => {
      expect(gate({}, branch, null)).toEqual([{ target: "destination", rule: "unreadable" }]);
    });

    it("still judges the delivery's own commits, whatever the destination holds", () => {
      expect(gate({ commits: [commit({ body: "Generated-by: x" })] }, branch, [])).toEqual(
        onCommit("ai_attribution"),
      );
    });
  });

  describe("the remote branch a push lands on", () => {
    const landsOn = (remoteName: string, onto: string) =>
      gate({}, branch, [], { remoteName, branch: onto });

    it("passes the branch's own name on any remote", () => {
      expect(landsOn("origin", branch)).toEqual([]);
      expect(landsOn("fork", branch)).toEqual([]);
    });

    it("passes another name that keeps to the rules, as an alias can", () => {
      expect(landsOn("my-org/chore", "bugfix/item-7")).toEqual([]);
    });

    it.each([
      // `feature/item-7` with a remote called `feature`, or tracking `my-org/feature`'s `item-7`.
      ["without its prefix", "feature", "item-7", "branch_prefix"],
      ["under a name naming a tool", "fork", "feature/port-claude", "ai_name_in_branch"],
      [
        "under a name carrying attribution",
        "fork",
        "feature/generated-by-x",
        "ai_attribution_in_branch",
      ],
    ])("refuses one that lands %s, naming where", (_name, remote, onto, rule) => {
      expect(landsOn(remote, onto)).toEqual([
        { target: "remote_branch", rule, remote, branch: onto },
      ]);
    });

    it("refuses a push that names no remote branch, as a destination it cannot read", () => {
      expect(gate({}, branch, [], null)).toEqual([{ target: "destination", rule: "unreadable" }]);
    });

    it("leaves it to the worktree's branch when that is not the delivery's", () => {
      expect(
        gate({ branch: "feature/other" }, branch, [], { remoteName: "feature", branch: "other" }),
      ).toEqual([{ target: "branch", rule: "wrong_branch" }]);
    });
  });

  it("refuses a disallowed branch whenever it was created, even with nothing else wrong", () => {
    const legacy = "work/fd-1-add-branch-facts";
    expect(gate({ branch: legacy }, legacy)).toEqual([{ target: "branch", rule: "branch_prefix" }]);
    expect(gate({ branch: "feature/port-claude" }, "feature/port-claude")).toEqual([
      { target: "branch", rule: "ai_name_in_branch" },
    ]);
  });

  it("refuses a worktree off the delivery's branch, or detached", () => {
    expect(gate({ branch: "feature/other" })).toEqual([{ target: "branch", rule: "wrong_branch" }]);
    expect(gate({ branch: null })).toEqual([{ target: "branch", rule: "wrong_branch" }]);
  });

  it("refuses a history the baseline does not start, or with no commit", () => {
    expect(gate({ baselineIsAncestor: false })).toEqual([
      { target: "commits", rule: "baseline_not_ancestor" },
    ]);
    expect(gate({ commits: [] })).toEqual([{ target: "commits", rule: "no_new_commit" }]);
  });

  it("judges the text only when given, and reports every problem together", () => {
    const legacy = "work/x";
    expect(
      evaluatePublication({
        facts: {
          ...facts({ branch: legacy, commits: [commit({ body: "Generated-by: x" })] }),
          target: { remoteName: "origin", branch: legacy },
          ancestry: [],
        },
        expectedBranch: legacy,
      }),
    ).toEqual([{ target: "branch", rule: "branch_prefix" }, ...onCommit("ai_attribution")]);
    expect(
      evaluatePublication({
        facts: {
          ...facts({ branch: legacy }),
          target: { remoteName: "origin", branch: legacy },
          ancestry: [],
        },
        expectedBranch: legacy,
        text: { title: "fd-1: raw", body: "Assisted-by: Grok", key: "fd-1" },
      }),
    ).toEqual([
      { target: "branch", rule: "branch_prefix" },
      { target: "title", rule: "malformed_title" },
      { target: "body", rule: "ai_name" },
      { target: "body", rule: "ai_attribution" },
    ]);
  });
});

describe("evaluateSavedPullRequest", () => {
  const sent = { title: "feat: fd-1 Add branch facts", body: "Work item fd-1: Add branch facts" };
  const saved = { ...sent, headBranch: branch };
  const created = (overrides: Partial<typeof saved>) =>
    evaluateSavedPullRequest({
      saved: { ...saved, ...overrides },
      expectedHead: branch,
      key: "fd-1",
      sent,
    });

  it("passes what the host saved of what Factory sent, modulo its line endings", () => {
    expect(created({})).toEqual([]);
    expect(created({ body: `${sent.body}\r\n` })).toEqual([]);
    expect(
      evaluateSavedPullRequest({
        saved: { ...saved, body: "a\r\nb" },
        expectedHead: branch,
        key: "fd-1",
        sent: { ...sent, body: "a\nb" },
      }),
    ).toEqual([]);
  });

  it.each([
    [
      "title",
      { title: "feat: fd-1 Add other facts" },
      [{ target: "saved_title", rule: "differs" }],
    ],
    ["body", { body: "Another body" }, [{ target: "saved_body", rule: "differs" }]],
    ["head branch", { headBranch: "feature/other" }, [{ target: "saved_head", rule: "differs" }]],
  ])("refuses an altered %s", (_name, overrides, problems) => {
    expect(created(overrides)).toEqual(problems);
  });

  it("refuses what breaks the rules as well as what differs", () => {
    expect(created({ title: "fd-1: raw", body: "Generated-by: Claude" })).toEqual([
      { target: "saved_title", rule: "differs" },
      { target: "saved_body", rule: "differs" },
      { target: "saved_title", rule: "malformed_title" },
      { target: "saved_body", rule: "ai_name" },
      { target: "saved_body", rule: "ai_attribution" },
    ]);
  });

  it("holds a pull request Factory did not write now only to the rules", () => {
    const earlier = {
      title: "feat: fd-1 an owner's own words",
      body: "An owner's own body.",
      headBranch: branch,
    };
    expect(evaluateSavedPullRequest({ saved: earlier, expectedHead: branch, key: "fd-1" })).toEqual(
      [],
    );
    const later = (changes: Partial<typeof earlier>) =>
      evaluateSavedPullRequest({
        saved: { ...earlier, ...changes },
        expectedHead: branch,
        key: "fd-1",
      });
    expect(later({ title: "fd-1: a raw title" })).toEqual([
      { target: "saved_title", rule: "malformed_title" },
    ]);
    // Conventional, but no longer about the item.
    expect(later({ title: "feat: unrelated change" })).toEqual([
      { target: "saved_title", rule: "malformed_title" },
    ]);
    expect(later({ headBranch: "feature/other" })).toEqual([
      { target: "saved_head", rule: "differs" },
    ]);
  });

  it.each([
    ["a folded credit of the editor", "Co-authored-by:\n Cursor <editor@example.com>", "ai_name"],
    ["a CRLF-folded credit", "Co-authored-by:\r\n\tCursor <editor@example.com>", "ai_name"],
    [
      "a folded sign-off by an assistant",
      "Signed-off-by:\n AI Assistant <assistant@example.com>",
      "ai_attribution",
    ],
    ["the editor after an address", "Co-authored-by: Ada <ada@example.com> and Cursor", "ai_name"],
    [
      "an assistant after an address",
      "Co-authored-by: Ada <ada@example.com> and AI Assistant",
      "ai_attribution",
    ],
    ["a spaced credit key", "Co-authored-by : Cursor <editor@example.com>", "ai_name"],
    [
      "an assistant's sign-off with a tab before the colon",
      "Signed-off-by\t: AI Assistant <helper@example.com>",
      "ai_attribution",
    ],
    [
      "the editor's credit folded into a sign-off",
      "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Cursor <editor@example.com>",
      "ai_name",
    ],
    [
      "an assistant's credit after a sign-off on one line",
      "Signed-off-by: Ada Lovelace <ada@example.com> Co-authored-by: AI Assistant <helper@example.com>",
      "ai_attribution",
    ],
    ["the editor's help", "Helped-by: Cursor <e@example.com>", "ai_name"],
    ["an assistant's help", "Helped-by: AI Assistant <helper@example.com>", "ai_attribution"],
    ["the editor after a bare address", "Co-authored-by: ada+cursor@example.com Cursor", "ai_name"],
    ["the editor's suggestion", "Suggested-by: Cursor <e@example.com>", "ai_name"],
    ["the editor's report", "Reported-by: Cursor <e@example.com>", "ai_name"],
    ["a spaced report by the editor", "Reported-by : Cursor <e@example.com>", "ai_name"],
    ["a folded suggestion by the editor", "Suggested-by:\r\n Cursor <e@example.com>", "ai_name"],
    [
      "an assistant's suggestion",
      "Suggested-by: AI Assistant <helper@example.com>",
      "ai_attribution",
    ],
    [
      "an assistant's report after a sign-off on one line",
      "Signed-off-by: Ada Lovelace <ada@example.com> Reported-by: AI Assistant <helper@example.com>",
      "ai_attribution",
    ],
  ])("holds a saved body to the whole of %s", (_name, body, rule) => {
    const saved = { title: "feat: fd-1 Add branch facts", body, headBranch: branch };
    expect(evaluateSavedPullRequest({ saved, expectedHead: branch, key: "fd-1" })).toEqual([
      { target: "saved_body", rule },
    ]);
  });

  it.each([
    "Co-authored-by:\n Ada Lovelace <ada@example.com>",
    "Signed-off-by:\r\n Ai Nguyen <ai.nguyen@example.com>",
    "Co-authored-by: Ada Lovelace <ada@example.com>, Ada Cursor <ada.cursor@example.com>",
    "Co-authored-by : Ada Cursor <ada@example.com>",
    "Signed-off-by: Ada Lovelace <ada@example.com>\n Co-authored-by: Ai Nguyen <ai.nguyen@example.com>",
    "Helped-by: Ada Cursor <ada@example.com>",
    "Co-authored-by: ada+cursor@example.com",
    "Co-authored-by: Ada Lovelace <ada+cursor@example.com>",
    "Suggested-by: Ada Cursor <ada@example.com>",
    "Reported-by:\n Ai Nguyen <ai.nguyen@example.com>",
  ])("keeps a person's credit in a saved body: %j", (body) => {
    const saved = { title: "feat: fd-1 Add branch facts", body, headBranch: branch };
    expect(evaluateSavedPullRequest({ saved, expectedHead: branch, key: "fd-1" })).toEqual([]);
  });
});
