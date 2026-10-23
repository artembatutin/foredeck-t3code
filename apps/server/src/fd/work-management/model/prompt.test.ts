import { describe, expect, it } from "@effect/vitest";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

import {
  PROMPT_COMMENTS_MAX,
  renderWorkPrompt,
  workBranchName,
  workThreadTitle,
  type WorkPromptItem,
} from "./prompt.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");

const item = (overrides: Partial<WorkPromptItem> = {}): WorkPromptItem => ({
  ref: { sourceId, itemId: WorkItemId.make("fd-7k3qa2") },
  kind: "markdown",
  key: "fd-7k3qa2",
  title: "Add Jira sync",
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: "high",
  labels: ["work", "jira"],
  assignee: null,
  parent: null,
  blockedBy: [],
  url: null,
  updatedAt: null,
  revision: "sha256:1",
  invalid: null,
  body: "Map ADF to Markdown.",
  bodyTruncated: false,
  bodyFidelity: "exact",
  comments: [],
  commentsTruncated: false,
  children: [],
  blocking: [],
  transitions: [],
  locator: ".foredeck/work/fd-7k3qa2-add-jira-sync.md",
  ...overrides,
});

describe("workBranchName", () => {
  it("keys each source the way a branch can carry it", () => {
    expect(workBranchName(item())).toBe("work/fd-7k3qa2-add-jira-sync");
    expect(
      workBranchName(
        item({ kind: "github", ref: { sourceId, itemId: WorkItemId.make("123") }, key: "#123" }),
      ),
    ).toBe("work/gh-123-add-jira-sync");
    expect(
      workBranchName(item({ kind: "jira", ref: { sourceId, itemId: WorkItemId.make("PROJ-12") } })),
    ).toBe("work/PROJ-12-add-jira-sync");
  });

  it("bounds the slug and drops characters a branch cannot use", () => {
    const name = workBranchName(item({ title: `Fix: "crash" on ~/path..${"x".repeat(80)}` }));
    expect(name).toMatch(/^work\/fd-7k3qa2-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual("work/fd-7k3qa2-".length + 40);
    expect(workBranchName(item({ title: "!!!" }))).toBe("work/fd-7k3qa2");
  });
});

describe("renderWorkPrompt", () => {
  it("carries the item, its reference, the mode and the tool rules", () => {
    const prompt = renderWorkPrompt({
      item: item(),
      mode: "implement",
      directory: ".foredeck/work",
    });
    expect(prompt).toContain("Work item fd-7k3qa2 (markdown): Add Jira sync");
    expect(prompt).toContain("File: .foredeck/work/fd-7k3qa2-add-jira-sync.md");
    expect(prompt).toContain("Labels: work, jira");
    expect(prompt).toContain(`work-item: ${sourceId}:fd-7k3qa2`);
    expect(prompt).toContain("titled `fd-7k3qa2: ...`");
    expect(prompt).toContain("Do not edit the frontmatter of .foredeck/work/*.md");
  });

  it("keeps only recent comments and appends the owner's text", () => {
    const comments = Array.from({ length: PROMPT_COMMENTS_MAX + 3 }, (_, index) => ({
      id: `c${index}`,
      author: { id: "a", label: "Ann" },
      body: `comment ${index}`,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: null,
    }));
    const prompt = renderWorkPrompt({
      item: item({ comments }),
      mode: "scope",
      extra: "Focus on the API.",
    });
    expect(prompt).not.toContain("comment 2\n");
    expect(prompt).toContain(`comment ${PROMPT_COMMENTS_MAX + 2}`);
    expect(prompt).toContain("Change no files");
    expect(prompt.endsWith("Focus on the API.")).toBe(true);
    expect(prompt).not.toContain("frontmatter");
  });
});

describe("workThreadTitle", () => {
  it("prefixes the key and fits the title limit", () => {
    expect(workThreadTitle(item())).toBe("fd-7k3qa2: Add Jira sync");
    expect(workThreadTitle(item({ title: "y".repeat(200) })).length).toBe(100);
  });
});
