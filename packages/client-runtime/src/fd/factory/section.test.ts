import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

import {
  cancelConfirmationTarget,
  type FactoryControlPermissions,
  factoryDeliveryView,
} from "./section.ts";

const environmentId = EnvironmentId.make("env-1");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const otherRef = { sourceId, itemId: WorkItemId.make("fd-9x1zz0") };
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId: ProjectId.make("p1"),
  itemRef,
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
  ...overrides,
});

const ALLOWED: FactoryControlPermissions = { stop: true, resume: true, cancel: true };
const NONE = { stop: false, resume: false, cancel: false };

const view = (overrides: Partial<Parameters<typeof factoryDeliveryView>[0]> = {}) =>
  factoryDeliveryView({
    environmentId,
    itemRef,
    supported: true,
    connected: true,
    deliveries: [],
    permitted: ALLOWED,
    ...overrides,
  });

const receipt = (
  finishedAt: string,
  code: number | null,
  number?: number,
): FactoryVerifyReceiptSummary => ({
  headSha: HEAD,
  tree: HEAD,
  startedAt: finishedAt,
  finishedAt,
  code,
  timedOut: false,
  durationMs: 65_000,
  ...(number === undefined ? {} : { number }),
});

const review = (overrides: Partial<FactoryReviewSummary> = {}): FactoryReviewSummary => ({
  headSha: HEAD,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 2, low: 0 },
  reviewedAt: "2026-10-21T09:30:00.000Z",
  number: 1,
  ...overrides,
});

