import {
  FACTORY_REVIEW_DETAIL_MAX_LENGTH,
  FACTORY_REVIEW_DETAILS_MAX,
  type FactoryFindingSeverity,
  type FactoryReview,
  type FactoryReviewDetails,
} from "@t3tools/contracts/fd/factory";

const SEVERITY_ORDER: Readonly<Record<FactoryFindingSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** `text` within the summary's bound, cut with an ellipsis when longer, never inside a pair. */
const truncated = (text: string) => {
  if (text.length <= FACTORY_REVIEW_DETAIL_MAX_LENGTH) return text;
  let end = FACTORY_REVIEW_DETAIL_MAX_LENGTH - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
};

/** The first entries up to the cap, and how many it left out. */
const capped = <A>(entries: ReadonlyArray<A>) => ({
  kept: entries.slice(0, FACTORY_REVIEW_DETAILS_MAX),
  omitted: Math.max(0, entries.length - FACTORY_REVIEW_DETAILS_MAX),
});

/**
 * What clients see of an accepted review, computed once when it is accepted, since snapshots
 * never read evidence: its findings, the criteria it did not verify and its missing evidence, each
 * list capped and each text truncated, the rest only counted. Findings that block or are required
 * come first, then by severity, so the cap leaves out the least pressing. A criterion's paths stay
 * in the evidence.
 */
export const reviewDetails = (
  review: FactoryReview,
  blockingSeverities: ReadonlyArray<FactoryFindingSeverity>,
): FactoryReviewDetails => {
  const findings = capped(
    review.findings
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        required: finding.required,
        blocking: blockingSeverities.includes(finding.severity),
        file: finding.file,
        line: finding.line,
        detail: truncated(finding.detail),
      }))
      // Stable, so findings of one rank keep the reviewer's order.
      .sort(
        (left, right) =>
          Number(!(left.blocking || left.required)) - Number(!(right.blocking || right.required)) ||
          SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
      ),
  );
  const criteria = capped(
    review.acceptance.flatMap((check) =>
      check.status === "verified"
        ? []
        : [{ criterion: check.criterion, status: check.status, detail: truncated(check.evidence) }],
    ),
  );
  const missingEvidence = capped(review.missing_evidence.map(truncated));
  return {
    findings: findings.kept,
    criteria: criteria.kept,
    missingEvidence: missingEvidence.kept,
    omitted: {
      findings: findings.omitted,
      criteria: criteria.omitted,
      missingEvidence: missingEvidence.omitted,
    },
  };
};
