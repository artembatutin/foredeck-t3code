import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type {
  WorkErrorReasonValue,
  WorkItemDetail,
  WorkItemSummary,
  WorkListQuery,
  WorkListResult,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";

import { HandoffBackend } from "../assistant/index.ts";
import {
  actorFromCaller,
  type WorkActor,
  type WorkDomainError,
  workItemNotes,
  workItemScopeFingerprint,
  WorkService,
} from "../work-management/index.ts";

/** Who the assistant's own reads are made as: the server checking an item, not an agent. */
const reader: WorkActor = {
  id: "assistant:handoff",
  grants: [AuthWorkReadScope],
  label: "the project assistant",
};

/** Each page a marker lookup reads holds this many items. */
const LOOKUP_PAGE = 100;

/** Work's own category for each of its failures, as its transports report it. */
const REASONS: Readonly<Record<WorkDomainError["_tag"], WorkErrorReasonValue>> = {
  WorkPermissionDenied: "forbidden",
  WorkSourceNotFound: "not_found",
  WorkItemNotFound: "not_found",
  WorkStale: "stale",
  WorkSourceStale: "stale",
  WorkConflict: "conflict",
  WorkUnsupported: "unsupported",
  WorkInvalid: "invalid_request",
  WorkUnavailable: "unavailable",
  WorkUnauthenticated: "unauthenticated",
  WorkForbidden: "forbidden",
  WorkRateLimited: "rate_limited",
};

const failed =
  (operation: HandoffBackend.HandoffBackendError["operation"]) => (cause: WorkDomainError) =>
    new HandoffBackend.HandoffBackendError({ operation, reason: REASONS[cause._tag], cause });

const itemOf = (detail: WorkItemDetail): HandoffBackend.HandoffItem => ({
  ref: detail.ref,
  key: detail.key,
  url: detail.url,
  title: detail.title,
  status: detail.status,
  revision: detail.revision,
  invalid: detail.invalid !== null,
  body: detail.body,
  fingerprint: workItemScopeFingerprint(detail),
  notes: workItemNotes(detail),
});

type Backend = typeof HandoffBackend.HandoffBackend.Service;

/** The assistant's Work port over Work's service; see `HandoffBackend`. */
export const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;

  /** Every page of a listing: its items, and whether any page was stale. */
  const listAll = (query: Omit<WorkListQuery, "cursor" | "limit">) =>
    Effect.gen(function* () {
      const items: Array<WorkItemSummary> = [];
      let stale = false;
      let cursor: string | null = null;
      do {
        const page: WorkListResult = yield* work.listItems(reader, {
          ...query,
          limit: LOOKUP_PAGE,
          ...(cursor === null ? {} : { cursor }),
        });
        stale ||= page.stale;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { items, stale };
    });

  const read: Backend["read"] = (ref) =>
    work
      .refresh(reader, {})
      .pipe(
        Effect.andThen(work.getItem(reader, { ref })),
        Effect.map(itemOf),
        Effect.mapError(failed("read")),
      );

  const findByMarker: Backend["findByMarker"] = ({ sourceId, marker }) =>
    Effect.gen(function* () {
      yield* work.refresh(reader, {});
      const { stored } = yield* work.resolveSource(sourceId);
      const searched = yield* listAll({ sourceId, search: marker });
      // A search matches loosely; only a body that carries the marker counts.
      const listed = yield* Effect.forEach(searched.items, ({ ref }) =>
        work.getItem(reader, { ref }).pipe(Effect.map(itemOf)),
      );
      const items = listed.filter(({ body }) => body.includes(marker));
      // A tracker's search may not show an item created moments ago, so its miss proves nothing.
      if (stored.kind !== "markdown") return { items, complete: false };
      // Markdown lists a file it cannot read as invalid, with no body for a search to match: it
      // could be the item. A stale listing lacks files it never indexed.
      const whole = searched.stale ? searched : yield* listAll({ sourceId });
      return {
        items,
        complete: !whole.stale && whole.items.every(({ invalid }) => invalid === null),
      };
    }).pipe(Effect.mapError(failed("find")));

  return HandoffBackend.HandoffBackend.of({
    sources: (projectId) =>
      work.listSources(reader, { projectId, includeDisconnected: false }).pipe(
        Effect.map(({ sources }) =>
          sources.map(({ sourceId, kind, label }) => ({ sourceId, kind, label })),
        ),
        Effect.mapError(failed("sources")),
      ),
    read,
    // What a capture writes is the whole body, as written: a read of it fingerprints the same.
    fingerprint: ({ kind, title, body }) =>
      workItemScopeFingerprint({ kind, title, body, bodyTruncated: false, bodyFidelity: "exact" }),
    findByMarker,
    // Work's own grant for agents: a read-only client or a plan-mode thread only reads.
    writer: (caller) => {
      const actor = actorFromCaller(caller);
      return actor.grants.includes(AuthWorkWriteScope)
        ? Effect.succeed(actor)
        : Effect.fail(new HandoffBackend.HandoffWriteRefused());
    },
    create: (writer, input) =>
      work.createItem(writer, input).pipe(
        Effect.map(({ ref, key, url }) => ({ ref, key, url })),
        Effect.mapError(failed("create")),
      ),
    update: (writer, input) =>
      work.updateItem(writer, input).pipe(Effect.asVoid, Effect.mapError(failed("update"))),
  });
});