describe("factoryDeliveryView", () => {
  it("shows nothing without Factory, before deliveries load, or for an item with no delivery", () => {
    const blocked = [delivery("d1", { status: "blocked" })];
    expect(view({ supported: false, deliveries: blocked })).toBeNull();
    expect(view({ deliveries: null })).toBeNull();
    expect(view()).toBeNull();
    // Another item's delivery is not this item's.
    expect(view({ deliveries: [delivery("d1", { itemRef: otherRef })] })).toBeNull();
  });

  it("reads an open delivery's label, needs-you reason, stage, branch and rounds", () => {
    expect(
      view({
        deliveries: [
          delivery("d1", {
            status: "blocked",
            needsYou: "Verify failed twice on the same tree.",
            stage: { name: "verify", kind: "command" },
            branch: "fd-7k3qa2-ship",
            rounds: { fix: 2, review: 0 },
          }),
        ],
      }),
    ).toMatchObject({
      deliveryId: "d1",
      label: "Blocked",
      needsYou: "Verify failed twice on the same tree.",
      stage: "Verify",
      branch: "fd-7k3qa2-ship",
      rounds: { fix: 2, review: 0 },
      controls: { stop: false, resume: true, cancel: true },
    });
    expect(view({ deliveries: [delivery("d1", { status: "blocked" })] })?.needsYou).toBe(
      "Factory blocked this delivery.",
    );
    expect(view({ deliveries: [delivery("d1")] })?.needsYou).toBeUndefined();
  });

  it("shows a slot wait beside the status, which is not a reason it needs you", () => {
    const waiting = view({ deliveries: [delivery("d1", { capacityWait: true })] });
    expect(waiting).toMatchObject({
      label: "Running",
      capacityNote: "Waiting for a project assistant slot",
      needsYou: undefined,
      controls: { stop: true, resume: false, cancel: true },
    });
    expect(view({ deliveries: [delivery("d1")] })?.capacityNote).toBeUndefined();
  });

  it("shows the newest of a terminal history, with nothing to control", () => {
    const history = view({
      deliveries: [
        delivery("d1", { status: "done", createdAt: "2026-10-21T09:00:00.000Z" }),
        delivery("d2", { status: "cancelled", createdAt: "2026-10-22T09:00:00.000Z" }),
      ],
    });
    expect(history).toMatchObject({ deliveryId: "d2", label: "Cancelled", controls: NONE });
    // An open delivery wins over a newer terminal one.
    expect(
      view({
        deliveries: [
          delivery("d2", { status: "running", createdAt: "2026-10-21T08:00:00.000Z" }),
          delivery("d1", { status: "cancelled", createdAt: "2026-10-21T10:00:00.000Z" }),
        ],
      })?.deliveryId,
    ).toBe("d2");
  });

  it("shows a just-started delivery before any attempt", () => {
    expect(view({ deliveries: [delivery("d3", { status: "queued" })] })).toEqual({
      deliveryId: "d3",
      family: "single",
      label: "Queued",
      needsYou: undefined,
      stage: undefined,
      rounds: { fix: 0, review: 0 },
      branch: undefined,
      controls: { stop: false, resume: false, cancel: true },
      timeline: [],
      receipts: [],
      reviews: [],
    });
  });

  it("lists attempts with rounds, receipts, reviews and each thread on the delivery's environment", () => {
    const current = view({
      deliveries: [
        delivery("d1", {
          stageRuns: [
            {
              stage: "author",
              attempt: 1,
              outcome: "passed",
              threadId: author,
              startedAt: "2026-10-21T09:00:00.000Z",
              finishedAt: "2026-10-21T09:10:00.000Z",
            },
            {
              stage: "verify",
              attempt: 1,
              outcome: "failed",
              startedAt: "2026-10-21T09:11:00.000Z",
              finishedAt: "2026-10-21T09:13:00.000Z",
              receiptNumber: 1,
            },
            {
              stage: "verify",
              attempt: 2,
              outcome: "passed",
              startedAt: "2026-10-21T09:21:00.000Z",
              finishedAt: "2026-10-21T09:23:00.000Z",
              receiptNumber: 2,
            },
            {
              stage: "review",
              attempt: 1,
              outcome: "failed",
              threadId: reviewer,
              startedAt: "2026-10-21T09:24:00.000Z",
              finishedAt: "2026-10-21T09:31:00.000Z",
              reviewNumber: 1,
            },
            {
              stage: "review",
              attempt: 2,
              outcome: null,
              threadId: reviewer,
              startedAt: "2026-10-21T09:40:00.000Z",
            },
          ],
          receipts: [
            receipt("2026-10-21T09:12:00.000Z", 1, 1),
            receipt("2026-10-21T09:22:00.000Z", 0, 2),
          ],
          reviews: [
            review(),
            // Accepted while its attempt is still active, so no attempt names it yet.
            review({
              verdict: "pass",
              blocking: false,
              findings: { high: 0, medium: 0, low: 1 },
              reviewedAt: "2026-10-21T09:45:00.000Z",
              number: 2,
            }),
          ],
        }),
      ],
    });
    expect(
      current?.timeline.map(({ key: _key, ...row }) => ({
        ...row,
        receipts: row.receipts.map((line) => line.text),
        reviews: row.reviews.map((line) => line.text),
      })),
    ).toEqual([
      {
        stage: "Author",
        round: 1,
        outcome: "Passed",
        startedAt: "2026-10-21T09:00:00.000Z",
        receipts: [],
        reviews: [],
        thread: { environmentId, threadId: author },
      },
      {
        stage: "Verify",
        round: 1,
        outcome: "Failed",
        startedAt: "2026-10-21T09:11:00.000Z",
        receipts: ["Failed with exit code 1 on 0123456 in 1m 5s"],
        reviews: [],
        thread: null,
      },
      {
        stage: "Verify",
        round: 2,
        outcome: "Passed",
        startedAt: "2026-10-21T09:21:00.000Z",
        receipts: ["Passed on 0123456 in 1m 5s"],
        reviews: [],
        thread: null,
      },
      {
        stage: "Review",
        round: 1,
        outcome: "Failed",
        startedAt: "2026-10-21T09:24:00.000Z",
        receipts: [],
        reviews: ["Changes required, blocking on 0123456: 1 high, 2 medium, 0 low"],
        thread: { environmentId, threadId: reviewer },
      },
      {
        stage: "Review",
        round: 2,
        outcome: "In progress",
        startedAt: "2026-10-21T09:40:00.000Z",
        receipts: [],
        reviews: [],
        thread: { environmentId, threadId: reviewer },
      },
    ]);
    expect(current?.receipts).toEqual([]);
    expect(current?.reviews.map((line) => line.text)).toEqual([
      "Pass on 0123456: 0 high, 0 medium, 1 low",
    ]);
    const keys = current?.timeline.map((row) => row.key) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reads a snapshot without attempts as its current stage holding every receipt", () => {
    expect(
      view({
        deliveries: [
          delivery("d1", {
            stage: { name: "verify", kind: "command" },
            receipts: [{ ...receipt("2026-10-21T09:12:00.000Z", null), timedOut: true }],
          }),
        ],
      })?.timeline,
    ).toMatchObject([
      {
        stage: "Verify",
        round: null,
        outcome: "Current stage",
        receipts: [{ text: "Timed out on 0123456 in 1m 5s" }],
        thread: null,
      },
    ]);
    expect(
      view({
        deliveries: [delivery("d1", { receipts: [receipt("2026-10-21T09:12:00.000Z", null)] })],
      })?.receipts.map((line) => line.text),
    ).toEqual(["Ended without an exit code on 0123456 in 1m 5s"]);
  });

  it("lists what a review raised as plain finding lines, with what the server left out", () => {
    const lines = view({
      deliveries: [
        delivery("d1", {
          reviews: [
            review({
              details: {
                findings: [
                  {
                    id: "no-header",
                    severity: "high",
                    required: true,
                    blocking: true,
                    file: "src/export.ts",
                    line: 12,
                    detail: "The export writes no header row.",
                  },
                  {
                    id: "slow-join",
                    severity: "medium",
                    required: false,
                    blocking: false,
                    file: "src/query.ts",
                    line: null,
                    detail: "<b>joins</b> every row",
                  },
                ],
                criteria: [{ criterion: 2, status: "failed", detail: "A comma splits the row." }],
                missingEvidence: ["No test exports an empty table."],
                omitted: { findings: 4, criteria: 0, missingEvidence: 1 },
              },
            }),
          ],
        }),
      ],
    })?.reviews;
    expect(lines).toEqual([
      {
        key: `2026-10-21T09:30:00.000Z:${HEAD}`,
        text: "Changes required, blocking on 0123456: 1 high, 2 medium, 0 low",
        notes: [
          {
            key: "finding:no-header",
            label: "High",
            required: true,
            blocking: true,
            location: "src/export.ts:12",
            detail: "The export writes no header row.",
          },
          {
            key: "finding:slow-join",
            label: "Medium",
            required: false,
            blocking: false,
            location: "src/query.ts",
            detail: "<b>joins</b> every row",
          },
          {
            key: "criterion:2",
            label: "Criterion 2 failed",
            required: false,
            blocking: true,
            location: undefined,
            detail: "A comma splits the row.",
          },
          {
            key: "missing:0",
            label: "Missing evidence",
            required: false,
            blocking: true,
            location: undefined,
            detail: "No test exports an empty table.",
          },
        ],
        omitted: "Not shown: 4 more findings and 1 more missing evidence entry.",
      },
    ]);
  });
});

