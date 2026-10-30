import type { ProjectId } from "@t3tools/contracts";
import {
  WorkErrorReason,
  type WorkErrorReasonValue,
  type WorkItemId,
  type WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { Caller } from "../../mcp/threadAccess.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import * as Portfolio from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as WorkCaptureStore from "./WorkCaptureStore.ts";

const ListedSource = Schema.Struct({
  sourceId: Schema.String,
  kind: Schema.String,
  label: Schema.String,
});

const listed = (sources: ReadonlyArray<typeof ListedSource.Type>) =>
  sources.length === 0
    ? "none"
    : sources.map((source) => `${source.sourceId} (${source.kind}, ${source.label})`).join("; ");

/** Nothing was written: the call cannot capture as asked. */
export class WorkCaptureRefused extends Schema.TaggedError<WorkCaptureRefused>()(
  "WorkCaptureRefused",
  {
    reason: Schema.Literals([
      "not_assistant",
      "read_only",
      "incomplete_brief",
      "no_sources",
      "several_sources",
      "unknown_source",
      "source_changed",
      "source_inactive",
      "tracker_parent",
      "item_missing",
      "item_closed",
      "item_invalid",
      "external_edit",
      "item_unconfirmed",
      "recover_mismatch",
      "recover_unneeded",
      "no_capture",
      "in_use",
      "in_flight",
    ]),
    /** The sources the refusal names: the project's, or its Markdown ones for a parent. */
    sources: Schema.optionalKey(Schema.Array(ListedSource)),
  },
) {
  override get message(): string {
    const sources = listed(this.sources ?? []);
    switch (this.reason) {
      case "not_assistant":
        return "Only the project assistant can capture work.";
      case "read_only":
        return "This caller can only read Work (a thread in plan mode, or a client approved read-only), so nothing was captured.";
      case "incomplete_brief":
        return "Save the idea's agreed goal and at least one acceptance criterion with assistant_revise_brief before capturing it.";
      case "no_sources":
        return "This project has no active Work source. Add one in Project settings → Work sources, then capture again.";
      case "several_sources":
        return `This project has several Work sources. Ask the owner which one to use and pass its sourceId. Sources: ${sources}.`;
      case "unknown_source":
        return `That is not an active Work source of this project. Sources: ${sources}.`;
      case "source_changed":
        return "This idea is already captured in another Work source. Abandon the capture first to capture it in a different one.";
      case "source_inactive":
        return "The Work source this idea was captured in is not active. Restore it in Project settings → Work sources, or abandon the capture.";
      case "tracker_parent":
        return `Only an item in a Markdown source can be delivered as a parent, because its tasks become task files there; nothing was copied. Capture it as single${this.sources?.length ? `, or in one of this project's Markdown sources: ${sources}` : ", or add a Markdown source in Project settings → Work sources"}.`;
      case "item_missing":
        return "The captured Work item no longer exists in its source. Abandon the capture to capture the idea again.";
      case "item_closed":
        return "The captured Work item is done or cancelled, so it was not changed. Reopen it in Work, or abandon the capture to capture a new item.";
      case "item_invalid":
        return "Work cannot read the captured item cleanly, so it was not changed. Fix it in its source and capture again.";
      case "external_edit":
        return "The captured Work item was changed outside the assistant since it was captured, so nothing was written. Show the owner the item in Work, and capture again with overwrite only if they want the brief to replace those changes.";
      case "item_unconfirmed":
        return "No read has confirmed what the captured Work item says since the assistant wrote it, and it now says neither what was written nor what the brief says, so nothing was written. Show the owner the item in Work, and capture again with overwrite only if they want the brief to replace what it says.";
      case "recover_mismatch":
        return "That Work item's description does not open with this capture's marker, so it was not adopted.";
      case "recover_unneeded":
        return "recoverItem applies only to a capture whose item is uncertain.";
      case "no_capture":
        return "This idea has no capture to abandon.";
      case "in_use":
        return "A Factory assignment that has not ended uses this capture. Cancel the assignment before abandoning the capture.";
      case "in_flight":
        return "This idea's capture is being written now. Try again once it finishes.";
    }
  }
}

const workReasonText: Readonly<Record<WorkErrorReasonValue, string>> = {
  invalid_request: "the source refused it as invalid",
  not_found: "the source or item was not found",
  forbidden: "the credential is not allowed to do this",
  unsupported: "the source cannot store it as written",
  stale: "the item changed meanwhile",
  conflict: "the source reported a conflict",
  unavailable: "the source is unavailable",
  unauthenticated: "the source needs its credential renewed",
  rate_limited: "the source is rate limiting requests",
};

/** The assistant cannot tell whether the source holds the write. */
export class WorkCaptureUncertain extends Schema.TaggedError<WorkCaptureUncertain>()(
  "WorkCaptureUncertain",
  {
    operation: Schema.Literals(["create", "update"]),
    uncertainty: Schema.Literals(["unconfirmed", "ambiguous", "incomplete", "not_found"]),
    captureId: Schema.String,
    /** The capture's source is GitHub or Jira, whose search cannot prove an item absent. */
    tracker: Schema.Boolean,
    workReason: Schema.optionalKey(WorkErrorReason),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const why = this.workReason === undefined ? "" : ` (${workReasonText[this.workReason]})`;
    if (this.operation === "update") {
      return `The Work source did not confirm the update${why}, and the item now differs from what was captured. Show the owner the item in Work; capture again with overwrite to rewrite it.`;
    }
    const finding = {
      unconfirmed: `The Work source did not confirm the new item${why}.`,
      ambiguous: `More than one Work item opens with this capture's marker (${this.captureId}).`,
      incomplete: `The Work source could not be read completely${why}, so the assistant cannot tell which item, if any, is the one with this capture's marker (${this.captureId}).`,
      not_found: `No Work item with this capture's marker (${this.captureId}) was found, but a tracker can take a while to show a new item.`,
    }[this.uncertainty];
    return this.tracker
      ? `${finding} Look for it in the source: pass recoverItem with its id to adopt it, or, if it is not there, abandon the capture so the next capture creates a new item.`
      : `${finding} Capture again to look for it once more, pass recoverItem with its id to adopt one, or abandon the capture so the next capture creates a new item.`;
  }
}

/** Work or the assistant's own records failed; `stage` says what the failure left behind. */
export class WorkCaptureFailed extends Schema.TaggedError<WorkCaptureFailed>()(
  "WorkCaptureFailed",
  {
    stage: Schema.Literals(["work", "update", "record", "storage", "interrupted"]),
    workReason: Schema.optionalKey(WorkErrorReason),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const why = this.workReason === undefined ? "" : ` (${workReasonText[this.workReason]})`;
    switch (this.stage) {
      case "work":
        return `Work could not be read${why}, so nothing was captured. Try again.`;
      case "update":
        return `The Work source refused the update${why}; the item is unchanged.`;
      case "record":
        return "The Work item was written, but the assistant could not record it. Capture again to record it; no second item is created.";
      case "storage":
        return "The assistant's records could not be read or written, so nothing was captured. Try again.";
      case "interrupted":
        return "The capture was cut short because the server is stopping. Capture again once it is back; no second item is created.";
    }
  }
}

export type WorkCaptureError = WorkCaptureRefused | WorkCaptureUncertain | WorkCaptureFailed;

type CaptureKind = WorkCaptureStore.StoredCapture["kind"];

export interface CaptureInput {
  readonly caller: Caller;
  readonly projectId: ProjectId;
  readonly ideaId: string;
  readonly kind: CaptureKind;
  /** The source to capture in; needed only while the project has several. */
  readonly sourceId?: WorkSourceId | undefined;
  /** Replace an item someone edited since its capture. */
  readonly overwrite?: boolean | undefined;
  /** The item of an uncertain capture, to adopt when its description opens with the marker. */
  readonly recoverItem?: WorkItemId | undefined;
}

interface CapturedItem {
  readonly sourceId: WorkSourceId;
  readonly itemId: WorkItemId;
  readonly key: string | null;
  readonly url: string | null;
}

export interface CaptureResult {
  readonly captureId: string;
  /**
   * `unchanged` wrote nothing: the item already says what the brief does. `verified` confirmed an
   * item no read had confirmed since it was written, which said exactly what was written or what
   * the brief says; `recovered` adopted an item an earlier write left.
   */
  readonly outcome: "created" | "updated" | "unchanged" | "recovered" | "verified";
  readonly kind: CaptureKind;
  readonly item: CapturedItem;
  /** Whether a read after the write recorded the item's fingerprint, which execution needs. */
  readonly verified: boolean;
  /** The brief's execution authorization afterwards; a capture never grants it. */
  readonly executionAuthorized: boolean;
}

/**
 * The one Work item an idea is captured as: the agreed brief written to the owner's Work source
 * on the owner's explicit request, and kept up to date on later requests. A capture never
 * launches, queues, calls Factory or grants execution; a capture that changes what the item says
 * clears the brief's execution authorization, in the transaction that records it, so the owner
 * reviews the item before authorizing again.
 *
 * Every item opens with its capture's marker, which names the capture id, so a capture finds its
 * item again after a write it could not record. What an item says is the capture's only when a read
 * shows it says exactly what the capture wrote (or would write now), by Work's own fingerprint: an
 * item edited since, or one no read has confirmed and that says something else, is never rewritten
 * without `overwrite`.
 *
 * One writer per idea runs in the service's scope, and callers join it: a caller that goes away
 * leaves it running. The capture is claimed, with this instance, before the item is created, and
 * the source write and its read-back run uninterruptibly.
 * A claim no writer here can still write (the claiming instance shut down, since one server owns a
 * T3 home, or its writer here has ended) is reconciled by the marker. In a Markdown source read
 * whole, its one item is adopted, or with none the item is created once, with the same marker. A
 * GitHub or Jira item is created at most once and never again, since its search can miss a new
 * item: the one its search shows is adopted, and otherwise `recoverItem` adopts it or the capture
 * is abandoned. Anything else stays uncertain.
 */
export class WorkCapture extends Context.Service<
  WorkCapture,
  {
    readonly capture: (input: CaptureInput) => Effect.Effect<CaptureResult, WorkCaptureError>;
    /**
     * Drops the idea's capture, keeping its history and its item, so the next capture mints a new
     * id and creates a new item. Refused while its writer runs or an unended Factory assignment
     * uses it.
     */
    readonly abandon: (input: {
      readonly caller: Caller;
      readonly projectId: ProjectId;
      readonly ideaId: string;
    }) => Effect.Effect<
      { readonly captureId: string; readonly item: CapturedItem | null },
      WorkCaptureError
    >;
  }
>()("t3/fd/assistant/WorkCapture") {}

const TITLE_MAX = 512;

/** What a captured item's description opens with. */
const markerOf = (captureId: string) =>
  `Captured by the Foredeck project assistant as ${captureId}.`;

/** Whether the description opens with the capture's marker, as only the capture's own item does. */
const opensWithMarker = (body: string, captureId: string) =>
  (body.split("\n", 1)[0] ?? "").trim() === markerOf(captureId);

/** The goal's first line, cut to Work's title bound without splitting a surrogate pair. */
const titleOf = (goal: string) => {
  const line = (goal.split(/\r?\n/, 1)[0] ?? "").trim();
  if (line.length <= TITLE_MAX) return line;
  let end = TITLE_MAX - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
};

const section = (title: string, items: ReadonlyArray<string>, numbered: boolean) =>
  `## ${title}\n\n${
    items.length === 0
      ? "(none recorded)"
      : items.map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${item}`).join("\n")
  }`;

/** The item as the brief states it. */
const render = (brief: Portfolio.ProjectBrief, captureId: string) => ({
  title: titleOf(brief.goal),
  body: [
    markerOf(captureId),
    `## Goal\n\n${brief.goal}`,
    section("Acceptance criteria", brief.acceptanceCriteria, true),
    section("Constraints", brief.constraints, false),
    section("Decisions", brief.decisions ?? [], false),
    section("Open questions", brief.openQuestions, false),
  ].join("\n\n"),
});

