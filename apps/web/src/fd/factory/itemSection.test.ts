import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { factoryDeliverable } from "./deliver";
import {
  cancelConfirmationTarget,
  type FactoryItemPermissions,
  factoryItemSection,
} from "./itemSection";

const environmentId = EnvironmentId.make("env-1");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const otherRef = { sourceId, itemId: WorkItemId.make("fd-9x1zz0") };
const HEAD = "0123456789abcdef0123456789abcdef01234567";

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

const ALLOWED: FactoryItemPermissions = { start: true, stop: true, resume: true, cancel: true };
const DENIED: FactoryItemPermissions = { start: false, stop: false, resume: false, cancel: false };

const section = (
  overrides: Partial<Parameters<typeof factoryItemSection>[0]> = {},
): ReturnType<typeof factoryItemSection> =>
  factoryItemSection({
    environmentId,
    itemRef,
    supported: true,
    connected: true,
    deliveries: [],
    started: [],
    permitted: ALLOWED,
    ...overrides,
  });

const OPEN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "stopping",
  "stopped",
  "approved",
  "pr_open",
  "unknown",
] as const;

describe("Deliver", () => {
  it("is offered for an item without deliveries where Factory is served and start is permitted", () => {
    expect(section()).toEqual({ deliver: true, delivery: null });
    // Another item's open delivery does not reserve this one.
    expect(section({ deliveries: [delivery("d1", { itemRef: otherRef })] })).toEqual({
      deliver: true,
      delivery: null,
    });
  });

  it("shows nothing on a server without Factory, whatever the item has", () => {
    expect(section({ supported: false })).toBeNull();
    expect(
      section({ supported: false, deliveries: [delivery("d1", { status: "blocked" })] }),
    ).toBeNull();
  });

  it("waits for the project's deliveries before offering anything", () => {
    expect(section({ deliveries: null })).toBeNull();
  });

  it("is not offered to a session that may not start deliveries", () => {
    expect(section({ permitted: { ...ALLOWED, start: false } })).toBeNull();
    // The item's last delivery still shows, without Deliver.
    const done = section({
      permitted: { ...ALLOWED, start: false },
      deliveries: [delivery("d1", { status: "done" })],
    });
    expect(done?.deliver).toBe(false);
    expect(done?.delivery?.label).toBe("Done");
  });

  it.each(OPEN_STATUSES)("is not offered while the item has a %s delivery", (status) => {
    const view = section({
      deliveries: [
        delivery("d2", { status, createdAt: "2026-10-21T08:00:00.000Z" }),
        delivery("d1", { status: "cancelled", createdAt: "2026-10-21T10:00:00.000Z" }),
      ],
    });
    expect(view?.deliver).toBe(false);
    expect(view?.delivery?.deliveryId).toBe("d2");
  });

  it("is offered again once every delivery of the item is done or cancelled", () => {
    const view = section({
      deliveries: [
        delivery("d2", { status: "cancelled", createdAt: "2026-10-22T09:00:00.000Z" }),
        delivery("d1", { status: "done", createdAt: "2026-10-21T09:00:00.000Z" }),
      ],
    });
    expect(view?.deliver).toBe(true);
    expect(view?.delivery).toMatchObject({ deliveryId: "d2", label: "Cancelled" });
  });

  it("counts a delivery the start returned until the list holds it", () => {
    const started = [{ environmentId, delivery: delivery("d3", { status: "queued" }) }];
    expect(section({ started })).toMatchObject({
      deliver: false,
      delivery: { deliveryId: "d3", label: "Queued" },
    });
    // The list's copy wins once it arrives.
    expect(
      section({ started, deliveries: [delivery("d3", { status: "cancelled" })] }),
    ).toMatchObject({ deliver: true, delivery: { deliveryId: "d3", label: "Cancelled" } });
  });

  it("follows the shared Deliver rule for the same inputs", () => {
    const histories = [
      null,
      [],
      [delivery("d1", { status: "running" })],
      [delivery("d1", { status: "unknown" })],
      [delivery("d1", { status: "done" }), delivery("d2", { status: "cancelled" })],
    ];
    const starts = [[], [{ environmentId, delivery: delivery("d9", { status: "queued" }) }]];
    for (const supported of [true, false]) {
      for (const connected of [true, false]) {
        for (const start of [true, false]) {
          for (const deliveries of histories) {
            for (const started of starts) {
              const permitted = { ...ALLOWED, start };
              const inputs = { supported, connected, deliveries, started, permitted };
              expect(section(inputs)?.deliver ?? false).toBe(
                factoryDeliverable({
                  environmentId,
                  itemRef,
                  supported,
                  connected,
                  startPermitted: start,
                  deliveries,
                  started,
                }),
              );
            }
          }
        }
      }
    }
  });
});

