import { ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { transitionComment } from "./comments.ts";
import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "./state.ts";

const pullRequest = {
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  headBranch: "work/fd-aaaaaa-add-export",
};

/** A single item with its pull request open. */
const prOpen: FactoryDeliveryState = {
  ...queuedDeliveryState({ branch: pullRequest.headBranch, baseRef: "HEAD" }),
  status: "pr_open",
  stage: "pr",
  worktreePath: "/worktrees/fd-aaaaaa",
  baseline: "b".repeat(40),
  threads: { author: ThreadId.make("thread-author"), reviewer: ThreadId.make("thread-reviewer") },
  effectsIssued: 6,
  pullRequest,
};

const closed: FactoryEvent = { type: "pr.closed", number: 7, url: pullRequest.url };
const merged: FactoryEvent = { type: "pr.merged", number: 7, url: pullRequest.url };

/** The comment the step that folds `event` into `before` records, as the worker derives it. */
const commentOf = (before: FactoryDeliveryState, event: FactoryEvent) =>
  transitionComment(before, advance(before, event).delivery);

const closedText =
  "Pull request #7 for this item was closed without merging, so Factory cancelled the delivery; its worktree, branch and commits stay.";

describe("transitionComment for a pull request closed without merging", () => {
  it("announces the cancel the close made, with the pull request's number and URL", () => {
    expect(commentOf(prOpen, closed)).toEqual({
      status: "cancelled",
      body: `${closedText} ${pullRequest.url}`,
    });
  });

  it("says nothing for the owner's own cancel, whatever the delivery was doing", () => {
    expect(commentOf(prOpen, { type: "cancel" })).toBeUndefined();
    const closingOut = advance(prOpen, merged).delivery;
    expect(commentOf(closingOut, { type: "cancel" })).toBeUndefined();
    const running = { ...prOpen, status: "running" as const, pullRequest: null };
    expect(commentOf(running, { type: "cancel" })).toBeUndefined();
  });

  it("says nothing for a merge, its close-out or a repeated close", () => {
    const closingOut = advance(prOpen, merged).delivery;
    expect(transitionComment(prOpen, closingOut)).toBeUndefined();
    expect(commentOf(closingOut, { type: "closed_out", effectId: 7 })).toBeUndefined();
    const cancelled = advance(prOpen, closed).delivery;
    expect(commentOf(cancelled, closed)).toBeUndefined();
  });

  it("drops a URL that names an AI tool, keeping the fixed text", () => {
    const named = { ...pullRequest, url: "https://github.com/acme/claude-tools/pull/7" };
    const before = { ...prOpen, pullRequest: named };
    expect(commentOf(before, { ...closed, url: named.url })).toEqual({
      status: "cancelled",
      body: closedText,
    });
  });

  it("announces a closed parent's cancel on the parent as a single item's", () => {
    const children = [FactoryDeliveryId.make("child-1")];
    const parent = { ...prOpen, kind: "parent" as const, children, approvedChildren: children };
    expect(commentOf(parent, closed)).toEqual(commentOf(prOpen, closed));
  });
});