const versionOf = ({ captureId, sequence }: WorkCaptureStore.StoredCapture) => ({
  captureId,
  sequence,
});
const fieldsOf = (capture: WorkCaptureStore.StoredCapture): WorkCaptureStore.CaptureFields => {
  const { updatedAt: _updatedAt, sequence: _sequence, ...fields } = capture;
  return fields;
};

/**
 * A decision step: the result, or decide again on what the step stored, which may have adopted
 * or confirmed the item.
 */
type Step =
  | { readonly type: "done"; readonly result: CaptureResult }
  | { readonly type: "again"; readonly found?: "recovered" | "verified" };

const again = (found?: "recovered" | "verified"): Step =>
  found === undefined ? { type: "again" } : { type: "again", found };
/** Decisions per call: adopting, confirming and then updating the item take three, a race one more. */
const MAX_STEPS = 5;

/** An item the capture's write created, before it was recorded. */
interface Unrecorded {
  readonly captureId: string;
  readonly created: HandoffBackend.HandoffCreated;
  readonly fingerprint: string | null;
}

type Slot =
  | {
      readonly type: "capture";
      readonly done: Deferred.Deferred<CaptureResult, WorkCaptureError>;
    }
  | { readonly type: "abandon"; readonly done: Deferred.Deferred<void> };

