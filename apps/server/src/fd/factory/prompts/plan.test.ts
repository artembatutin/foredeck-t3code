import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { carriesAiAttribution, namesAiTool } from "../git/publishedText.ts";
import { validatePlan } from "../plan/validate.ts";
import type { FactoryAuthorItem } from "./author.ts";
import { renderPlanPrompt } from "./plan.ts";

const item = {
  ref: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-parent"),
  },
  key: "fd-parent",
  title: "Ship table exports",
  url: null,
  locator: "tasks/fd-parent.md",
  body: "Users can export tables as CSV and JSON.",
  bodyTruncated: false,
} satisfies FactoryAuthorItem;

const prompt = renderPlanPrompt({ item, branch: "work/fd-parent" });

describe("renderPlanPrompt", () => {
  it("names the item, its description and the delivery branch", () => {
    for (const expected of [
      "Factory plan for Work item fd-parent: Ship table exports",
      "Users can export tables as CSV and JSON.",
      "work-item: 7e2aa85e-9347-44ce-b019-cb8dfd365b20:fd-parent",
      "branch `work/fd-parent`",
    ]) {
      expect(prompt).toContain(expected);
    }
  });

  it("states the plan rules", () => {
    for (const expected of [
      "Inspect only",
      "change no file",
      "bounded vertical tasks",
      "testable acceptance criteria",
      "exactly one test plan entry",
      'Set risk to "high" for work on security, persistence or migrations, concurrency, cross-module contracts, or where the architecture is ambiguous',
      "Never invent requirements, decisions, tickets or evidence",
    ]) {
      expect(prompt).toContain(expected);
    }
  });

  it("asks for the tool submission and the same plan in a final fenced json block", () => {
    expect(prompt).toContain("Call the `factory_submit_plan` tool once");
    expect(prompt).toContain(
      "End your final message with the same plan as JSON in one fenced ```json block",
    );
    const example = /```json\n([\s\S]*?)\n```/.exec(prompt)?.[1];
    expect(example).toBeDefined();
    expect(validatePlan(JSON.parse(example ?? "null"), []).status).toBe("valid");
  });

  it("passes the published-text name and attribution checks", () => {
    expect(namesAiTool(prompt)).toBe(false);
    expect(carriesAiAttribution(prompt)).toBe(false);
  });
});
