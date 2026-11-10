import { describe, expect, it } from "vite-plus/test";

import { failureFingerprint } from "./fingerprint.ts";

const tree = "c".repeat(40);
const otherTree = "d".repeat(40);

describe("failureFingerprint", () => {
  it("hashes the same stage failing on the same tree to the same sha-256", () => {
    expect(failureFingerprint({ stage: "verify", tree })).toBe(
      failureFingerprint({ stage: "verify", tree }),
    );
    expect(failureFingerprint({ stage: "verify", tree })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells another tree apart", () => {
    expect(failureFingerprint({ stage: "verify", tree: otherTree })).not.toBe(
      failureFingerprint({ stage: "verify", tree }),
    );
    expect(failureFingerprint({ stage: "review", tree: otherTree })).not.toBe(
      failureFingerprint({ stage: "review", tree }),
    );
  });

  it("tells the stages apart", () => {
    expect(failureFingerprint({ stage: "review", tree })).not.toBe(
      failureFingerprint({ stage: "verify", tree }),
    );
  });
});
