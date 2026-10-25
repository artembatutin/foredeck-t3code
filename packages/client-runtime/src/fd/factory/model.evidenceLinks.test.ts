import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryStageRunSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

import { currentDelivery, type FactoryTimeline, factoryTimeline } from "./model.ts";

const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const author = ThreadId.make("author");
const reviewer = ThreadId.make("reviewer");
/** Milliseconds (under 1000) past one instant, so attempts can share a boundary exactly. */
const ms = (offset: number) => `2026-10-25T09:00:00.${String(offset).padStart(3, "0")}Z`;

const delivery = (overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make("d1"),
  projectId: ProjectId.make("p1"),
  itemRef,
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: ms(0),
  updatedAt: ms(0),
  ...overrides,
});

const receipt = (
  finishedAt: number,
  code: number,
  number?: number,
): FactoryVerifyReceiptSummary => ({
  headSha: "a".repeat(40),
  tree: "b".repeat(40),
  startedAt: ms(Math.max(0, finishedAt - 1)),
  finishedAt: ms(finishedAt),
  code,
  timedOut: false,
  durationMs: 1,
  ...(number === undefined ? {} : { number }),
});

const review = (reviewedAt: number, number?: number): FactoryReviewSummary => ({
  headSha: "a".repeat(40),
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 0 },
  reviewedAt: ms(reviewedAt),
  ...(number === undefined ? {} : { number }),
});

const run = (
  stage: FactoryStageRunSummary["stage"],
  attempt: number,
  startedAt: number,
  finishedAt: number | null,
  links: Pick<FactoryStageRunSummary, "receiptNumber" | "reviewNumber"> = {},
): FactoryStageRunSummary => ({
  stage,
  attempt,
  outcome: finishedAt === null ? null : "failed",
  ...(stage === "review" ? { threadId: reviewer } : stage === "verify" ? {} : { threadId: author }),
  startedAt: ms(startedAt),
  ...(finishedAt === null ? {} : { finishedAt: ms(finishedAt) }),
  ...links,
});

/** Each entry as `[stage, round, receipts, reviews]`. */
const placed = (timeline: FactoryTimeline) =>
  timeline.entries.map(({ stage, round, receipts, reviews }) => [stage, round, receipts, reviews]);

/** Asserts every receipt and review of the snapshot is in the timeline exactly once. */
const expectEachOnce = (snapshot: FactoryDelivery, timeline: FactoryTimeline) => {
  const shown = [
    ...timeline.entries.flatMap((entry) => [...entry.receipts, ...entry.reviews]),
    ...timeline.receipts,
    ...timeline.reviews,
  ];
  expect(shown).toHaveLength(snapshot.receipts.length + snapshot.reviews.length);
  for (const piece of [...snapshot.receipts, ...snapshot.reviews]) {
    expect(shown.filter((candidate) => candidate === piece)).toHaveLength(1);
  }
};

describe("evidence on attempts that share a boundary", () => {
  it("shows a failed receipt only under the verify attempt that produced it", () => {
    // Verify 1 ends in the millisecond its receipt finished, and the repair and verify 2 start
    // in that same millisecond.
    const failed = receipt(2, 1, 1);
    const snapshot = delivery({
      stage: { name: "verify", kind: "command" },
      receipts: [failed],
      stageRuns: [
        run("verify", 1, 0, 2, { receiptNumber: 1 }),
        run("repair", 1, 2, 2),
        run("verify", 2, 2, null),
      ],
    });
    const timeline = factoryTimeline(snapshot);
    expect(placed(timeline)).toEqual([
      ["verify", 1, [failed], []],
      ["repair", 1, [], []],
      ["verify", 2, [], []],
    ]);
    expect(timeline.receipts).toEqual([]);
    expectEachOnce(snapshot, timeline);
  });

  it("shows an accepted review once, under the attempt that accepted it", () => {
    const blocking = review(12, 1);
    const snapshot = delivery({
      stage: { name: "review", kind: "agent" },
      receipts: [receipt(5, 0, 1), receipt(12, 0, 2)],
      reviews: [blocking],
      stageRuns: [
        run("verify", 1, 0, 5, { receiptNumber: 1 }),
        run("review", 1, 5, 12, { reviewNumber: 1 }),
        run("repair", 1, 12, 12),
        run("verify", 2, 12, 12, { receiptNumber: 2 }),
        // Active since the instant the first review was accepted.
        run("review", 2, 12, null),
      ],
    });
    const timeline = factoryTimeline(snapshot);
    expect(placed(timeline)).toEqual([
      ["verify", 1, [snapshot.receipts[0]], []],
      ["review", 1, [], [blocking]],
      ["repair", 1, [], []],
      ["verify", 2, [snapshot.receipts[1]], []],
      ["review", 2, [], []],
    ]);
    expect(timeline.reviews).toEqual([]);
    expectEachOnce(snapshot, timeline);
  });
});

