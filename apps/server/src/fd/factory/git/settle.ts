import type { FactoryBranchCommit, FactoryBranchFacts } from "./branchFacts.ts";
import { aiAttribution, aiNames } from "./publishedText.ts";

/**
 * Commit policy ported from Looper. Its name and attribution rules are the ones pull request
 * text follows too (see `publishedText.ts`).
 */
const commitPolicy = {
  subject: /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([^)]+\))?!?: \S/,
  names: aiNames,
  attribution: aiAttribution,
};

export type FactorySettleRule =
  | "wrong_branch"
  | "dirty_worktree"
  | "baseline_not_ancestor"
  | "no_new_commit"
  | "non_conventional_subject"
  | "ai_name_in_subject"
  | "ai_name_in_body"
  | "ai_attribution"
  | "ai_identity";

export interface FactorySettleProblem {
  readonly rule: FactorySettleRule;
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

const commitProblems = (commit: FactoryBranchCommit): FactorySettleProblem[] => {
  const label = `Commit ${commit.sha.slice(0, 12)}`;
  const problems: FactorySettleProblem[] = [];
  if (!commitPolicy.subject.test(commit.subject)) {
    problems.push({
      rule: "non_conventional_subject",
      description: `${label} subject is not a Conventional Commit: ${quote(commit.subject)}.`,
    });
  }
  if (commitPolicy.names.test(commit.subject)) {
    problems.push({
      rule: "ai_name_in_subject",
      description: `${label} subject names an AI agent, model or provider.`,
    });
  }
  if (commitPolicy.names.test(commit.body)) {
    problems.push({
      rule: "ai_name_in_body",
      description: `${label} body names an AI agent, model or provider.`,
    });
  }
  if (commitPolicy.attribution.test(`${commit.subject}\n${commit.body}`)) {
    problems.push({
      rule: "ai_attribution",
      description: `${label} message carries generated or assisted attribution.`,
    });
  }
  const identities = [
    ["author", `${commit.authorName}\n${commit.authorEmail}`],
    ["committer", `${commit.committerName}\n${commit.committerEmail}`],
  ] as const;
  for (const [role, identity] of identities) {
    if (commitPolicy.names.test(identity)) {
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
