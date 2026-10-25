import type { FactoryPlan, FactoryPlanTask } from "@t3tools/contracts/fd/factory";

import { cappedProblems, type FactoryPlanProblem, planProblem, validatePlan } from "./validate.ts";

/** An owner's edit the gate takes, or the problems that refuse it. */
export type FactoryPlanEditValidation =
  | { readonly status: "invalid"; readonly problems: ReadonlyArray<FactoryPlanProblem> }
  | { readonly status: "valid"; readonly plan: FactoryPlan };

/** The fields of a task that stay the planner's; an edit changes only the others. */
const KEPT_FIELDS = [
  ["kind", "kind"],
  ["likelyPaths", "likely paths"],
  ["risk", "risk"],
] as const satisfies ReadonlyArray<readonly [keyof FactoryPlanTask, string]>;

const sameValue = (left: unknown, right: unknown) =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;

/** "a", "a and b", "a, b and c". */
const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/**
 * Judges the owner's edit of the plan waiting at the gate. The edited plan passes the planner's
 * plan validator, against the task ids the delivery already used, and changes of the recorded
 * plan only what the owner edits: task titles, summaries, acceptance criteria and test plans, the
 * order of the tasks, and which of them stay. It keeps at least one task, every task is one of the
 * recorded plan's under its id, with its kind, likely paths and risk, and the note stays the
 * planner's. Every problem is reported together.
 */
export const validatePlanEdit = (
  recorded: FactoryPlan,
  edited: FactoryPlan,
  usedTaskIds: Iterable<string>,
): FactoryPlanEditValidation => {
  const validation = validatePlan(edited, usedTaskIds);
  const problems: FactoryPlanProblem[] =
    validation.status === "invalid"
      ? [...validation.problems]
      : validation.status === "empty"
        ? [
            planProblem(
              "plan_emptied",
              "The edited plan has no tasks; keep at least one, or reject the plan.",
            ),
          ]
        : [];
  const planned = new Map(recorded.tasks.map((task) => [task.id, task]));
  for (const task of edited.tasks) {
    const before = planned.get(task.id);
    if (before === undefined) {
      problems.push(
        planProblem(
          "task_added",
          `Task ${JSON.stringify(task.id)} is not in the planner's plan; an edit cannot add a task or change a task's id.`,
        ),
      );
      continue;
    }
    const changed = KEPT_FIELDS.filter(([field]) => !sameValue(task[field], before[field]));
    if (changed.length > 0) {
      problems.push(
        planProblem(
          "task_field_changed",
          `Task ${JSON.stringify(task.id)}: an edit cannot change its ${listed(changed.map(([, name]) => name))}.`,
        ),
      );
    }
  }
  if (edited.note !== recorded.note) {
    problems.push(planProblem("note_changed", "An edit cannot change the planner's note."));
  }
  // The validator's decode, so the plan stored is the one it judged. A plan it did not pass has
  // a problem listed already.
  return validation.status === "valid" && problems.length === 0
    ? { status: "valid", plan: validation.plan }
    : { status: "invalid", problems: cappedProblems(problems) };
};
