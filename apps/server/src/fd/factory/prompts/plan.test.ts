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

describe("renderPlanPrompt descriptions", () => {
  const MARKER = "[description truncated; read the rest with work_read]";
  const requirement = "Exports must include a header row.";
  const render = (body: string, bodyTruncated = false) =>
    renderPlanPrompt({ item: { ...item, body, bodyTruncated }, branch: "work/fd-parent" });
  const whitespace = (length: number) => " \n\t".repeat(length).slice(0, length);
  const empty = render("");

  it("keeps a requirement that follows 16,000 whitespace characters", () => {
    const prompt = render(`${whitespace(16_000)}${requirement}`);
    expect(prompt).toContain(`Description:\n${requirement}`);
    expect(prompt).not.toContain(MARKER);
    expect(prompt).not.toBe(empty);
  });

  it("signals content past the preview instead of dropping it silently", () => {
    const prompt = render(`Intro.${whitespace(16_000)}${requirement}`);
    expect(prompt).toContain("Description:\nIntro.");
    expect(prompt).toContain(MARKER);
    expect(prompt).not.toContain(requirement);
    expect(prompt.length).toBeLessThan(empty.length + 16_100);
  });

  it("signals a body Work cut short even when the part it returned is blank", () => {
    expect(render(whitespace(16_000), true)).toContain(`Description:\n${MARKER}`);
  });

  it("renders a truly empty body without a description or a notice", () => {
    expect(empty).not.toContain("Description:");
    expect(empty).not.toContain(MARKER);
    expect(render(whitespace(20_000))).toBe(empty);
  });
});
