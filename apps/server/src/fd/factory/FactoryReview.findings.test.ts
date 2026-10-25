import { assert, describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import {
  FACTORY_REVIEW_DETAIL_MAX_LENGTH,
  FACTORY_REVIEW_DETAILS_MAX,
  FactoryDelivery,
  type FactoryDeliveryId,
  type FactoryReview,
  type FactoryReviewDetails,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Factory from "./index.ts";
import { reviewDetails } from "./review/details.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

/** A detail far over the summary's bound, which the reviewer may still submit. */
const longDetail = "The CSV writer never quotes a field, so a comma in a name splits its row. "
  .repeat(30)
  .trim();

const lows = Array.from({ length: 22 }, (_, index) => ({
  id: `low-${index + 1}`,
  severity: "low" as const,
  required: false,
  file: "export.ts",
  line: index + 1,
  detail: `Low finding ${index + 1}.`,
}));

/**
 * More findings than the cap, the pressing ones late in the reviewer's order, one detail over the
 * length bound, a verified, a failed and an untested criterion, and missing evidence.
 */
const crowdedReview = {
  verdict: "changes-required",
  findings: [
    ...lows.slice(0, 10),
    {
      id: "unquoted-fields",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: longDetail,
    },
    ...lows.slice(10),
    {
      id: "no-header",
      severity: "medium",
      required: true,
      file: "export.ts",
      line: null,
      detail: "The export writes no header row.",
    },
    {
      id: "slow-join",
      severity: "high",
      required: false,
      file: "src/join.ts",
      line: 4,
      detail: "Rows are joined in a loop.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export test covers CSV output.",
      paths: ["export.ts"],
    },
    {
      criterion: 2,
      status: "failed",
      evidence: "A comma in a name splits the row.",
      paths: ["export.ts"],
    },
    { criterion: 3, status: "untested", evidence: "Nothing exports an empty table.", paths: [] },
  ],
  missing_evidence: ["A test that exports an empty table."],
} satisfies FactoryReview;

const fenced = (review: unknown) =>
  `I reviewed the export.\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``;

const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    return { threadId: awaiting.threadId, runId: awaiting.runId };
  });

const submitReview = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
    service.submitReview({ threadId, review }),
  ).pipe(Effect.orDie);

const read = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
    service.get(deliveryId).pipe(Effect.map(Option.getOrThrow), Effect.orDie),
  );

const encodeDelivery = Schema.encodeSync(FactoryDelivery);

/** The findings as the reviewer submitted them, as clients see them. */
const asDetail = (finding: (typeof crowdedReview.findings)[number]) => ({
  ...finding,
  blocking: finding.severity === "high",
});

describe("review details of an accepted review", () => {
  it.live.each(["mcp", "fallback"] as const)(
    "keeps a bounded projection of a %s review, counted against its evidence",
    (source) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const { deliveryId } = author;
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            const reviewer = yield* awaitedRun(deliveryId);
            assert.strictEqual(
              yield* runReached(reviewer.runId, ["starting", ...ended]),
              "starting",
            );
            yield* drainOrchestration;

            if (source === "mcp") {
              yield* submitReview(reviewer.threadId, crowdedReview);
            } else {
              const turn =
                world.provider.started.find(({ runId }) => runId === reviewer.runId) ??
                assert.fail("The reviewer's turn did not start.");
              yield* world.provider.say(turn, fenced(crowdedReview));
            }
            yield* world.endRun(reviewer.runId, "completed");

            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.status, "blocked");
            const [accepted] = state.reviews;
            assert.strictEqual(state.reviews.length, 1);
            assert.strictEqual(accepted?.source, source);
            const details = accepted?.details ?? assert.fail("No details were kept.");

            // Blocking and required findings first, by severity, then the reviewer's order.
            const [unquoted, ...rest] = details.findings;
            expect(details.findings).toHaveLength(FACTORY_REVIEW_DETAILS_MAX);
            expect(details.findings.map(({ id }) => id)).toEqual([
              "unquoted-fields",
              "slow-join",
              "no-header",
              ...lows.slice(0, 17).map(({ id }) => id),
            ]);
            expect(details.omitted).toEqual({ findings: 5, criteria: 0, missingEvidence: 0 });
            // Every other kept finding is as the reviewer submitted it.
            const submitted = new Map(
              crowdedReview.findings.map((finding) => [finding.id, finding]),
            );
            expect(rest).toEqual(rest.map(({ id }) => asDetail(submitted.get(id)!)));
            // The long detail is cut to the bound, ending in an ellipsis.
            expect(unquoted?.blocking).toBe(true);
            expect(unquoted?.required).toBe(true);
            expect(unquoted?.detail.length).toBeLessThanOrEqual(FACTORY_REVIEW_DETAIL_MAX_LENGTH);
            expect(unquoted?.detail.endsWith("…")).toBe(true);
            expect(longDetail.startsWith(unquoted?.detail.slice(0, -1) ?? "")).toBe(true);
            expect(unquoted?.detail.length).toBeGreaterThan(FACTORY_REVIEW_DETAIL_MAX_LENGTH - 10);
            // The criteria that block, without their paths, and the missing evidence.
            expect(details.criteria).toEqual([
              { criterion: 2, status: "failed", detail: "A comma in a name splits the row." },
              { criterion: 3, status: "untested", detail: "Nothing exports an empty table." },
            ]);
            expect(details.missingEvidence).toEqual(["A test that exports an empty table."]);

            // Its counts agree with the full review in the evidence file.
            const fileSystem = yield* FileSystem.FileSystem;
            const written = JSON.parse(
              yield* fileSystem.readFileString(accepted?.evidencePath ?? ""),
            ) as { readonly review: FactoryReview };
            const full = written.review;
            expect(full).toEqual(crowdedReview);
            expect(full.findings.length).toBe(details.findings.length + details.omitted.findings);
            expect(accepted?.summary.findings).toEqual({
              high: full.findings.filter(({ severity }) => severity === "high").length,
              medium: full.findings.filter(({ severity }) => severity === "medium").length,
              low: full.findings.filter(({ severity }) => severity === "low").length,
            });
            expect(full.acceptance.filter(({ status }) => status !== "verified")).toHaveLength(
              details.criteria.length + details.omitted.criteria,
            );
            expect(full.missing_evidence).toHaveLength(
              details.missingEvidence.length + details.omitted.missingEvidence,
            );
            // The block keeps the summary's counts only; the details live on the review.
            assert.strictEqual(state.block?.reason, "review_changes_required");
            if (state.block?.reason === "review_changes_required") {
              expect(state.block.summary).not.toHaveProperty("details");
            }

            // Clients get the projection in the review's summary, and no evidence location.
            const snapshot = toFactoryDelivery(yield* read(deliveryId));
            expect(snapshot.reviews.map((review) => review.details)).toEqual([details]);
            const wire = JSON.stringify(encodeDelivery(snapshot));
            expect(wire).not.toContain(world.evidenceDir(deliveryId));
            expect(wire).not.toContain("review-1.json");
            expect(wire).not.toContain('"paths"');
          }),
        { limits: { maxReviewRounds: 0 } },
      ),
  );
});

const review = (overrides: Partial<FactoryReview>): FactoryReview => ({
  verdict: "pass",
  findings: [],
  acceptance: [],
  missing_evidence: [],
  ...overrides,
});

describe("reviewDetails", () => {
  it("keeps nothing for a review that raised nothing", () => {
    const passing = review({
      acceptance: [{ criterion: 1, status: "verified", evidence: "Tested.", paths: [] }],
    });
    expect(reviewDetails(passing, ["high"])).toEqual({
      findings: [],
      criteria: [],
      missingEvidence: [],
      omitted: { findings: 0, criteria: 0, missingEvidence: 0 },
    } satisfies FactoryReviewDetails);
  });

  it("caps the criteria and missing evidence and counts what it left out", () => {
    const details = reviewDetails(
      review({
        verdict: "changes-required",
        acceptance: Array.from({ length: 30 }, (_, index) => ({
          criterion: index + 1,
          status: index % 2 === 0 ? ("untested" as const) : ("failed" as const),
          evidence: `Criterion ${index + 1} has no check.`,
          paths: [],
        })),
        missing_evidence: Array.from({ length: 25 }, (_, index) => `Evidence ${index + 1}.`),
      }),
      ["high"],
    );
    expect(details.criteria.map(({ criterion }) => criterion)).toEqual(
      Array.from({ length: FACTORY_REVIEW_DETAILS_MAX }, (_, index) => index + 1),
    );
    expect(details.missingEvidence.at(-1)).toBe(`Evidence ${FACTORY_REVIEW_DETAILS_MAX}.`);
    expect(details.omitted).toEqual({ findings: 0, criteria: 10, missingEvidence: 5 });
  });

  it("marks findings as blocking by the severities given", () => {
    const finding = (id: string, severity: "high" | "medium" | "low") => ({
      id,
      severity,
      required: false,
      file: "a.ts",
      line: null,
      detail: id,
    });
    const details = reviewDetails(
      review({ findings: [finding("low", "low"), finding("medium", "medium")] }),
      ["medium"],
    );
    expect(details.findings.map(({ id, blocking }) => [id, blocking])).toEqual([
      ["medium", true],
      ["low", false],
    ]);
  });

  it("keeps a detail at the bound whole and never cuts inside a surrogate pair", () => {
    const atBound = "a".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH);
    const pair = `${"a".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH - 2)}😀${"b".repeat(10)}`;
    const details = reviewDetails(review({ missing_evidence: [atBound, `${atBound}b`, pair] }), [
      "high",
    ]);
    const [whole, cut, emoji] = details.missingEvidence;
    expect(whole).toBe(atBound);
    expect(cut).toBe(`${"a".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH - 1)}…`);
    expect(emoji).toBe(`${"a".repeat(FACTORY_REVIEW_DETAIL_MAX_LENGTH - 2)}…`);
  });
});
