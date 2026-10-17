import { describe, expect, it } from "vite-plus/test";

import type { ReviewSectionItem, ReviewSectionKind } from "./reviewModel";
import { buildReviewSectionMenu } from "./review-section-menu";

function section(id: string, kind: ReviewSectionKind): ReviewSectionItem {
  return {
    id,
    kind,
    title: id,
    subtitle: null,
    diff: null,
    isLoading: false,
  };
}

describe("buildReviewSectionMenu", () => {
  it("exposes git scopes and the latest turn at the top level", () => {
    const turn28 = section("turn:28", "turn");
    const turn27 = section("turn:27", "turn");
    const workingTree = section("git:working-tree", "working-tree");
    const branchChanges = section("git:branch-range", "branch-range");

    expect(buildReviewSectionMenu([turn28, turn27, workingTree, branchChanges])).toEqual({
      conversation: null,
      workingTree,
      branchChanges,
      latestTurn: turn28,
      turns: [turn28, turn27],
    });
  });

  it("lists the combined conversation diff separately from individual turns", () => {
    const conversation = section("thread", "thread");
    const turn = section("turn:2", "turn");
    const menu = buildReviewSectionMenu([conversation, turn]);
    expect(menu.conversation).toBe(conversation);
    expect(menu.latestTurn).toBe(turn);
    expect(menu.turns).toEqual([turn]);
  });

  it("keeps unavailable scopes empty while data loads", () => {
    expect(buildReviewSectionMenu([])).toEqual({
      conversation: null,
      workingTree: null,
      branchChanges: null,
      latestTurn: null,
      turns: [],
    });
  });
});
