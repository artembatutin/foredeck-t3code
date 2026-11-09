import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import type {
  WorkErrorReasonValue,
  WorkItemDetail,
  WorkItemId,
  WorkItemSummary,
  WorkListQuery,
  WorkListResult,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HandoffBackend } from "../assistant/index.ts";
import {
  actorFromCaller,
  actorFromSession,
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

/** How long the overview waits on a Work source before showing its rows without its facts. */
const SUMMARIES_TIMEOUT = "3 seconds";

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

  const summaries: Backend["summaries"] = (refs) =>
    Effect.gen(function* () {
      const bySource = new Map<WorkSourceId, Array<WorkItemId>>();
      for (const { sourceId, itemId } of refs) {
        bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), itemId]);
      }
      const read = yield* Effect.forEach(
        [...bySource],
        ([sourceId, itemIds]) =>
          work.currentSummaries(sourceId, itemIds).pipe(
            Effect.timeoutOption(SUMMARIES_TIMEOUT),
            Effect.map(Option.getOrElse(() => [])),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.as(Effect.logWarning("assistant overview read no Work facts", cause), []),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return read.flat().map((summary) => ({
        ref: summary.ref,
        title: summary.title,
        status: summary.status,
        statusName: summary.nativeStatus?.name ?? null,
        assignee: summary.assignee?.label ?? null,
      }));
    });

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
          sources.map(({ sourceId, kind, label, identity, version }) => ({
            sourceId,
            kind,
            label,
            identity,
            version,
          })),
        ),
        Effect.mapError(failed("sources")),
      ),
    read,
    summaries,
    // What a capture writes is the whole body, as written: a read of it fingerprints the same.
    fingerprint: ({ kind, title, body }) =>
      workItemScopeFingerprint({ kind, title, body, bodyTruncated: false, bodyFidelity: "exact" }),
    findByMarker,
    // An owner writes under their own session's grants, as their client reaches Work. An agent
    // takes Work's own grant for agents: a read-only client or a plan-mode thread only reads.
    writer: (input) => {
      const actor = HandoffBackend.isHandoffOwner(input)
        ? actorFromSession(input)
        : actorFromCaller(input);
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
