import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import {
  type MobileFactoryDestination,
  mobileCancelTarget,
  mobileFactorySection,
} from "./itemSection";

const environmentId = EnvironmentId.make("env-1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const ALLOWED = { stop: true, resume: true, cancel: true };
const NONE = { stop: false, resume: false, cancel: false };

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

const section = (overrides: Partial<MobileFactoryDestination> = {}) =>
  mobileFactorySection({
    environmentId,
    itemRef,
    supported: true,
    connectionState: "connected",
    deliveries: [delivery("d1")],
    permitted: ALLOWED,
    ...overrides,
  });

describe("mobileFactorySection", () => {
  it.each([
    ["running", { stop: true, resume: false, cancel: true }],
    ["stopping", { stop: false, resume: true, cancel: true }],
    ["stopped", { stop: false, resume: true, cancel: true }],
    ["blocked", { stop: false, resume: true, cancel: true }],
    ["waiting", { stop: false, resume: false, cancel: true }],
    ["pr_open", { stop: false, resume: false, cancel: true }],
    ["done", NONE],
    ["cancelled", NONE],
  ] as const)("connected with every grant, a %s delivery offers %o", (status, controls) => {
    expect(section({ deliveries: [delivery("d1", { status })] })?.controls).toEqual(controls);
  });

  it.each(["reconnecting", "connecting", "offline", "error", undefined] as const)(
    "shows the deliveries read before but offers nothing while %s",
    (connectionState) => {
      const deliveries = [
        delivery("d1", { status: "blocked", needsYou: "Review found a high finding." }),
      ];
      expect(section({ deliveries })?.controls).toEqual({
        stop: false,
        resume: true,
        cancel: true,
      });
      expect(section({ deliveries, connectionState })).toMatchObject({
        deliveryId: "d1",
        label: "Blocked",
        needsYou: "Review found a high finding.",
        controls: NONE,
      });
    },
  );

  it("offers stop only with the stop grant", () => {
    expect(section({ permitted: { ...ALLOWED, stop: false } })?.controls).toEqual({
      stop: false,
      resume: false,
      cancel: true,
    });
  });

  it("offers nothing for an unknown status, stage name or stage kind", () => {
    expect(section({ deliveries: [delivery("d1", { status: "unknown" })] })).toMatchObject({
      label: "Unknown",
      controls: NONE,
    });
    expect(
      section({ deliveries: [delivery("d1", { stage: { name: "unknown", kind: "agent" } })] })
        ?.controls,
    ).toEqual(NONE);
    expect(
      section({ deliveries: [delivery("d1", { stage: { name: "author", kind: "unknown" } })] })
        ?.controls,
    ).toEqual(NONE);
  });

  it("shows nothing on a server without Factory", () => {
    expect(section({ supported: false })).toBeNull();
  });

  it("targets each row's thread on the delivery's own environment", () => {
    const author = ThreadId.make("thread-author");
    const rows = section({
      environmentId: EnvironmentId.make("env-2"),
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
              outcome: null,
              startedAt: "2026-10-21T09:11:00.000Z",
            },
          ],
        }),
      ],
    })?.timeline;
    expect(rows?.map((row) => row.thread)).toEqual([
      { environmentId: EnvironmentId.make("env-2"), threadId: author },
      null,
    ]);
  });
});

describe("mobileCancelTarget", () => {
  const a = FactoryDeliveryId.make("delivery-a");

  it("cancels the delivery the confirmation was opened for while it is current and cancellable", () => {
    expect(mobileCancelTarget(section({ deliveries: [delivery("delivery-a")] }), a)).toBe(a);
  });

  it("cancels nothing once another delivery replaced it", () => {
    const replaced = section({
      deliveries: [
        delivery("delivery-b", { createdAt: "2026-10-21T10:00:00.000Z" }),
        delivery("delivery-a", { status: "cancelled" }),
      ],
    });
    expect(replaced?.controls.cancel).toBe(true);
    expect(mobileCancelTarget(replaced, a)).toBeNull();
  });

  it("cancels nothing once it ended or the grant went", () => {
    expect(
      mobileCancelTarget(section({ deliveries: [delivery("delivery-a", { status: "done" })] }), a),
    ).toBeNull();
    expect(
      mobileCancelTarget(
        section({ deliveries: [delivery("delivery-a")], permitted: { ...ALLOWED, cancel: false } }),
        a,
      ),
    ).toBeNull();
    expect(
      mobileCancelTarget(
        section({ deliveries: [delivery("delivery-a")], connectionState: "reconnecting" }),
        a,
      ),
    ).toBeNull();
  });
});
