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
 * A fingerprint of what the item says: its title and its body without comments, with whether the
 * read holds all of the body and all of its content. Two reads of an unedited item fingerprint
 * equally, however many comments were added in between or how the source spells line ends, so a
 * changed fingerprint means someone changed what the item asks for. Accepts an item rendered for
 * writing as well as one read back.
 */
export const workItemScopeFingerprint = (item: ScopedItem): string =>
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
 * The comments section the item keeps in its body, as written: a Markdown task's `## Notes`, or
 * empty. A writer replacing what the item says puts it back after the new text, so no comment is
 * lost.
 */
export const workItemNotes = (item: Pick<WorkItemDetail, "kind" | "body">): string =>
  split(item).notes;
