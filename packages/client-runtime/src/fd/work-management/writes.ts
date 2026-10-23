import {
  isWorkNativeStatus,
  WorkItemId,
  type WorkItemRef,
  type WorkItemSummary,
  type WorkNativeStatus,
  type WorkSetStatusInput,
  type WorkStatus,
  type WorkTransition,
} from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Write rules shared by web and mobile: drafts that keep the revision they were started from,
 * stale handling that never drops a draft, revision-guarded status changes and an Undo that only
 * reverses its own action.
 */

/** What a Work write came back with, in the terms the surfaces act on. */
export type WorkWriteOutcome<A> =
  | { readonly _tag: "success"; readonly value: A }
  | { readonly _tag: "stale"; readonly current: WorkItemSummary | null; readonly message: string }
  | { readonly _tag: "candidates"; readonly candidates: ReadonlyArray<WorkTransition> }
  | { readonly _tag: "failed"; readonly message: string };

const FALLBACK_MESSAGE = "The Work request failed.";

/** Reads a settled command result. Non-Work failures keep their own message. */
export function workWriteOutcome<A>(
  result:
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
): WorkWriteOutcome<A> {
  if (result._tag === "Success") return { _tag: "success", value: result.value };
  const error = Option.getOrNull(Cause.findErrorOption(result.cause)) as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
    readonly current?: WorkItemSummary;
    readonly candidates?: ReadonlyArray<WorkTransition>;
  } | null;
  if (error !== null && typeof error === "object" && error._tag === "WorkError") {
    if (error.reason === "stale") {
      return {
        _tag: "stale",
        current: error.current ?? null,
        message: typeof error.message === "string" ? error.message : FALLBACK_MESSAGE,
      };
    }
    if (error.candidates !== undefined) return { _tag: "candidates", candidates: error.candidates };
  }
  const squashed = Cause.squash(result.cause);
  return {
    _tag: "failed",
    message:
      squashed instanceof Error && squashed.message.trim().length > 0
        ? squashed.message
        : FALLBACK_MESSAGE,
  };
}

export type WorkDraftField = "title" | "body";

/**
 * An unsaved title or body edit. `baseRevision` is the item revision when editing began; a
 * background refresh changes the item but never this, so saving refuses to overwrite a change
 * the owner has not seen. `conflict` is set when a save came back stale.
 */
export interface WorkDraft {
  readonly field: WorkDraftField;
  readonly value: string;
  readonly baseRevision: string;
  readonly conflict: { readonly current: WorkItemSummary | null } | null;
}

export const beginWorkDraft = (
  field: WorkDraftField,
  item: Pick<WorkItemSummary, "revision" | "title"> & { readonly body?: string },
): WorkDraft => ({
  field,
  value: field === "title" ? item.title : (item.body ?? ""),
  baseRevision: item.revision,
  conflict: null,
});

export const editWorkDraft = (draft: WorkDraft, value: string): WorkDraft => ({ ...draft, value });

/** The update a draft saves: only its field, guarded by the revision it started from. */
export const workDraftPatch = (ref: WorkItemRef, draft: WorkDraft) =>
  draft.field === "title"
    ? { ref, title: draft.value.trim(), expectedRevision: draft.baseRevision }
    : { ref, body: draft.value, expectedRevision: draft.baseRevision };

/**
 * The draft after a save: gone on success, marked conflicting on stale (the text is kept), and
 * unchanged on any other failure so the owner can retry.
 */
export const settleWorkDraft = (
  draft: WorkDraft,
  outcome: WorkWriteOutcome<unknown>,
): WorkDraft | null => {
  switch (outcome._tag) {
    case "success":
      return null;
    case "stale":
      return { ...draft, conflict: { current: outcome.current } };
    default:
      return draft;
  }
};

/**
 * "Reapply my edit": keep the owner's text and move its base to the item as it is now, so the
 * next save deliberately replaces the newer version the owner has just been shown.
 */
export const rebaseWorkDraft = (draft: WorkDraft, currentRevision: string): WorkDraft => ({
  ...draft,
  baseRevision: currentRevision,
  conflict: null,
});

/**
 * Whether a conflicting draft can be reapplied: the item on screen is newer than the draft's
 * base. Any newer revision will do, not only the one the stale answer named, since another edit
 * may land before the reload; reapplying then overwrites exactly the version on screen.
 */
export const workDraftConflictReady = (draft: WorkDraft, shownRevision: string): boolean =>
  draft.conflict !== null && shownRevision !== draft.baseRevision;

/** Whether a title draft would change anything; a blank title cannot be saved. */
export const workDraftChanged = (
  draft: WorkDraft,
  item: Pick<WorkItemSummary, "title"> & { readonly body?: string },
): boolean =>
  draft.field === "title"
    ? draft.value.trim().length > 0 && draft.value.trim() !== item.title
    : draft.value !== (item.body ?? "");

