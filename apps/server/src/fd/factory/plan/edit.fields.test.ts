import {
  FactoryDeliveryId,
  FactoryPlan,
  type FactoryPlanTask,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FactoryChildItemUncreatableError } from "../FactoryService.ts";
import { toFactoryError } from "../wireError.ts";
import { validatePlanEdit } from "./edit.ts";

const recorded = Schema.decodeUnknownSync(FactoryPlan)({
  tasks: ["export-csv", "export-header"].map((id) => ({
    id,
    title: `Task ${id}`,
    kind: "feature",
    summary: `Build ${id}.`,
    acceptance: [`${id} works.`, `${id} is documented.`],
    testPlan: [
      { criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] },
      { criterion: 2, check: `${id} has docs.`, paths: [`docs/${id}.md`] },
    ],
    likelyPaths: [`src/${id}.ts`],
    risk: "normal",
  })),
  note: "Two tasks.",
});
const [first, second] = recorded.tasks as readonly [FactoryPlanTask, FactoryPlanTask];
const CSV = FactoryTaskId.make("export-csv");
const HEADER = FactoryTaskId.make("export-header");

const fieldsOf = (edited: unknown) => {
  const result = validatePlanEdit(recorded, edited, []);
  if (result.status !== "invalid") throw new Error("The edit was taken.");
  return result.fields;
};

describe("validatePlanEdit fields", () => {
  it("names the field of the task each problem is in, by the task's id", () => {
    expect(
      fieldsOf({
        ...recorded,
        tasks: [
          { ...first, title: "  ", testPlan: [first.testPlan[0]] },
          { ...second, testPlan: [...second.testPlan, { criterion: 3, check: "x", paths: [] }] },
        ],
      }),
    ).toEqual([
      { taskId: CSV, field: "title" },
      { taskId: CSV, field: "acceptance.2.testPlan" },
      { taskId: HEADER, field: "testPlan.2.criterion" },
    ]);
  });

  it("follows the edit's order, and a task that is not an object, to the right task", () => {
    expect(
      fieldsOf({
        ...recorded,
        tasks: [
          { ...second, summary: "" },
          { ...first, acceptance: [first.acceptance[0], ""] },
        ],
      }),
    ).toEqual([
      { taskId: HEADER, field: "summary" },
      { taskId: CSV, field: "acceptance.2" },
    ]);
    expect(fieldsOf({ ...recorded, tasks: [42, { ...first, title: "" }] })).toEqual([
      { taskId: CSV, field: "title" },
    ]);
  });

  it("names each field once, however many problems it has", () => {
    const entry = { criterion: 1, check: "x", paths: ["../up", "/abs"] };
    expect(
      fieldsOf({ ...recorded, tasks: [{ ...first, testPlan: [entry, first.testPlan[1]] }] }),
    ).toEqual([{ taskId: CSV, field: "testPlan.0.paths" }]);
  });

  it("names a whole task for what an edit may not change, and nothing outside the recorded plan", () => {
    expect(fieldsOf({ ...recorded, tasks: [{ ...first, risk: "high" }, second] })).toEqual([
      { taskId: CSV },
    ]);
    expect(
      fieldsOf({ ...recorded, tasks: [first, { ...second, id: "export-footer", title: "" }] }),
    ).toEqual([]);
    expect(fieldsOf({ ...recorded, note: "Another note." })).toEqual([]);
    expect(fieldsOf({ ...recorded, tasks: [] })).toEqual([]);
    expect(fieldsOf("Keep it.")).toEqual([]);
  });
});

describe("plan refusals on the wire", () => {
  it("name the tasks whose child items the source cannot hold", () => {
    const deliveryId = FactoryDeliveryId.make("delivery-1");
    const wire = toFactoryError(
      new FactoryChildItemUncreatableError({ deliveryId, taskIds: [HEADER, CSV] }),
    );
    expect(wire.reason).toBe("invalid_request");
    expect(wire.fields).toEqual([{ taskId: HEADER }, { taskId: CSV }]);
  });
});
