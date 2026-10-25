import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

import {
  currentDelivery,
  FACTORY_STATUS_LABELS,
  factoryControls,
  factoryNeedsYou,
  factoryTimeline,
  type FactoryStatus,
  serverFactorySupport,
} from "./model.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const sha = (digit: string) => digit.repeat(40);
const at = (minute: number) => `2026-10-21T09:${String(minute).padStart(2, "0")}:00.000Z`;

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
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

const receipt = (minute: number, code: number): FactoryVerifyReceiptSummary => ({
  headSha: sha("a"),
  tree: sha("b"),
  startedAt: at(minute - 1),
  finishedAt: at(minute),
  code,
  timedOut: false,
  durationMs: 60_000,
});

const review = (minute: number): FactoryReviewSummary => ({
  headSha: sha("a"),
  verdict: "pass",
  blocking: false,
  findings: { high: 0, medium: 0, low: 1 },
  reviewedAt: at(minute),
});

const STATUSES: ReadonlyArray<FactoryStatus> = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "stopping",
  "stopped",
  "approved",
  "pr_open",
  "done",
  "cancelled",
  "unknown",
];

describe("serverFactorySupport", () => {
  it("reads the advertised Factory and hides it otherwise", () => {
    const config = (factory?: { version: number }) => ({
      environment: { capabilities: factory === undefined ? {} : { factory } },
    });
    // The cast narrows the environment descriptor to the capabilities support reads.
    const support = (value: ReturnType<typeof config> | null | undefined) =>
      serverFactorySupport(value as Parameters<typeof serverFactorySupport>[0]);
    expect(support(config({ version: 1 }))).toEqual({ version: 1 });
    expect(support(config({ version: 2 }))).toBeUndefined();
    expect(support(config())).toBeUndefined();
    expect(support(null)).toBeUndefined();
    expect(support(undefined)).toBeUndefined();
  });
});

describe("status label and needs-you", () => {
  it.each(STATUSES)("labels %s", (status) => {
    expect(FACTORY_STATUS_LABELS[status]).toMatch(/\S/);
  });

  it("gives every status its own label", () => {
    expect(new Set(STATUSES.map((status) => FACTORY_STATUS_LABELS[status])).size).toBe(
      STATUSES.length,
    );
  });

  const needing = new Set<FactoryStatus>(["blocked", "waiting"]);
  it.each(STATUSES)("needs you only when blocked or waiting: %s", (status) => {
    const withReason = factoryNeedsYou({
      status,
      needsYou: "Verify failed with no fix round left.",
    });
    const withoutReason = factoryNeedsYou({ status });
    const blankReason = factoryNeedsYou({ status, needsYou: "  " });
    if (needing.has(status)) {
      expect(withReason).toBe("Verify failed with no fix round left.");
      expect(withoutReason).toMatch(/\S/);
      expect(blankReason).toBe(withoutReason);
    } else {
      expect(withReason).toBeUndefined();
      expect(withoutReason).toBeUndefined();
      expect(blankReason).toBeUndefined();
    }
  });

  it("falls back to fixed text per status", () => {
    expect(factoryNeedsYou({ status: "blocked" })).toBe("Factory blocked this delivery.");
    expect(factoryNeedsYou({ status: "waiting" })).toBe("Factory is waiting for your decision.");
  });
});

describe("factoryControls", () => {
  const expected: Record<FactoryStatus, [stop: boolean, resume: boolean, cancel: boolean]> = {
    queued: [false, false, true],
    running: [true, false, true],
    waiting: [false, false, true],
    blocked: [false, true, true],
    stopping: [false, true, true],
    stopped: [false, true, true],
    approved: [false, false, true],
    pr_open: [false, false, true],
    done: [false, false, false],
    cancelled: [false, false, false],
    unknown: [false, false, false],
  };
  it.each(STATUSES)("follows the engine for %s", (status) => {
    const [stop, resume, cancel] = expected[status];
    expect(factoryControls({ status })).toEqual({ stop, resume, cancel });
    expect(factoryControls({ status, stage: { name: "verify", kind: "command" } })).toEqual({
      stop,
      resume,
      cancel,
    });
  });

  it.each(STATUSES)(
    "offers nothing for a %s delivery at a stage this build cannot read",
    (status) => {
      const none = { stop: false, resume: false, cancel: false };
      expect(factoryControls({ status, stage: { name: "unknown", kind: "agent" } })).toEqual(none);
      expect(factoryControls({ status, stage: { name: "review", kind: "unknown" } })).toEqual(none);
    },
  );
});

