import { describe, expect, it } from "@effect/vitest";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { namesAiTool } from "@t3tools/shared/fd/publishedNames";

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
  it("keys each source the way a branch can carry it, under the neutral prefix", () => {
    expect(workBranchName(item())).toBe("feature/fd-7k3qa2-add-jira-sync");
    expect(
      workBranchName(
        item({ kind: "github", ref: { sourceId, itemId: WorkItemId.make("123") }, key: "#123" }),
      ),
    ).toBe("feature/gh-123-add-jira-sync");
    expect(
      workBranchName(item({ kind: "jira", ref: { sourceId, itemId: WorkItemId.make("PROJ-12") } })),
    ).toBe("feature/PROJ-12-add-jira-sync");
  });

  it("bounds the slug and drops characters a branch cannot use", () => {
    const name = workBranchName(item({ title: `Fix: "crash" on ~/path..${"x".repeat(80)}` }));
    expect(name).toMatch(/^feature\/fd-7k3qa2-[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual("feature/fd-7k3qa2-".length + 40);
    expect(workBranchName(item({ title: "!!!" }))).toBe("feature/fd-7k3qa2");
  });

  it.each([
    ["Port the Claude adapter", "feature/fd-7k3qa2-port-the-adapter"],
    ["Fix GPT-4 and Codex output", "feature/fd-7k3qa2-fix-4-and-output"],
    ["Use the Cursor agent", "feature/fd-7k3qa2-use-the"],
    // Taking the middle name out joins the two around it into a product form.
    ["cursor claude agent export", "feature/fd-7k3qa2-export"],
    ["Claude", "feature/fd-7k3qa2"],
    ["OpenAI / Gemini", "feature/fd-7k3qa2"],
    // A word that only resembles a name, and the everyday cursor, stay.
    ["Paginate with a database cursor", "feature/fd-7k3qa2-paginate-with-a-database-cursor"],
    ["Thank Claudette", "feature/fd-7k3qa2-thank-claudette"],
  ])("omits prohibited names from the slug of %j", (title, expected) => {
    expect(workBranchName(item({ title }))).toBe(expected);
  });

  it.each([
    ["Made with Cursor", "feature/fd-7k3qa2"],
    ["Fix cursor.com connection", "feature/fd-7k3qa2-fix-connection"],
    ["See https://cursor.sh/docs", "feature/fd-7k3qa2-see-https-docs"],
    ["Export. Co-authored-by: Cursor <cursor@cursor.com>", "feature/fd-7k3qa2-export"],
    ["Export. Signed-off-by: Cursor", "feature/fd-7k3qa2-export"],
    ["Export. Signed-off-by:\n Cursor <editor@example.com>", "feature/fd-7k3qa2-export"],
    ["Export. Signed-off-by:\r\n\tCursor", "feature/fd-7k3qa2-export"],
    ["Export. Signed-off-by: Ada <ada@example.com> and Cursor", "feature/fd-7k3qa2-export"],
    ["Export. Co-authored-by : Cursor", "feature/fd-7k3qa2-export"],
    [
      "Export. Signed-off-by: Ada <ada@example.com>\n Co-authored-by: Cursor",
      "feature/fd-7k3qa2-export",
    ],
    ["Export. Helped-by: Cursor <e@example.com>", "feature/fd-7k3qa2-export"],
    ["Export. Suggested-by: Cursor <e@example.com>", "feature/fd-7k3qa2-export"],
    ["Export. Reported-by :\n Cursor", "feature/fd-7k3qa2-export"],
    ["Export. Made-with\t: Cursor", "feature/fd-7k3qa2-export"],
    ["Export. Made-with: Cursor", "feature/fd-7k3qa2-export"],
    ["Drafted using Cursor.", "feature/fd-7k3qa2"],
    ["Fix the crash using Cursor", "feature/fd-7k3qa2-fix-the-crash"],
    ["Port the Anysphere client", "feature/fd-7k3qa2-port-the-client"],
    ["Port to GPT4 and Claude3", "feature/fd-7k3qa2-port-to-and"],
  ])("omits what only the title shows is a product, in %j", (title, expected) => {
    expect(namesAiTool(title)).toBe(true);
    const name = workBranchName(item({ title }));
    expect(name).toBe(expected);
    expect(namesAiTool(name)).toBe(false);
  });

  it("omits what could only be a product in any case", () => {
    expect(workBranchName(item({ title: "made with cursor" }))).toBe("feature/fd-7k3qa2");
    expect(workBranchName(item({ title: "Ｃｕｒｓｏｒ.ｃｏｍ login" }))).toBe(
      "feature/fd-7k3qa2-login",
    );
  });

  it.each([
    ["Paginate with a database cursor", "paginate-with-a-database-cursor"],
    ["Move the cursor to the end", "move-the-cursor-to-the-end"],
    ["Cursor-based pagination", "cursor-based-pagination"],
    ["Paginate with Cursor-based tokens", "paginate-with-cursor-based-tokens"],
    ["Select text with the cursor", "select-text-with-the-cursor"],
    ["Use the built-in cursor", "use-the-built-in-cursor"],
    ["Pass the cursor in the request", "pass-the-cursor-in-the-request"],
    ["Support gptq weights", "support-gptq-weights"],
  ])("keeps ordinary wording in %j", (title, slug) => {
    expect(namesAiTool(title)).toBe(false);
    const name = workBranchName(item({ title }));
    expect(name).toBe(`feature/fd-7k3qa2-${slug}`);
    expect(namesAiTool(name)).toBe(false);
  });

  it("leaves no name the cut would make out of a longer word", () => {
    const padding = "x".repeat(33);
    expect(workBranchName(item({ title: `${padding} claudette` }))).toBe(
      `feature/fd-7k3qa2-${padding}`,
    );
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
    expect(prompt).toContain("`<type>(<scope>): fd-7k3qa2 <summary>`");
    expect(prompt).not.toContain("titled `fd-7k3qa2:");
    expect(prompt).toContain("Do not edit the frontmatter of `.foredeck/work/*.md`");
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
