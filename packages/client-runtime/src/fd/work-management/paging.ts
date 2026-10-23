import type {
  WorkItemSummary,
  WorkListResult,
  WorkNativeStatus,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type { WorkView } from "./model.ts";

/**
 * Paging rules for Work lists, shared by web and mobile. A list is one query per page; page `n`
 * needs page `n - 1`'s cursor, so pages are read in order and the chain stops at the first page
 * that has not arrived yet.
 */

/** The page size a source serves: Markdown pages hold up to 100 items, remote pages 50. */
export const workPageLimit = (kind: WorkSourceKind): number => (kind === "markdown" ? 100 : 50);

/**
 * The statuses a view asks the server for. Ready pushes `todo` down so a backlog of finished or
 * in-progress items cannot fill whole pages with nothing Ready; blocked and open-thread
 * filtering stay on the client because they depend on links and live thread state. Active is
 * any item with an open thread, whatever its status, so it reads every status.
 */
export const workViewStatuses = (view: WorkView): ReadonlyArray<WorkNativeStatus> | undefined => {
  switch (view) {
    case "ready":
      return ["todo"];
    case "done":
      return ["done", "cancelled"];
    case "active":
    case "all":
      return undefined;
  }
};

/** One source's pages, accumulated. */
export interface WorkSourcePages {
  readonly items: ReadonlyArray<WorkItemSummary>;
  /** Where the next page starts; null at the end or while a requested page is still loading. */
  readonly nextCursor: string | null;
  readonly waiting: boolean;
  readonly failed: boolean;
  readonly stale: boolean;
  /** When the newest loaded page last succeeded, for "Refreshed at". */
  readonly updatedAt: number;
}

/**
 * Reads up to `pageCount` pages through `readPage` and merges them. Items repeated across pages
 * (an item that moved while paging) keep their first position.
 */
export function collectWorkPages<E>(
  pageCount: number,
  readPage: (cursor: string | undefined) => AsyncResult.AsyncResult<WorkListResult, E>,
): WorkSourcePages {
  const items: Array<WorkItemSummary> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  let waiting = false;
  let failed = false;
  let stale = false;
  let updatedAt = 0;
  for (let page = 0; page < Math.max(1, pageCount); page += 1) {
    const result = readPage(cursor);
    if (result._tag === "Initial" || result.waiting) waiting = true;
    if (result._tag === "Failure") failed = true;
    if (result._tag === "Success") updatedAt = Math.max(updatedAt, result.timestamp);
    const value = Option.getOrUndefined(AsyncResult.value(result));
    if (value === undefined) {
      nextCursor = null;
      break;
    }
    for (const item of value.items) {
      const key = workItemRefString(item.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    stale = stale || value.stale;
    nextCursor = value.nextCursor;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }
  return { items, nextCursor, waiting, failed, stale, updatedAt };
}

/** How many items a filtered view tries to show before it stops fetching pages by itself. */
export const WORK_WANTED_VISIBLE = 25;
/** The most pages a view fetches without being asked; past it the owner taps Load more. */
export const WORK_AUTO_PAGE_LIMIT = 5;

/**
 * Whether a view should fetch another page on its own: the client-side filter left it short,
 * more pages exist, nothing is in flight, and it has not already fetched its automatic budget.
 */
export const shouldAutoLoadWorkPage = (input: {
  readonly visible: number;
  readonly hasMore: boolean;
  readonly waiting: boolean;
  readonly pageCount: number;
}): boolean =>
  input.hasMore &&
  !input.waiting &&
  input.visible < WORK_WANTED_VISIBLE &&
  input.pageCount < WORK_AUTO_PAGE_LIMIT;

/**
 * An explicit refresh: ask the server to drop its caches (every client then refetches through
 * the refresh subscription), and refresh this client's queries too so a missed or late
 * subscription event cannot leave the view stale. Resolves whether the server refresh worked.
 */
export async function refreshWork(input: {
  readonly requestServerRefresh: () => Promise<{ readonly _tag: "Success" | "Failure" }>;
  readonly refreshQueries: () => void;
}): Promise<boolean> {
  let refreshed = false;
  try {
    refreshed = (await input.requestServerRefresh())._tag === "Success";
  } finally {
    input.refreshQueries();
  }
  return refreshed;
}
