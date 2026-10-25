import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_REVIEW_DETAIL_MAX_LENGTH,
  FACTORY_REVIEW_DETAILS_MAX,
  FactoryDelivery,
  type FactoryReviewDetails,
  FactoryReviewSummary,
} from "./index.ts";

const summary = {
  headSha: "a".repeat(40),
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 1, low: 4 },
  reviewedAt: "2026-10-25T09:05:00.000Z",
  number: 1,
};
const finding = {
  id: "no-header",
  severity: "high",
  required: true,
  blocking: true,
  file: "src/export.ts",
  line: 12,
  detail: "The export writes no header row, so spreadsheets read the first record as names.",
};
const details = {
  findings: [
    finding,
    {
      ...finding,
      id: "slow-join",
      severity: "medium",
      required: false,
      blocking: false,
      line: null,
    },
  ],
  criteria: [
    { criterion: 2, status: "failed", detail: "A comma in a name splits the row." },
    { criterion: 3, status: "untested", detail: "Nothing exports an empty table." },
  ],
  missingEvidence: ["A test that exports an empty table."],
  omitted: { findings: 4, criteria: 0, missingEvidence: 0 },
};

const decodeSummary = Schema.decodeUnknownSync(FactoryReviewSummary);
const encodeSummary = Schema.encodeSync(FactoryReviewSummary);
const decodeSummaryOption = Schema.decodeUnknownOption(FactoryReviewSummary);
const encodeSummaryOption = Schema.encodeUnknownOption(FactoryReviewSummary);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);

/** `count` distinct entries, each made from its index. */
const copies = <A>(count: number, entry: (index: number) => A) =>
  Array.from({ length: count }, (_, index) => entry(index));

// Exactly these keys at each level: a path, log or fingerprint added to the details fails
// typecheck here.
type Keys<A> = Record<keyof A, true>;
type FindingDetail = FactoryReviewDetails["findings"][number];
type CriterionDetail = FactoryReviewDetails["criteria"][number];
const DETAILS_KEYS: Keys<FactoryReviewDetails> = {
  findings: true,
  criteria: true,
  missingEvidence: true,
  omitted: true,
};
const FINDING_KEYS: Keys<FindingDetail> = {
  id: true,
  severity: true,
  required: true,
  blocking: true,
  file: true,
  line: true,
  detail: true,
};
const CRITERION_KEYS: Keys<CriterionDetail> = { criterion: true, status: true, detail: true };
const OMITTED_KEYS: Keys<FactoryReviewDetails["omitted"]> = {
  findings: true,
  criteria: true,
  missingEvidence: true,
};

/** Every key of every object in `value`, however deep. */
const keysOf = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)])
      : [];

describe("FactoryReviewSummary details", () => {
  it("decodes a summary without them as having none, and encodes it unchanged", () => {
    const { number: _, ...older } = summary;
    for (const payload of [summary, older]) {
      const decoded = decodeSummary(payload);
      expect(decoded).not.toHaveProperty("details");
      expect(encodeSummary(decoded)).toEqual(payload);
    }
  });

  it("round-trips the findings, criteria, missing evidence and omitted counts", () => {
    const payload = { ...summary, details };
    const decoded = decodeSummary(payload);
    expect(decoded.details?.findings.map(({ line }) => line)).toEqual([12, null]);
    expect(decoded.details?.omitted.findings).toBe(4);
    expect(encodeSummary(decoded)).toEqual(payload);
  });

  it("decodes a review in a delivery with and without details", () => {
    const delivery = {
      deliveryId: "d-1",
      projectId: "project-1",
      itemRef: { sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20", itemId: "fd-7k3qa2" },
      childIds: [],
      status: "blocked",
      stage: { name: "review", kind: "agent" },
      rounds: { fix: 0, review: 0 },
      threads: {},
      receipts: [],
      reviews: [summary, { ...summary, number: 2, details }],
      createdAt: "2026-10-25T08:59:00.000Z",
      updatedAt: "2026-10-25T09:06:00.000Z",
    };
    const decoded = decodeDelivery(delivery);
    expect(decoded.reviews.map((review) => review.details)).toEqual([undefined, details]);
  });

  it.each([
    [
      "more findings than the cap",
      {
        findings: copies(FACTORY_REVIEW_DETAILS_MAX + 1, (index) => ({
          ...finding,
          id: `f-${index}`,
        })),
      },
    ],
    [
      "more criteria than the cap",
      {
        criteria: copies(FACTORY_REVIEW_DETAILS_MAX + 1, (index) => ({
          ...details.criteria[0],
          criterion: index + 1,
        })),
      },
    ],
    [
      "more missing evidence than the cap",
      { missingEvidence: copies(FACTORY_REVIEW_DETAILS_MAX + 1, (index) => `Missing ${index}.`) },
    ],
    [
      "a finding detail over the length bound",
      { findings: [{ ...finding, detail: "x".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH + 1) }] },
    ],
    [
      "a criterion detail over the length bound",
      {
        criteria: [
          { ...details.criteria[0], detail: "x".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH + 1) },
        ],
      },
    ],
    [
      "missing evidence over the length bound",
      { missingEvidence: ["x".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH + 1)] },
    ],
    ["a verified criterion", { criteria: [{ ...details.criteria[0], status: "verified" }] }],
    ["a negative omitted count", { omitted: { ...details.omitted, findings: -1 } }],
  ])("refuses to decode or encode %s", (_, change) => {
    const payload = { ...summary, details: { ...details, ...change } };
    expect(Option.isNone(decodeSummaryOption(payload))).toBe(true);
    expect(Option.isNone(encodeSummaryOption(payload))).toBe(true);
  });

  it("takes a list and a detail exactly at their bounds", () => {
    const payload = {
      ...summary,
      details: {
        ...details,
        findings: copies(FACTORY_REVIEW_DETAILS_MAX, (index) => ({
          ...finding,
          id: `finding-${index}`,
          detail: "x".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH),
        })),
      },
    };
    expect(encodeSummary(decodeSummary(payload))).toEqual(payload);
  });

  it("never carries a path: unknown keys are dropped and none is path-like", () => {
    const decoded = decodeSummary({
      ...summary,
      evidencePath: "/home/owner/.t3/userdata/fd-factory/d-1/review-1.json",
      details: {
        ...details,
        findings: [{ ...finding, paths: ["src/export.test.ts"] }],
        criteria: [{ ...details.criteria[0], paths: ["src/export.test.ts"], evidence: "x" }],
        logPath: "/home/owner/.t3/userdata/fd-factory/d-1/verify-1.log",
      },
    });
    const wire = encodeSummary(decoded);
    const keys = new Set(keysOf(wire.details));
    const allowed = new Set(
      [DETAILS_KEYS, FINDING_KEYS, CRITERION_KEYS, OMITTED_KEYS].flatMap(Object.keys),
    );
    expect([...keys].filter((key) => !allowed.has(key))).toEqual([]);
    expect(keysOf(wire).filter((key) => /path/i.test(key))).toEqual([]);
    const text = JSON.stringify(wire);
    for (const hidden of ["fd-factory", "export.test.ts", "review-1", "verify-1"]) {
      expect(text).not.toContain(hidden);
    }
  });
});
