import { describe, expect, it } from "vite-plus/test";

import { MAX_PROBLEM_LENGTH, MAX_PROBLEMS, validatePlan } from "./validate.ts";
import type { FactoryPlanProblemRule, FactoryPlanValidation } from "./validate.ts";

type Task = Record<string, unknown>;

const task = (id: string, overrides: Task = {}): Task => ({
  id,
  title: `Task ${id}`,
  kind: "feature",
  summary: "Adds the behavior.",
  acceptance: ["The first behavior holds.", "The second behavior holds."],
  testPlan: [
    { criterion: 1, check: "A focused test.", paths: ["src/a.test.ts"] },
    { criterion: 2, check: "Another focused test.", paths: ["src/b.test.ts"] },
  ],
  likelyPaths: ["src/a.ts"],
  risk: "normal",
  ...overrides,
});

const rules = (result: FactoryPlanValidation): ReadonlyArray<FactoryPlanProblemRule> =>
  result.status === "invalid" ? result.problems.map((problem) => problem.rule) : [];

const descriptions = (result: FactoryPlanValidation) =>
  result.status === "invalid" ? result.problems.map((problem) => problem.description) : [];

describe("validatePlan", () => {
  it("accepts a valid plan with its decoded tasks", () => {
    const result = validatePlan({ tasks: [task("a"), task("b", { risk: "high" })] }, ["old"]);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.plan.tasks.map((planned) => [planned.id, planned.risk])).toEqual([
      ["a", "normal"],
      ["b", "high"],
    ]);
  });

  it.each<[string, unknown, FactoryPlanProblemRule, string]>([
    [
      "a duplicate task id",
      { tasks: [task("a"), task("a")] },
      "duplicate_task_id",
      'Task id "a" is used 2 times',
    ],
    [
      "an id the delivery already used",
      { tasks: [task("used")] },
      "task_id_used",
      'Task id "used" is already used in this delivery',
    ],
    [
      "a criterion without a test plan entry",
      { tasks: [task("a", { testPlan: [{ criterion: 1, check: "c", paths: [] }] })] },
      "criterion_without_test",
      'Task "a": acceptance criterion 2 has no test plan entry',
    ],
    [
      "a test plan entry outside the criteria",
      {
        tasks: [
          task("a", {
            testPlan: [
              { criterion: 1, check: "c", paths: [] },
              { criterion: 2, check: "c", paths: [] },
              { criterion: 3, check: "c", paths: [] },
            ],
          }),
        ],
      },
      "test_criterion_out_of_range",
      'Task "a": a test plan entry names criterion 3, outside 1..2',
    ],
    [
      "a path that escapes the repository",
      { tasks: [task("a", { likelyPaths: ["../x"] })] },
      "not_a_plan",
      "tasks[0].likelyPaths[0]: Use a normalized path",
    ],
    [
      "a path in Git metadata",
      {
        tasks: [
          task("a", {
            testPlan: [
              { criterion: 1, check: "c", paths: [".git/x"] },
              { criterion: 2, check: "c", paths: [] },
            ],
          }),
        ],
      },
      "not_a_plan",
      "tasks[0].testPlan[0].paths[0]: Choose a path outside Git metadata.",
    ],
    [
      "an unknown kind",
      { tasks: [task("a", { kind: "spike" })] },
      "not_a_plan",
      "tasks[0].kind: Expected",
    ],
    [
      "an unknown risk",
      { tasks: [task("a", { risk: "low" })] },
      "not_a_plan",
      'tasks[0].risk: Expected "normal" | "high"',
    ],
    [
      "empty acceptance",
      { tasks: [task("a", { acceptance: [], testPlan: [] })] },
      "not_a_plan",
      "tasks[0].acceptance: Expected a value with a length between 1 and 50",
    ],
    ["a value that is not a plan", "plan", "not_a_plan", "the plan: Expected"],
  ])("reports %s as its own problem", (_name, value, rule, description) => {
    const result = validatePlan(value, ["used"]);
    expect(rules(result)).toEqual([rule]);
    expect(descriptions(result)[0]).toContain(description);
  });

  it("reports every fault of one plan at once, decode issues and id checks alike", () => {
    const result = validatePlan(
      {
        tasks: [
          task("a", { kind: "spike", likelyPaths: ["../x", ".git/x"] }),
          task("a", { testPlan: [{ criterion: 1, check: "c", paths: [] }] }),
          task("used", {
            testPlan: [
              { criterion: 1, check: "c", paths: [] },
              { criterion: 2, check: "c", paths: [] },
              { criterion: 7, check: "c", paths: [] },
            ],
          }),
          task("b", { acceptance: [] }),
        ],
      },
      ["used"],
    );
    expect([...rules(result)].toSorted()).toEqual(
      [
        "not_a_plan",
        "not_a_plan",
        "not_a_plan",
        "not_a_plan",
        "duplicate_task_id",
        "task_id_used",
        "criterion_without_test",
        "test_criterion_out_of_range",
      ].toSorted(),
    );
  });

  it("keeps every problem within the length bound and caps their count", () => {
    const longId = "a".repeat(64);
    const many = validatePlan(
      {
        tasks: Array.from({ length: 50 }, () =>
          task(longId, { testPlan: [], title: "", kind: "x".repeat(5000) }),
        ),
      },
      [longId],
    );
    expect(many.status).toBe("invalid");
    if (many.status !== "invalid") return;
    expect(many.problems).toHaveLength(MAX_PROBLEMS);
    expect(many.problems.at(-1)).toMatchObject({ rule: "more_problems" });
    expect(many.problems.at(-1)?.description).toMatch(/^\d+ more problems are not listed/);
    for (const problem of many.problems) {
      expect(problem.description.length).toBeLessThanOrEqual(MAX_PROBLEM_LENGTH);
      expect(problem.description).not.toContain("xxxx");
    }
  });

  it("judges the ids and criteria of a plan that does not decode", () => {
    const result = validatePlan({ tasks: [{ id: "used" }, { id: "used" }] }, ["used"]);
    expect(rules(result)).toContain("duplicate_task_id");
    expect(rules(result)).toContain("task_id_used");
    expect(rules(result)).not.toContain("criterion_without_test");
  });
});

describe("validatePlan with no tasks", () => {
  it("judges an empty plan with a note as empty, carrying the note unchanged", () => {
    const note = "The item is already delivered by fd-123; nothing is left to plan.";
    expect(validatePlan({ tasks: [], note }, [])).toEqual({ status: "empty", note });
  });

  it("judges an empty plan without a note as empty with no note", () => {
    expect(validatePlan({ tasks: [] }, ["a"])).toEqual({ status: "empty", note: null });
  });

  it("never reports an empty plan with a problem as empty", () => {
    expect(validatePlan({ tasks: [], note: "  " }, []).status).toBe("invalid");
  });
});
