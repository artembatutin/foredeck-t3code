// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps this a pure function.
import * as NodeCrypto from "node:crypto";

/**
 * What failed, for its fingerprint: a verify run's log tail, or a blocking review's blocking
 * findings, each with the tree the stage judged.
 */
export type FactoryFailure =
  | { readonly stage: "verify"; readonly tail: string; readonly tree: string }
  | {
      readonly stage: "review";
      readonly findings: ReadonlyArray<{ readonly id: string; readonly detail: string }>;
      readonly tree: string;
    };

/**
 * A failure's fingerprint (port of Looper's): a hash of the stage, the failure and the tree. The
 * same failure of one stage on one tree hashes equally, so the engine stops a repair loop the
 * second time it sees one: another round would repair what the last one did not. Findings are
 * hashed in id order, since a review may list the same findings in any order.
 */
export const failureFingerprint = (failure: FactoryFailure): string => {
  const failed =
    failure.stage === "verify"
      ? failure.tail
      : failure.findings
          .map(({ id, detail }) => [id, detail] as const)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([failure.stage, failed, failure.tree]))
    .digest("hex");
};
