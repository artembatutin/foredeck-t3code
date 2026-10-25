import { describe, expect, it } from "@effect/vitest";
import { FactoryPlan, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";

import {
  addFactoryPlanCriterion,
  addFactoryTestPlanEntry,
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  editFactoryTestPlanEntry,
  FACTORY_PLAN_BOUNDS,
  factoryPlanDraft,
  type FactoryPlanDraft,
  factoryPlanDraftEdited,
  factoryPlanFromDraft,
  moveFactoryPlanTask,
  removeFactoryPlanCriterion,
  removeFactoryPlanTask,
  removeFactoryTestPlanEntry,
} from "./planDraft.ts";

const decode = Schema.decodeUnknownSync(FactoryPlan);
const SCHEMA = FactoryTaskId.make("schema");
const SERVER = FactoryTaskId.make("server");
const WEB = FactoryTaskId.make("web");

const PLAN = decode({
  tasks: [
    {
      id: "schema",
      title: "Add the plan schema",
      kind: "feature",
      summary: "Declare the plan contract.",
      acceptance: ["Plans decode.", "Bad plans fail.", "Old plans still decode."],
      testPlan: [
        { criterion: 1, check: "Decode a plan.", paths: ["packages/contracts/a.test.ts"] },
        { criterion: 2, check: "Decode a bad plan.", paths: ["packages/contracts/b.test.ts"] },
        { criterion: 3, check: "Decode an old plan.", paths: ["packages/contracts/c.test.ts"] },
      ],
      likelyPaths: ["packages/contracts/src/plan.ts"],
      risk: "normal",
    },
    {
      id: "server",
      title: "Validate plans on the server",
      kind: "fix",
      summary: "Refuse invalid plans.",
      acceptance: ["Invalid plans are refused."],
      testPlan: [{ criterion: 1, check: "Submit an invalid plan.", paths: [] }],
      likelyPaths: ["apps/server/src/plan.ts", "apps/server/src/plan.test.ts"],
      risk: "high",
    },
    {
      id: "web",
      title: "Show the plan",
      kind: "docs",
      summary: "Render the plan.",
      acceptance: ["The plan shows."],
      testPlan: [{ criterion: 1, check: "Render it.", paths: ["apps/web/src/plan.test.ts"] }],
      likelyPaths: [],
      risk: "normal",
    },
  ],
  note: "Three tasks, in order.",
});

/** The plan of a draft, which must also decode with the contract. */
const valid = (draft: FactoryPlanDraft) => {
  const result = factoryPlanFromDraft(draft);
  if (result._tag !== "Valid") throw new Error(`invalid draft: ${JSON.stringify(result.errors)}`);
  expect(decode(result.plan)).toStrictEqual(result.plan);
  return result.plan;
};

const invalid = (draft: FactoryPlanDraft) => {
  const result = factoryPlanFromDraft(draft);
  if (result._tag !== "Invalid") throw new Error("expected an invalid draft");
  return result.errors;
};

const taskOf = (plan: FactoryPlan, id: FactoryTaskId) => plan.tasks.find((task) => task.id === id)!;

describe("factoryPlanDraft round trip", () => {
  it("returns a two-task plan with its note unchanged", () => {
    const plan = decode({ tasks: PLAN.tasks.slice(0, 2), note: PLAN.note });
    const draft = factoryPlanDraft(plan);
    expect(factoryPlanDraftEdited(draft)).toBe(false);
    const result = valid(draft);
    expect(result).toStrictEqual(plan);
    expect(result.note).toBe("Three tasks, in order.");
    expect(taskOf(result, SERVER)).toMatchObject({
      id: "server",
      kind: "fix",
      likelyPaths: ["apps/server/src/plan.ts", "apps/server/src/plan.test.ts"],
      risk: "high",
    });
  });

  it("returns a plan without a note without adding one", () => {
    const plan = decode({ tasks: PLAN.tasks });
    const result = valid(factoryPlanDraft(plan));
    expect(result).toStrictEqual(plan);
    expect("note" in result).toBe(false);
  });
});

describe("factoryPlanDraft edits", () => {
  const withServer = (plan: FactoryPlan, fields: Partial<FactoryPlan["tasks"][number]>) => ({
    ...plan,
    tasks: plan.tasks.map((task) => (task.id === SERVER ? { ...task, ...fields } : task)),
  });

  const edits: ReadonlyArray<{
    readonly name: string;
    readonly edit: (draft: FactoryPlanDraft) => FactoryPlanDraft;
    readonly revert: (draft: FactoryPlanDraft) => FactoryPlanDraft;
    readonly expected: (plan: FactoryPlan) => FactoryPlan;
  }> = [
    {
      name: "title",
      edit: (draft) => editFactoryPlanTask(draft, SERVER, { title: "Validate submitted plans" }),
      revert: (draft) =>
        editFactoryPlanTask(draft, SERVER, { title: "Validate plans on the server" }),
      expected: (plan) => withServer(plan, { title: "Validate submitted plans" }),
    },
    {
      name: "summary",
      edit: (draft) => editFactoryPlanTask(draft, SERVER, { summary: "Refuse them." }),
      revert: (draft) => editFactoryPlanTask(draft, SERVER, { summary: "Refuse invalid plans." }),
      expected: (plan) => withServer(plan, { summary: "Refuse them." }),
    },
    {
      name: "criterion",
      edit: (draft) => editFactoryPlanCriterion(draft, SERVER, 1, "Refused with a reason."),
      revert: (draft) => editFactoryPlanCriterion(draft, SERVER, 1, "Invalid plans are refused."),
      expected: (plan) => withServer(plan, { acceptance: ["Refused with a reason."] }),
    },
    {
      name: "test plan check",
      edit: (draft) => editFactoryTestPlanEntry(draft, SERVER, 0, { check: "Submit one." }),
      revert: (draft) =>
        editFactoryTestPlanEntry(draft, SERVER, 0, { check: "Submit an invalid plan." }),
      expected: (plan) =>
        withServer(plan, { testPlan: [{ criterion: 1, check: "Submit one.", paths: [] }] }),
    },
    {
      name: "test plan paths",
      edit: (draft) =>
        editFactoryTestPlanEntry(draft, SERVER, 0, { paths: ["apps/server/src/plan.test.ts"] }),
      revert: (draft) => editFactoryTestPlanEntry(draft, SERVER, 0, { paths: [] }),
      expected: (plan) =>
        withServer(plan, {
          testPlan: [
            {
              criterion: 1,
              check: "Submit an invalid plan.",
              paths: ["apps/server/src/plan.test.ts"],
            },
          ],
        }),
    },
  ];

  it.each(edits)(
    "changes only the $name, and reverting it leaves the draft unedited",
    ({ edit, revert, expected }) => {
      const edited = edit(factoryPlanDraft(PLAN));
      expect(factoryPlanDraftEdited(edited)).toBe(true);
      // The other tasks and every other field stay exactly as planned.
      expect(valid(edited)).toStrictEqual(expected(PLAN));
      const reverted = revert(edited);
      expect(factoryPlanDraftEdited(reverted)).toBe(false);
      expect(valid(reverted)).toStrictEqual(PLAN);
    },
  );

  it("trims prose the contract trims, and keeps a title as written", () => {
    const draft = editFactoryPlanCriterion(
      editFactoryPlanTask(factoryPlanDraft(PLAN), WEB, { title: " Show it", summary: "  Wide. " }),
      WEB,
      1,
      " Shown. ",
    );
    const task = taskOf(valid(draft), WEB);
    expect(task.title).toBe(" Show it");
    expect(task.summary).toBe("Wide.");
    expect(task.acceptance).toStrictEqual(["Shown."]);
  });
});

describe("factoryPlanDraft criteria", () => {
  it("drops a removed criterion's entries and renumbers later ones", () => {
    const draft = removeFactoryPlanCriterion(factoryPlanDraft(PLAN), SCHEMA, 2);
    const task = taskOf(valid(draft), SCHEMA);
    expect(task.acceptance).toStrictEqual(["Plans decode.", "Old plans still decode."]);
    expect(task.testPlan).toStrictEqual([
      { criterion: 1, check: "Decode a plan.", paths: ["packages/contracts/a.test.ts"] },
      { criterion: 2, check: "Decode an old plan.", paths: ["packages/contracts/c.test.ts"] },
    ]);
    expect(factoryPlanDraftEdited(draft)).toBe(true);
    expect(taskOf(valid(draft), SERVER)).toStrictEqual(taskOf(PLAN, SERVER));
  });

  it("ignores removing a criterion the task does not have", () => {
    const draft = factoryPlanDraft(PLAN);
    expect(valid(removeFactoryPlanCriterion(draft, SCHEMA, 4))).toStrictEqual(PLAN);
    expect(valid(removeFactoryPlanCriterion(draft, SCHEMA, 0))).toStrictEqual(PLAN);
  });

  it("appends a criterion with no test plan entry until one is added", () => {
    const added = editFactoryPlanCriterion(
      addFactoryPlanCriterion(factoryPlanDraft(PLAN), SERVER),
      SERVER,
      2,
      "Refusals name the field.",
    );
    expect(invalid(added)).toStrictEqual({
      server: { "acceptance.2.testPlan": "Add a test plan entry for criterion 2." },
    });
    const proved = editFactoryTestPlanEntry(addFactoryTestPlanEntry(added, SERVER, 2), SERVER, 1, {
      check: "Submit a plan without a title.",
    });
    expect(taskOf(valid(proved), SERVER)).toMatchObject({
      acceptance: ["Invalid plans are refused.", "Refusals name the field."],
      testPlan: [
        { criterion: 1, check: "Submit an invalid plan.", paths: [] },
        { criterion: 2, check: "Submit a plan without a title.", paths: [] },
      ],
    });
  });

  it("reports the criterion left without an entry when its entry is removed", () => {
    const draft = removeFactoryTestPlanEntry(factoryPlanDraft(PLAN), SCHEMA, 1);
    expect(invalid(draft)).toStrictEqual({
      schema: { "acceptance.2.testPlan": "Add a test plan entry for criterion 2." },
    });
  });
});

describe("factoryPlanDraft order", () => {
  const ids = (plan: FactoryPlan) => plan.tasks.map((task) => task.id);

  it("moves a task down and up, keeping every task's fields", () => {
    const down = moveFactoryPlanTask(factoryPlanDraft(PLAN), SCHEMA, 1);
    const plan = valid(down);
    expect(ids(plan)).toStrictEqual(["server", "schema", "web"]);
    for (const task of PLAN.tasks) expect(taskOf(plan, task.id)).toStrictEqual(task);
    expect(factoryPlanDraftEdited(down)).toBe(true);
    const back = moveFactoryPlanTask(down, SCHEMA, -1);
    expect(factoryPlanDraftEdited(back)).toBe(false);
    expect(valid(back)).toStrictEqual(PLAN);
  });

  it("changes nothing for a move past either end", () => {
    const draft = factoryPlanDraft(PLAN);
    expect(moveFactoryPlanTask(draft, WEB, 1)).toBe(draft);
    expect(moveFactoryPlanTask(draft, SCHEMA, -1)).toBe(draft);
    expect(valid(moveFactoryPlanTask(draft, WEB, 1))).toStrictEqual(PLAN);
  });

  it("removes a task, keeping the others' ids, fields and order", () => {
    const draft = removeFactoryPlanTask(factoryPlanDraft(PLAN), SERVER);
    const plan = valid(draft);
    expect(ids(plan)).toStrictEqual(["schema", "web"]);
    expect(plan.tasks).toStrictEqual([taskOf(PLAN, SCHEMA), taskOf(PLAN, WEB)]);
    expect(plan.note).toBe(PLAN.note);
    expect(factoryPlanDraftEdited(draft)).toBe(true);
  });
});

describe("factoryPlanFromDraft errors", () => {
  const draft = factoryPlanDraft(PLAN);
  const long = (length: number) => "x".repeat(length);

  it.each([
    ["blank", "   ", "Enter a single-line title."],
    ["multi-line", "Two\nlines", "Enter a single-line title."],
    [
      "too long",
      long(FACTORY_PLAN_BOUNDS.titleLength + 1),
      `Use at most ${FACTORY_PLAN_BOUNDS.titleLength} characters.`,
    ],
  ])("refuses a %s title", (_, title, message) => {
    expect(invalid(editFactoryPlanTask(draft, WEB, { title }))).toStrictEqual({
      web: { title: message },
    });
  });

  it("accepts a title at the bound", () => {
    const title = long(FACTORY_PLAN_BOUNDS.titleLength);
    expect(taskOf(valid(editFactoryPlanTask(draft, WEB, { title })), WEB).title).toBe(title);
  });

  it("refuses a summary over 8000 characters or blank, and accepts one at the bound", () => {
    expect(invalid(editFactoryPlanTask(draft, WEB, { summary: long(8001) }))).toStrictEqual({
      web: { summary: "Use at most 8000 characters." },
    });
    expect(invalid(editFactoryPlanTask(draft, WEB, { summary: " " }))).toStrictEqual({
      web: { summary: "Enter some text." },
    });
    valid(editFactoryPlanTask(draft, WEB, { summary: ` ${long(8000)} ` }));
  });

  it("refuses a criterion or check outside its bounds", () => {
    const edited = editFactoryTestPlanEntry(
      editFactoryPlanCriterion(draft, SCHEMA, 3, long(2001)),
      SCHEMA,
      0,
      { check: "" },
    );
    expect(invalid(edited)).toStrictEqual({
      schema: {
        "acceptance.3": "Use at most 2000 characters.",
        "testPlan.0.check": "Enter some text.",
      },
    });
  });

  it("refuses a task with no acceptance criterion", () => {
    const empty = removeFactoryPlanCriterion(draft, WEB, 1);
    // The criterion's entry goes with it, so only the empty list is reported.
    expect(invalid(empty)).toStrictEqual({
      web: { acceptance: "Add at least one acceptance criterion." },
    });
  });

  it("refuses more criteria than the contract holds", () => {
    let many = draft;
    for (let n = 2; n <= FACTORY_PLAN_BOUNDS.criterionCount + 1; n += 1) {
      many = addFactoryTestPlanEntry(
        editFactoryPlanCriterion(addFactoryPlanCriterion(many, WEB), WEB, n, `Criterion ${n}.`),
        WEB,
        n,
      );
      many = editFactoryTestPlanEntry(many, WEB, n - 1, { check: `Check ${n}.` });
    }
    expect(invalid(many)).toStrictEqual({
      web: {
        acceptance: "Use at most 50 acceptance criteria.",
        testPlan: "Use at most 50 test plan entries.",
      },
    });
  });

  it.each(["../x", "/abs", ".git/x", "a/./b", "a//b", "C:/x", "a\\b"])(
    "refuses the test plan path %s",
    (path) => {
      const edited = editFactoryTestPlanEntry(draft, SERVER, 0, { paths: ["ok/path.ts", path] });
      expect(invalid(edited)).toStrictEqual({
        server: {
          "testPlan.0.paths": `Use a normalized repository-relative path outside .git: ${path}`,
        },
      });
    },
  );

  it("refuses an entry naming a criterion the task does not have", () => {
    const edited = addFactoryTestPlanEntry(draft, WEB, 2);
    expect(invalid(editFactoryTestPlanEntry(edited, WEB, 1, { check: "Check." }))).toStrictEqual({
      web: { "testPlan.1.criterion": "Choose one of the task's acceptance criteria." },
    });
  });

  it("keys errors in several tasks by task id", () => {
    const edited = editFactoryPlanTask(editFactoryPlanTask(draft, SCHEMA, { title: "" }), WEB, {
      summary: "",
    });
    expect(invalid(edited)).toStrictEqual({
      schema: { title: "Enter a single-line title." },
      web: { summary: "Enter some text." },
    });
  });
});
