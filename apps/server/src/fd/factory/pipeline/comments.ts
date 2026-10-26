import type { FactoryDeliveryStatus } from "@t3tools/contracts/fd/factory";

import { carriesAiAttribution, namesAiTool } from "../git/publishedText.ts";
import { needsYou } from "../snapshot.ts";
import type { FactoryBlock, FactoryDeliveryState } from "./state.ts";

/**
 * The Work comment a delivery's transition posts on its item, so a tracker shows what Factory
 * needs from the owner, or that the work is ready, without Foredeck open. Pure: the worker posts
 * what this returns once the step that made the transition is stored.
 */

/**
 * The statuses whose entry is announced: blocked and waiting need the owner; the others report.
 * Cancelled is announced only when the pull request closed: the owner's own cancel needs no word.
 */
export type FactoryCommentedStatus = Extract<
  FactoryDeliveryStatus,
  "blocked" | "waiting" | "approved" | "pr_open" | "cancelled"
>;

export interface FactoryTransitionComment {
  readonly status: FactoryCommentedStatus;
  readonly body: string;
}

/** A mention, which would notify someone on GitHub or Jira under the owner's credentials. */
const MENTION = /(?<![\w@])@[A-Za-z0-9]/;

const publishable = (text: string) =>
  !namesAiTool(text) && !carriesAiAttribution(text) && !MENTION.test(text);

/**
 * The first of the texts that names no AI agent, model or provider, carries no attribution and
 * mentions no one, else `fixed`, which never does. Each text drops more of the facts that can
 * bring those in: a quoted commit subject or branch, a review problem, an error tag, a repository
 * name in a URL.
 */
const firstPublishable = (texts: ReadonlyArray<string>, fixed: string) =>
  texts.find(publishable) ?? fixed;

/**
 * The block with none of the free text its problems, failure detail or planner's note quote, so
 * its message is the reason's fixed text alone. The other reasons' facts are roles, statuses,
 * stages and counts.
 */
const withoutFreeText = (block: FactoryBlock): FactoryBlock => {
  switch (block.reason) {
    case "unsettled":
    case "invalid_submission":
      return { ...block, problems: [] };
    case "effect_failed":
      return { ...block, detail: "Factory could not complete a step." };
    case "plan_empty":
      return { ...block, note: null };
    default:
      return block;
  }
};

const BLOCKED = "Factory is blocked on this item and needs you.";
const BLOCKED_ACTION = "Resume or cancel the delivery in Foredeck.";
const blockedBody = (reason: string | undefined) =>
  reason === undefined ? `${BLOCKED} ${BLOCKED_ACTION}` : `${BLOCKED} ${reason} ${BLOCKED_ACTION}`;

/**
 * The comment for moving from `before` to `after`: one for entering blocked, waiting, approved or
 * pr_open from any other status, or cancelled because the pull request closed without merging,
 * none for staying in a status or entering any other. A blocked comment gives the block's message,
 * as the delivery's `needsYou` does, and keeps the reason's fixed text when it drops the facts; an
 * approved one the approved commit, the one the last receipt verified, and that its pull request
 * is being opened unless it is a child, whose parent's pull request carries it; a pr_open one the
 * pull request's number and URL, and so does a closed one.
 */
export const transitionComment = (
  before: FactoryDeliveryState,
  after: FactoryDeliveryState,
): FactoryTransitionComment | undefined => {
  if (after.status === before.status) return undefined;
  switch (after.status) {
    case "blocked": {
      const { block } = after;
      return {
        status: "blocked",
        body: firstPublishable(
          [
            blockedBody(needsYou(after)),
            ...(block === null
              ? []
              : [blockedBody(needsYou({ ...after, block: withoutFreeText(block) }))]),
          ],
          blockedBody(undefined),
        ),
      };
    }
    case "waiting":
      return {
        status: "waiting",
        body: "Factory is waiting for your decision on this item in Foredeck.",
      };
    case "approved": {
      const commit = after.receipts.at(-1)?.headSha;
      const next = after.kind === "child" ? "" : ", and is opening its pull request";
      const fixed = `Factory approved this item after verify and review${next}.`;
      return {
        status: "approved",
        body:
          commit === undefined
            ? fixed
            : firstPublishable(
                [`Factory approved commit ${commit} for this item after verify and review${next}.`],
                fixed,
              ),
      };
    }
    case "pr_open": {
      const { pullRequest } = after;
      if (pullRequest === null) {
        return { status: "pr_open", body: "Factory opened a pull request for this item." };
      }
      const opened = `Factory opened pull request #${pullRequest.number} for this item.`;
      return {
        status: "pr_open",
        body: firstPublishable([`${opened} ${pullRequest.url}`], opened),
      };
    }
    case "cancelled": {
      const { pullRequest } = after;
      if (pullRequest?.outcome !== "closed") return undefined;
      const closed = `Pull request #${pullRequest.number} for this item was closed without merging, so Factory cancelled the delivery; its worktree, branch and commits stay.`;
      return {
        status: "cancelled",
        body: firstPublishable([`${closed} ${pullRequest.url}`], closed),
      };
    }
    default:
      return undefined;
  }
};
