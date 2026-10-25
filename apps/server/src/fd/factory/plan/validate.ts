import { FactoryPlan } from "@t3tools/contracts/fd/factory";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export type FactoryPlanProblemRule =
  | "not_a_plan"
  | "duplicate_task_id"
  | "task_id_used"
  | "criterion_without_test"
  | "test_criterion_out_of_range"
  /** The fenced fallback's: the final message holds no ```json block, or one that is not JSON. */
  | "no_json_block"
  | "invalid_json"
  /** Stands for the problems past the count bound. */
  | "more_problems";

/** A problem the planner can correct, so the description says exactly what to fix. */
export interface FactoryPlanProblem {
  readonly rule: FactoryPlanProblemRule;
  /** At most `MAX_PROBLEM_LENGTH` characters. */
  readonly description: string;
}

/**
 * An invalid plan goes back to the planner. An accepted plan without tasks ends planning with the
 * planner's note, never as a plan that succeeded; only a plan with tasks reaches the owner's gate.
 */
export type FactoryPlanValidation =
  | { readonly status: "invalid"; readonly problems: ReadonlyArray<FactoryPlanProblem> }
  | {
      readonly status: "empty";
      /**
       * The note as `FactoryPlan` decodes it: its lines as written, without surrounding
       * whitespace, which the contract trims from every plan text before checking its bound.
       */
      readonly note: string | null;
    }
  | { readonly status: "valid"; readonly plan: FactoryPlan };

export const MAX_PROBLEM_LENGTH = 300;
/** Problems past this are counted in one `more_problems` entry, so a retry prompt stays small. */
export const MAX_PROBLEMS = 25;
const MAX_QUOTED = 64;

const quote = (text: string) =>
  JSON.stringify(text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text);

const bounded = (text: string) =>
  text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH - 1)}…` : text;

/** A problem with its description cut to the length bound. */
export const planProblem = (
  rule: FactoryPlanProblemRule,
  description: string,
): FactoryPlanProblem => ({ rule, description: bounded(description) });

// Every issue at once: the planner gets one corrected retry.
const decodePlan = Schema.decodeUnknownResult(FactoryPlan, { errors: "all" });
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type IssuePath = NonNullable<ReturnType<typeof formatIssues>["issues"][number]["path"]>;

/** `tasks[0].testPlan[1].paths[0]`, the field a schema issue is at. */
const fieldPath = (path: IssuePath) =>
  path
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("") || "the plan";

/** What the id and criteria checks read of a task; a field the submission lacks is null. */
interface TaskOutline {
  readonly id: string | null;
  readonly criteriaCount: number | null;
  readonly testCriteria: ReadonlyArray<number> | null;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Outlines read straight from the submission, so a plan that does not decode still has its ids
 * and criteria judged and one corrected retry can fix every problem. A malformed field is the
 * decode's problem and skips the checks that need it.
 */
const outlines = (value: unknown): ReadonlyArray<TaskOutline> => {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return [];
  return value.tasks.filter(isRecord).map((task) => {
    const acceptance = task.acceptance;
    const testPlan = task.testPlan;
    return {
      id: typeof task.id === "string" ? task.id : null,
      criteriaCount: Array.isArray(acceptance) && acceptance.length > 0 ? acceptance.length : null,
      testCriteria: Array.isArray(testPlan)
        ? testPlan.flatMap((entry) =>
            isRecord(entry) &&
            typeof entry.criterion === "number" &&
            Number.isInteger(entry.criterion)
              ? [entry.criterion]
              : [],
          )
        : null,
    };
  });
};

const taskName = (task: TaskOutline, index: number) =>
  task.id === null ? `Task ${index + 1}` : `Task ${quote(task.id)}`;

const outlineProblems = (
  tasks: ReadonlyArray<TaskOutline>,
  usedTaskIds: ReadonlySet<string>,
): FactoryPlanProblem[] => {
  const problems: FactoryPlanProblem[] = [];
  const counts = new Map<string, number>();
  for (const { id } of tasks) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      problems.push(
        planProblem(
          "duplicate_task_id",
          `Task id ${quote(id)} is used ${count} times; give each task its own id.`,
        ),
      );
    }
    if (usedTaskIds.has(id)) {
      problems.push(
        planProblem(
          "task_id_used",
          `Task id ${quote(id)} is already used in this delivery; choose an id it has not used.`,
        ),
      );
    }
  }
  tasks.forEach((task, index) => {
    if (task.criteriaCount === null || task.testCriteria === null) return;
    const name = taskName(task, index);
    const tested = new Set(task.testCriteria);
    for (let criterion = 1; criterion <= task.criteriaCount; criterion += 1) {
      if (!tested.has(criterion)) {
        problems.push(
          planProblem(
            "criterion_without_test",
            `${name}: acceptance criterion ${criterion} has no test plan entry; add one naming criterion ${criterion}.`,
          ),
        );
      }
    }
    for (const criterion of tested) {
      if (criterion < 1 || criterion > task.criteriaCount) {
        problems.push(
          planProblem(
            "test_criterion_out_of_range",
            `${name}: a test plan entry names criterion ${criterion}, outside 1..${task.criteriaCount}; the task has ${task.criteriaCount} acceptance criteria.`,
          ),
        );
      }
    }
  });
  return problems;
};

const capped = (problems: ReadonlyArray<FactoryPlanProblem>): ReadonlyArray<FactoryPlanProblem> =>
  problems.length <= MAX_PROBLEMS
    ? problems
    : [
        ...problems.slice(0, MAX_PROBLEMS - 1),
        planProblem(
          "more_problems",
          `${problems.length - MAX_PROBLEMS + 1} more problems are not listed; check every task against the same rules.`,
        ),
      ];

/**
 * Judges a planner's submission (port of Looper's `validatePlan`) against the task ids its
 * delivery already used. Every problem is reported together, schema issues and id and criteria
 * checks alike, so one corrected retry can fix them all.
 */
export const validatePlan = (
  value: unknown,
  usedTaskIds: Iterable<string>,
): FactoryPlanValidation => {
  const decoded = decodePlan(value);
  const problems: FactoryPlanProblem[] = [];
  if (Result.isFailure(decoded)) {
    const issues = formatIssues(decoded.failure.issue).issues;
    for (const issue of issues) {
      problems.push(planProblem("not_a_plan", `${fieldPath(issue.path ?? [])}: ${issue.message}`));
    }
    if (issues.length === 0) problems.push(planProblem("not_a_plan", "The value is not a plan."));
  }
  problems.push(...outlineProblems(outlines(value), new Set(usedTaskIds)));
  if (Result.isFailure(decoded) || problems.length > 0) {
    return { status: "invalid", problems: capped(problems) };
  }
  const plan = decoded.success;
  return plan.tasks.length === 0
    ? { status: "empty", note: plan.note ?? null }
    : { status: "valid", plan };
};