describe("the current delivery", () => {
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
  const review: FactoryReviewSummary = {
    headSha: HEAD,
    verdict: "changes-required",
    blocking: true,
    findings: { high: 1, medium: 2, low: 0 },
    reviewedAt: "2026-10-21T09:30:00.000Z",
    number: 1,
  };
  const author = ThreadId.make("thread-author");
  const reviewer = ThreadId.make("thread-reviewer");

  it("reads its label, needs-you reason and stage from the shared models", () => {
    expect(
      section({
        deliveries: [
          delivery("d1", {
            status: "blocked",
            needsYou: "Verify failed twice on the same tree.",
            stage: { name: "verify", kind: "command" },
            branch: "fd-7k3qa2-ship",
            rounds: { fix: 2, review: 0 },
          }),
        ],
      })?.delivery,
    ).toMatchObject({
      label: "Blocked",
      needsYou: "Verify failed twice on the same tree.",
      stage: "Verify",
      branch: "fd-7k3qa2-ship",
      rounds: { fix: 2, review: 0 },
    });
    // A blocked delivery without the server's reason still needs its owner; a running one does not.
    expect(
      section({ deliveries: [delivery("d1", { status: "blocked" })] })?.delivery?.needsYou,
    ).toBe("Factory blocked this delivery.");
    expect(section()?.delivery).toBeNull();
    expect(section({ deliveries: [delivery("d1")] })?.delivery?.needsYou).toBeUndefined();
  });

  it("lists its attempts with rounds, receipts, review counts and each thread's route", () => {
    const view = section({
      deliveries: [
        delivery("d1", {
          status: "running",
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
              stage: "repair",
              attempt: 1,
              outcome: "passed",
              threadId: author,
              startedAt: "2026-10-21T09:14:00.000Z",
              finishedAt: "2026-10-21T09:20:00.000Z",
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
              outcome: null,
              threadId: reviewer,
              startedAt: "2026-10-21T09:24:00.000Z",
            },
          ],
          receipts: [
            receipt("2026-10-21T09:12:00.000Z", 1, 1),
            receipt("2026-10-21T09:22:00.000Z", 0, 2),
          ],
          // Accepted while its attempt is still active, so no attempt names it yet.
          reviews: [review],
        }),
      ],
    });
    expect(
      view?.delivery?.timeline.map(({ key: _key, ...row }) => ({
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
        stage: "Repair",
        round: 1,
        outcome: "Passed",
        startedAt: "2026-10-21T09:14:00.000Z",
        receipts: [],
        reviews: [],
        thread: { environmentId, threadId: author },
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
        outcome: "In progress",
        startedAt: "2026-10-21T09:24:00.000Z",
        receipts: [],
        reviews: [],
        thread: { environmentId, threadId: reviewer },
      },
    ]);
    expect(view?.delivery?.receipts).toEqual([]);
    expect(view?.delivery?.reviews.map((line) => line.text)).toEqual([
      "Changes required, blocking on 0123456: 1 high, 2 medium, 0 low",
    ]);
    const keys = view?.delivery?.timeline.map((row) => row.key) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect(view?.delivery?.timeline[1]?.receipts[0]?.key).not.toBe(
      view?.delivery?.timeline[3]?.receipts[0]?.key,
    );
  });

  it("reads a snapshot without attempts as its current stage holding every receipt", () => {
    const view = section({
      deliveries: [
        delivery("d1", {
          stage: { name: "verify", kind: "command" },
          receipts: [{ ...receipt("2026-10-21T09:12:00.000Z", null), timedOut: true }],
        }),
      ],
    });
    expect(view?.delivery?.timeline).toMatchObject([
      {
        stage: "Verify",
        round: null,
        outcome: "Current stage",
        receipts: [{ text: "Timed out on 0123456 in 1m 5s" }],
        thread: null,
      },
    ]);
  });
});

