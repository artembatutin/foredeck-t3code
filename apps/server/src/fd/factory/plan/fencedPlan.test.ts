import { describe, expect, it } from "vite-plus/test";

import { parseFencedPlan } from "./fencedPlan.ts";
import { validatePlan } from "./validate.ts";

const plan = (id: string) => ({
  tasks: [
    {
      id,
      title: `Task ${id}`,
      kind: "fix",
      summary: "Fixes the behavior.",
      acceptance: ["The behavior holds."],
      testPlan: [{ criterion: 1, check: "A focused test.", paths: ["src/a.test.ts"] }],
      likelyPaths: ["src/a.ts"],
      risk: "normal",
    },
  ],
});

const fenced = (body: string, info = "json", fence = "```") => `${fence}${info}\n${body}\n${fence}`;

describe("parseFencedPlan", () => {
  it("judges the last of several json blocks", () => {
    const message = [
      "Draft:",
      fenced(JSON.stringify(plan("draft"))),
      "Final:",
      fenced(JSON.stringify(plan("final"), null, 2)),
    ].join("\n");
    const result = parseFencedPlan(message, []);
    expect(result).toMatchObject({ status: "valid", plan: { tasks: [{ id: "final" }] } });
  });

  it("ignores a json fence quoted inside another fence", () => {
    const quoted = fenced(fenced(JSON.stringify(plan("quoted"))), "markdown", "````");
    const message = [fenced(JSON.stringify(plan("final"))), quoted].join("\n");
    expect(parseFencedPlan(message, [])).toMatchObject({
      status: "valid",
      plan: { tasks: [{ id: "final" }] },
    });
  });

  it("judges the block exactly as a direct submission", () => {
    for (const value of [
      plan("used"),
      { tasks: [], note: "Nothing to plan." },
      { tasks: [{ ...plan("a").tasks[0], kind: "spike", likelyPaths: ["../x"] }] },
    ]) {
      expect(parseFencedPlan(fenced(JSON.stringify(value)), ["used"])).toEqual(
        validatePlan(value, ["used"]),
      );
    }
  });

  it("returns the fixed problem asking for the block when there is none", () => {
    const expected = {
      status: "invalid",
      problems: [
        {
          rule: "no_json_block",
          description:
            "Your final message has no fenced ```json block holding the plan. End your final message with the plan as JSON in one fenced ```json block.",
        },
      ],
    };
    expect(parseFencedPlan("Here is my plan: two tasks.", [])).toEqual(expected);
    expect(parseFencedPlan(fenced(JSON.stringify(plan("a")), "ts"), [])).toEqual(expected);
  });

  it("reports a block that is not JSON as one bounded problem", () => {
    const result = parseFencedPlan(fenced(`{"tasks": [${"x".repeat(5000)}`), []);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.rule).toBe("invalid_json");
    expect(result.problems[0]?.description.length).toBeLessThanOrEqual(300);
  });
});
