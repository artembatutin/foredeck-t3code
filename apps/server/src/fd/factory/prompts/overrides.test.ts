import { FactoryTaskId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { renderAuthorPrompt } from "./author.ts";
import { renderFixCommitPrompt } from "./fixCommit.ts";
import { renderFixReviewPrompt } from "./fixReview.ts";
import { renderFixVerifyPrompt } from "./fixVerify.ts";
import { renderIntegratePrompt } from "./integrate.ts";
import { renderPlanPrompt, renderPlanRetryPrompt, renderReplanPrompt } from "./plan.ts";
import { renderReviewPrompt, renderReviewRetryPrompt } from "./review.ts";
import { renderReviewFollowUpPrompt } from "./reviewFollowUp.ts";

const item = {
  ref: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("item"),
  },
  key: "item",
  title: "Export",
  body: "Export the visible rows.",
  bodyTruncated: false,
  url: "https://example.com/item",
  locator: "tasks/item.md",
};
const branch = "feature/export";
const baseline = "b".repeat(40);
const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings",
  platform: "darwin-arm64",
  startedAt: "2026-10-27T10:00:00.000Z",
  finishedAt: "2026-10-27T10:00:01.000Z",
  code: 0,
  timedOut: false,
  durationMs: 1000,
  logPath: "/evidence/verify-1.log",
  outputHash: "hash",
};
const override = "Project rules\n\nKeep this text verbatim, including `code`.\n";
const finding = {
  id: "export-empty",
  severity: "high" as const,
  required: true,
  file: "export.ts",
  line: 3,
  detail: "Empty rows crash the export.",
};

/** Compare everything outside the rules byte for byte, including schemas and submission examples. */
const replacesRulesOnly = (render: (rulesOverride?: string) => string) => {
  const builtIn = render();
  const rules = builtIn.match(/Rules:\n[^]*?(?=\n\n|$)/)?.[0];
  expect(rules).toBeDefined();
  expect(render(override)).toBe(builtIn.replace(rules ?? "", override));
};

describe("Factory rules-only prompt overrides", () => {
  it("plan replaces rules and preserves item, branch, plan fields and submit instructions", () => {
    replacesRulesOnly((rulesOverride) => renderPlanPrompt({ item, branch, rulesOverride }));
  });
  it("author replaces rules and preserves item, branch and final summary instructions", () => {
    replacesRulesOnly((rulesOverride) => renderAuthorPrompt({ item, branch, rulesOverride }));
  });
  it("review replaces rules and preserves item, commit, receipt, fields and submit instructions", () => {
    replacesRulesOnly((rulesOverride) =>
      renderReviewPrompt({ item, branch, baseline, receipt }, rulesOverride),
    );
  });
  it("fix-verify replaces rules and preserves commit, command, failure output and reply instructions", () => {
    replacesRulesOnly((rulesOverride) =>
      renderFixVerifyPrompt({
        branch,
        receipt: { ...receipt, code: 1 },
        round: 2,
        tail: "A failing assertion.",
        rulesOverride,
      }),
    );
  });
  it("fix-review replaces rules and preserves findings, other blockers, commit and reply instructions", () => {
    replacesRulesOnly((rulesOverride) =>
      renderFixReviewPrompt({
        branch,
        headSha: receipt.headSha,
        round: 2,
        findings: [finding],
        otherReasons: ["Criterion 2 remains untested."],
        rulesOverride,
      }),
    );
  });
  it("fix-commit replaces rules and preserves branch, checkpoint, problems and immutable baseline", () => {
    for (const checkpoint of [null, "review"] as const) {
      const input = { branch, baseline, checkpoint, problems: ["The worktree is dirty."] };
      const builtIn = renderFixCommitPrompt(input);
      const start = builtIn.indexOf("Fix only these problems, then stop:");
      const end = builtIn.indexOf("\n\nReply with what you changed.");
      const baselineFact = `- To repair a commit message or identity, amend or reword only commits after ${baseline}; never rewrite earlier commits.`;
      expect(renderFixCommitPrompt({ ...input, rulesOverride: override })).toBe(
        `${builtIn.slice(0, start)}${override}\n${baselineFact}${builtIn.slice(end)}`,
      );
    }
  });
  it("integrate has its own rules and preserves all tasks, criteria, branch, receipt and review submission", () => {
    replacesRulesOnly((rulesOverride) =>
      renderIntegratePrompt({
        item,
        branch,
        base: baseline,
        baseRef: "main",
        receipt,
        rulesOverride,
        tasks: [
          {
            id: FactoryTaskId.make("export"),
            title: "Export CSV",
            acceptance: ["Rows export.", "Empty rows export."],
          },
        ],
      }),
    );
  });
  it("review follow-up replaces repeated rules and preserves findings, author claims, receipt and submission", () => {
    replacesRulesOnly((rulesOverride) =>
      renderReviewFollowUpPrompt({
        branch,
        baseline,
        receipt,
        round: 2,
        previous: { headSha: baseline, findings: [finding] },
        authorResponse: "I fixed empty rows.",
        rulesOverride,
      }),
    );
  });
  it("retry and replan turns retain correction facts and submission instructions with current rules", () => {
    const renderers = [
      (rulesOverride?: string) =>
        renderPlanRetryPrompt({
          problems: ["Missing criterion."],
          checkpoint: null,
          rulesOverride,
        }),
      (rulesOverride?: string) =>
        renderPlanRetryPrompt({
          problems: ["Missing criterion."],
          checkpoint: "plan",
          rulesOverride,
        }),
      (rulesOverride?: string) =>
        renderReplanPrompt({ note: "Keep the export small.", rulesOverride }),
      (rulesOverride?: string) =>
        renderReviewRetryPrompt({ problems: ["Missing evidence."], rulesOverride }),
    ];
    for (const render of renderers) expect(render(override)).toBe(`${render()}\n\n${override}`);
  });
});
