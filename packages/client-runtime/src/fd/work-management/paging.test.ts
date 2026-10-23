import { describe, expect, it } from "@effect/vitest";
import {
  WorkItemId,
  type WorkItemSummary,
  type WorkListResult,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import { AsyncResult } from "effect/reactivity";

import { itemInView } from "./model.ts";
import {
  collectWorkPages,
  refreshWork,
  shouldAutoLoadWorkPage,
  WORK_AUTO_PAGE_LIMIT,
  workPageLimit,
  workViewStatuses,
} from "./paging.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const item = (id: string, overrides: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  ref: { sourceId, itemId: WorkItemId.make(id) },
  kind: "markdown",
  key: id,
  title: `Item ${id}`,
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: null,
  labels: [],
  assignee: null,
  parent: null,
  blockedBy: [],
  url: null,
  updatedAt: null,
  revision: "r1",
  invalid: null,
  ...overrides,
});

/** A fake server: pages of the given items, `size` per page, cursors as offsets. */
const pagedServer = (all: ReadonlyArray<WorkItemSummary>, size: number) => {
  const requested: Array<string | undefined> = [];
  const read = (cursor: string | undefined) => {
    requested.push(cursor);
    const start = cursor === undefined ? 0 : Number(cursor);
    const value: WorkListResult = {
      items: all.slice(start, start + size),
      nextCursor: start + size < all.length ? String(start + size) : null,
      stale: false,
    };
    return AsyncResult.success(value);
  };
  return { read, requested };
};

describe("collectWorkPages", () => {
  it("follows cursors up to the requested page count and reports where to continue", () => {
    const all = Array.from({ length: 7 }, (_, index) => item(`fd-${index}`));
    const server = pagedServer(all, 3);
    const first = collectWorkPages(1, server.read);
    expect(first.items.map((entry) => entry.key)).toEqual(["fd-0", "fd-1", "fd-2"]);
    expect(first.nextCursor).toBe("3");

    const all3 = collectWorkPages(3, pagedServer(all, 3).read);
    expect(all3.items).toHaveLength(7);
    expect(all3.nextCursor).toBeNull();
    // Asking for more pages than exist stops at the end.
    const server5 = pagedServer(all, 3);
    collectWorkPages(5, server5.read);
    expect(server5.requested).toEqual([undefined, "3", "6"]);
  });

  it("stops at a page still loading and offers no cursor until it arrives", () => {
    const pages = collectWorkPages(2, (cursor) =>
      cursor === undefined
        ? AsyncResult.success({ items: [item("fd-a")], nextCursor: "1", stale: false })
        : AsyncResult.initial(true),
    );
    expect(pages.items.map((entry) => entry.key)).toEqual(["fd-a"]);
    expect(pages.waiting).toBe(true);
    expect(pages.nextCursor).toBeNull();
  });

  it("keeps an item that moved between pages once", () => {
    const pages = collectWorkPages(2, (cursor) =>
      AsyncResult.success({
        items: cursor === undefined ? [item("fd-a"), item("fd-b")] : [item("fd-b"), item("fd-c")],
        nextCursor: cursor === undefined ? "2" : null,
        stale: cursor !== undefined,
      }),
    );
    expect(pages.items.map((entry) => entry.key)).toEqual(["fd-a", "fd-b", "fd-c"]);
    expect(pages.stale).toBe(true);
  });

  it("finds Ready items that only exist on later pages", () => {
    // The first two pages hold only blocked todos, which the Ready view filters out locally.
    const all = [
      ...Array.from({ length: 100 }, (_, index) => item(`blocked-${index}`, { blocked: true })),
      ...Array.from({ length: 30 }, (_, index) => item(`ready-${index}`)),
    ];
    const server = pagedServer(all, 50);
    let pageCount = 1;
    let visible = 0;
    for (;;) {
      const pages = collectWorkPages(pageCount, server.read);
      visible = pages.items.filter((entry) => itemInView("ready", entry, [])).length;
      if (
        !shouldAutoLoadWorkPage({
          visible,
          hasMore: pages.nextCursor !== null,
          waiting: pages.waiting,
          pageCount,
        })
      ) {
        break;
      }
      pageCount += 1;
    }
    expect(pageCount).toBe(3);
    expect(visible).toBe(30);
  });

  it("stops fetching by itself after its page budget", () => {
    expect(
      shouldAutoLoadWorkPage({
        visible: 0,
        hasMore: true,
        waiting: false,
        pageCount: WORK_AUTO_PAGE_LIMIT,
      }),
    ).toBe(false);
    expect(shouldAutoLoadWorkPage({ visible: 0, hasMore: true, waiting: true, pageCount: 1 })).toBe(
      false,
    );
    expect(
      shouldAutoLoadWorkPage({ visible: 0, hasMore: false, waiting: false, pageCount: 1 }),
    ).toBe(false);
  });

  it("asks the server for todo only in Ready and sizes pages per source kind", () => {
    expect(workViewStatuses("ready")).toEqual(["todo"]);
    expect(workViewStatuses("all")).toBeUndefined();
    expect(workViewStatuses("active")).toBeUndefined();
    expect(workPageLimit("markdown")).toBe(100);
    expect(workPageLimit("jira")).toBe(50);
  });
});

describe("refreshWork", () => {
  it("asks the server to refresh, then refreshes the queries", async () => {
    const calls: Array<string> = [];
    const refreshed = await refreshWork({
      requestServerRefresh: async () => {
        calls.push("server");
        return { _tag: "Success" };
      },
      refreshQueries: () => calls.push("queries"),
    });
    expect(refreshed).toBe(true);
    expect(calls).toEqual(["server", "queries"]);
  });

  it("still refreshes the queries when the server refresh fails", async () => {
    const calls: Array<string> = [];
    const refreshed = await refreshWork({
      requestServerRefresh: async () => ({ _tag: "Failure" }),
      refreshQueries: () => calls.push("queries"),
    });
    expect(refreshed).toBe(false);
    expect(calls).toEqual(["queries"]);
  });
});
