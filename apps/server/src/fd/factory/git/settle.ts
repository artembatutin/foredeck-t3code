import * as Schema from "effect/Schema";

import type { FactoryBranchCommit, FactoryBranchFacts } from "./branchFacts.ts";
import {
  branchProblems,
  carriesAiAttribution,
  conventionalSubject,
  identityIsAiTool,
  namesAiTool,
  pullRequestTextProblems,
} from "./publishedText.ts";

/**
 * Commit policy ported from Looper. Its name and attribution rules are the ones pull request
 * text follows too (see `publishedText.ts`).
 */
const commitPolicy = {
  subject: conventionalSubject,
  names: namesAiTool,
  attribution: carriesAiAttribution,
  identity: identityIsAiTool,
};

type FactoryCommitRule =
  | "non_conventional_subject"
  | "ai_name_in_subject"
  | "ai_name_in_body"
  | "ai_attribution"
  | "ai_identity";

export type FactorySettleRule =
  | "wrong_branch"
  | "dirty_worktree"
  | "baseline_not_ancestor"
  | "no_new_commit"
  | FactoryCommitRule;

export interface FactorySettleProblem<Rule extends FactorySettleRule = FactorySettleRule> {
  readonly rule: Rule;
  /** Bounded and built from facts, never from command output. */
  readonly description: string;
}

/**
 * Repairable problems are the input of the single fix-commit turn. An AI identity on a commit is
 * unrepairable: Factory never rewrites identities, so the delivery blocks at once.
 */
export type FactorySettleEvaluation =
  | { readonly status: "settled" }
  | {
      readonly status: "repairable" | "unrepairable";
      readonly problems: ReadonlyArray<FactorySettleProblem>;
    };

const MAX_QUOTED = 72;

const quote = (text: string) =>
  JSON.stringify(text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text);

const commitProblems = (commit: FactoryBranchCommit) => {
  const label = `Commit ${commit.sha.slice(0, 12)}`;
  const problems: Array<FactorySettleProblem<FactoryCommitRule>> = [];
  if (!commitPolicy.subject.test(commit.subject)) {
    problems.push({
      rule: "non_conventional_subject",
      description: `${label} subject is not a Conventional Commit: ${quote(commit.subject)}.`,
    });
  }
  if (commitPolicy.names(commit.subject)) {
    problems.push({
      rule: "ai_name_in_subject",
      description: `${label} subject names an AI agent, model or provider.`,
    });
  }
  if (commitPolicy.names(commit.body)) {
    problems.push({
      rule: "ai_name_in_body",
      description: `${label} body names an AI agent, model or provider.`,
    });
  }
  if (commitPolicy.attribution(`${commit.subject}\n${commit.body}`)) {
    problems.push({
      rule: "ai_attribution",
      description: `${label} message carries generated or assisted attribution.`,
    });
  }
  const identities = [
    ["author", { name: commit.authorName, email: commit.authorEmail }],
    ["committer", { name: commit.committerName, email: commit.committerEmail }],
  ] as const;
  for (const [role, identity] of identities) {
    if (commitPolicy.identity(identity)) {
      problems.push({
        rule: "ai_identity",
        description: `${label} ${role} identity names an AI agent, model or provider.`,
      });
    }
  }
  return problems;
};

/** Evaluates every settle rule against the facts and reports all problems together. */
export const evaluateSettle = (
  facts: FactoryBranchFacts,
  expectedBranch: string,
): FactorySettleEvaluation => {
  const problems: FactorySettleProblem[] = [];
  if (facts.branch !== expectedBranch) {
    problems.push({
      rule: "wrong_branch",
      description:
        facts.branch === null
          ? `HEAD is detached; expected branch ${quote(expectedBranch)}.`
          : `Worktree is on branch ${quote(facts.branch)}; expected ${quote(expectedBranch)}.`,
    });
  }
  if (!facts.clean) {
    problems.push({
      rule: "dirty_worktree",
      description: "Worktree has uncommitted or untracked changes.",
    });
  }
  if (!facts.baselineIsAncestor) {
    problems.push({
      rule: "baseline_not_ancestor",
      description: "The task baseline is no longer an ancestor of HEAD.",
    });
  }
  if (facts.commits.length === 0) {
    problems.push({
      rule: "no_new_commit",
      description: "No commit was added since the baseline.",
    });
  }
  problems.push(...facts.commits.flatMap(commitProblems));

  if (problems.length === 0) return { status: "settled" };
  return {
    status: problems.some((problem) => problem.rule === "ai_identity")
      ? "unrepairable"
      : "repairable",
    problems,
  };
};

