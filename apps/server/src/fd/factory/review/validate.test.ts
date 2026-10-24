import { FactoryReview } from "@t3tools/contracts/fd/factory";
import type { FactoryFindingSeverity } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { validateReview } from "./validate.ts";
import type { FactoryReviewBlockingRule, FactoryReviewContext } from "./validate.ts";

const decodeReview = Schema.decodeUnknownSync(FactoryReview);

type Finding = FactoryReview["findings"][number];
type Check = FactoryReview["acceptance"][number];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "f1",
  severity: "low",
  required: false,
  file: "apps/server/src/a.ts",
  line: 12,
  detail: "The guard reads a stale value, so a retry runs twice.",
  ...overrides,
});

const check = (criterion: number, overrides: Partial<Check> = {}): Check => ({
  criterion,
  status: "verified",
  evidence: "The focused test covers it.",
  paths: ["apps/server/src/a.test.ts"],
  ...overrides,
});

/** Decoded like a submission, so every case is a review the schema accepts. */
const review = (overrides: Partial<FactoryReview> = {}): FactoryReview =>
  decodeReview({
    verdict: "pass",
    findings: [],
    acceptance: [check(1), check(2)],
    missing_evidence: [],
    ...overrides,
  });

const planned: FactoryReviewContext = { criteriaCount: 2, blockingSeverities: ["high"] };
const singleItem: FactoryReviewContext = { criteriaCount: null, blockingSeverities: ["high"] };

describe("validateReview", () => {
  it("passes a review with no blocking cause and counts its findings by severity", () => {
    const passing = review({
      findings: [
        finding({ id: "f1", severity: "medium" }),
        finding({ id: "f2", severity: "low" }),
        finding({ id: "f3", severity: "low", line: null }),
      ],
    });
    expect(validateReview(passing, planned)).toEqual({
      status: "passing",
      findings: { high: 0, medium: 1, low: 2 },
    });
  });

  it("passes a single-item review without planned criteria", () => {
    expect(validateReview(review({ acceptance: [check(1)] }), singleItem)).toEqual({
      status: "passing",
      findings: { high: 0, medium: 0, low: 0 },
    });
    expect(validateReview(review({ acceptance: [] }), singleItem)).toEqual({
      status: "passing",
      findings: { high: 0, medium: 0, low: 0 },
    });
  });

  const blockingCases: ReadonlyArray<{
    readonly name: string;
    readonly review: FactoryReview;
    readonly context: FactoryReviewContext;
    readonly rule: FactoryReviewBlockingRule;
    readonly description: string;
  }> = [
    {
      name: "a changes-required verdict",
      review: review({ verdict: "changes-required" }),
      context: planned,
      rule: "changes_required",
      description: "The verdict is changes-required.",
    },
    {
      name: "a high finding when only high blocks",
      review: review({ findings: [finding({ id: "race", severity: "high" })] }),
      context: planned,
      rule: "blocking_finding",
      description: 'Finding "race" is high severity at apps/server/src/a.ts:12.',
    },
    {
      name: "a medium finding when high and medium block",
      review: review({ findings: [finding({ id: "naming", severity: "medium", line: null })] }),
      context: { ...planned, blockingSeverities: ["high", "medium"] },
      rule: "blocking_finding",
      description: 'Finding "naming" is medium severity at apps/server/src/a.ts.',
    },
    {
      name: "a missing evidence entry",
      review: review({ missing_evidence: ["No test drives the retry path."] }),
      context: planned,
      rule: "missing_evidence",
      description: 'Missing evidence: "No test drives the retry path.".',
    },
    {
      name: "a failed criterion",
      review: review({ acceptance: [check(1), check(2, { status: "failed" })] }),
      context: planned,
      rule: "criterion_not_verified",
      description: "Criterion 2 is failed.",
    },
    {
      name: "an untested criterion",
      review: review({ acceptance: [check(1, { status: "untested" }), check(2)] }),
      context: planned,
      rule: "criterion_not_verified",
      description: "Criterion 1 is untested.",
    },
    {
      name: "an untested entry of a single item",
      review: review({ acceptance: [check(1, { status: "untested" })] }),
      context: singleItem,
      rule: "criterion_not_verified",
      description: "Criterion 1 is untested.",
    },
    {
      name: "a planned criterion with no entry",
      review: review({ acceptance: [check(1)] }),
      context: planned,
      rule: "criterion_absent",
      description: "Criterion 2 has no acceptance entry.",
    },
  ];

  it.each(blockingCases)("blocks on $name alone", (testCase) => {
    expect(validateReview(testCase.review, testCase.context)).toEqual({
      status: "blocking",
      reasons: [{ rule: testCase.rule, description: testCase.description }],
      findings: expect.any(Object),
    });
  });

  it.each([
    { severity: "medium", blockingSeverities: ["high"] },
    { severity: "low", blockingSeverities: ["high", "medium"] },
  ] satisfies ReadonlyArray<{
    severity: FactoryFindingSeverity;
    blockingSeverities: FactoryFindingSeverity[];
  }>)(
    "does not block on a $severity finding when $blockingSeverities block",
    ({ severity, blockingSeverities }) => {
      const result = validateReview(review({ findings: [finding({ severity })] }), {
        ...planned,
        blockingSeverities,
      });
      expect(result.status).toBe("passing");
    },
  );

  it("lists every blocking reason with the severity counts", () => {
    const result = validateReview(
      review({
        verdict: "changes-required",
        findings: [
          finding({ id: "a", severity: "high" }),
          finding({ id: "b", severity: "medium" }),
          finding({ id: "c", severity: "high" }),
        ],
        acceptance: [check(1, { status: "failed" })],
        missing_evidence: ["x".repeat(500)],
      }),
      { criteriaCount: 3, blockingSeverities: ["high"] },
    );
    expect(result.status).toBe("blocking");
    if (result.status !== "blocking") return;
    expect(result.reasons.map((reason) => reason.rule)).toEqual([
      "changes_required",
      "blocking_finding",
      "blocking_finding",
      "missing_evidence",
      "criterion_not_verified",
      "criterion_absent",
      "criterion_absent",
    ]);
    expect(result.findings).toEqual({ high: 2, medium: 1, low: 0 });
    // Free text from the reviewer is clipped, so a reason stays short.
    expect(result.reasons.every((reason) => reason.description.length <= 200)).toBe(true);
  });
});

