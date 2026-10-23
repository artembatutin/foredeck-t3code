import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { mobileStartInput, parseStatusActionId, statusActionId } from "./actions";

describe("status menu ids", () => {
  it("round-trips statuses and transitions, including ids with colons", () => {
    expect(parseStatusActionId(statusActionId({ status: "done" }))).toEqual({ status: "done" });
    expect(parseStatusActionId(statusActionId({ transitionId: "31:a" }))).toEqual({
      transitionId: "31:a",
    });
  });

  it("ignores ids it does not understand", () => {
    expect(parseStatusActionId("status:blocked")).toBeNull();
    expect(parseStatusActionId("transition:")).toBeNull();
    expect(parseStatusActionId("other")).toBeNull();
  });
});

describe("mobileStartInput", () => {
  it("sends the chosen workspace", () => {
    const ref = {
      sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
      itemId: WorkItemId.make("fd-1"),
    };
    expect(mobileStartInput({ ref, mode: "plan", workspace: "worktree", force: true })).toEqual({
      ref,
      creationSource: "mobile",
      mode: "plan",
      workspaceStrategy: { type: "worktree" },
      force: true,
    });
    expect(
      mobileStartInput({ ref, mode: "implement", workspace: "root", force: false })
        .workspaceStrategy,
    ).toEqual({ type: "root" });
  });
});
