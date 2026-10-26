import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnectionPhase } from "../../connection/presentation.ts";
import { factoryFleet } from "./fleet.ts";
import { createFactoryFleetAtom } from "./fleetAtom.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const envC = EnvironmentId.make("env-c");

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId: ProjectId.make("project-a"),
  itemRef: {
    sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
    itemId: WorkItemId.make(`item-${id}`),
  },
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
  ...overrides,
});

type Read = AsyncResult.AsyncResult<
  { readonly deliveries: ReadonlyArray<FactoryDelivery> },
  unknown
>;
const loaded = (...deliveries: ReadonlyArray<FactoryDelivery>): Read =>
  AsyncResult.success({ deliveries });

const registries: Array<AtomRegistry.AtomRegistry> = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

/**
 * The fleet over writable connections, support and delivery reads. A read is held only while
 * the fleet reads it, as an environment query is, and `held` names the environments read now.
 */
const harness = (
  connections: ReadonlyArray<readonly [EnvironmentId, EnvironmentConnectionPhase]>,
) => {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {
        const index = tasks.indexOf(task);
        if (index >= 0) tasks.splice(index, 1);
      };
    },
  });
  registries.push(registry);
  const environmentsAtom = Atom.make(
    connections.map(([environmentId, connectionState]) => ({ environmentId, connectionState })),
  ).pipe(Atom.keepAlive);
  const supported = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(true).pipe(Atom.keepAlive, Atom.withLabel(`supported:${environmentId}`)),
  );
  const results = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<Read>(AsyncResult.initial()).pipe(
      Atom.keepAlive,
      Atom.withLabel(`deliveries:${environmentId}`),
    ),
  );
  const held = new Set<EnvironmentId>();
  const deliveries = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      held.add(environmentId);
      get.addFinalizer(() => held.delete(environmentId));
      return get(results(environmentId));
    }),
  );
  const fleet = createFactoryFleetAtom({ environmentsAtom, supported, deliveries });
  registry.mount(fleet);
  const settle = () => {
    for (let pass = 0; pass < 100 && tasks.length > 0; pass++) {
      while (tasks.length > 0) tasks.shift()?.();
    }
  };
  return {
    fleet: () => {
      settle();
      const value = registry.get(fleet);
      return { ...value, rows: factoryFleet(value.environments).map((row) => row.key) };
    },
    held: () => {
      settle();
      return [...held].sort();
    },
    connect: (environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) =>
      registry.update(environmentsAtom, (current) =>
        current.map((entry) =>
          entry.environmentId === environmentId ? { environmentId, connectionState } : entry,
        ),
      ),
    load: (environmentId: EnvironmentId, read: Read) => registry.set(results(environmentId), read),
    support: (environmentId: EnvironmentId, value: boolean) =>
      registry.set(supported(environmentId), value),
  };
};

describe("createFactoryFleetAtom", () => {
  it("reads only connected Factory environments and names the rest as not connected", () => {
    const fleet = harness([
      [envA, "connected"],
      [envB, "reconnecting"],
      [envC, "connected"],
    ]);
    fleet.support(envC, false);
    fleet.load(envA, loaded(delivery("a1", { status: "blocked", needsYou: "Verify failed." })));
    // A config cached from an earlier connection still advertises Factory on B; whatever its read
    // holds is not shown, and it adds no loading.
    fleet.load(envB, loaded(delivery("b1", { status: "waiting" })));
    expect(fleet.fleet()).toEqual({
      environments: [
        {
          environmentId: envA,
          supported: true,
          deliveries: [delivery("a1", { status: "blocked", needsYou: "Verify failed." })],
        },
      ],
      rows: ["env-a:a1"],
      loading: false,
      failed: [],
      disconnected: [envB],
    });
    expect(fleet.held()).toEqual([envA]);
  });

  it("drops a disconnected environment's rows and reads it again once it reconnects", () => {
    const fleet = harness([
      [envA, "connected"],
      [envB, "connected"],
    ]);
    fleet.load(envA, loaded(delivery("a1")));
    fleet.load(envB, loaded(delivery("b1", { status: "blocked" })));
    expect(fleet.fleet().rows).toEqual(["env-b:b1", "env-a:a1"]);
    expect(fleet.held()).toEqual([envA, envB]);

    for (const phase of ["connecting", "reconnecting", "offline", "error"] as const) {
      fleet.connect(envB, phase);
      expect(fleet.fleet()).toMatchObject({
        rows: ["env-a:a1"],
        loading: false,
        failed: [],
        disconnected: [envB],
      });
      expect(fleet.held()).toEqual([envA]);
    }

    // The delivery finished while B was away; reconnecting reads B's deliveries again.
    fleet.load(envB, loaded(delivery("b1", { status: "done" }), delivery("b2")));
    fleet.connect(envB, "connected");
    expect(fleet.held()).toEqual([envA, envB]);
    expect(fleet.fleet()).toMatchObject({
      // Same creation time: the shared order puts the greater delivery id first.
      rows: ["env-b:b2", "env-a:a1"],
      disconnected: [],
    });
  });

  it("loads only while a connected environment's read is pending, and reports a failed read", () => {
    const fleet = harness([
      [envA, "connected"],
      [envB, "connecting"],
    ]);
    // B never loaded and cannot load while it reconnects, so it holds nothing up.
    expect(fleet.fleet()).toMatchObject({ rows: [], loading: true, disconnected: [envB] });
    fleet.load(envA, loaded());
    expect(fleet.fleet()).toMatchObject({ rows: [], loading: false, disconnected: [envB] });

    fleet.connect(envB, "connected");
    expect(fleet.fleet()).toMatchObject({ loading: true, disconnected: [] });
    fleet.load(envB, AsyncResult.failure(Cause.fail("unavailable")));
    expect(fleet.fleet()).toMatchObject({ loading: false, failed: [envB], disconnected: [] });
  });

  it("leaves out an environment that does not serve Factory, connected or not", () => {
    const fleet = harness([
      [envA, "connected"],
      [envB, "offline"],
    ]);
    fleet.support(envA, false);
    fleet.support(envB, false);
    fleet.load(envA, loaded(delivery("a1")));
    expect(fleet.fleet()).toEqual({
      environments: [],
      rows: [],
      loading: false,
      failed: [],
      disconnected: [],
    });
    expect(fleet.held()).toEqual([]);
  });

  it("never reads unsupported environments, and keeps a connected one's rows beside them", () => {
    const fleet = harness([
      [envA, "connected"],
      [envB, "reconnecting"],
      [envC, "connected"],
    ]);
    fleet.support(envA, false);
    fleet.support(envB, false);
    fleet.load(envA, loaded(delivery("a1")));
    fleet.load(envC, loaded(delivery("c1")));
    expect(fleet.fleet()).toMatchObject({
      rows: ["env-c:c1"],
      loading: false,
      failed: [],
      disconnected: [],
    });
    expect(fleet.held()).toEqual([envC]);

    // B reconnects still without Factory; A stops serving it; neither is ever read.
    fleet.connect(envB, "connected");
    fleet.connect(envA, "reconnecting");
    expect(fleet.fleet()).toMatchObject({ rows: ["env-c:c1"], disconnected: [] });
    expect(fleet.held()).toEqual([envC]);

    // A server that starts advertising Factory while connected is read from then on.
    fleet.connect(envA, "connected");
    fleet.support(envA, true);
    expect(fleet.held()).toEqual([envA, envC]);
    expect(fleet.fleet()).toMatchObject({ rows: ["env-c:c1", "env-a:a1"], disconnected: [] });
  });
});