describe("gated controls", () => {
  const controlsOf = (
    status: FactoryDelivery["status"],
    overrides: Partial<Parameters<typeof factoryDeliveryView>[0]> = {},
  ) => view({ deliveries: [delivery("d1", { status })], ...overrides })?.controls;

  it.each([
    ["running", { stop: true, resume: false, cancel: true }],
    ["stopping", { stop: false, resume: true, cancel: true }],
    ["stopped", { stop: false, resume: true, cancel: true }],
    ["blocked", { stop: false, resume: true, cancel: true }],
    ["queued", { stop: false, resume: false, cancel: true }],
    ["waiting", { stop: false, resume: false, cancel: true }],
    ["approved", { stop: false, resume: false, cancel: true }],
    ["pr_open", { stop: false, resume: false, cancel: true }],
    ["done", NONE],
    ["cancelled", NONE],
    ["unknown", NONE],
  ] as const)("a %s delivery offers %o", (status, expected) => {
    expect(controlsOf(status)).toEqual(expected);
  });

  it("offers a control only with its grant and a live connection", () => {
    expect(controlsOf("running", { permitted: { ...ALLOWED, stop: false } })).toEqual({
      stop: false,
      resume: false,
      cancel: true,
    });
    expect(controlsOf("blocked", { permitted: { ...ALLOWED, resume: false } })).toEqual({
      stop: false,
      resume: false,
      cancel: true,
    });
    expect(controlsOf("stopped", { permitted: { ...ALLOWED, cancel: false } })).toEqual({
      stop: false,
      resume: true,
      cancel: false,
    });
    expect(controlsOf("blocked", { connected: false })).toEqual(NONE);
  });

  it("offers nothing at a current stage this build cannot read", () => {
    const at = (stage: NonNullable<FactoryDelivery["stage"]>) =>
      view({ deliveries: [delivery("d1", { stage })] })?.controls;
    expect(at({ name: "verify", kind: "command" })).toEqual({
      stop: true,
      resume: false,
      cancel: true,
    });
    expect(at({ name: "unknown", kind: "command" })).toEqual(NONE);
    expect(at({ name: "verify", kind: "unknown" })).toEqual(NONE);
  });
});

describe("cancelConfirmationTarget", () => {
  const a = FactoryDeliveryId.make("delivery-a");

  it("cancels the delivery it was opened for while that is current and cancellable", () => {
    const current = view({ deliveries: [delivery("delivery-a")] });
    expect(cancelConfirmationTarget(current, a)).toBe(a);
    expect(cancelConfirmationTarget(current, null)).toBeNull();
  });

  it("cancels nothing once the delivery was replaced, ended, or the grant or connection went", () => {
    const replaced = view({
      deliveries: [
        delivery("delivery-b", { createdAt: "2026-10-21T10:00:00.000Z" }),
        delivery("delivery-a", { status: "cancelled" }),
      ],
    });
    expect(replaced?.controls.cancel).toBe(true);
    expect(cancelConfirmationTarget(replaced, a)).toBeNull();
    expect(
      cancelConfirmationTarget(
        view({ deliveries: [delivery("delivery-a", { status: "done" })] }),
        a,
      ),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(
        view({ deliveries: [delivery("delivery-a")], permitted: { ...ALLOWED, cancel: false } }),
        a,
      ),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(view({ deliveries: [delivery("delivery-a")], connected: false }), a),
    ).toBeNull();
    expect(cancelConfirmationTarget(null, a)).toBeNull();
  });
});
