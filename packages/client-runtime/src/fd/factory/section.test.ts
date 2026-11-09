import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceiptSummary,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

import { factoryPendingActionDestination, factoryPendingActionTarget } from "./model.ts";
import {
  cancelConfirmationTarget,
  type FactoryControlPermissions,
  factoryDeliveryView,
  factoryExecutionView,
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
    expect(view({ deliveries: [delivery("d3", { status: "queued" })] })).toMatchObject({
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

describe("the next action", () => {
  const url = "https://github.com/acme/alpha/pull/7";
  const opened = { number: 7, url, threadId: author };
  const nextOf = (overrides: Partial<FactoryDelivery>) =>
    view({ deliveries: [delivery("d1", overrides)] })?.nextAction;

  it.each<[string, Partial<FactoryDelivery>, string, boolean]>([
    ["queued", { status: "queued" }, "Waiting to start", false],
    ["running", { status: "running" }, "Factory is working", false],
    ["stopping", { status: "stopping" }, "Stopping after this step", false],
    ["stopped", { status: "stopped" }, "Stopped", true],
    ["blocked", { status: "blocked" }, "Blocked", true],
    ["waiting", { status: "waiting" }, "Waiting for your decision", true],
    [
      "opening its pull request",
      { status: "approved", proceeding: true },
      "Opening the pull request",
      false,
    ],
    [
      "approved before pull requests existed",
      { status: "approved", proceeding: false },
      "Approved, with no pull request",
      true,
    ],
    ["approved, from a server that cannot say", { status: "approved" }, "Approved", false],
    [
      "an approved child, whose parent carries its work",
      { status: "approved", parentId: FactoryDeliveryId.make("parent"), proceeding: false },
      "Approved",
      false,
    ],
    [
      "running a round of its pull request's feedback",
      { status: "running", pullRequest: opened, stage: { name: "follow_through", kind: "agent" } },
      "Following up on the pull request",
      false,
    ],
    [
      "approved again in a round, about to push it",
      { status: "approved", pullRequest: opened, proceeding: true },
      "Following up on the pull request",
      false,
    ],
    [
      "pr_open idle",
      { status: "pr_open", pullRequest: opened, proceeding: false },
      "Ready for your review",
      true,
    ],
    [
      "pr_open following up",
      { status: "pr_open", pullRequest: opened, proceeding: true },
      "Following up on the pull request",
      false,
    ],
    [
      "pr_open with its merge closing out",
      { status: "pr_open", pullRequest: { ...opened, outcome: "merged" }, proceeding: true },
      "Merged, finishing up",
      false,
    ],
    ["done", { status: "done", pullRequest: { ...opened, outcome: "merged" } }, "Done", false],
    ["cancelled", { status: "cancelled" }, "Cancelled", false],
    ["of a status this build cannot read", { status: "unknown" }, "Unknown status", false],
  ])("reads a delivery %s", (_name, overrides, title, forYou) => {
    expect(nextOf(overrides)).toMatchObject({ title, forYou });
  });

  it("never reads an open pull request as completed", () => {
    const shown = view({
      deliveries: [delivery("d1", { status: "pr_open", pullRequest: opened, proceeding: false })],
    });
    expect(shown?.label).toBe("PR open");
    expect(shown?.nextAction).toMatchObject({
      title: "Ready for your review",
      readyForReview: true,
    });
    expect(shown?.nextAction.detail).toContain("Factory never merges");
    expect(`${shown?.nextAction.title} ${shown?.nextAction.detail}`).not.toMatch(/complete|done/i);
  });

  it("reads ready only with nothing else under way", () => {
    const moving = nextOf({ status: "pr_open", pullRequest: opened, proceeding: true });
    expect(moving?.readyForReview).toBe(false);
    expect(moving?.reviewThread).toBeNull();
    expect(moving?.evidence).toBeNull();
    // Following up, the link stays on hand, without asking the owner to judge a moving branch.
    expect(moving?.pullRequestUrl).toBe(url);
  });

  it("offers the pull request, its changes and what it was judged on while ready", () => {
    const next = nextOf({
      status: "pr_open",
      pullRequest: opened,
      proceeding: false,
      receipts: [
        { ...receipt("2026-10-21T09:12:00.000Z", 1, 1), headSha: "f".repeat(40) },
        receipt("2026-10-21T09:22:00.000Z", 0, 2),
      ],
      reviews: [
        review({ verdict: "pass", blocking: false, findings: { high: 0, medium: 0, low: 1 } }),
      ],
    });
    expect(next).toMatchObject({
      pullRequestUrl: url,
      reviewThread: { environmentId, threadId: author },
      evidence: {
        verifiedCommit: "0123456",
        verify: "Passed on 0123456 in 1m 5s",
        review: "Pass on 0123456: 0 high, 0 medium, 1 low",
      },
    });
  });

  it("says a verified commit is not recorded rather than name a failed one", () => {
    expect(
      nextOf({
        status: "pr_open",
        pullRequest: opened,
        proceeding: false,
        receipts: [receipt("2026-10-21T09:12:00.000Z", 1, 1)],
      })?.evidence,
    ).toEqual({
      verifiedCommit: "Not recorded",
      verify: "Failed with exit code 1 on 0123456 in 1m 5s",
      review: "Not recorded",
    });
  });

  it("reads a delivery from an older server, with no evidence or pull request, honestly", () => {
    const next = nextOf({ status: "pr_open" });
    expect(next).toMatchObject({
      title: "Ready for your review",
      pullRequestUrl: null,
      reviewThread: null,
      evidence: { verifiedCommit: "Not recorded", verify: "Not recorded", review: "Not recorded" },
    });
  });

  it("links only a pull request a browser should open, whatever else is recorded", () => {
    const linked = (candidate: string) =>
      nextOf({
        status: "pr_open",
        proceeding: false,
        pullRequest: { number: 7, url: candidate, threadId: author },
      })?.pullRequestUrl;
    expect(linked(url)).toBe(url);
    expect(linked("javascript:alert(1)")).toBeNull();
    expect(linked("not a url")).toBeNull();
  });

  it("carries the block's reason, with what to do about it", () => {
    expect(nextOf({ status: "blocked", needsYou: "Verify failed." })?.detail).toBe(
      "Verify failed. Fix what it names if needed, then resume or cancel it.",
    );
  });

  it("says how a pull request closed without merging ended it", () => {
    expect(
      nextOf({ status: "cancelled", pullRequest: { ...opened, outcome: "closed" } })?.detail,
    ).toContain("closed without merging");
    expect(nextOf({ status: "cancelled" })?.detail).not.toContain("closed without merging");
  });
});

describe("the item's facts", () => {
  const value = (facts: ReadonlyArray<{ key: string; label: string; value: string }>) =>
    Object.fromEntries(facts.map((fact) => [fact.label, fact.value]));

  it("keeps a To do item, its queue rank and its open pull request as separate facts", () => {
    const shown = view({
      deliveries: [
        delivery("d1", {
          status: "pr_open",
          stage: { name: "pr", kind: "pr" },
          queuePriority: 1,
          source: {
            key: "fd-7k3qa2",
            title: "Ship",
            status: "todo",
            statusName: null,
            assignee: null,
          },
        }),
      ],
    });
    expect(value(shown?.facts ?? [])).toEqual({
      "Work status": "To do",
      "Queue priority": "P1",
      "Human assignee": "Unassigned",
      "Factory delivery": "PR open · Pull request",
    });
  });

  it.each(["done", "cancelled"] as const)(
    "keeps the rank of a %s delivery, which Work goes on showing",
    (status) => {
      const facts = (queuePriority: number | null) =>
        value(
          view({
            deliveries: [delivery("d1", { status, queuePriority })],
            item: { status: "done", nativeStatus: null, assignee: null },
          })?.facts ?? [],
        );
      expect(facts(1)["Queue priority"]).toBe("P1");
      expect(facts(null)["Queue priority"]).toBe("Not set");
    },
  );

  it("prefers the item the surface read over the listing's, in the source's own words", () => {
    const shown = view({
      deliveries: [delivery("d1")],
      item: {
        status: "in_progress",
        nativeStatus: { id: "3", name: "In review" },
        assignee: { id: "a", label: "Sam" },
      },
    });
    expect(value(shown?.facts ?? [])).toMatchObject({
      "Work status": "In review",
      "Human assignee": "Sam",
    });
  });

  it("says a source that was not read is unavailable, never unassigned", () => {
    expect(value(view({ deliveries: [delivery("d1")] })?.facts ?? [])).toEqual({
      "Work status": "Not available",
      "Queue priority": "Not set",
      "Human assignee": "Not available",
      "Factory delivery": "Running",
    });
  });
});

describe("the counts", () => {
  const counts = (fix: number, followUps: number) => ({
    verificationFixes: { used: fix, limit: 2, remaining: 2 - fix },
    reviewFollowUps: { used: followUps, limit: 2, remaining: 2 - followUps },
    fixCommitTurns: { used: 0, limit: 1, remaining: 1 },
  });

  it("names one repair and two review attempts for what each counts", () => {
    const shown = view({
      deliveries: [
        delivery("d1", {
          rounds: { fix: 0, review: 1 },
          allowance: {
            counted: "whole_delivery",
            ...counts(0, 1),
            attempts: { verify: 2, review: 2 },
          },
        }),
      ],
    })?.counters;
    expect(shown).toEqual({
      lines: [
        { key: "fix", label: "Verification fixes", text: "0 used, 2 left of 2" },
        { key: "review", label: "Review follow-ups", text: "1 used, 1 left of 2" },
        { key: "fix-commit", label: "Fix-commit turns", text: "0 used, 1 left of 1" },
      ],
      attempts: "2 verify attempts · 2 review attempts",
      scope: "Approved in your review for the whole delivery. A resume adds none.",
    });
  });

  it("labels a delivery without a review as counted since its last resume", () => {
    const shown = view({
      deliveries: [
        delivery("d1", {
          allowance: {
            counted: "since_resume",
            ...counts(1, 0),
            attempts: { verify: 1, review: 0 },
          },
        }),
      ],
    })?.counters;
    expect(shown?.scope).toBe("Counted since the last resume, which starts them over.");
    expect(shown?.attempts).toBe("1 verify attempt · 0 review attempts");
  });

  it("leaves out the repair counts a parent does not have", () => {
    const lines = view({
      deliveries: [
        delivery("d1", {
          allowance: {
            counted: "since_resume",
            verificationFixes: null,
            reviewFollowUps: null,
            fixCommitTurns: { used: 1, limit: 1, remaining: 0 },
            attempts: { verify: 1, review: 1 },
          },
        }),
      ],
    })?.counters.lines;
    expect(lines?.map((line) => line.label)).toEqual(["Fix-commit turns"]);
  });

  it("shows an older server's rounds as what they are", () => {
    expect(
      view({ deliveries: [delivery("d1", { rounds: { fix: 1, review: 2 } })] })?.counters,
    ).toEqual({
      lines: [
        { key: "fix", label: "Fix rounds", text: "1" },
        { key: "review", label: "Review rounds", text: "2" },
      ],
      attempts: undefined,
      scope: undefined,
    });
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

  describe("what stands in for a control", () => {
    const noteOf = (
      status: FactoryDelivery["status"],
      overrides: Partial<Parameters<typeof factoryDeliveryView>[0]> = {},
      delivered: Partial<FactoryDelivery> = {},
    ) =>
      view({ deliveries: [delivery("d1", { status, ...delivered })], ...overrides })?.controlsNote;

    it.each<[FactoryDelivery["status"], string | undefined]>([
      ["running", undefined],
      ["stopping", undefined],
      ["stopped", undefined],
      ["blocked", undefined],
      ["queued", "nothing to stop yet"],
      ["waiting", "nothing to stop or resume"],
      ["approved", "nothing to stop or resume"],
      ["pr_open", "Merge or close the pull request"],
      ["done", "does not reopen"],
      ["cancelled", "does not reopen"],
      ["unknown", "Update the app"],
    ])("a %s delivery explains %s", (status, text) => {
      const note = noteOf(status, {}, status === "pr_open" ? { proceeding: false } : {});
      if (text === undefined) expect(note).toBeUndefined();
      else expect(note).toContain(text);
    });

    it("gives the way out of an ended delivery, since none is offered", () => {
      expect(controlsOf("done")).toEqual(NONE);
      expect(noteOf("done")).toContain("Delivering the item again");
      expect(controlsOf("cancelled")).toEqual(NONE);
      expect(noteOf("cancelled")).toContain("Delivering the item again");
    });

    it("says a disconnected session can do nothing until it reconnects", () => {
      expect(noteOf("running", { connected: false })).toBe(
        "Reconnect to stop or cancel this delivery.",
      );
      expect(noteOf("blocked", { connected: false })).toBe(
        "Reconnect to resume or cancel this delivery.",
      );
      expect(noteOf("queued", { connected: false })).toBe("Reconnect to cancel this delivery.");
    });

    it("names what an unpermitted session cannot do, and only that", () => {
      expect(noteOf("running", { permitted: NONE })).toBe(
        "This connection is not allowed to stop or cancel this delivery.",
      );
      expect(noteOf("blocked", { permitted: { ...ALLOWED, resume: false } })).toBe(
        "This connection is not allowed to resume this delivery.",
      );
      expect(noteOf("running", { permitted: { ...ALLOWED, resume: false } })).toBeUndefined();
    });

    it("says nothing of connections about a delivery that has none to offer", () => {
      expect(noteOf("done", { connected: false })).toContain("does not reopen");
      expect(noteOf("cancelled", { permitted: NONE })).toContain("does not reopen");
    });

    it("explains an open pull request finishing on its own apart from one awaiting review", () => {
      expect(noteOf("pr_open", {}, { proceeding: true })).toContain("finishing on its own");
    });
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

describe("factoryDeliveryView pending actions", () => {
  const pendingView = (pendingActions: FactoryDelivery["pendingActions"]) =>
    view({ deliveries: [delivery("d1", pendingActions === undefined ? {} : { pendingActions })] })
      ?.pendingActions;
  const projectId = ProjectId.make("project-1");
  const action = {
    kind: "file-change",
    runClass: "factory",
    runtimeMode: "auto-accept-edits",
    threadId: ThreadId.make("author"),
    projectId,
    requestId: "request-1",
    capability: "live",
  } as const;

  it("shows none while nothing waits, and no note", () => {
    expect(pendingView(undefined)).toEqual({ rows: [], note: undefined });
  });

  it("says what each row is, why, who asks and where it is decided", () => {
    expect(pendingView({ items: [action], omitted: 0, complete: true })?.rows).toEqual([
      {
        key: "file-change:author:request-1",
        label: "Provider or session permission",
        reason: expect.stringContaining("did not cover this file change"),
        provenance: "Factory's own agent",
        projectId,
        threadId: ThreadId.make("author"),
        item: null,
      },
    ]);
  });

  it("decides a plan on the delivery, where no thread is asking", () => {
    const row = pendingView({
      items: [
        {
          kind: "plan_gate",
          runClass: null,
          runtimeMode: null,
          threadId: null,
          projectId,
          requestId: null,
          capability: "live",
        },
      ],
      omitted: 0,
      complete: true,
    })?.rows[0];
    expect(row?.label).toBe("Foredeck authorization");
    expect(row?.threadId).toBeNull();
  });

  it("reads a kind this build does not know as unknown, never as a permission", () => {
    const row = pendingView({
      items: [{ ...action, kind: "new-kind" }],
      omitted: 0,
      complete: true,
    })?.rows[0];
    expect(row?.label).toBe("Unknown");
    expect(row?.reason).toContain("gave no reason");
  });

  it("words a provider's own reason, and never works out why from the kind", () => {
    const row = (reason?: string) =>
      pendingView({
        items: [{ ...action, ...(reason === undefined ? {} : { reason }) }],
        omitted: 0,
        complete: true,
      })?.rows[0]?.reason;
    expect(row()).toBe(
      "Auto-accept edits did not cover this file change. The provider gave no reason.",
    );
    expect(row("Writes outside the workspace.")).toContain(
      "The provider says: Writes outside the workspace.",
    );
  });

  it("sends a child's refused launch on a parent to the child, and keeps its own here", () => {
    const shown = itemRef;
    const childItem = otherRef;
    const refused = {
      ...action,
      kind: "host_policy",
      threadId: null,
      requestId: null,
      runClass: null,
    };
    expect(factoryPendingActionDestination({ threadId: null, item: childItem }, shown)).toEqual({
      type: "item",
      item: childItem,
    });
    expect(factoryPendingActionDestination({ threadId: null, item: shown }, shown)).toEqual({
      type: "here",
    });
    expect(factoryPendingActionDestination({ threadId: null, item: null }, shown)).toEqual({
      type: "here",
    });
    // On a surface showing no item, such as the assistant's list, it always links.
    expect(factoryPendingActionDestination({ threadId: null, item: shown }, null)).toEqual({
      type: "item",
      item: shown,
    });
    expect(
      pendingView({ items: [{ ...refused, item: childItem }], omitted: 0, complete: true })?.rows[0]
        ?.item,
    ).toEqual(childItem);
  });

  it("sends what a thread asks to that thread, whatever item it belongs to", () => {
    expect(
      factoryPendingActionDestination(
        { threadId: ThreadId.make("author"), item: itemRef },
        itemRef,
      ),
    ).toEqual({ type: "thread", threadId: ThreadId.make("author") });
  });

  it("names a row's project and thread, or their ids where it knows no name", () => {
    const row = { projectId, threadId: ThreadId.make("author") };
    expect(
      factoryPendingActionTarget(row, { project: () => "Alpha", thread: () => "Author" }),
    ).toBe("Project: Alpha · Thread: Author");
    expect(
      factoryPendingActionTarget(row, { project: () => undefined, thread: () => undefined }),
    ).toBe("Project: project-1 · Thread: author");
    expect(
      factoryPendingActionTarget(
        { projectId, threadId: null },
        { project: () => "Alpha", thread: () => undefined },
      ),
    ).toBe("Project: Alpha");
  });

  it("says how many it left out and when its read failed", () => {
    const note = pendingView({ items: [action], omitted: 3, complete: false })?.note;
    expect(note).toContain("3 more are not listed here.");
    expect(note).toContain("could not all be read");
  });
});

describe("what each role runs on", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const requested = {
    instanceId,
    model: "gpt-6-sol",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
      { id: "fastMode", value: false },
    ],
  };

  it("shows nothing until a read of the delivery brought them, or on an older server", () => {
    expect(factoryExecutionView(delivery("d"))).toBeNull();
    expect(factoryExecutionView({ execution: { roles: [] } })).toBeNull();
  });

  it("marks a reviewed role as reviewed, saying what that holds it to", () => {
    const view = factoryExecutionView({
      execution: {
        roles: [{ role: "author", selection: requested, binding: "reviewed", reviewed: requested }],
      },
    });
    const text =
      "codex · gpt-6-sol · reasoningEffort: high · serviceTier: priority · fastMode: off";
    expect(view?.roles).toEqual([
      {
        key: "author",
        label: "Author",
        requested: text,
        binding: "Reviewed",
        reviewed: text,
        acknowledged: "Not reported",
      },
    ]);
    expect(view?.note).toContain("stay what you reviewed");
  });

  it("shows an escalated request apart from what was reviewed, and says why they differ", () => {
    const view = factoryExecutionView({
      execution: {
        roles: [
          {
            role: "author",
            binding: "reviewed",
            reviewed: { instanceId, model: "m", options: [{ id: "effort", value: "low" }] },
            selection: { instanceId, model: "m", options: [{ id: "effort", value: "high" }] },
          },
        ],
      },
    });
    expect(view?.roles[0]?.reviewed).toBe("codex · m · effort: low");
    expect(view?.roles[0]?.requested).toBe("codex · m · effort: high");
    expect(view?.note).toContain("can ask for the high-risk effort you reviewed");
    expect(view?.note).toContain("a fix-commit turn asks for medium for that turn alone");
  });

  it("names no reviewed value for a role without a review", () => {
    const view = factoryExecutionView({
      execution: { roles: [{ role: "author", selection: requested, binding: "read_now" }] },
    });
    expect(view?.roles[0]?.reviewed).toBeUndefined();
  });

  it("marks a role without a review as read now, never as frozen", () => {
    const view = factoryExecutionView({
      execution: {
        roles: [
          { role: "planner", selection: { instanceId, model: "m" }, binding: "read_now" },
          { role: "reviewer", selection: requested, binding: "read_now" },
        ],
      },
    });
    expect(view?.roles.map(({ label, binding }) => [label, binding])).toEqual([
      ["Planner", "Read now"],
      ["Reviewer", "Read now"],
    ]);
    expect(view?.roles[0]?.requested).toBe("codex · m · provider defaults");
    expect(view?.note).toContain("started without a review");
    expect(view?.note).toContain("a settings change can change its next step");
    expect(view?.note).not.toContain("stay what you reviewed");
  });

  it("reads Not reported where no provider said, however clear the request is", () => {
    const [role] =
      factoryExecutionView({
        execution: { roles: [{ role: "author", selection: requested, binding: "reviewed" }] },
      })?.roles ?? [];
    expect(role?.acknowledged).toBe("Not reported");
    expect(role?.acknowledged).not.toBe(role?.requested);
  });

  it("shows what a provider reported as it reported it, even where it differs", () => {
    const [role] =
      factoryExecutionView({
        execution: {
          roles: [
            {
              role: "reviewer",
              selection: requested,
              binding: "reviewed",
              acknowledged: {
                instanceId,
                model: "gpt-6-sol",
                options: [{ id: "reasoningEffort", value: "medium" }],
              },
            },
          ],
        },
      })?.roles ?? [];
    expect(role?.acknowledged).toBe("codex · gpt-6-sol · reasoningEffort: medium");
    expect(role?.requested).toContain("reasoningEffort: high");
  });

  it("promises nothing about billing or priority", () => {
    for (const binding of ["reviewed", "read_now"] as const) {
      const view = factoryExecutionView({
        execution: { roles: [{ role: "author", selection: requested, binding }] },
      });
      expect(view?.note).toContain("These are requests");
      expect(view?.note).toContain("the provider decides what it runs and how it bills");
      expect(view?.note.toLowerCase()).not.toContain("guarantee");
    }
  });

  it("reads a role or binding from a newer server without guessing", () => {
    const [role] =
      factoryExecutionView({
        execution: { roles: [{ role: "unknown", selection: requested, binding: "unknown" }] },
      })?.roles ?? [];
    expect(role?.label).toBe("Role");
    expect(role?.binding).toBe("Unknown");
  });
});
