import { FactoryTaskId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryAuthorItem } from "./author.ts";
import { integrateCriteria, integrateThreadTitle, renderIntegratePrompt } from "./integrate.ts";
import { renderReviewPrompt } from "./review.ts";

const item = {
  ref: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-parent"),
  },
  key: "fd-parent",
  title: "Export the table",
  url: null,
  locator: "tasks/fd-parent.md",
  body: "Users can export the current table.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

const base = "b".repeat(40);
const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: "2026-10-25T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-parent/verify-1.log",
  outputHash: "output-1",
};

const tasks = [
  {
    id: FactoryTaskId.make("export-csv"),
    title: "Export the current table as CSV",
    acceptance: ["The export downloads the visible rows as CSV.", "Commas in a cell are quoted."],
  },
  {
    id: FactoryTaskId.make("export-header"),
    title: "Write a header row first",
    acceptance: ["The CSV starts with the column names."],
  },
];

const prompt = renderIntegratePrompt({
  item,
  branch: "work/fd-parent",
  baseRef: "HEAD",
  base,
  receipt,
  tasks,
});

describe("renderIntegratePrompt", () => {
  it("names the branch, where it started, its base ref and the verified commit", () => {
    for (const expected of [
      "Factory integrate review of Work item fd-parent: Export the table",
      "work-item: 7e2aa85e-9347-44ce-b019-cb8dfd365b20:fd-parent",
      "Users can export the current table.",
      "the whole branch `work/fd-parent`",
      `commit ${base} (created from \`HEAD\`)`,
      `\`${base}..${receipt.headSha}\``,
      `- Commit: ${receipt.headSha} (tree ${receipt.tree})`,
    ]) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).not.toContain(receipt.logPath);
  });

  it("lists every task's title and criteria in plan order, numbered across the plan", () => {
    const listed = [
      "Task 1 of 2, `export-csv`: Export the current table as CSV",
      "- Criterion 1: The export downloads the visible rows as CSV.",
      "- Criterion 2: Commas in a cell are quoted.",
      "Task 2 of 2, `export-header`: Write a header row first",
      "- Criterion 3: The CSV starts with the column names.",
    ];
    const positions = listed.map((line) => prompt.indexOf(line));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    // The review answers each of those numbers, through the tool and the fenced fallback.
    expect(prompt).toContain(
      "- `acceptance`: one entry for each criterion numbered above, 1 to 3, with that number as its `criterion`.",
    );
    expect(prompt).toContain("Call the `factory_submit_review` tool once");
    expect(prompt).toContain("one fenced ```json block");
    expect(integrateCriteria(tasks)).toEqual([
      { criterion: 1, taskId: "export-csv", text: tasks[0]?.acceptance[0] },
      { criterion: 2, taskId: "export-csv", text: tasks[0]?.acceptance[1] },
      { criterion: 3, taskId: "export-header", text: tasks[1]?.acceptance[0] },
    ]);
  });

  it("keeps a task review's prompt to its own item's criteria", () => {
    const review = renderReviewPrompt({ item, branch: "work/fd-parent", baseline: base, receipt });
    expect(review).toContain(
      "- `acceptance`: one entry per acceptance criterion of the item, numbered from 1 in the order its description gives them (when it lists none, the behavior it asks for is criterion 1). Each has",
    );
    expect(review).not.toContain("Criterion 1:");
  });

  it("titles the thread for the parent item, within the thread title limit", () => {
    expect(integrateThreadTitle(item)).toBe("Integrate fd-parent: Export the table");
    expect(integrateThreadTitle({ key: "fd-parent", title: "x".repeat(200) })).toHaveLength(100);
  });
});