describe("controls", () => {
  const controlsOf = (status: FactoryDelivery["status"], permitted = ALLOWED) =>
    section({ deliveries: [delivery("d1", { status })], permitted })?.delivery?.controls;

  it.each([
    ["running", { stop: true, resume: false, cancel: true }],
    ["stopping", { stop: false, resume: true, cancel: true }],
    ["stopped", { stop: false, resume: true, cancel: true }],
    ["blocked", { stop: false, resume: true, cancel: true }],
    ["queued", { stop: false, resume: false, cancel: true }],
    ["waiting", { stop: false, resume: false, cancel: true }],
    ["approved", { stop: false, resume: false, cancel: true }],
    ["pr_open", { stop: false, resume: false, cancel: true }],
    ["done", { stop: false, resume: false, cancel: false }],
    ["cancelled", { stop: false, resume: false, cancel: false }],
    ["unknown", { stop: false, resume: false, cancel: false }],
  ] as const)("a %s delivery offers %o", (status, expected) => {
    expect(controlsOf(status)).toEqual(expected);
  });

  it("offers a control only where its command is permitted", () => {
    expect(controlsOf("running", { ...ALLOWED, stop: false })).toEqual({
      stop: false,
      resume: false,
      cancel: true,
    });
    expect(controlsOf("blocked", { ...ALLOWED, resume: false })).toEqual({
      stop: false,
      resume: false,
      cancel: true,
    });
    expect(controlsOf("stopped", { ...ALLOWED, cancel: false })).toEqual({
      stop: false,
      resume: true,
      cancel: false,
    });
    expect(controlsOf("running", DENIED)).toEqual({ stop: false, resume: false, cancel: false });
  });

  it("offers nothing at a current stage this build cannot read", () => {
    const none = { stop: false, resume: false, cancel: false };
    const at = (stage: NonNullable<FactoryDelivery["stage"]>) =>
      section({ deliveries: [delivery("d1", { status: "running", stage })] })?.delivery?.controls;
    expect(at({ name: "verify", kind: "command" })).toEqual({
      stop: true,
      resume: false,
      cancel: true,
    });
    expect(at({ name: "unknown", kind: "command" })).toEqual(none);
    expect(at({ name: "verify", kind: "unknown" })).toEqual(none);
  });

  it("offers nothing while the environment reconnects, and still shows the delivery", () => {
    const deliveries = [
      delivery("d1", { status: "blocked", needsYou: "Review found a high finding." }),
    ];
    expect(section({ deliveries })?.delivery?.controls).toEqual({
      stop: false,
      resume: true,
      cancel: true,
    });
    // Connected, then in a reconnect's backoff with the deliveries read before.
    expect(section({ deliveries, connected: false })).toMatchObject({
      deliver: false,
      delivery: {
        label: "Blocked",
        needsYou: "Review found a high finding.",
        controls: { stop: false, resume: false, cancel: false },
      },
    });
    // Deliver waits for the connection too.
    expect(section({ connected: false })).toBeNull();
    expect(
      section({ connected: false, deliveries: [delivery("d1", { status: "done" })] })?.deliver,
    ).toBe(false);
  });
});

describe("cancelConfirmationTarget", () => {
  const a = FactoryDeliveryId.make("delivery-a");
  // A's confirmation as opened, saying what cancelling a single delivery ends.
  const openedForA = { deliveryId: a, family: "single" } as const;
  const running = (id: string, overrides: Partial<FactoryDelivery> = {}) =>
    section({ deliveries: [delivery(id, overrides)] });

  it("cancels the delivery the confirmation was opened for while it still offers cancel", () => {
    expect(cancelConfirmationTarget(running("delivery-a"), openedForA)).toBe(a);
    expect(cancelConfirmationTarget(running("delivery-a"), null)).toBeNull();
  });

  it("closes when another delivery replaced it", () => {
    // Another client cancelled delivery A and started B while A's confirmation was open.
    const replaced = section({
      deliveries: [
        delivery("delivery-b", { createdAt: "2026-10-21T10:00:00.000Z" }),
        delivery("delivery-a", { status: "cancelled" }),
      ],
    });
    expect(replaced?.delivery?.deliveryId).toBe("delivery-b");
    expect(replaced?.delivery?.controls.cancel).toBe(true);
    expect(cancelConfirmationTarget(replaced, openedForA)).toBeNull();
  });

  it("closes when the delivery can no longer be cancelled", () => {
    expect(
      cancelConfirmationTarget(running("delivery-a", { status: "done" }), openedForA),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(
        section({
          deliveries: [delivery("delivery-a")],
          permitted: { ...ALLOWED, cancel: false },
        }),
        openedForA,
      ),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(
        section({ deliveries: [delivery("delivery-a")], connected: false }),
        openedForA,
      ),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(
        running("delivery-a", { stage: { name: "unknown", kind: "agent" } }),
        openedForA,
      ),
    ).toBeNull();
    expect(
      cancelConfirmationTarget(
        section({ supported: false, deliveries: [delivery("delivery-a")] }),
        openedForA,
      ),
    ).toBeNull();
  });
});
