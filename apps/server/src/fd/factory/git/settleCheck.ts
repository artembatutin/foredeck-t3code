import * as Effect from "effect/Effect";

import type { FactoryDeliveryState, FactorySettleResult } from "../pipeline/state.ts";
import { readBranchFacts } from "./branchFacts.ts";
import { evaluateSettle } from "./settle.ts";

/** A branch that cannot be read never settles; the problem names only the path and operation. */
const unreadable = (problem: string): FactorySettleResult => ({
  status: "unrepairable",
  problems: [problem],
});

/**
 * Reads the delivery's branch and evaluates the settle rules against it, for the settle check
 * after an author's turn and for a resume. A worktree that cannot be read is unrepairable.
 */
export const readSettle = (state: FactoryDeliveryState) => {
  const { worktreePath, baseline } = state;
  if (worktreePath === null || baseline === null) {
    return Effect.succeed(unreadable("The delivery has no recorded worktree and baseline."));
  }
  return readBranchFacts({ worktreePath, baselineSha: baseline }).pipe(
    Effect.map((facts): FactorySettleResult => {
      const evaluation = evaluateSettle(facts, state.branch);
      return evaluation.status === "settled"
        ? evaluation
        : {
            status: evaluation.status,
            problems: evaluation.problems.map((problem) => problem.description),
          };
    }),
    Effect.catchTags({
      FactoryWorktreeMissingError: (error) => Effect.succeed(unreadable(error.message)),
      FactoryBranchReadError: (error) => Effect.succeed(unreadable(error.message)),
    }),
  );
};