/** A status change guarded by the revision the owner was looking at. */
export const workStatusInput = (
  item: Pick<WorkItemSummary, "ref" | "revision">,
  change: { readonly status: WorkNativeStatus } | { readonly transitionId: string },
): WorkSetStatusInput => ({ ref: item.ref, ...change, expectedRevision: item.revision });

/**
 * The Undo for a status change, or null when there is nothing to reverse. It is guarded by the
 * revision the change itself produced, so if anyone (another client, an agent, the source)
 * wrote the item since, the Undo fails as stale instead of overwriting their change.
 */
export const workStatusUndo = (
  before: { readonly status: WorkStatus },
  after: Pick<WorkItemSummary, "ref" | "revision" | "status">,
): WorkSetStatusInput | null =>
  isWorkNativeStatus(before.status) && before.status !== after.status
    ? { ref: after.ref, status: before.status, expectedRevision: after.revision }
    : null;

/** What the owner is told when an Undo did not apply. */
export const workUndoMessage = (key: string, outcome: WorkWriteOutcome<unknown>): string | null => {
  switch (outcome._tag) {
    case "success":
      return null;
    case "stale":
      return `${key} changed after that action, so Undo was not applied. Review it and change it by hand.`;
    case "candidates":
      return `${key} has several ways back; change its status by hand.`;
    case "failed":
      return outcome.message;
  }
};

/**
 * Adds text to an unsent composer draft without replacing it. The addition goes after the
 * owner's text; adding the same text twice is a no-op.
 */
export const mergeComposerText = (existing: string, addition: string): string => {
  if (existing.trim().length === 0) return addition;
  if (existing.includes(addition)) return existing;
  return `${existing.trimEnd()}\n\n${addition}`;
};

const isWorkItemId = Schema.is(WorkItemId);

export type WorkRelationshipField = "parent" | "blockedBy";

/**
 * A parent or blocked-by edit. Like a title draft it keeps the revision it started from:
 * blocked-by replaces the whole set, so saving from an older view must not erase a blocker
 * someone added since.
 */
export interface WorkRelationshipDraft {
  readonly field: WorkRelationshipField;
  readonly value: string;
  readonly baseRevision: string;
}

export const workRelationshipText = (
  item: Pick<WorkItemSummary, "parent" | "blockedBy">,
  field: WorkRelationshipField,
): string => (field === "parent" ? (item.parent ?? "") : item.blockedBy.join(", "));

export const beginWorkRelationshipDraft = (
  item: Pick<WorkItemSummary, "parent" | "blockedBy" | "revision">,
  field: WorkRelationshipField,
): WorkRelationshipDraft => ({
  field,
  value: workRelationshipText(item, field),
  baseRevision: item.revision,
});

/** The guarded update a relationship draft saves, or why it cannot be saved. */
export const workRelationshipPatch = (
  draft: WorkRelationshipDraft,
):
  | {
      readonly patch:
        | { readonly parent: WorkItemId | null; readonly expectedRevision: string }
        | { readonly blockedBy: Array<WorkItemId>; readonly expectedRevision: string };
    }
  | { readonly invalid: string } => {
  const parsed = parseWorkItemIds(draft.value);
  if (parsed.invalid.length > 0) return { invalid: `Not item ids: ${parsed.invalid.join(", ")}` };
  if (draft.field === "parent") {
    if (parsed.ids.length > 1) return { invalid: "Enter one item id." };
    return { patch: { parent: parsed.ids[0] ?? null, expectedRevision: draft.baseRevision } };
  }
  return { patch: { blockedBy: [...parsed.ids], expectedRevision: draft.baseRevision } };
};

/**
 * Item ids typed by the owner for parent or blocked-by, separated by commas or spaces. A leading
 * `#` (GitHub's display key) is dropped; anything else that is not an id is returned as invalid.
 */
export const parseWorkItemIds = (
  text: string,
): { readonly ids: ReadonlyArray<WorkItemId>; readonly invalid: ReadonlyArray<string> } => {
  const ids: Array<WorkItemId> = [];
  const invalid: Array<string> = [];
  for (const token of text.split(/[\s,]+/)) {
    const value = token.replace(/^#/, "");
    if (value.length === 0) continue;
    if (!isWorkItemId(value)) invalid.push(token);
    else if (!ids.includes(value)) ids.push(value);
  }
  return { ids, invalid };
};

/** Threads of the item's project the owner can link: open, not yet linked, matching the search. */
export const workLinkCandidates = <
  Shell extends {
    readonly environmentId: string;
    readonly projectId: string;
    readonly id: string;
    readonly title: string;
    readonly archivedAt: string | null;
  },
>(
  shells: ReadonlyArray<Shell>,
  input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly linked: ReadonlyArray<string>;
    readonly query: string;
    readonly limit?: number;
  },
): ReadonlyArray<Shell> => {
  const needle = input.query.trim().toLowerCase();
  return shells
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.projectId === input.projectId &&
        shell.archivedAt === null &&
        !input.linked.includes(shell.id) &&
        (needle.length === 0 || shell.title.toLowerCase().includes(needle)),
    )
    .slice(0, input.limit ?? 50);
};
