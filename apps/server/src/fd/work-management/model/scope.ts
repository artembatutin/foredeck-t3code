// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps this a pure function.
import * as NodeCrypto from "node:crypto";

import type { WorkItemDetail } from "@t3tools/contracts/fd/work-management";

import { splitNotes } from "../documents/taskFiles.ts";

/** What of an item states its scope, and so its fingerprint. */
type ScopedItem = Pick<
  WorkItemDetail,
  "kind" | "title" | "body" | "bodyTruncated" | "bodyFidelity"
>;

/**
 * The item's body split into what it states and the comments section it keeps in the body. Only a
 * Markdown task keeps one, its `## Notes`, which Work appends to on every comment; GitHub and Jira
 * keep comments apart from the body.
 */
const split = (item: Pick<WorkItemDetail, "kind" | "body">) =>
  item.kind === "markdown" ? splitNotes(item.body) : { rest: item.body, notes: "" };

/** Line breaks as `\n`, without trailing whitespace on a line or blank lines at the end. */
const normalized = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/, "");

/**
 * A fingerprint of what the given text says: its title and its body without comments, with whether
 * it holds all of the body and all of its content. Two readings of an unedited item fingerprint
 * equally, however many comments were added in between or how the source spells line ends, so a
 * changed fingerprint means someone changed what the item asks for. A source takes this from the
 * whole body, before it cuts that for the wire.
 */
export const workItemContentFingerprint = (item: ScopedItem): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        item.title,
        normalized(split(item).rest),
        item.bodyTruncated,
        item.bodyFidelity,
      ]),
    )
    .digest("hex");

/**
 * The fingerprint of an item as read or as rendered for writing. A read carries the one its source
 * took from the whole body, which wins: its bounded text cannot see an edit past the cut, and a
 * comment growing a Markdown task across the cap would read as a change to what it asks. An item
 * rendered for writing is whole already, so reads back the same.
 */
export const workItemScopeFingerprint = (
  item: ScopedItem & Partial<Pick<WorkItemDetail, "scopeFingerprint">>,
): string => item.scopeFingerprint ?? workItemContentFingerprint(item);

/**
 * What a link keeps and a read reports of an item. Nothing for an item its source cannot read
 * cleanly, whose text says nothing of what it asks: a broken file is not a changed requirement.
 */
export const workItemLinkScope = (
  item: ScopedItem &
    Partial<Pick<WorkItemDetail, "scopeFingerprint">> &
    Pick<WorkItemDetail, "invalid">,
): { readonly scopeFingerprint?: string } =>
  item.invalid === null ? { scopeFingerprint: workItemScopeFingerprint(item) } : {};

/**
 * The comments section the item keeps in its body, as written: a Markdown task's `## Notes`, or
 * empty. A writer replacing what the item says puts it back after the new text, so no comment is
 * lost.
 */
export const workItemNotes = (item: Pick<WorkItemDetail, "kind" | "body">): string =>
  split(item).notes;
