import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type { FactoryAuthorItem } from "./author.ts";
import {
  type FactoryReviewPromptInput,
  renderReviewPrompt,
  renderReviewRetryPrompt,
  reviewThreadTitle,
} from "./review.ts";

const item = {
  ref: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-aaaaaa"),
  },
  key: "fd-aaaaaa",
  title: "Add the export button",
  url: "https://example.com/items/fd-aaaaaa",
  locator: "tasks/fd-aaaaaa.md",
  body: "Users can export the current table as CSV.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

const baseline = "b".repeat(40);
const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:02:03.000Z",
  code: 0,
  timedOut: false,
  durationMs: 123_400,
  command: { executable: "vp", args: ["test", "run", "--reporter", "dot"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
};

const prompt = renderReviewPrompt({ item, branch: "work/fd-aaaaaa", baseline, receipt });

describe("renderReviewPrompt", () => {
  it("takes the item and the verified commit, and nothing from the author thread", () => {
    expectTypeOf<keyof FactoryReviewPromptInput>().toEqualTypeOf<
      "item" | "branch" | "baseline" | "receipt"
    >();
    expectTypeOf<keyof FactoryAuthorItem>().toEqualTypeOf<
      "ref" | "key" | "title" | "url" | "locator" | "body" | "bodyTruncated"
    >();
  });

  it("names the item, the branch and the commit range under review", () => {
    for (const expected of [
      "Factory review of Work item fd-aaaaaa: Add the export button",
      "Link: https://example.com/items/fd-aaaaaa",
      "work-item: 7e2aa85e-9347-44ce-b019-cb8dfd365b20:fd-aaaaaa",
      "Users can export the current table as CSV.",
      "branch `work/fd-aaaaaa`",
      `\`${baseline}..${receipt.headSha}\``,
    ]) {
      expect(prompt).toContain(expected);
    }
  });

  it("summarizes the verify receipt without its log", () => {
    expect(prompt).toContain(
      [
        "The server verified this commit:",
        "- Command: `vp test run --reporter dot`",
        `- Commit: ${receipt.headSha} (tree ${receipt.tree})`,
        "- Result: exit code 0 after 123 s, from 2026-10-24T10:00:00.000Z to 2026-10-24T10:02:03.000Z",
      ].join("\n"),
    );
    expect(prompt).not.toContain(receipt.logPath);
    expect(prompt).not.toContain(receipt.outputHash);
  });

  it.each([
    [{ code: null, timedOut: true }, "timed out"],
    [{ code: null, timedOut: false }, "ended by a signal"],
  ] as const)("describes a run that %j as %s", (overrides, result) => {
    expect(
      renderReviewPrompt({ item, branch: "b", baseline, receipt: { ...receipt, ...overrides } }),
    ).toContain(`- Result: ${result} after 123 s`);
  });

  it("asks for the tool submission and the same review in a final fenced json block", () => {
    expect(prompt).toContain("Call the `factory_submit_review` tool once");
    expect(prompt).toContain(
      "End your final message with the same review as JSON in one fenced ```json block",
    );
    const example = /```json\n([\s\S]*?)\n```/.exec(prompt)?.[1];
    expect(example).toBeDefined();
    expect(Object.keys(JSON.parse(example ?? "{}"))).toEqual([
      "verdict",
      "findings",
      "acceptance",
      "missing_evidence",
    ]);
  });

  it("states the reviewer's rules", () => {
    for (const expected of [
      "Review independently and read-only",
      "The server refuses a review once the code under review changes.",
      "not claims",
      "A passing command alone does not prove a behavior",
      "actionable and causal",
      "Do not invent findings",
    ]) {
      expect(prompt).toContain(expected);
    }
  });
});

describe("reviewThreadTitle", () => {
  it("prefixes the item and stays within the thread title limit", () => {
    expect(reviewThreadTitle(item)).toBe("Review fd-aaaaaa: Add the export button");
    expect(reviewThreadTitle({ key: "fd-aaaaaa", title: "x".repeat(200) })).toHaveLength(100);
  });
});

describe("renderReviewRetryPrompt", () => {
  it("lists each problem and asks for the whole review again by both paths", () => {
    const text = renderReviewRetryPrompt({
      problems: ["Your final message has no fenced ```json block.", "Criterion 2 is repeated."],
    });
    expect(text).toContain("- Your final message has no fenced ```json block.");
    expect(text).toContain("- Criterion 2 is repeated.");
    expect(text).toContain("`factory_submit_review`");
    expect(text).toContain("one fenced ```json block");
    expect(text).toContain("Change no file.");
  });
});
