import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildThreadActivityFileParams } from "./threadActivityFileNavigation";

describe("thread activity file navigation", () => {
  it("keeps inherited activity file links on the currently selected thread", () => {
    const sourceThreadId = ThreadId.make("source-thread");
    const currentThreadId = ThreadId.make("current-thread");

    const params = buildThreadActivityFileParams({
      environmentId: EnvironmentId.make("environment"),
      currentThreadId,
      activitySourceThreadId: sourceThreadId,
      relativePath: "apps/mobile/src/index.ts",
      line: 12,
    });

    expect(params).toEqual({
      environmentId: "environment",
      threadId: "current-thread",
      path: ["apps", "mobile", "src", "index.ts"],
      line: "12",
    });
  });
  it("retains absolute paths so a secondary repository link cannot become relative to the primary", () => {
    const params = buildThreadActivityFileParams({
      environmentId: EnvironmentId.make("host"),
      currentThreadId: ThreadId.make("thread"),
      activitySourceThreadId: ThreadId.make("thread"),
      relativePath: "/separate/client/src/index.ts",
    });
    expect(params.path.join("/")).toBe("/separate/client/src/index.ts");
  });
});
