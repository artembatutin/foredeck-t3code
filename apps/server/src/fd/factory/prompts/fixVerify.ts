import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";

import { fence, repairRules } from "./repair.ts";
import { commandLine, describeResult } from "./review.ts";

/**
 * The repair turn an author gets when the server's verify run of its commit failed or timed out:
 * the command, how it ended and the end of its output.
 */
export const renderFixVerifyPrompt = (input: {
  /** The failed run's receipt. */
  readonly receipt: FactoryVerifyReceipt;
  /** The end of the run's log. */
  readonly tail: string;
  readonly branch: string;
  /** This fix-verify round, from 1. */
  readonly round: number;
}): string => {
  const { receipt } = input;
  return [
    [
      `Factory verified commit ${receipt.headSha} on branch \`${input.branch}\` and the check failed: ${describeResult(receipt)} after ${Math.round(receipt.durationMs / 1000)} s.`,
      `Command: \`${commandLine(receipt)}\``,
    ].join("\n"),
    input.tail.trim().length === 0
      ? "The command printed nothing."
      : `The end of its output:\n${fence(input.tail, "text")}`,
    "Your task: find why this check fails and fix it in this worktree, then stop.",
    repairRules({ branch: input.branch, round: input.round }),
    "Reply with the cause you found, what you changed and the committed tests that cover it.",
  ].join("\n\n");
};