describe("validateReview structural problems", () => {
  it("reports a duplicate finding id as invalid, naming the id", () => {
    const result = validateReview(
      review({
        verdict: "changes-required",
        findings: [
          finding({ id: "dup", severity: "high" }),
          finding({ id: "ok" }),
          finding({ id: "dup" }),
        ],
      }),
      planned,
    );
    expect(result).toEqual({
      status: "invalid",
      problems: [
        {
          rule: "duplicate_finding_id",
          description: 'Finding id "dup" is used 2 times; give each finding its own id.',
        },
      ],
    });
  });

  it("reports a repeated criterion number as invalid, naming the number", () => {
    const result = validateReview(
      review({ acceptance: [check(1), check(2), check(2, { status: "failed" })] }),
      planned,
    );
    expect(result).toEqual({
      status: "invalid",
      problems: [
        {
          rule: "repeated_criterion",
          description: "Criterion 2 has 2 acceptance entries; submit one per criterion.",
        },
      ],
    });
  });

  it("reports a repeated criterion of a single item as invalid", () => {
    const result = validateReview(review({ acceptance: [check(1), check(1)] }), singleItem);
    expect(result.status).toBe("invalid");
  });

  it("reports a criterion number past the planned count as invalid, naming the number", () => {
    const result = validateReview(review({ acceptance: [check(1), check(2), check(3)] }), planned);
    expect(result).toEqual({
      status: "invalid",
      problems: [
        {
          rule: "criterion_out_of_range",
          description: "Criterion 3 is outside 1..2; the task has 2 acceptance criteria.",
        },
      ],
    });
  });

  it("accepts any criterion number when no criteria are planned", () => {
    const result = validateReview(review({ acceptance: [check(7)] }), singleItem);
    expect(result.status).toBe("passing");
  });

  it("reports every structural problem together", () => {
    const result = validateReview(
      review({
        findings: [finding({ id: "a" }), finding({ id: "a" })],
        acceptance: [check(1), check(1), check(4)],
      }),
      planned,
    );
    expect(result.status === "invalid" && result.problems.map((problem) => problem.rule)).toEqual([
      "duplicate_finding_id",
      "repeated_criterion",
      "criterion_out_of_range",
    ]);
  });
});
