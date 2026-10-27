import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";

import { describeFinding, type FactoryReviewFinding, fence } from "./repair.ts";
import { reviewInstructionSections, verifiedCommitSection } from "./review.ts";

const RESPONSE_MAX_CHARS = 8_000;

/**
 * A later review round, sent on the reviewer thread that judged the round before: the newly
 * verified commit, the reviewer's previous findings, and the author's reply to them. The reply
 * is labelled as claims, so the round judges the code rather than the author's account of it.
 */
export const renderReviewFollowUpPrompt = (input: {
  readonly rulesOverride?: string | undefined;
  readonly round: number;
  readonly branch: string;
  /** The task baseline; the review covers `baseline..receipt.headSha`. */
  readonly baseline: string;
  /** The server's passing verify run of the commit under review. */
  readonly receipt: FactoryVerifyReceipt;
  /** The commit the previous round judged, and its findings. */
  readonly previous: {
    readonly headSha: string;
    readonly findings: ReadonlyArray<FactoryReviewFinding>;
  };
  /** The last message of the author's fix-review turn; null when it sent none. */
  readonly authorResponse: string | null;
}): string => {
  const { receipt, previous } = input;
  const range = `${input.baseline}..${receipt.headSha}`;
  const response = input.authorResponse?.trim() ?? "";
  const bounded =
    response.length > RESPONSE_MAX_CHARS
      ? `${response.slice(0, RESPONSE_MAX_CHARS)}\n[reply truncated]`
      : response;
  return [
    `Factory review round ${input.round}. The author worked on your previous review on branch \`${input.branch}\`, and the server verified the branch again.`,
    `Your task: review the work again, the commits in \`${range}\`, and check what changed since the commit you last reviewed in \`${previous.headSha}..${receipt.headSha}\`.`,
    verifiedCommitSection(receipt),
    previous.findings.length === 0
      ? `Your previous review of ${previous.headSha} had no findings.`
      : `Your previous findings, on ${previous.headSha}:\n${previous.findings.map(describeFinding).join("\n")}`,
    bounded.length === 0
      ? "The author sent no reply to your findings."
      : `The author's reply to your findings. These are claims to check against the code, not evidence:\n${fence(bounded, "text")}`,
    "Recheck every previous finding: keep its id while it still applies, and leave it out once the code fixes it. Report new problems as new findings with new ids.",
    ...reviewInstructionSections(undefined, input.rulesOverride),
  ].join("\n\n");
};
