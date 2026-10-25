import type { FactoryDeliveryStatus } from "@t3tools/contracts/fd/factory";

import { carriesAiAttribution, namesAiTool } from "../git/publishedText.ts";
import { needsYou } from "../snapshot.ts";
import type { FactoryDeliveryState } from "./state.ts";

/**
 * The Work comment a delivery's transition posts on its item, so a tracker shows what Factory
 * needs from the owner, or that the work is ready, without Foredeck open. Pure: the worker posts
 * what this returns once the step that made the transition is stored.
 */

/** The statuses whose entry is announced: blocked and waiting need the owner; the others report. */
export type FactoryCommentedStatus = Extract<
  FactoryDeliveryStatus,
  "blocked" | "waiting" | "approved" | "pr_open"
>;

export interface FactoryTransitionComment {
  readonly status: FactoryCommentedStatus;
  readonly body: string;
}

/** A mention, which would notify someone on GitHub or Jira under the owner's credentials. */
const MENTION = /(?<![\w@])@[A-Za-z0-9]/;

/**
 * The text with its facts, or the fixed text without them when the facts (a quoted commit
 * subject or branch, a repository name in a URL) would make it name an AI agent, model or
 * provider, carry attribution, or mention someone. The fixed text never does.
 */
const withFacts = (text: string, fixed: string) =>
  namesAiTool(text) || carriesAiAttribution(text) || MENTION.test(text) ? fixed : text;

const BLOCKED = "Factory is blocked on this item and needs you.";
const BLOCKED_ACTION = "Resume or cancel the delivery in Foredeck.";

/**
 * The comment for moving from `before` to `after`: one for entering blocked, waiting, approved or
 * pr_open from any other status, none for staying in a status or entering any other. A blocked
 * comment gives the block's fixed message, as the delivery's `needsYou` does; an approved one the
 * approved commit, the one the last receipt verified; a pr_open one the pull request's number and
 * URL.
 */
export const transitionComment = (
  before: FactoryDeliveryState,
  after: FactoryDeliveryState,
): FactoryTransitionComment | undefined => {
  if (after.status === before.status) return undefined;
  switch (after.status) {
    case "blocked": {
      const fixed = `${BLOCKED} ${BLOCKED_ACTION}`;
      const reason = needsYou(after);
      return {
        status: "blocked",
        body:
          reason === undefined ? fixed : withFacts(`${BLOCKED} ${reason} ${BLOCKED_ACTION}`, fixed),
      };
    }
    case "waiting":
      return {
        status: "waiting",
        body: "Factory is waiting for your decision on this item in Foredeck.",
      };
    case "approved": {
      const commit = after.receipts.at(-1)?.headSha;
      const fixed =
        "Factory approved this item after verify and review, and is opening its pull request.";
      return {
        status: "approved",
        body:
          commit === undefined
            ? fixed
            : withFacts(
                `Factory approved commit ${commit} for this item after verify and review, and is opening its pull request.`,
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
        body: withFacts(`${opened} ${pullRequest.url}`, opened),
      };
    }
    default:
      return undefined;
  }
};
