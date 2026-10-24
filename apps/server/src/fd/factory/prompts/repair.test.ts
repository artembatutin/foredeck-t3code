import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { renderFixReviewPrompt } from "./fixReview.ts";
import { renderFixVerifyPrompt } from "./fixVerify.ts";
import { fence, type FactoryReviewFinding } from "./repair.ts";
import { renderReviewFollowUpPrompt } from "./reviewFollowUp.ts";

const branch = "work/fd-aaaaaa";
const baseline = "b".repeat(40);
const receipt = (overrides: Partial<FactoryVerifyReceipt> = {}): FactoryVerifyReceipt => ({
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-24T10:00:00.000Z",
  finishedAt: "2026-10-24T10:02:03.000Z",
  code: 1,
  timedOut: false,
  durationMs: 123_400,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
  ...overrides,
});
const tail = "FAIL src/export.test.ts > exports a header row\nAssertionError: expected 1 to be 2";

const emptyTable: FactoryReviewFinding = {
  id: "empty-table",
  severity: "high",
  required: true,
  file: "src/export.ts",
  line: 12,
  detail: "An empty table exports no header row, so the CSV cannot be re-imported.",
};
const naming: FactoryReviewFinding = {
  id: "export-name",
  severity: "low",
  required: false,
  file: "src/export.ts",
  line: null,
  detail: "The export is named for its format only.",
};

const REASSESS = "Reassess the root cause";

describe("renderFixVerifyPrompt", () => {
  const prompt = renderFixVerifyPrompt({ receipt: receipt(), tail, branch, round: 1 });

  it("names the failed commit, the command, how it ended and the end of its output", () => {
    for (const expected of [
      `Factory verified commit ${"a".repeat(40)} on branch \`${branch}\` and the check failed: exit code 1 after 123 s.`,
      "Command: `vp test run`",
      `The end of its output:\n\`\`\`text\n${tail}\n\`\`\``,
      "find why this check fails and fix it",
      "never adjust expected results to hide a bug",
      "leave the worktree clean",
      "Never name an AI agent, model or provider in commits",
      "never push, merge, switch branches",
    ]) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).not.toContain(REASSESS);
  });

  it("names a timeout", () => {
    expect(
      renderFixVerifyPrompt({
        receipt: receipt({ code: null, timedOut: true }),
        tail,
        branch,
        round: 1,
      }),
    ).toContain("the check failed: timed out after 123 s.");
  });

  it("asks a later round to reassess the root cause", () => {
    expect(renderFixVerifyPrompt({ receipt: receipt(), tail, branch, round: 2 })).toContain(
      `This is repair round 2: the earlier round did not fix it. ${REASSESS}`,
    );
  });

  it("says when the command printed nothing", () => {
    const quiet = renderFixVerifyPrompt({ receipt: receipt(), tail: "", branch, round: 1 });
    expect(quiet).toContain("The command printed nothing.");
    expect(quiet).not.toContain("```text");
  });

  it("keeps a tail with its own fences inside one block", () => {
    const fenced = "```\nnot the end\n```";
    expect(renderFixVerifyPrompt({ receipt: receipt(), tail: fenced, branch, round: 1 })).toContain(
      `\`\`\`\`text\n${fenced}\n\`\`\`\``,
    );
  });
});

describe("fence", () => {
  it.each([
    ["plain text", "x", "```"],
    ["a backtick run of three", "a ``` b", "````"],
    ["a backtick run of five", "`````", "``````"],
  ] as const)("outlasts %s", (_, text, marker) => {
    expect(fence(text)).toBe(`${marker}\n${text}\n${marker}`);
  });
});

