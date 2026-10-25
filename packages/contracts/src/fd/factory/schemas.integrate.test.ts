import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_PLAN_TASKS_MAX,
  FACTORY_TASK_CRITERIA_MAX,
  FactoryIntegrateReview,
  FactoryReview,
} from "./index.ts";

const review = (entries: number) => ({
  verdict: "pass",
  findings: [],
  acceptance: Array.from({ length: entries }, (_, index) => ({
    criterion: index + 1,
    status: "verified",
    evidence: "Checked.",
    paths: ["src/export.test.ts"],
  })),
  missing_evidence: [],
});
const isReview = Schema.is(FactoryReview);
const isIntegrateReview = Schema.is(FactoryIntegrateReview);

describe("an integrate review", () => {
  it("holds an entry for every criterion of the largest plan, which a task's review cannot", () => {
    const largest = FACTORY_PLAN_TASKS_MAX * FACTORY_TASK_CRITERIA_MAX;
    expect(largest).toBe(2500);
    expect(isIntegrateReview(review(largest))).toBe(true);
    expect(isIntegrateReview(review(largest + 1))).toBe(false);
    expect(isReview(review(FACTORY_TASK_CRITERIA_MAX))).toBe(true);
    expect(isReview(review(FACTORY_TASK_CRITERIA_MAX + 1))).toBe(false);
  });
});
