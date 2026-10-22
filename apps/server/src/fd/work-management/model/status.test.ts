import type { WorkNativeStatus } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import {
  fromGitHubState,
  fromJiraStatusCategory,
  GITHUB_STATE_REASONS,
  GITHUB_WRITABLE_STATUSES,
  isOpenStatus,
  JIRA_CANCELLED_RESOLUTIONS,
  JIRA_WRITABLE_STATUSES,
  jiraCategoryFor,
  MARKDOWN_WRITABLE_STATUSES,
  toGitHubState,
} from "./status.ts";

const NATIVE_STATUSES: ReadonlyArray<WorkNativeStatus> = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
];

describe("fromGitHubState", () => {
  it("maps state and reason to a native status", () => {
    const cases = [
      ["open", null, "todo"],
      ["open", undefined, "todo"],
      ["open", "reopened", "todo"],
      ["closed", "completed", "done"],
      ["closed", "not_planned", "cancelled"],
      ["closed", "duplicate", "cancelled"],
      ["closed", null, "done"],
      ["closed", undefined, "done"],
    ] as const;
    for (const [state, reason, expected] of cases) {
      expect(fromGitHubState(state, reason), `${state}/${String(reason)}`).toBe(expected);
    }
  });

  it("reads every known reason on a closed issue as a native status", () => {
    for (const reason of GITHUB_STATE_REASONS) {
      expect(NATIVE_STATUSES).toContain(fromGitHubState("closed", reason));
    }
  });
});

describe("toGitHubState", () => {
  it("writes the state and reason for each supported status", () => {
    expect(toGitHubState("todo")).toEqual({ state: "open", stateReason: "reopened" });
    expect(toGitHubState("done")).toEqual({ state: "closed", stateReason: "completed" });
    expect(toGitHubState("cancelled")).toEqual({ state: "closed", stateReason: "not_planned" });
  });

  it("has no representation for in_progress", () => {
    expect(toGitHubState("in_progress")).toBeUndefined();
  });

  it("round-trips through fromGitHubState for every writable status", () => {
    for (const status of GITHUB_WRITABLE_STATUSES) {
      const written = toGitHubState(status);
      expect(written, status).toBeDefined();
      if (written === undefined) continue;
      expect(fromGitHubState(written.state, written.stateReason), status).toBe(status);
    }
  });
});

describe("fromJiraStatusCategory", () => {
  it("maps the three status categories", () => {
    expect(fromJiraStatusCategory("new", null)).toBe("todo");
    expect(fromJiraStatusCategory("indeterminate", null)).toBe("in_progress");
    expect(fromJiraStatusCategory("done", null)).toBe("done");
    expect(fromJiraStatusCategory("done", undefined)).toBe("done");
    expect(fromJiraStatusCategory("done", "Fixed")).toBe("done");
  });

  it("reads a done category with a cancelling resolution as cancelled, ignoring case", () => {
    for (const resolution of JIRA_CANCELLED_RESOLUTIONS) {
      expect(fromJiraStatusCategory("done", resolution), resolution).toBe("cancelled");
      expect(fromJiraStatusCategory("done", resolution.toUpperCase()), resolution).toBe(
        "cancelled",
      );
      expect(fromJiraStatusCategory("done", resolution.toLowerCase()), resolution).toBe(
        "cancelled",
      );
    }
  });

  it("only applies the resolution to the done category", () => {
    expect(fromJiraStatusCategory("new", "Won't Do")).toBe("todo");
    expect(fromJiraStatusCategory("indeterminate", "Duplicate")).toBe("in_progress");
  });

  it("reads any other category as unknown", () => {
    expect(fromJiraStatusCategory("undefined", null)).toBe("unknown");
    expect(fromJiraStatusCategory("", "Won't Do")).toBe("unknown");
    expect(fromJiraStatusCategory("DONE", null)).toBe("unknown");
  });
});

describe("jiraCategoryFor", () => {
  it("names the category each native status lands in", () => {
    expect(jiraCategoryFor("todo")).toBe("new");
    expect(jiraCategoryFor("in_progress")).toBe("indeterminate");
    expect(jiraCategoryFor("done")).toBe("done");
    expect(jiraCategoryFor("cancelled")).toBe("done");
  });

  it("agrees with fromJiraStatusCategory for every writable status", () => {
    for (const status of JIRA_WRITABLE_STATUSES) {
      expect(fromJiraStatusCategory(jiraCategoryFor(status), null), status).toBe(status);
    }
  });
});

describe("writable statuses", () => {
  it("lists what each source kind accepts", () => {
    expect(MARKDOWN_WRITABLE_STATUSES).toEqual(["todo", "in_progress", "done", "cancelled"]);
    expect(GITHUB_WRITABLE_STATUSES).toEqual(["todo", "done", "cancelled"]);
    expect(JIRA_WRITABLE_STATUSES).toEqual(["todo", "in_progress", "done"]);
  });

  it("matches the GitHub write table exactly", () => {
    for (const status of NATIVE_STATUSES) {
      expect(toGitHubState(status) !== undefined, status).toBe(
        GITHUB_WRITABLE_STATUSES.includes(status),
      );
    }
  });
});

describe("isOpenStatus", () => {
  it("treats todo, in_progress and unknown as open", () => {
    expect(isOpenStatus("todo")).toBe(true);
    expect(isOpenStatus("in_progress")).toBe(true);
    expect(isOpenStatus("unknown")).toBe(true);
  });

  it("treats done and cancelled as closed", () => {
    expect(isOpenStatus("done")).toBe(false);
    expect(isOpenStatus("cancelled")).toBe(false);
  });
});