describe("renderFixReviewPrompt", () => {
  const prompt = renderFixReviewPrompt({
    headSha: "a".repeat(40),
    findings: [emptyTable, naming],
    otherReasons: ["Criterion 2 is untested.", 'Missing evidence: "the import test".'],
    branch,
    round: 1,
  });

  it("lists each finding to fix with its id, severity, location and detail", () => {
    expect(prompt).toContain(
      [
        "Findings to fix:",
        "- `empty-table` (high, required) at src/export.ts:12: An empty table exports no header row, so the CSV cannot be re-imported.",
        "- `export-name` (low) at src/export.ts: The export is named for its format only.",
      ].join("\n"),
    );
  });

  it("lists the review's other blocking reasons", () => {
    expect(prompt).toContain(
      [
        "Also blocking:",
        "- Criterion 2 is untested.",
        '- Missing evidence: "the import test".',
      ].join("\n"),
    );
  });

  it("asks for a reply by finding id, which the reviewer checks", () => {
    expect(prompt).toContain(`An independent review of commit ${"a".repeat(40)}`);
    expect(prompt).toContain("goes through the findings by id");
    expect(prompt).toContain("The reviewer checks your reply against the code.");
    expect(prompt).not.toContain(REASSESS);
  });

  it("leaves out empty sections and asks a later round to reassess", () => {
    const later = renderFixReviewPrompt({
      headSha: "a".repeat(40),
      findings: [emptyTable],
      otherReasons: [],
      branch,
      round: 2,
    });
    expect(later).not.toContain("Also blocking:");
    expect(later).toContain(
      `This is repair round 2: the earlier round did not fix it. ${REASSESS}`,
    );
  });
});

describe("renderReviewFollowUpPrompt", () => {
  const repaired = receipt({ headSha: "d".repeat(40), tree: "e".repeat(40), code: 0 });
  const reply = "Fixed empty-table: the header row is always written. export-name needs no change.";
  const render = (authorResponse: string | null) =>
    renderReviewFollowUpPrompt({
      round: 2,
      branch,
      baseline,
      receipt: repaired,
      previous: { headSha: "a".repeat(40), findings: [emptyTable, naming] },
      authorResponse,
    });
  const prompt = render(reply);

  it("names the round, the new commit and both ranges", () => {
    for (const expected of [
      "Factory review round 2.",
      `\`${baseline}..${"d".repeat(40)}\``,
      `\`${"a".repeat(40)}..${"d".repeat(40)}\``,
      `Commit: ${"d".repeat(40)} (tree ${"e".repeat(40)})`,
      "exit code 0 after 123 s",
    ]) {
      expect(prompt).toContain(expected);
    }
  });

  it("carries the previous findings by id", () => {
    expect(prompt).toContain(
      [
        `Your previous findings, on ${"a".repeat(40)}:`,
        "- `empty-table` (high, required) at src/export.ts:12: An empty table exports no header row, so the CSV cannot be re-imported.",
        "- `export-name` (low) at src/export.ts: The export is named for its format only.",
      ].join("\n"),
    );
    expect(prompt).toContain("keep its id while it still applies");
  });

  it("labels the author's reply as claims to check, not evidence", () => {
    expect(prompt).toContain(
      `The author's reply to your findings. These are claims to check against the code, not evidence:\n\`\`\`text\n${reply}\n\`\`\``,
    );
    expect(prompt).toContain("Judge the code and the evidence, not claims");
  });

  it("keeps the first round's rules and asks for the review the same way", () => {
    expect(prompt).toContain("Review independently and read-only");
    expect(prompt).toContain("factory_submit_review");
    expect(prompt).toContain("```json");
  });

  it("says when the author sent no reply", () => {
    for (const none of [null, "  \n"]) {
      const silent = render(none);
      expect(silent).toContain("The author sent no reply to your findings.");
      expect(silent).not.toContain("claims to check");
    }
  });

  it("cuts a long reply", () => {
    const long = render("x".repeat(9_000));
    expect(long).toContain(`${"x".repeat(8_000)}\n[reply truncated]`);
    expect(long).not.toContain("x".repeat(8_001));
  });

  it("says when the previous review had no findings", () => {
    expect(
      renderReviewFollowUpPrompt({
        round: 3,
        branch,
        baseline,
        receipt: repaired,
        previous: { headSha: "a".repeat(40), findings: [] },
        authorResponse: reply,
      }),
    ).toContain(`Your previous review of ${"a".repeat(40)} had no findings.`);
  });
});
