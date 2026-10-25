import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FactoryDelivery,
  type FactoryReviewSummary,
  type FactoryStageRunSummary,
  type FactoryVerifyReceiptSummary,
} from "./index.ts";

const headSha = "a".repeat(40);
const receipt = {
  headSha,
  tree: "b".repeat(40),
  startedAt: "2026-10-25T09:00:00.000Z",
  finishedAt: "2026-10-25T09:00:02.000Z",
  code: 1,
  timedOut: false,
  durationMs: 2_000,
};
const review = {
  headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 0 },
  reviewedAt: "2026-10-25T09:05:00.000Z",
};
const verifyAttempt = {
  stage: "verify",
  attempt: 1,
  outcome: "failed",
  startedAt: "2026-10-25T09:00:00.000Z",
  finishedAt: "2026-10-25T09:00:02.000Z",
};
const reviewAttempt = {
  stage: "review",
  attempt: 1,
  outcome: "failed",
  threadId: "thread-reviewer",
  startedAt: "2026-10-25T09:03:00.000Z",
  finishedAt: "2026-10-25T09:06:00.000Z",
};

const snapshot = (evidence: {
  readonly receipts: ReadonlyArray<unknown>;
  readonly reviews: ReadonlyArray<unknown>;
  readonly stageRuns: ReadonlyArray<unknown>;
}) => ({
  deliveryId: "d-1",
  projectId: "project-1",
  itemRef: { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-7k3qa2" },
  childIds: [],
  status: "running",
  stage: { name: "repair", kind: "agent" },
  rounds: { fix: 1, review: 1 },
  threads: { author: "thread-author", reviewer: "thread-reviewer" },
  ...evidence,
  createdAt: "2026-10-25T08:59:00.000Z",
  updatedAt: "2026-10-25T09:06:00.000Z",
});

const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);
const encodeDelivery = Schema.encodeSync(FactoryDelivery);

// Exactly these keys: a path, log, fingerprint or command line added to a summary fails
// typecheck here.
const RECEIPT_KEYS: Record<keyof FactoryVerifyReceiptSummary, true> = {
  headSha: true,
  tree: true,
  startedAt: true,
  finishedAt: true,
  code: true,
  timedOut: true,
  durationMs: true,
  number: true,
};
const REVIEW_KEYS: Record<keyof FactoryReviewSummary, true> = {
  headSha: true,
  verdict: true,
  blocking: true,
  findings: true,
  reviewedAt: true,
  number: true,
};
const ATTEMPT_KEYS: Record<keyof FactoryStageRunSummary, true> = {
  stage: true,
  attempt: true,
  outcome: true,
  threadId: true,
  startedAt: true,
  finishedAt: true,
  receiptNumber: true,
  reviewNumber: true,
};

describe("FactoryDelivery evidence links", () => {
  it("decodes a payload without them as having none", () => {
    const old = snapshot({
      receipts: [receipt],
      reviews: [review],
      stageRuns: [verifyAttempt, reviewAttempt],
    });
    const decoded = decodeDelivery(old);
    expect(decoded.receipts[0]).not.toHaveProperty("number");
    expect(decoded.reviews[0]).not.toHaveProperty("number");
    for (const attempt of decoded.stageRuns) {
      expect(attempt).not.toHaveProperty("receiptNumber");
      expect(attempt).not.toHaveProperty("reviewNumber");
    }
    expect(encodeDelivery(decoded)).toEqual(old);
  });

  it("round-trips the receipt and review an attempt names", () => {
    const linked = snapshot({
      receipts: [{ ...receipt, number: 1 }],
      reviews: [{ ...review, number: 2 }],
      stageRuns: [
        { ...verifyAttempt, receiptNumber: 1 },
        { ...reviewAttempt, reviewNumber: 2 },
      ],
    });
    const decoded = decodeDelivery(linked);
    expect(
      decoded.stageRuns.map(({ receiptNumber, reviewNumber }) => [receiptNumber, reviewNumber]),
    ).toEqual([
      [1, undefined],
      [undefined, 2],
    ]);
    expect(decoded.receipts[0]?.number).toBe(1);
    expect(decoded.reviews[0]?.number).toBe(2);
    expect(encodeDelivery(decoded)).toEqual(linked);
  });

  it("drops an entry whose link it cannot read and keeps the rest", () => {
    const decoded = decodeDelivery(
      snapshot({
        receipts: [
          { ...receipt, number: 0 },
          { ...receipt, number: "2" },
          { ...receipt, number: 1.5 },
          { ...receipt, number: 3 },
        ],
        reviews: [{ ...review, number: -1 }, { ...review, number: null }, review],
        stageRuns: [
          { ...verifyAttempt, receiptNumber: 0 },
          { ...reviewAttempt, reviewNumber: "1" },
          { ...verifyAttempt, attempt: 2, receiptNumber: 3 },
        ],
      }),
    );
    expect(decoded.receipts).toEqual([{ ...receipt, number: 3 }]);
    expect(decoded.reviews).toEqual([review]);
    expect(decoded.stageRuns).toEqual([{ ...verifyAttempt, attempt: 2, receiptNumber: 3 }]);
    expect(decoded.status).toBe("running");
  });

  it("never carries an evidence path, log path, fingerprint or command line", () => {
    const folder = "/home/owner/.t3/userdata/fd-factory/d-1";
    const decoded = decodeDelivery(
      snapshot({
        receipts: [
          {
            ...receipt,
            number: 1,
            logPath: `${folder}/verify-1.log`,
            command: { executable: "secret-verify-tool", args: ["--token", "hunter2"] },
            outputHash: "output-hash",
          },
        ],
        reviews: [{ ...review, number: 1, evidencePath: `${folder}/review-1.json` }],
        stageRuns: [
          {
            ...verifyAttempt,
            receiptNumber: 1,
            runId: "run-1",
            evidencePath: `${folder}/verify-1.json`,
            fingerprint: "fingerprint-1",
          },
          { ...reviewAttempt, reviewNumber: 1, fingerprint: "fingerprint-2" },
        ],
      }),
    );
    const wire = encodeDelivery(decoded);
    const keysOf = (entries: ReadonlyArray<unknown>) =>
      new Set(entries.flatMap((entry) => Object.keys(entry as object)));
    const outside = (keys: ReadonlySet<string>, allowed: object) =>
      [...keys].filter((key) => !Object.hasOwn(allowed, key));
    expect(outside(keysOf(wire.receipts), RECEIPT_KEYS)).toEqual([]);
    expect(outside(keysOf(wire.reviews), REVIEW_KEYS)).toEqual([]);
    expect(outside(keysOf(wire.stageRuns ?? []), ATTEMPT_KEYS)).toEqual([]);
    const text = JSON.stringify(wire);
    for (const hidden of [
      "fd-factory",
      "verify-1",
      "review-1",
      "fingerprint",
      "hunter2",
      "run-1",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });
});
