import { FACTORY_CANCEL_TEXT } from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDelivery as FactoryDeliverySchema,
  FactoryDeliveryId,
  FactoryError,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryCommandError,
  type MobileFactoryDestination,
  mobileCancelTarget,
  mobileFactorySection,
} from "./itemSection";

const environmentId = EnvironmentId.make("env-1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const decodeDelivery = Schema.decodeUnknownSync(FactoryDeliverySchema);
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

describe("the cancel confirmation's family", () => {
  const PARENT = FactoryDeliveryId.make("parent-1");
  const familyOf = (deliveries: ReadonlyArray<FactoryDelivery>) => section({ deliveries })?.family;

  it("says a parent's cancel ends its unapproved children", () => {
    const family = familyOf([
      delivery("parent-1", { childIds: [FactoryDeliveryId.make("child-1")] }),
    ]);
    expect(family).toBe("parent");
    expect(FACTORY_CANCEL_TEXT[family!]).toContain(
      "and so does each of its child deliveries not yet approved",
    );
  });

  it("says a child's cancel ends its parent and unapproved siblings", () => {
    const family = familyOf([delivery("child-1", { parentId: PARENT })]);
    expect(family).toBe("child");
    expect(FACTORY_CANCEL_TEXT[family!]).toContain("its parent");
  });

  it("keeps the single wording for a delivery on its own", () => {
    expect(familyOf([delivery("d1")])).toBe("single");
    // A parent still at its plan gate has no children yet, so its cancel ends it alone.
    expect(
      familyOf([
        delivery("d1", { status: "waiting", stage: { name: "approve_plan", kind: "gate" } }),
      ]),
    ).toBe("single");
  });

  it("keeps the single wording for a delivery from a server before planning", () => {
    const older = decodeDelivery({
      deliveryId: "d1",
      projectId: "p1",
      itemRef,
      // No parent, stage runs or plan: what a server from before planning sends.
      childIds: [],
      status: "running",
      rounds: { fix: 0, review: 0 },
      threads: {},
      receipts: [],
      reviews: [],
      createdAt: "2026-10-21T09:00:00.000Z",
      updatedAt: "2026-10-21T09:00:00.000Z",
    });
    expect(familyOf([older])).toBe("single");
  });
});

describe("mobileCancelTarget", () => {
  const a = FactoryDeliveryId.make("delivery-a");
  const single = { deliveryId: a, family: "single" } as const;

  it("cancels the delivery the confirmation was opened for while it is current and cancellable", () => {
    expect(mobileCancelTarget(section({ deliveries: [delivery("delivery-a")] }), single)).toBe(a);
    const child = { deliveryId: a, family: "child" } as const;
    expect(
      mobileCancelTarget(
        section({
          deliveries: [delivery("delivery-a", { parentId: FactoryDeliveryId.make("p") })],
        }),
        child,
      ),
    ).toBe(a);
  });

  it("cancels nothing once another delivery replaced it", () => {
    const replaced = section({
      deliveries: [
        delivery("delivery-b", { createdAt: "2026-10-21T10:00:00.000Z" }),
        delivery("delivery-a", { status: "cancelled" }),
      ],
    });
    expect(replaced?.controls.cancel).toBe(true);
    expect(mobileCancelTarget(replaced, single)).toBeNull();
  });

  it("cancels nothing once its cancel would end deliveries the confirmation did not name", () => {
    // The plan was approved while the alert was open, giving the parent children.
    const approved = section({
      deliveries: [delivery("delivery-a", { childIds: [FactoryDeliveryId.make("child-1")] })],
    });
    expect(approved?.controls.cancel).toBe(true);
    expect(mobileCancelTarget(approved, single)).toBeNull();
  });

  it("cancels nothing once it ended or the grant went", () => {
    expect(
      mobileCancelTarget(
        section({ deliveries: [delivery("delivery-a", { status: "done" })] }),
        single,
      ),
    ).toBeNull();
    expect(
      mobileCancelTarget(
        section({ deliveries: [delivery("delivery-a")], permitted: { ...ALLOWED, cancel: false } }),
        single,
      ),
    ).toBeNull();
    expect(
      mobileCancelTarget(
        section({ deliveries: [delivery("delivery-a")], connectionState: "reconnecting" }),
        single,
      ),
    ).toBeNull();
  });
});

describe("factoryCommandError", () => {
  it("shows nothing for a command that succeeded", () => {
    expect(factoryCommandError(AsyncResult.success(delivery("d1")))).toBeNull();
  });

  it("shows a refused command's Factory text", () => {
    const refused = new FactoryError({
      reason: "refused",
      message: "The delivery is not waiting at the plan gate.",
    });
    expect(factoryCommandError(AsyncResult.failure(Cause.fail(refused)))).toBe(
      "The delivery is not waiting at the plan gate.",
    );
  });

  it("falls back to fixed text for a failure without a message", () => {
    expect(factoryCommandError(AsyncResult.failure(Cause.fail("lost")))).toBe(
      "Factory could not complete the request. Try again.",
    );
  });
});