describe("currentDelivery", () => {
  const otherItem = { sourceId, itemId: WorkItemId.make("fd-other") };

  it("prefers the active delivery over newer terminal ones", () => {
    const active = delivery({ deliveryId: FactoryDeliveryId.make("active"), createdAt: at(10) });
    const deliveries = [
      delivery({
        deliveryId: FactoryDeliveryId.make("other"),
        itemRef: otherItem,
        createdAt: at(30),
      }),
      delivery({
        deliveryId: FactoryDeliveryId.make("newer-cancelled"),
        status: "cancelled",
        createdAt: at(20),
      }),
      active,
      delivery({
        deliveryId: FactoryDeliveryId.make("old-done"),
        status: "done",
        createdAt: at(1),
      }),
    ];
    expect(currentDelivery(deliveries, itemRef)?.deliveryId).toBe("active");
    expect(currentDelivery(deliveries.toReversed(), itemRef)?.deliveryId).toBe("active");
  });

  it("falls back to the newest when every delivery ended", () => {
    const deliveries = [
      delivery({ deliveryId: FactoryDeliveryId.make("first"), status: "done", createdAt: at(1) }),
      delivery({
        deliveryId: FactoryDeliveryId.make("newest"),
        status: "cancelled",
        createdAt: at(9),
      }),
      delivery({
        deliveryId: FactoryDeliveryId.make("middle"),
        status: "cancelled",
        createdAt: at(5),
      }),
    ];
    expect(currentDelivery(deliveries, itemRef)?.deliveryId).toBe("newest");
  });

  it("has none without the item's deliveries", () => {
    expect(currentDelivery([], itemRef)).toBeUndefined();
    expect(currentDelivery([delivery({ itemRef: otherItem })], itemRef)).toBeUndefined();
  });
});

describe("factoryTimeline", () => {
  const author = ThreadId.make("author");
  const reviewer = ThreadId.make("reviewer");

  it("places each receipt and review on the attempt it was recorded in", () => {
    const failed = receipt(12, 1);
    const passed = receipt(22, 0);
    const accepted = review(27);
    const timeline = factoryTimeline(
      delivery({
        // An older receipt and review than the snapshot's attempts belong to no attempt.
        receipts: [receipt(0, 0), failed, passed],
        reviews: [review(0), accepted],
        stageRuns: [
          // Out of order on purpose: the timeline follows start times.
          {
            stage: "verify",
            attempt: 2,
            outcome: "passed",
            startedAt: at(20),
            finishedAt: at(23),
          },
          {
            stage: "author",
            attempt: 1,
            outcome: "passed",
            threadId: author,
            startedAt: at(1),
            finishedAt: at(10),
          },
          {
            stage: "verify",
            attempt: 1,
            outcome: "failed",
            startedAt: at(10),
            finishedAt: at(13),
          },
          {
            stage: "repair",
            attempt: 1,
            outcome: "passed",
            threadId: author,
            startedAt: at(13),
            finishedAt: at(20),
          },
          {
            stage: "review",
            attempt: 1,
            outcome: "passed",
            threadId: reviewer,
            startedAt: at(23),
            finishedAt: at(29),
          },
          { stage: "record", attempt: 1, outcome: null, startedAt: at(29) },
        ],
      }),
    );
    expect(
      timeline.map(({ stage, round, outcome, threadId, receipts, reviews }) => ({
        stage,
        round,
        outcome,
        threadId,
        receipts,
        reviews,
      })),
    ).toEqual([
      {
        stage: "author",
        round: 1,
        outcome: "passed",
        threadId: author,
        receipts: [],
        reviews: [],
      },
      {
        stage: "verify",
        round: 1,
        outcome: "failed",
        threadId: undefined,
        receipts: [failed],
        reviews: [],
      },
      {
        stage: "repair",
        round: 1,
        outcome: "passed",
        threadId: author,
        receipts: [],
        reviews: [],
      },
      {
        stage: "verify",
        round: 2,
        outcome: "passed",
        threadId: undefined,
        receipts: [passed],
        reviews: [],
      },
      {
        stage: "review",
        round: 1,
        outcome: "passed",
        threadId: reviewer,
        receipts: [],
        reviews: [accepted],
      },
      {
        stage: "record",
        round: 1,
        outcome: null,
        threadId: undefined,
        receipts: [],
        reviews: [],
      },
    ]);
    expect(timeline.at(-1)?.finishedAt).toBeUndefined();
  });

  it("gives an active attempt what was recorded since it started", () => {
    const submitted = review(31);
    const [entry] = factoryTimeline(
      delivery({
        reviews: [submitted],
        stageRuns: [
          { stage: "review", attempt: 2, outcome: null, threadId: reviewer, startedAt: at(30) },
        ],
      }),
    );
    expect(entry).toMatchObject({ stage: "review", round: 2, outcome: null, reviews: [submitted] });
  });

  it("reads an old server's snapshot as its current stage with every receipt and review", () => {
    const receipts = [receipt(12, 1), receipt(22, 0)];
    const reviews = [review(27)];
    expect(
      factoryTimeline(delivery({ stage: { name: "review", kind: "agent" }, receipts, reviews })),
    ).toEqual([
      {
        stage: "review",
        round: null,
        outcome: null,
        threadId: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        receipts,
        reviews,
      },
    ]);
    expect(factoryTimeline(delivery({ status: "queued" }))).toEqual([]);
  });
});