const refused = (
  reason: WorkCaptureRefused["reason"],
  sources?: ReadonlyArray<HandoffBackend.HandoffSource>,
) =>
  new WorkCaptureRefused({
    reason,
    ...(sources === undefined
      ? {}
      : { sources: sources.map(({ sourceId, kind, label }) => ({ sourceId, kind, label })) }),
  });

const workFailed = (error: HandoffBackend.HandoffBackendError) =>
  new WorkCaptureFailed({ stage: "work", workReason: error.reason, cause: error });
const storageFailed = (cause: unknown) => new WorkCaptureFailed({ stage: "storage", cause });

const assistantOnly = (caller: Caller) => {
  const threadId = caller.scope.thread?.threadId;
  return threadId !== undefined && isAssistantThread(threadId)
    ? Effect.void
    : Effect.fail(refused("not_assistant"));
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const portfolio = yield* PortfolioStore.PortfolioStore;
  const captures = yield* WorkCaptureStore.WorkCaptureStore;
  const backend = yield* HandoffBackend.HandoffBackend;
  const scope = yield* Effect.scope;
  // Recorded on every claim. One server owns a T3 home, so a claim naming another instance was
  // made by a process that has shut down.
  const instanceId = yield* randomUuidV4;
  // The writer (or abandon) running for each idea, and items created but not yet recorded.
  const slots = new Map<string, Slot>();
  const unrecorded = new Map<string, Unrecorded>();

  const keyOf = (projectId: ProjectId, ideaId: string) => `${projectId}\0${ideaId}`;

  const writerOf = (caller: Caller) =>
    backend.writer(caller).pipe(
      Effect.catchTags({
        HandoffWriteRefused: () => Effect.fail(refused("read_only")),
        HandoffBackendError: (error) => Effect.fail(workFailed(error)),
      }),
    );

  const briefOf = (projectId: ProjectId, ideaId: string) =>
    portfolio.getBrief(projectId, ideaId).pipe(
      Effect.mapError(storageFailed),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(refused("incomplete_brief")),
          onSome: (brief) =>
            brief.goal.trim() === "" || brief.acceptanceCriteria.length === 0
              ? Effect.fail(refused("incomplete_brief"))
              : Effect.succeed(brief),
        }),
      ),
    );

  /** The source the capture writes to: its own, the one asked for, or the project's only one. */
  const sourceFor = (
    sources: ReadonlyArray<HandoffBackend.HandoffSource>,
    requested: WorkSourceId | undefined,
    stored: Option.Option<WorkCaptureStore.StoredCapture>,
  ) => {
    if (Option.isSome(stored)) {
      if (requested !== undefined && requested !== stored.value.sourceId) {
        return Effect.fail(refused("source_changed"));
      }
      const own = sources.find((source) => source.sourceId === stored.value.sourceId);
      return own === undefined ? Effect.fail(refused("source_inactive")) : Effect.succeed(own);
    }
    if (sources.length === 0) return Effect.fail(refused("no_sources"));
    if (requested !== undefined) {
      const named = sources.find((source) => source.sourceId === requested);
      return named === undefined
        ? Effect.fail(refused("unknown_source", sources))
        : Effect.succeed(named);
    }
    const [only, ...others] = sources;
    return only === undefined || others.length > 0
      ? Effect.fail(refused("several_sources", sources))
      : Effect.succeed(only);
  };

  const clearAuthorization = (capture: WorkCaptureStore.CaptureFields, key: string | null) =>
    portfolio.reviseBrief({
      projectId: capture.projectId,
      ideaId: capture.ideaId,
      patch: { executionAuthorized: false },
      reason: `Captured as Work item ${key ?? capture.captureId}. The owner reviews it in Work before execution is authorized again.`,
    });

  /**
   * Stores `next` with its event and, when `clear`, clears the brief's execution authorization in
   * the same transaction. None when the capture moved since it was read.
   *
   * The item's fingerprint is the baseline execution and later updates are judged against, so it
   * is recorded only when it is the content recorded with it (`contentHash`): a read showing
   * anything else, even right after the capture's own write, may show an edit that landed in
   * between, and leaves the item unconfirmed for the next capture to confirm or refuse.
   */
  const commit = (
    capture: WorkCaptureStore.StoredCapture,
    next: WorkCaptureStore.CaptureFields,
    event: WorkCaptureStore.CaptureEvent,
    options: { readonly detail?: string; readonly clear: boolean; readonly authorized: boolean },
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const saved = yield* captures.write({
            expected: versionOf(capture),
            next: {
              ...next,
              itemFingerprint:
                next.itemFingerprint === next.contentHash ? next.itemFingerprint : null,
            },
            event,
            ...(options.detail === undefined ? {} : { detail: options.detail }),
          });
          if (Option.isNone(saved)) return Option.none();
          const authorized = options.clear
            ? (yield* clearAuthorization(next, next.itemKey)).executionAuthorized
            : options.authorized;
          return Option.some({ saved: saved.value, authorized });
        }),
      )
      .pipe(Effect.mapError((cause) => new WorkCaptureFailed({ stage: "record", cause })));

  const resultOf = (
    saved: WorkCaptureStore.StoredCapture,
    item: CapturedItem,
    outcome: CaptureResult["outcome"],
    authorized: boolean,
  ): CaptureResult => ({
    captureId: saved.captureId,
    outcome,
    kind: saved.kind,
    item,
    verified: saved.itemFingerprint !== null,
    executionAuthorized: authorized,
  });

  const done = (result: CaptureResult): Step => ({ type: "done", result });

  /**
   * Work's fingerprint of the content as the capture writes it to the source, stored as the
   * capture's `contentHash`: a read of the item fingerprints the same only when it says exactly
   * that.
   */
  const fingerprintOf = (
    source: HandoffBackend.HandoffSource,
    content: { readonly title: string; readonly body: string },
  ) => backend.fingerprint({ kind: source.kind, title: content.title, body: content.body });

  /**
   * The item's fingerprint by a fresh read, or none when that read fails. Recorded only when it
   * is what was written (see `commit`).
   */
  const readBack = (ref: HandoffBackend.HandoffItemRef) =>
    backend.read(ref).pipe(
      Effect.map((item): string | null => item.fingerprint),
      Effect.orElseSucceed(() => null),
    );

  /** Marks a capture whose item is unknown; one already uncertain is left as it is. */
  const markUncertain = (capture: WorkCaptureStore.StoredCapture, detail: string) =>
    capture.state === "uncertain"
      ? Effect.void
      : captures
          .write({
            expected: versionOf(capture),
            next: { ...fieldsOf(capture), state: "uncertain" },
            event: "create_uncertain",
            detail,
          })
          .pipe(
            Effect.asVoid,
            // Left pending, it is reconciled the same way by the next capture.
            Effect.catchTags({
              WorkCaptureStoreError: (error) =>
                Effect.logWarning("Work capture left pending", error),
            }),
          );

  const uncertain = (
    capture: WorkCaptureStore.StoredCapture,
    source: HandoffBackend.HandoffSource,
    uncertainty: WorkCaptureUncertain["uncertainty"],
    error?: HandoffBackend.HandoffBackendError,
  ) =>
    markUncertain(capture, uncertainty).pipe(
      Effect.andThen(
        Effect.fail(
          new WorkCaptureUncertain({
            operation: "create",
            uncertainty,
            captureId: capture.captureId,
            tracker: source.kind !== "markdown",
            ...(error === undefined ? {} : { workReason: error.reason, cause: error }),
          }),
        ),
      ),
    );

  /** Records an item the capture's write created, clearing authorization with it. */
  const recordCreated = (
    capture: WorkCaptureStore.StoredCapture,
    written: Omit<Unrecorded, "captureId">,
  ) =>
    Effect.gen(function* () {
      const key = keyOf(capture.projectId, capture.ideaId);
      const { created, fingerprint } = written;
      const committed = yield* commit(
        capture,
        {
          ...fieldsOf(capture),
          state: "captured",
          writerInstanceId: instanceId,
          itemId: created.ref.itemId,
          itemKey: created.key,
          itemUrl: created.url,
          itemFingerprint: fingerprint,
        },
        "created",
        { clear: true, authorized: false },
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new WorkCaptureFailed({ stage: "record" })),
            onSome: Effect.succeed,
          }),
        ),
        // The item exists: the next writer here records it instead of creating another.
        Effect.tapError(() =>
          Effect.sync(() => unrecorded.set(key, { captureId: capture.captureId, ...written })),
        ),
      );
      unrecorded.delete(key);
      return done(
        resultOf(
          committed.saved,
          {
            sourceId: created.ref.sourceId,
            itemId: created.ref.itemId,
            key: created.key,
            url: created.url,
          },
          "created",
          committed.authorized,
        ),
      );
    });

  /**
   * Claims the capture for this instance (a new one when `expected` is null), then creates its
   * item and reads it back without interruption, and records it. A create that fails leaves the
   * capture uncertain: the source may hold the item all the same.
   */
  const create = (
    input: CaptureInput,
    brief: Portfolio.ProjectBrief,
    source: HandoffBackend.HandoffSource,
    writer: HandoffBackend.HandoffWriter,
    expected: WorkCaptureStore.StoredCapture | null,
    captureId: string,
  ) =>
    Effect.gen(function* () {
      const content = render(brief, captureId);
      const claimed = yield* captures
        .write({
          expected: expected === null ? null : versionOf(expected),
          next: {
            projectId: input.projectId,
            ideaId: input.ideaId,
            captureId,
            sourceId: source.sourceId,
            kind: input.kind,
            state: "pending",
            writerInstanceId: instanceId,
            itemId: null,
            itemKey: null,
            itemUrl: null,
            itemFingerprint: null,
            contentHash: fingerprintOf(source, content),
            scopeHash: Portfolio.briefScopeHash(brief),
            briefRevision: brief.revision,
          },
          event: "claimed",
        })
        .pipe(Effect.mapError(storageFailed));
      if (Option.isNone(claimed)) return again();
      const written = yield* Effect.uninterruptible(
        backend
          .create(writer, { sourceId: source.sourceId, title: content.title, body: content.body })
          .pipe(
            Effect.flatMap((created) =>
              readBack(created.ref).pipe(Effect.map((fingerprint) => ({ created, fingerprint }))),
            ),
            Effect.result,
          ),
      );
      if (Result.isFailure(written)) {
        return yield* uncertain(claimed.value, source, "unconfirmed", written.failure);
      }
      return yield* recordCreated(claimed.value, written.success);
    });

  /**
   * Records an item found for the capture; the next step brings it up to date with the brief.
   * Finding it shows which item is the capture's, not what it says: its content is confirmed only
   * when it says exactly what the claim wrote (see `commit`), and is otherwise left for the next
   * step to confirm.
   */
  const adopt = (
    capture: WorkCaptureStore.StoredCapture,
    item: HandoffBackend.HandoffItem,
    detail: "marker" | "recover_item",
  ) =>
    commit(
      capture,
      {
        ...fieldsOf(capture),
        state: "captured",
        writerInstanceId: instanceId,
        itemId: item.ref.itemId,
        itemKey: item.key,
        itemUrl: item.url,
        itemFingerprint: item.fingerprint,
      },
      "recovered",
      { detail, clear: true, authorized: false },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => unrecorded.delete(keyOf(capture.projectId, capture.ideaId))),
      ),
      Effect.map((committed) => (Option.isSome(committed) ? again("recovered") : again())),
    );

  /** A capture no writer can still be writing: find its item by the marker, or create it once. */
  const reconcile = (
    input: CaptureInput,
    brief: Portfolio.ProjectBrief,
    source: HandoffBackend.HandoffSource,
    writer: HandoffBackend.HandoffWriter,
    capture: WorkCaptureStore.StoredCapture,
  ) =>
    Effect.gen(function* () {
      const found = yield* backend
        .findByMarker({ sourceId: capture.sourceId, marker: capture.captureId })
        .pipe(Effect.result);
      if (Result.isFailure(found)) {
        return yield* uncertain(capture, source, "incomplete", found.failure);
      }
      const matches = found.success.items.filter((item) =>
        opensWithMarker(item.body, capture.captureId),
      );
      const [match, ...others] = matches;
      if (match !== undefined && others.length > 0) {
        return yield* uncertain(capture, source, "ambiguous");
      }
      // A Markdown capture may be created again once a whole read finds none, so only a whole read
      // shows that its one match is the only item, or that it has none. A tracker's is created at
      // most once and never again, and its search never reads whole.
      const whole = source.kind === "markdown" && found.success.complete;
      if (match !== undefined && (whole || source.kind !== "markdown")) {
        return yield* adopt(capture, match, "marker");
      }
      if (match === undefined && whole) {
        return yield* create(input, brief, source, writer, capture, capture.captureId);
      }
      return yield* uncertain(
        capture,
        source,
        source.kind === "markdown" ? "incomplete" : "not_found",
      );
    });

  /** Adopts the item named for an uncertain capture, when it is the capture's own. */
  const recover = (capture: WorkCaptureStore.StoredCapture, itemId: WorkItemId) =>
    Effect.gen(function* () {
      const item = yield* backend
        .read({ sourceId: capture.sourceId, itemId })
        .pipe(Effect.mapError(workFailed));
      if (!opensWithMarker(item.body, capture.captureId)) {
        return yield* refused("recover_mismatch");
      }
      return yield* adopt(capture, item, "recover_item");
    });

  /** Brings a recorded item up to date with the brief, unless someone else changed it. */
  const update = (
    input: CaptureInput,
    brief: Portfolio.ProjectBrief,
    source: HandoffBackend.HandoffSource,
    writer: HandoffBackend.HandoffWriter,
    capture: WorkCaptureStore.StoredCapture,
  ) =>
    Effect.gen(function* () {
      if (capture.itemId === null) return yield* Effect.die("A captured capture names its item.");
      const ref = { sourceId: capture.sourceId, itemId: capture.itemId };
      const content = render(brief, capture.captureId);
      const item = yield* backend
        .read(ref)
        .pipe(
          Effect.mapError((error) =>
            error.reason === "not_found" ? refused("item_missing") : workFailed(error),
          ),
        );
      if (item.invalid) return yield* refused("item_invalid");
      if (item.status === "done" || item.status === "cancelled") {
        return yield* refused("item_closed");
      }
      const current: CapturedItem = {
        sourceId: ref.sourceId,
        itemId: ref.itemId,
        key: item.key,
        url: item.url,
      };
      const intended = fingerprintOf(source, content);
      if (capture.itemFingerprint === null) {
        // No read has confirmed the item since it was written (its read-back failed, an update's
        // outcome was lost, or it was adopted saying something else). Only what the item actually
        // says confirms it: exactly what was written, or what the brief says now.
        const now = item.fingerprint === intended;
        if (now || item.fingerprint === capture.contentHash) {
          const confirmed = yield* commit(
            capture,
            {
              ...fieldsOf(capture),
              itemFingerprint: item.fingerprint,
              ...(now
                ? {
                    contentHash: intended,
                    scopeHash: Portfolio.briefScopeHash(brief),
                    briefRevision: brief.revision,
                  }
                : {}),
            },
            "recovered",
            { detail: "verified", clear: true, authorized: brief.executionAuthorized },
          );
          return Option.isSome(confirmed) ? again("verified") : again();
        }
        if (input.overwrite !== true) return yield* refused("item_unconfirmed");
      }
      const edited =
        capture.itemFingerprint !== null && item.fingerprint !== capture.itemFingerprint;
      const sameContent = intended === capture.contentHash;
      const sameKind = input.kind === capture.kind;
      if (capture.itemFingerprint !== null && !edited && sameContent) {
        if (sameKind)
          return done(resultOf(capture, current, "unchanged", brief.executionAuthorized));
        // The item says the same; delivering it as another kind still needs authorizing again.
        const recorded = yield* commit(
          capture,
          { ...fieldsOf(capture), kind: input.kind },
          "updated",
          {
            detail: "kind",
            clear: true,
            authorized: brief.executionAuthorized,
          },
        );
        return Option.match(recorded, {
          onNone: () => again(),
          onSome: ({ saved, authorized }) => done(resultOf(saved, current, "updated", authorized)),
        });
      }
      if (edited && input.overwrite !== true) return yield* refused("external_edit");
      const written = yield* Effect.uninterruptible(
        backend
          .update(writer, {
            ref,
            expectedRevision: item.revision,
            title: content.title,
            // Comments the item keeps in its body stay after the new text.
            body: item.notes === "" ? content.body : `${content.body}\n\n${item.notes}`,
          })
          .pipe(Effect.andThen(readBack(ref)), Effect.result),
      );
      if (Result.isSuccess(written)) {
        const updated = yield* commit(
          capture,
          {
            ...fieldsOf(capture),
            kind: input.kind,
            itemKey: item.key,
            itemUrl: item.url,
            itemFingerprint: written.success,
            contentHash: intended,
            scopeHash: Portfolio.briefScopeHash(brief),
            briefRevision: brief.revision,
          },
          "updated",
          { clear: true, authorized: brief.executionAuthorized },
        );
        return Option.match(updated, {
          onNone: () => again(),
          onSome: ({ saved, authorized }) => done(resultOf(saved, current, "updated", authorized)),
        });
      }
      const failure = written.failure;
      // Changed after the read above: the write was refused, and the change is someone else's.
      if (failure.reason === "stale") return yield* refused("external_edit");
      const reread = yield* backend.read(ref).pipe(Effect.option);
      if (Option.isSome(reread) && reread.value.fingerprint === item.fingerprint) {
        return yield* new WorkCaptureFailed({
          stage: "update",
          workReason: failure.reason,
          cause: failure,
        });
      }
      // The item may say what was written or something else: neither is verified any more.
      yield* commit(capture, { ...fieldsOf(capture), itemFingerprint: null }, "update_uncertain", {
        detail: failure.reason,
        clear: true,
        authorized: brief.executionAuthorized,
      }).pipe(
        Effect.catchTags({
          WorkCaptureFailed: (error) =>
            Effect.logWarning("Work capture update left unrecorded", error),
        }),
      );
      return yield* new WorkCaptureUncertain({
        operation: "update",
        uncertainty: "unconfirmed",
        captureId: capture.captureId,
        tracker: false,
        workReason: failure.reason,
        cause: failure,
      });
    });

  /**
   * One decision on what the capture holds now, and the write it calls for. `recoverItem` is the
   * input's until an item is adopted.
   */
  const decide = (
    input: CaptureInput,
    writer: HandoffBackend.HandoffWriter,
    recoverItem: WorkItemId | undefined,
  ) =>
    Effect.gen(function* () {
      const brief = yield* briefOf(input.projectId, input.ideaId);
      const stored = yield* captures
        .get(input.projectId, input.ideaId)
        .pipe(Effect.mapError(storageFailed));
      const sources = yield* backend.sources(input.projectId).pipe(Effect.mapError(workFailed));
      const source = yield* sourceFor(sources, input.sourceId, stored);
      if (input.kind === "parent" && source.kind !== "markdown") {
        return yield* refused(
          "tracker_parent",
          sources.filter(({ kind }) => kind === "markdown"),
        );
      }
      if (Option.isNone(stored)) {
        if (recoverItem !== undefined) return yield* refused("recover_unneeded");
        const uuid = yield* randomUuidV4;
        return yield* create(input, brief, source, writer, null, `cap-${uuid}`);
      }
      const capture = stored.value;
      if (capture.state === "captured") {
        if (recoverItem !== undefined) return yield* refused("recover_unneeded");
        return yield* update(input, brief, source, writer, capture);
      }
      if (recoverItem !== undefined) return yield* recover(capture, recoverItem);
      // This instance created the item and could not record it: record it now.
      const left = unrecorded.get(keyOf(input.projectId, input.ideaId));
      if (capture.state === "pending" && left?.captureId === capture.captureId) {
        return yield* recordCreated(capture, left);
      }
      // This call is the idea's only writer here, so whichever writer claimed the capture, in a
      // process that shut down or in this one, has stopped writing.
      return yield* reconcile(input, brief, source, writer, capture);
    });

  const run = (input: CaptureInput, writer: HandoffBackend.HandoffWriter) =>
    Effect.gen(function* () {
      // What an earlier step found, reported when nothing more had to be written.
      let found: "recovered" | "verified" | undefined;
      let recoverItem = input.recoverItem;
      for (let step = 0; step < MAX_STEPS; step++) {
        const next = yield* decide(input, writer, recoverItem);
        if (next.type === "done") {
          return found !== undefined && next.result.outcome === "unchanged"
            ? { ...next.result, outcome: found }
            : next.result;
        }
        found ??= next.found;
        // An adopted item is the capture's: the item named to recover has been taken.
        if (next.found === "recovered") recoverItem = undefined;
      }
      return yield* new WorkCaptureFailed({ stage: "storage" });
    });

  /** Settles a writer's callers; a writer cut short by shutdown failed, not succeeded. */
  const settled = (
    exit: Exit.Exit<CaptureResult, WorkCaptureError>,
  ): Exit.Exit<CaptureResult, WorkCaptureError> =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Exit.fail(new WorkCaptureFailed({ stage: "interrupted" }))
      : exit;

  /**
   * The idea's running writer or abandon, or a new writer running `work` in the service's scope.
   * Registered and forked without interruption, so a caller interrupted meanwhile never leaves a
   * slot without a writer. The writer's fiber starts uninterruptible and only its work can be
   * interrupted, so a shutdown that cuts it, even before it ran, still settles the slot.
   */
  const slotFor = (key: string, work: Effect.Effect<CaptureResult, WorkCaptureError>) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const running = slots.get(key);
        if (running !== undefined) return Effect.succeed(running);
        const slot: Slot = { type: "capture", done: Deferred.makeUnsafe() };
        slots.set(key, slot);
        return Effect.interruptible(work).pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              slots.delete(key);
              return Deferred.done(slot.done, settled(exit));
            }),
          ),
          Effect.forkIn(scope, { uninterruptible: true }),
          Effect.as(slot),
        );
      }),
    );

  const capture: WorkCapture["Service"]["capture"] = (input) =>
    Effect.gen(function* () {
      yield* assistantOnly(input.caller);
      const writer = yield* writerOf(input.caller);
      const key = keyOf(input.projectId, input.ideaId);
      for (;;) {
        const slot = yield* slotFor(key, run(input, writer));
        if (slot.type === "capture") return yield* Deferred.await(slot.done);
        // An abandon runs: once it ends, this capture starts afresh.
        yield* Deferred.await(slot.done);
      }
    });

  const abandon: WorkCapture["Service"]["abandon"] = (input) =>
    Effect.gen(function* () {
      yield* assistantOnly(input.caller);
      yield* writerOf(input.caller);
      const key = keyOf(input.projectId, input.ideaId);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const slot: Slot = { type: "abandon", done: Deferred.makeUnsafe() };
          const free = yield* Effect.sync(() => {
            if (slots.has(key)) return false;
            slots.set(key, slot);
            return true;
          });
          if (!free) return yield* refused("in_flight");
          return yield* restore(
            Effect.gen(function* () {
              const stored = yield* captures
                .get(input.projectId, input.ideaId)
                .pipe(Effect.mapError(storageFailed));
              if (Option.isNone(stored)) return yield* refused("no_capture");
              const capture = stored.value;
              const outcome = yield* captures
                .abandon({
                  projectId: input.projectId,
                  ideaId: input.ideaId,
                  expected: versionOf(capture),
                })
                .pipe(Effect.mapError(storageFailed));
              if (outcome === "in_use") return yield* refused("in_use");
              if (outcome === "moved") return yield* refused("in_flight");
              unrecorded.delete(key);
              return {
                captureId: capture.captureId,
                item:
                  capture.itemId === null
                    ? null
                    : {
                        sourceId: capture.sourceId,
                        itemId: capture.itemId,
                        key: capture.itemKey,
                        url: capture.itemUrl,
                      },
              };
            }),
          ).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                slots.delete(key);
                return Deferred.done(slot.done, Exit.void);
              }),
            ),
          );
        }),
      );
    });

  return WorkCapture.of({ capture, abandon });
});

export const layer = Layer.effect(WorkCapture, make);
