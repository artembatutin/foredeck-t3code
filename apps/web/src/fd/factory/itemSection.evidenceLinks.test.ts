import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryStageRunSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { factoryItemSection } from "./itemSection";

const environmentId = EnvironmentId.make("env-1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const reviewer = ThreadId.make("thread-reviewer");
const ms = (offset: number) => `2026-10-25T09:00:00.${String(offset).padStart(3, "0")}Z`;

const failed: FactoryVerifyReceiptSummary = {
  headSha: HEAD,
  tree: HEAD,
  startedAt: ms(0),
  finishedAt: ms(2),
  code: 1,
  timedOut: false,
  durationMs: 2_000,
};
const blocking: FactoryReviewSummary = {
  headSha: HEAD,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 2 },
  reviewedAt: ms(9),
};

const FAILED_TEXT = "Failed with exit code 1 on 0123456 in 2.0s";
const REVIEW_TEXT = "Changes required, blocking on 0123456: 1 high, 0 medium, 2 low";

/**
 * A verify attempt whose failed receipt finished as it ended and the next verify started, then a
 * review attempt that accepted a blocking review and one started in that same millisecond.
 */
const attempts = (linked: boolean): Array<FactoryStageRunSummary> => [
  {
    stage: "verify",
    attempt: 1,
    outcome: "failed",
    startedAt: ms(0),
    finishedAt: ms(2),
    ...(linked ? { receiptNumber: 1 } : {}),
  },
  { stage: "verify", attempt: 2, outcome: "passed", startedAt: ms(2), finishedAt: ms(3) },
  {
    stage: "review",
    attempt: 1,
    outcome: "failed",
    threadId: reviewer,
    startedAt: ms(3),
    finishedAt: ms(9),
    ...(linked ? { reviewNumber: 1 } : {}),
  },
  { stage: "review", attempt: 2, outcome: null, threadId: reviewer, startedAt: ms(9) },
];

const viewOf = (overrides: Partial<FactoryDelivery>) =>
  factoryItemSection({
    environmentId,
    itemRef,
    supported: true,
    connected: true,
    deliveries: [
      {
        deliveryId: FactoryDeliveryId.make("d1"),
        projectId: ProjectId.make("p1"),
        itemRef,
        childIds: [],
        status: "running",
        stage: { name: "review", kind: "agent" },
        rounds: { fix: 1, review: 1 },
        threads: { reviewer },
        receipts: [],
        reviews: [],
        stageRuns: [],
        createdAt: ms(0),
        updatedAt: ms(9),
        ...overrides,
      },
    ],
    started: null,
    permitted: { start: true, stop: true, resume: true, cancel: true },
  })?.delivery;

/** Each timeline row as `[stage, round, receipt texts, review texts]`. */
const rowsOf = (view: ReturnType<typeof viewOf>) =>
  view?.timeline.map((row) => [
    row.stage,
    row.round,
    row.receipts.map((line) => line.text),
    row.reviews.map((line) => line.text),
  ]);

describe("Factory item section evidence", () => {
  it("puts a linked receipt and review only under the attempts that produced them", () => {
    const view = viewOf({
      receipts: [{ ...failed, number: 1 }],
      reviews: [{ ...blocking, number: 1 }],
      stageRuns: attempts(true),
    });
    expect(rowsOf(view)).toEqual([
      ["Verify", 1, [FAILED_TEXT], []],
      ["Verify", 2, [], []],
      ["Review", 1, [], [REVIEW_TEXT]],
      ["Review", 2, [], []],
    ]);
    expect(view?.receipts).toEqual([]);
    expect(view?.reviews).toEqual([]);
  });

  it("lists unlinked receipts and reviews once for the delivery, under no attempt", () => {
    const view = viewOf({ receipts: [failed], reviews: [blocking], stageRuns: attempts(false) });
    expect(rowsOf(view)).toEqual([
      ["Verify", 1, [], []],
      ["Verify", 2, [], []],
      ["Review", 1, [], []],
      ["Review", 2, [], []],
    ]);
    expect(view?.receipts.map((line) => line.text)).toEqual([FAILED_TEXT]);
    expect(view?.reviews.map((line) => line.text)).toEqual([REVIEW_TEXT]);
  });

  it("lists numbered evidence no attempt names for the delivery too", () => {
    // The server numbered both, but the attempt that produced them is not in the snapshot.
    const view = viewOf({
      receipts: [{ ...failed, number: 1 }],
      reviews: [{ ...blocking, number: 1 }],
      stageRuns: attempts(false).slice(1),
    });
    expect(view?.timeline.flatMap((row) => [...row.receipts, ...row.reviews])).toEqual([]);
    expect(view?.receipts.map((line) => line.text)).toEqual([FAILED_TEXT]);
    expect(view?.reviews.map((line) => line.text)).toEqual([REVIEW_TEXT]);
  });

  it("shows a snapshot without attempts as its current stage holding every line", () => {
    const view = viewOf({ receipts: [failed], reviews: [blocking] });
    expect(rowsOf(view)).toEqual([["Review", null, [FAILED_TEXT], [REVIEW_TEXT]]]);
    expect([view?.receipts, view?.reviews]).toEqual([[], []]);
  });
});