const COMMIT_RULES = [
  "non_conventional_subject",
  "ai_name_in_subject",
  "ai_name_in_body",
  "ai_attribution",
  "ai_identity",
] as const;

const TEXT_RULES = ["malformed_title", "ai_name", "ai_attribution"] as const;

const BRANCH_RULES = ["branch_prefix", "ai_name_in_branch", "ai_attribution_in_branch"] as const;

/**
 * What keeps a publication from happening. Each names where and which rule, never the text that
 * broke it: a saved field is what the host holds now, a `commit` its first twelve characters.
 */
export const FactoryPublicationProblem = Schema.Union([
  Schema.Struct({
    target: Schema.Literal("branch"),
    rule: Schema.Literals(["wrong_branch", ...BRANCH_RULES]),
  }),
  // The branch a push of it lands on, named when it is not the branch's own name.
  Schema.Struct({
    target: Schema.Literal("remote_branch"),
    rule: Schema.Literals(BRANCH_RULES),
    remote: Schema.String,
    branch: Schema.String,
  }),
  Schema.Struct({
    target: Schema.Literal("commits"),
    rule: Schema.Literals(["baseline_missing", "baseline_not_ancestor", "no_new_commit"]),
  }),
  Schema.Struct({
    // `ancestor` is a commit from before the delivery's range that the push would newly publish.
    target: Schema.Literals(["commit", "ancestor"]),
    rule: Schema.Literals(COMMIT_RULES),
    commit: Schema.String,
  }),
  // `changed`: where the push goes moved from where the gate judged, so it stopped, before writing
  // or, when that moved while it pushed, after a push that went only where the gate judged.
  // `unpinnable`: the Git that pushes cannot be held to the URLs the gate judged, so it stopped
  // before writing.
  Schema.Struct({
    target: Schema.Literal("destination"),
    rule: Schema.Literals(["unreadable", "changed", "unpinnable"]),
  }),
  Schema.Struct({ target: Schema.Literals(["title", "body"]), rule: Schema.Literals(TEXT_RULES) }),
  Schema.Struct({
    target: Schema.Literals(["saved_title", "saved_body"]),
    rule: Schema.Literals([...TEXT_RULES, "differs"]),
  }),
  Schema.Struct({ target: Schema.Literal("saved_head"), rule: Schema.Literal("differs") }),
  Schema.Struct({
    target: Schema.Literal("saved_pull_request"),
    rule: Schema.Literal("unreadable"),
  }),
]);
export type FactoryPublicationProblem = typeof FactoryPublicationProblem.Type;

/** The publication gate's text input: a title and body, with the item's key when it is known. */
interface FactoryPublishedText {
  readonly title: string;
  readonly body: string;
  readonly key: string;
}

/** What the publication gate reads of the branch, right before the action. */
export interface FactoryPublicationFacts extends Pick<
  FactoryBranchFacts,
  "branch" | "baselineIsAncestor" | "commits"
> {
  /**
   * The remote and branch a push of it lands on, as the Git driver that pushes it resolves them, which
   * the action is then bound to. Null when it names none, which leaves no destination to read.
   */
  readonly target: { readonly remoteName: string; readonly branch: string } | null;
  /**
   * Commits outside `commits` the push would newly publish, as a base nobody pushed or what was merged
   * into it. Null when what its destination holds could not be read.
   */
  readonly ancestry: ReadonlyArray<FactoryBranchCommit> | null;
}

const commitRuleProblems = <Target extends "commit" | "ancestor">(
  target: Target,
  commits: ReadonlyArray<FactoryBranchCommit>,
) =>
  commits.flatMap((commit) =>
    commitProblems(commit).map(({ rule }) => ({ target, rule, commit: commit.sha.slice(0, 12) })),
  );

