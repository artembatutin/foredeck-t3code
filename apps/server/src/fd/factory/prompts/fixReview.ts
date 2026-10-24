import { describeFinding, type FactoryReviewFinding, repairRules } from "./repair.ts";

/**
 * The repair turn an author gets when an accepted review blocks its commit: the findings to fix
 * and the review's other blocking reasons. The reply is what the next review round checks.
 */
export const renderFixReviewPrompt = (input: {
  /** The commit the review judged. */
  readonly headSha: string;
  readonly findings: ReadonlyArray<FactoryReviewFinding>;
  /** Blocking reasons that are not findings: criteria not verified, missing evidence. */
  readonly otherReasons: ReadonlyArray<string>;
  readonly branch: string;
  /** This fix-review round, from 1. */
  readonly round: number;
}): string => {
  const blocking = [
    ...(input.findings.length === 0
      ? []
      : [`Findings to fix:\n${input.findings.map(describeFinding).join("\n")}`]),
    ...(input.otherReasons.length === 0
      ? []
      : [`Also blocking:\n${input.otherReasons.map((reason) => `- ${reason}`).join("\n")}`]),
  ];
  return [
    `An independent review of commit ${input.headSha} on branch \`${input.branch}\` requires changes before it can be accepted.`,
    ...blocking,
    "Your task: address each of these in this worktree, then stop. If you are sure a finding is wrong, leave that code as it is and say why, with evidence.",
    repairRules({ branch: input.branch, round: input.round }),
    "Finish with a reply that goes through the findings by id: what you changed for each and the committed tests that cover it, or why it needs no change. The reviewer checks your reply against the code.",
  ].join("\n\n");
};
