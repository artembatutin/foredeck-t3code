import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryError,
  type FactoryReviewSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_NOT_CONFIGURED_TEXT,
  type FactoryItemPermissions,
  factoryErrorText,
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

const decodeFactoryError = Schema.decodeUnknownSync(FactoryError);

const ALLOWED: FactoryItemPermissions = { start: true, stop: true, resume: true, cancel: true };
const DENIED: FactoryItemPermissions = { start: false, stop: false, resume: false, cancel: false };

const section = (
  overrides: Partial<Parameters<typeof factoryItemSection>[0]> = {},
): ReturnType<typeof factoryItemSection> =>
  factoryItemSection({
    environmentId,
    itemRef,
    supported: true,
    deliveries: [],
    started: null,
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
    const started = delivery("d3", { status: "queued" });
    expect(section({ started })).toMatchObject({
      deliver: false,
      delivery: { deliveryId: "d3", label: "Queued" },
    });
    // The list's copy wins once it arrives.
    expect(
      section({ started, deliveries: [delivery("d3", { status: "cancelled" })] }),
    ).toMatchObject({ deliver: true, delivery: { deliveryId: "d3", label: "Cancelled" } });
  });
});

describe("factoryErrorText", () => {
  const failure = (reason: FactoryError["reason"], message: string) =>
    Cause.fail(new FactoryError({ reason, message }));

  it("names Project settings → Factory when the project has no verify command", () => {
    const text = factoryErrorText(
      failure(
        "not_configured",
        "Set a verify command in the project's Factory settings before starting a delivery.",
      ),
    );
    expect(text).toBe(FACTORY_NOT_CONFIGURED_TEXT);
    expect(text).toContain("Project settings → Factory");
  });

  it("shows a Factory error's own fixed message for other reasons", () => {
    const conflict = "This Work item already has a Factory delivery that is not done or cancelled.";
    expect(factoryErrorText(failure("conflict", conflict))).toBe(conflict);
    const refused = "Only a running delivery can stop after its step; this one is blocked.";
    expect(factoryErrorText(failure("refused", refused))).toBe(refused);
  });

  it("shows the message of a reason this build does not know", () => {
    const error = decodeFactoryError({
      _tag: "FactoryError",
      reason: "quota_exceeded",
      message: "Factory has too many deliveries running.",
    });
    expect(error.reason).toBe("unavailable");
    expect(factoryErrorText(Cause.fail(error))).toBe("Factory has too many deliveries running.");
  });

  it("falls back to fixed text when a failure carries no message", () => {
    const fallback = "Factory could not complete the request. Try again.";
    expect(factoryErrorText(failure("unavailable", "  "))).toBe(fallback);
    expect(factoryErrorText(Cause.die("boom"))).toBe(fallback);
    expect(factoryErrorText(Cause.fail(new Error("The connection closed.")))).toBe(
      "The connection closed.",
    );
  });
});

describe("the current delivery", () => {
  const receipt = (finishedAt: string, code: number | null): FactoryVerifyReceiptSummary => ({
    headSha: HEAD,
    tree: HEAD,
    startedAt: finishedAt,
    finishedAt,
    code,
    timedOut: false,
    durationMs: 65_000,
  });
  const review: FactoryReviewSummary = {
    headSha: HEAD,
    verdict: "changes-required",
    blocking: true,
    findings: { high: 1, medium: 2, low: 0 },
    reviewedAt: "2026-10-21T09:30:00.000Z",
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
            receipt("2026-10-21T09:12:00.000Z", 1),
            receipt("2026-10-21T09:22:00.000Z", 0),
          ],
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
        reviews: ["Changes required, blocking on 0123456: 1 high, 2 medium, 0 low"],
        thread: { environmentId, threadId: reviewer },
      },
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
});
