import { EnvironmentId } from "@t3tools/contracts";
import {
  WorkItemId,
  WorkSourceId,
  type WorkListQuery,
  type WorkItemSummary,
} from "@t3tools/contracts/fd/work-management";
import { EnvironmentRegistry } from "../../connection/registry.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const server = vi.hoisted(() => ({
  reads: [] as Array<WorkListQuery>,
  items: [] as Array<WorkItemSummary>,
}));

// The RPC boundary returns actual filtered pages. The paging atoms, cache identity and cursor
// chaining below are the production implementation shared by web and mobile.
vi.mock("../../state/runtime.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/runtime.ts")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    ...original,
    createEnvironmentRpcQueryAtomFamily:
      (_runtime: unknown, options: { tag: string }) =>
      ({ input }: { input: WorkListQuery }) =>
        Atom.make(() => {
          if (options.tag !== "work.items.list") return AsyncResult.initial();
          server.reads.push(input);
          const matching = server.items.filter(
            (item) =>
              item.ref.sourceId === input.sourceId &&
              (input.labels ?? []).every((label) => item.labels.includes(label)) &&
              (input.assignee !== "me" || item.assignee?.id === "me"),
          );
          const offset = Number(input.cursor ?? 0);
          const end = offset + (input.limit ?? 50);
          return AsyncResult.success({
            items: matching.slice(offset, end),
            nextCursor: end < matching.length ? String(end) : null,
            stale: false,
          });
        }),
    createEnvironmentRpcSubscriptionAtomFamily: () => () => Atom.make(AsyncResult.initial()),
  };
});

import { createWorkEnvironmentAtoms } from "./atoms.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const environmentId = EnvironmentId.make("target");
const item = (index: number, labels: ReadonlyArray<string>, assignee: string): WorkItemSummary => ({
  ref: { sourceId, itemId: WorkItemId.make(String(index)) },
  kind: "github",
  key: String(index),
  title: `Item ${index}`,
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: null,
  labels: [...labels],
  assignee: { id: assignee, label: assignee },
  parent: null,
  blockedBy: [],
  url: null,
  updatedAt: null,
  revision: String(index),
  invalid: null,
});
let registry: AtomRegistry.AtomRegistry;
beforeEach(() => {
  registry = AtomRegistry.make();
  server.reads = [];
  server.items = [];
});
afterEach(() => registry.dispose());

describe("Work paged filter queries", () => {
  it("applies both filters to every cursor page and never mixes filtered cache entries", () => {
    server.items = [
      ...Array.from({ length: 52 }, (_, index) => item(index, ["auth", "urgent"], "me")),
      item(100, ["auth", "urgent"], "someone"),
      item(101, ["ui"], "me"),
    ];
    const atoms = createWorkEnvironmentAtoms(
      Atom.runtime(
        Layer.effect(EnvironmentRegistry, Effect.die("The test mocks the RPC boundary")),
      ),
    );
    const input = { environmentId, sources: [{ sourceId, kind: "github" as const }], pageCount: 2 };
    const filtered = atoms.pagedList({ ...input, labels: ["urgent", "auth"], assignee: "me" });
    const result = registry.get(filtered);
    expect(result[0]?.pages.items).toHaveLength(52);
    expect(result[0]?.pages.nextCursor).toBeNull();
    expect(server.reads).toEqual([
      { sourceId, limit: 50, labels: ["auth", "urgent"], assignee: "me" },
      { sourceId, limit: 50, labels: ["auth", "urgent"], assignee: "me", cursor: "50" },
    ]);
    expect(
      atoms.pagedList({ ...input, labels: [" auth", "urgent", "auth "], assignee: "me" }),
    ).toBe(filtered);
    expect(atoms.pagedList(input)).not.toBe(filtered);
    expect(registry.get(atoms.pagedList(input))[0]?.pages.items).toHaveLength(54);
  });
});