/**
 * What keeps the branch a push lands on from being published. Git can push a branch under another
 * name: without the name of a remote it starts with (`feature/x` to a remote called `feature` lands
 * on `x`), or to the head of an upstream it aliases. That name is the one that goes out, so it is held
 * to the branch's rules too. Judged only on the delivery's own branch, which `wrong_branch` checks.
 */
const targetProblems = (
  target: FactoryPublicationFacts["target"],
  expectedBranch: string,
): ReadonlyArray<FactoryPublicationProblem> => {
  if (target === null || target.branch === expectedBranch) return [];
  return branchProblems(target.branch).map((rule) => ({
    target: "remote_branch" as const,
    rule,
    remote: target.remoteName,
    branch: target.branch,
  }));
};

/**
 * The gate every push and pull request passes: the branch's prefix and name, and the name it lands on
 * remotely, every commit of the delivery's range, whether or not its destination holds it already,
 * full message and identities, every other commit the push would newly publish, and the text when
 * there is any. A branch or commit published before these rules is judged like any other, since this
 * push would go out on it, while history the destination holds from before the delivery is not this
 * delivery's to judge. Nothing here renames or rewrites anything. Reports every problem together.
 */
export const evaluatePublication = (input: {
  readonly facts: FactoryPublicationFacts;
  readonly expectedBranch: string;
  readonly text?: FactoryPublishedText;
}): ReadonlyArray<FactoryPublicationProblem> => {
  const { facts, expectedBranch, text } = input;
  return [
    ...(facts.branch === expectedBranch
      ? targetProblems(facts.target, expectedBranch)
      : [{ target: "branch" as const, rule: "wrong_branch" as const }]),
    ...branchProblems(expectedBranch).map((rule) => ({ target: "branch" as const, rule })),
    ...(facts.baselineIsAncestor
      ? []
      : [{ target: "commits" as const, rule: "baseline_not_ancestor" as const }]),
    ...(facts.commits.length === 0
      ? [{ target: "commits" as const, rule: "no_new_commit" as const }]
      : []),
    ...commitRuleProblems("commit", facts.commits),
    ...(facts.target === null || facts.ancestry === null
      ? [{ target: "destination" as const, rule: "unreadable" as const }]
      : commitRuleProblems("ancestor", facts.ancestry)),
    ...(text === undefined
      ? []
      : pullRequestTextProblems(text).map(({ field, rule }) => ({ target: field, rule }))),
  ];
};

const lineEndings = (text: string) => text.replace(/\r\n/g, "\n").trim();

/**
 * Judges a pull request as its host saved it: on the remote branch the delivery's pushes land on
 * (`expectedHead`), and by the same text rules under the item's verified key. `sent` is what Factory
 * just created it with, which it must hold exactly. A pull request Factory did not write this time, as
 * one already open or recorded earlier, has only the rules to answer to: an owner may have reworded
 * it. Line endings and surrounding space are the host's to normalize.
 */
export const evaluateSavedPullRequest = (input: {
  readonly saved: {
    readonly title: string;
    readonly body: string;
    readonly headBranch: string;
  };
  readonly expectedHead: string;
  readonly key: string;
  readonly sent?: { readonly title: string; readonly body: string };
}): ReadonlyArray<FactoryPublicationProblem> => {
  const { saved, expectedHead, key, sent } = input;
  return [
    ...(saved.headBranch === expectedHead
      ? []
      : [{ target: "saved_head" as const, rule: "differs" as const }]),
    ...(sent !== undefined && saved.title !== sent.title
      ? [{ target: "saved_title" as const, rule: "differs" as const }]
      : []),
    ...(sent !== undefined && lineEndings(saved.body) !== lineEndings(sent.body)
      ? [{ target: "saved_body" as const, rule: "differs" as const }]
      : []),
    ...pullRequestTextProblems({ title: saved.title, body: saved.body, key }).map(
      ({ field, rule }) => ({
        target: field === "title" ? ("saved_title" as const) : ("saved_body" as const),
        rule,
      }),
    ),
  ];
};
