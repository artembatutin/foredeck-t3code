// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps this a pure function.
import * as NodeCrypto from "node:crypto";

/** What failed, for its fingerprint: the repair stage that failed, and the tree it judged. */
export interface FactoryFailure {
  readonly stage: "verify" | "review";
  readonly tree: string;
}

/**
 * A failure's fingerprint: a hash of the stage and the tree it failed on. A stage that fails again
 * on a tree it already failed on hashes equally, so the engine stops a repair loop the second time
 * it sees one: the last round changed nothing that stage judges. The failure's text is left out on
 * purpose; log timings and reworded findings differ every run, so hashing them never repeated.
 * Fingerprints persisted from older deliveries hashed the text too and so never equal these.
 */
export const failureFingerprint = (failure: FactoryFailure): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(["failure-v2", failure.stage, failure.tree]))
    .digest("hex");
