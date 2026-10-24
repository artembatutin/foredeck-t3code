import type {
  FactoryFindingSeverity,
  FactoryReview,
  FactoryReviewSummary,
} from "@t3tools/contracts/fd/factory";

/** What a review is judged against. */
export interface FactoryReviewContext {
  /** The task's planned acceptance criteria; null for a single item without a plan. */
  readonly criteriaCount: number | null;
  /** The project's `blockingSeverities`. */
  readonly blockingSeverities: ReadonlyArray<FactoryFindingSeverity>;
}

export type FactoryReviewProblemRule =
  | "duplicate_finding_id"
  | "repeated_criterion"
  | "criterion_out_of_range"
  | "evidence_path_missing"
  | "evidence_path_outside_worktree";

/** A structural problem the reviewer can correct, so the description says exactly what to fix. */
export interface FactoryReviewProblem {
  readonly rule: FactoryReviewProblemRule;
  readonly description: string;
}

export type FactoryReviewBlockingRule =
  | "changes_required"
  | "blocking_finding"
  | "missing_evidence"
  | "criterion_not_verified"
  | "criterion_absent";

export interface FactoryReviewBlockingReason {
  readonly rule: FactoryReviewBlockingRule;
  /** Bounded; the full review stays in the delivery's evidence. */
  readonly description: string;
}

type FindingCounts = FactoryReviewSummary["findings"];

/**
 * An invalid review goes back to the reviewer and is never judged; a valid one blocks the task
 * (port of Looper's `validateReview`) or passes, and carries the counts its summary shows.
 */
export type FactoryReviewValidation =
  | { readonly status: "invalid"; readonly problems: ReadonlyArray<FactoryReviewProblem> }
  | {
      readonly status: "blocking";
      readonly reasons: ReadonlyArray<FactoryReviewBlockingReason>;
      readonly findings: FindingCounts;
    }
  | { readonly status: "passing"; readonly findings: FindingCounts };

const MAX_QUOTED = 120;

const quote = (text: string) =>
  JSON.stringify(text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text);

/** Values that occur more than once, with their counts, in first-seen order. */
const repeats = <T>(values: ReadonlyArray<T>) => {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1);
};

const structuralProblems = (
  review: FactoryReview,
  criteriaCount: number | null,
): FactoryReviewProblem[] => {
  const problems: FactoryReviewProblem[] = [];
  for (const [id, count] of repeats(review.findings.map((finding) => finding.id))) {
    problems.push({
      rule: "duplicate_finding_id",
      description: `Finding id ${quote(id)} is used ${count} times; give each finding its own id.`,
    });
  }
  const criteria = review.acceptance.map((check) => check.criterion);
  for (const [criterion, count] of repeats(criteria)) {
    problems.push({
      rule: "repeated_criterion",
      description: `Criterion ${criterion} has ${count} acceptance entries; submit one per criterion.`,
    });
  }
  if (criteriaCount !== null) {
    for (const criterion of new Set(criteria)) {
      if (criterion > criteriaCount) {
        problems.push({
          rule: "criterion_out_of_range",
          description: `Criterion ${criterion} is outside 1..${criteriaCount}; the task has ${criteriaCount} acceptance criteria.`,
        });
      }
    }
  }
  return problems;
};

const blockingReasons = (
  review: FactoryReview,
  context: FactoryReviewContext,
): FactoryReviewBlockingReason[] => {
  const reasons: FactoryReviewBlockingReason[] = [];
  if (review.verdict === "changes-required") {
    reasons.push({ rule: "changes_required", description: "The verdict is changes-required." });
  }
  for (const finding of review.findings) {
    if (context.blockingSeverities.includes(finding.severity)) {
      const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
      reasons.push({
        rule: "blocking_finding",
        description: `Finding ${quote(finding.id)} is ${finding.severity} severity at ${location}.`,
      });
    }
  }
  for (const entry of review.missing_evidence) {
    reasons.push({ rule: "missing_evidence", description: `Missing evidence: ${quote(entry)}.` });
  }
  for (const check of review.acceptance) {
    if (check.status !== "verified") {
      reasons.push({
        rule: "criterion_not_verified",
        description: `Criterion ${check.criterion} is ${check.status}.`,
      });
    }
  }
  // Without planned criteria (a single item), only the submitted entries are judged.
  if (context.criteriaCount !== null) {
    const covered = new Set(review.acceptance.map((check) => check.criterion));
    for (let criterion = 1; criterion <= context.criteriaCount; criterion += 1) {
      if (!covered.has(criterion)) {
        reasons.push({
          rule: "criterion_absent",
          description: `Criterion ${criterion} has no acceptance entry.`,
        });
      }
    }
  }
  return reasons;
};

const countFindings = (findings: FactoryReview["findings"]): FindingCounts => {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
};

/**
 * The findings a blocking review asks the author to fix: the required ones and those at a
 * blocking severity, or every finding when none is either. They name the review's failure in its
 * fingerprint and are what a fix-review turn lists.
 */
export const findingsToFix = (
  review: FactoryReview,
  blockingSeverities: ReadonlyArray<FactoryFindingSeverity>,
): FactoryReview["findings"] => {
  const blocking = review.findings.filter(
    (finding) => finding.required || blockingSeverities.includes(finding.severity),
  );
  return blocking.length > 0 ? blocking : review.findings;
};

/**
 * Judges a decoded review. Every structural problem is reported together, so one corrected
 * retry can fix them all; evidence paths need the worktree, see `evidencePaths.ts`.
 */
export const validateReview = (
  review: FactoryReview,
  context: FactoryReviewContext,
): FactoryReviewValidation => {
  const problems = structuralProblems(review, context.criteriaCount);
  if (problems.length > 0) return { status: "invalid", problems };
  const findings = countFindings(review.findings);
  const reasons = blockingReasons(review, context);
  return reasons.length > 0
    ? { status: "blocking", reasons, findings }
    : { status: "passing", findings };
};