describe("evidence the server does not tie to an attempt", () => {
  it("attaches nothing by time when attempts carry no links", () => {
    // Every receipt and review falls inside an attempt's window, and none is named.
    const snapshot = delivery({
      stage: { name: "review", kind: "agent" },
      receipts: [receipt(3, 1), receipt(7, 0, 2)],
      reviews: [review(9), review(10, 1)],
      stageRuns: [
        run("verify", 1, 0, 4),
        run("repair", 1, 4, 5),
        run("verify", 2, 5, 8),
        run("review", 1, 8, null),
      ],
    });
    const timeline = factoryTimeline(snapshot);
    for (const entry of timeline.entries) {
      expect([entry.receipts, entry.reviews]).toEqual([[], []]);
    }
    expect(timeline.receipts).toEqual(snapshot.receipts);
    expect(timeline.reviews).toEqual(snapshot.reviews);
    expectEachOnce(snapshot, timeline);
  });

  it("lists a receipt whose attempt fell off the snapshot's cap for the delivery", () => {
    const truncated = receipt(1, 1, 1);
    const kept = receipt(200, 1, 2);
    // The newest attempts only: the verify that produced receipt 1 is older than all of them.
    const stageRuns = Array.from({ length: FACTORY_SNAPSHOT_STAGE_RUNS_MAX }, (_, index) =>
      index === FACTORY_SNAPSHOT_STAGE_RUNS_MAX - 1
        ? run("verify", 26, 100 + index * 2, 200, { receiptNumber: 2 })
        : run(
            index % 2 === 0 ? "verify" : "repair",
            2 + Math.floor(index / 2),
            100 + index * 2,
            101 + index * 2,
          ),
    );
    const snapshot = delivery({ receipts: [truncated, kept], stageRuns });
    const timeline = factoryTimeline(snapshot);
    expect(timeline.entries).toHaveLength(FACTORY_SNAPSHOT_STAGE_RUNS_MAX);
    expect(timeline.entries.at(-1)?.receipts).toEqual([kept]);
    expect(timeline.entries.slice(0, -1).flatMap((entry) => entry.receipts)).toEqual([]);
    expect(timeline.receipts).toEqual([truncated]);
    expectEachOnce(snapshot, timeline);
  });

  it("attaches a named receipt or review to one attempt only, and a missing one to none", () => {
    const named = receipt(3, 1, 4);
    const snapshot = delivery({
      receipts: [named],
      reviews: [review(8, 2)],
      stageRuns: [
        run("verify", 1, 0, 3, { receiptNumber: 4 }),
        // A second claim on the same receipt, and on a review and receipt the snapshot lacks.
        run("verify", 2, 3, 6, { receiptNumber: 4 }),
        run("review", 1, 6, 9, { reviewNumber: 7 }),
        run("verify", 3, 9, null, { receiptNumber: 9 }),
      ],
    });
    const timeline = factoryTimeline(snapshot);
    expect(placed(timeline)).toEqual([
      ["verify", 1, [named], []],
      ["verify", 2, [], []],
      ["review", 1, [], []],
      ["verify", 3, [], []],
    ]);
    expect(timeline.reviews).toEqual(snapshot.reviews);
    expectEachOnce(snapshot, timeline);
  });

  it("keeps the current-stage fallback for a snapshot without attempts", () => {
    const snapshot = delivery({
      stage: { name: "verify", kind: "command" },
      receipts: [receipt(3, 1, 1)],
      reviews: [review(4)],
    });
    const timeline = factoryTimeline(snapshot);
    expect(placed(timeline)).toEqual([["verify", null, snapshot.receipts, snapshot.reviews]]);
    expect([timeline.receipts, timeline.reviews]).toEqual([[], []]);
    expectEachOnce(snapshot, timeline);

    // Without a stage either, nothing reads as an attempt and the evidence stays listed.
    const unstaged = delivery({ receipts: [receipt(3, 1)] });
    const listed = factoryTimeline(unstaged);
    expect(listed.entries).toEqual([]);
    expectEachOnce(unstaged, listed);
  });
});

describe("currentDelivery ties", () => {
  const at = ms(500);
  const a = (overrides: Partial<FactoryDelivery>) =>
    delivery({ deliveryId: FactoryDeliveryId.make("delivery-a"), createdAt: at, ...overrides });
  const b = (overrides: Partial<FactoryDelivery>) =>
    delivery({ deliveryId: FactoryDeliveryId.make("delivery-b"), createdAt: at, ...overrides });
  const chosen = (deliveries: ReadonlyArray<FactoryDelivery>) =>
    [currentDelivery(deliveries, itemRef), currentDelivery(deliveries.toReversed(), itemRef)].map(
      (current) => current?.deliveryId,
    );

  it("picks the greater id of two ended deliveries created at once, in either order", () => {
    expect(chosen([a({ status: "done" }), b({ status: "cancelled" })])).toEqual([
      "delivery-b",
      "delivery-b",
    ]);
  });

  it("picks the greater id of two open deliveries created at once, in either order", () => {
    // The server allows one open delivery; one it reports in a status this build cannot read
    // still counts as open.
    expect(chosen([a({ status: "running" }), b({ status: "unknown" })])).toEqual([
      "delivery-b",
      "delivery-b",
    ]);
  });

  it("still prefers an open delivery over an ended one, newer or tied", () => {
    expect(chosen([a({ status: "blocked" }), b({ status: "cancelled" })])).toEqual([
      "delivery-a",
      "delivery-a",
    ]);
    expect(chosen([a({ status: "stopped" }), b({ status: "done", createdAt: ms(900) })])).toEqual([
      "delivery-a",
      "delivery-a",
    ]);
  });

  it("still picks the newer of two ended deliveries before comparing ids", () => {
    expect(chosen([a({ status: "done", createdAt: ms(900) }), b({ status: "done" })])).toEqual([
      "delivery-a",
      "delivery-a",
    ]);
  });
});
