import type { EnvironmentId } from "@t3tools/contracts";
import {
  FactoryPlanTask,
  type FactoryDeliveryId,
  type FactoryPlan,
  type FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

/** The bounds `FactoryPlan` decodes with; the draft refuses anything outside them. */
export const FACTORY_PLAN_BOUNDS = {
  titleLength: 512,
  summaryLength: 8000,
  criterionLength: 2000,
  criterionCount: 50,
  checkLength: 2000,
  testPlanCount: 50,
  pathCount: 100,
} as const;

// The contract's own path rule (normalized, repository-relative, outside `.git`), so the draft
// never accepts a path the plan would not decode with.
const isRepoPath = Schema.is(FactoryPlanTask.fields.testPlan.value.fields.paths.value);

/** A test plan entry as the form edits it. `criterion` is the 1-based criterion it proves. */
export interface FactoryTestPlanEntryDraft {
  readonly criterion: number;
  readonly check: string;
  readonly paths: ReadonlyArray<string>;
}

/**
 * A planned task as the owner edits it. `base` is the planner's task, which the draft keeps the
 * fields it does not edit from (id, kind, likely paths, risk).
 */
export interface FactoryPlanTaskDraft {
  readonly base: FactoryPlanTask;
  readonly title: string;
  readonly summary: string;
  readonly acceptance: ReadonlyArray<string>;
  readonly testPlan: ReadonlyArray<FactoryTestPlanEntryDraft>;
}

/** The delivery a plan belongs to. A delivery id is unique only within its environment. */
export interface FactoryPlanDestination {
  readonly environmentId: EnvironmentId;
  readonly deliveryId: FactoryDeliveryId;
}

/**
 * A plan as the owner edits it before approval, pinned to the delivery it was made for. `base`
 * keeps the note and the original order, and is the plan the edits were made over. `current` is
 * the server's newer plan while it differs from `base` under edits, and null otherwise.
 */
export interface FactoryPlanDraft extends FactoryPlanDestination {
  readonly base: FactoryPlan;
  readonly tasks: ReadonlyArray<FactoryPlanTaskDraft>;
  readonly current: FactoryPlan | null;
}

/**
 * A field of one task. `acceptance.<n>` is criterion n (1-based, as test plan entries number
 * them) and `acceptance.<n>.testPlan` its missing test plan entry; `testPlan.<i>` is the entry at
 * index i (0-based).
 */
export type FactoryPlanTaskField =
  | "title"
  | "summary"
  | "acceptance"
  | `acceptance.${number}`
  | `acceptance.${number}.testPlan`
  | "testPlan"
  | `testPlan.${number}.criterion`
  | `testPlan.${number}.check`
  | `testPlan.${number}.paths`;

export type FactoryPlanTaskErrors = Partial<Record<FactoryPlanTaskField, string>>;

/** Errors keyed by task id; a task without errors has no key. */
export type FactoryPlanErrors = Readonly<Record<string, FactoryPlanTaskErrors>>;

/**
 * `Mismatch`: the draft was made for another delivery, named with the one asked for. `Changed`:
 * the server's plan changed under edits; the owner reapplies or discards them first.
 */
export type FactoryPlanDraftResult =
  | { readonly _tag: "Valid"; readonly plan: FactoryPlan }
  | { readonly _tag: "Invalid"; readonly errors: FactoryPlanErrors }
  | {
      readonly _tag: "Mismatch";
      readonly draft: FactoryPlanDestination;
      readonly requested: FactoryPlanDestination;
    }
  | { readonly _tag: "Changed"; readonly current: FactoryPlan };

const taskDraft = (task: FactoryPlanTask): FactoryPlanTaskDraft => ({
  base: task,
  title: task.title,
  summary: task.summary,
  acceptance: [...task.acceptance],
  testPlan: task.testPlan.map((entry) => ({
    criterion: entry.criterion,
    check: entry.check,
    paths: [...entry.paths],
  })),
});

/** The draft of a delivery's submitted plan, unedited. */
export const factoryPlanDraft = (
  destination: FactoryPlanDestination,
  plan: FactoryPlan,
): FactoryPlanDraft => ({
  environmentId: destination.environmentId,
  deliveryId: destination.deliveryId,
  base: plan,
  tasks: plan.tasks.map(taskDraft),
  current: null,
});

const sameDestination = (left: FactoryPlanDestination, right: FactoryPlanDestination) =>
  left.environmentId === right.environmentId && left.deliveryId === right.deliveryId;

const updateTask = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  update: (task: FactoryPlanTaskDraft) => FactoryPlanTaskDraft,
): FactoryPlanDraft => ({
  ...draft,
  tasks: draft.tasks.map((task) => (task.base.id === taskId ? update(task) : task)),
});

/** Sets a task's title or summary. */
export const editFactoryPlanTask = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  edit: Partial<Pick<FactoryPlanTaskDraft, "title" | "summary">>,
): FactoryPlanDraft => updateTask(draft, taskId, (task) => ({ ...task, ...edit }));

/** Sets the text of criterion n (1-based). */
export const editFactoryPlanCriterion = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  criterion: number,
  text: string,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => ({
    ...task,
    acceptance: task.acceptance.map((value, index) => (index === criterion - 1 ? text : value)),
  }));

/** Appends an empty criterion, which has no test plan entry until one is added. */
export const addFactoryPlanCriterion = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => ({ ...task, acceptance: [...task.acceptance, ""] }));

/**
 * Removes criterion n (1-based) with the test plan entries that prove it. Entries for later
 * criteria move down by one, so each still names the criterion it proves.
 */
export const removeFactoryPlanCriterion = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  criterion: number,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => {
    if (criterion < 1 || criterion > task.acceptance.length) return task;
    return {
      ...task,
      acceptance: task.acceptance.filter((_, index) => index !== criterion - 1),
      testPlan: task.testPlan
        .filter((entry) => entry.criterion !== criterion)
        .map((entry) =>
          entry.criterion > criterion ? { ...entry, criterion: entry.criterion - 1 } : entry,
        ),
    };
  });

/** Sets the check or paths of the test plan entry at `index` (0-based). */
export const editFactoryTestPlanEntry = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  index: number,
  edit: Partial<Pick<FactoryTestPlanEntryDraft, "check" | "paths">>,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => ({
    ...task,
    testPlan: task.testPlan.map((entry, at) => (at === index ? { ...entry, ...edit } : entry)),
  }));

/** Appends an empty test plan entry for criterion n (1-based). */
export const addFactoryTestPlanEntry = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  criterion: number,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => ({
    ...task,
    testPlan: [...task.testPlan, { criterion, check: "", paths: [] }],
  }));

/** Removes the test plan entry at `index` (0-based). */
export const removeFactoryTestPlanEntry = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  index: number,
): FactoryPlanDraft =>
  updateTask(draft, taskId, (task) => ({
    ...task,
    testPlan: task.testPlan.filter((_, at) => at !== index),
  }));

/** Moves a task one place up (-1) or down (1). A move past either end returns the draft as is. */
export const moveFactoryPlanTask = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
  offset: -1 | 1,
): FactoryPlanDraft => {
  const from = draft.tasks.findIndex((task) => task.base.id === taskId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= draft.tasks.length) return draft;
  const tasks = [...draft.tasks];
  [tasks[from], tasks[to]] = [tasks[to]!, tasks[from]!];
  return { ...draft, tasks };
};

/** Removes a task from the plan. */
export const removeFactoryPlanTask = (
  draft: FactoryPlanDraft,
  taskId: FactoryTaskId,
): FactoryPlanDraft => ({
  ...draft,
  tasks: draft.tasks.filter((task) => task.base.id !== taskId),
});

/** Prose the contract trims on decode, so the draft trims it too and bounds the trimmed text. */
const textFromDraft = (
  text: string,
  maxLength: number,
  field: FactoryPlanTaskField,
  errors: FactoryPlanTaskErrors,
): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) errors[field] = "Enter some text.";
  else if (trimmed.length > maxLength) errors[field] = `Use at most ${maxLength} characters.`;
  return trimmed;
};

const taskFromDraft = (
  task: FactoryPlanTaskDraft,
  errors: FactoryPlanTaskErrors,
): FactoryPlanTask => {
  const bounds = FACTORY_PLAN_BOUNDS;
  // The contract keeps a title as written; it must be one nonblank line.
  if (task.title.trim().length === 0 || /[\r\n]/.test(task.title)) {
    errors.title = "Enter a single-line title.";
  } else if (task.title.length > bounds.titleLength) {
    errors.title = `Use at most ${bounds.titleLength} characters.`;
  }
  const summary = textFromDraft(task.summary, bounds.summaryLength, "summary", errors);
  if (task.acceptance.length === 0) errors.acceptance = "Add at least one acceptance criterion.";
  else if (task.acceptance.length > bounds.criterionCount) {
    errors.acceptance = `Use at most ${bounds.criterionCount} acceptance criteria.`;
  }
  const acceptance = task.acceptance.map((text, index) =>
    textFromDraft(text, bounds.criterionLength, `acceptance.${index + 1}`, errors),
  );
  task.acceptance.forEach((_, index) => {
    const criterion = index + 1;
    if (!task.testPlan.some((entry) => entry.criterion === criterion)) {
      errors[`acceptance.${criterion}.testPlan`] =
        `Add a test plan entry for criterion ${criterion}.`;
    }
  });
  if (task.testPlan.length > bounds.testPlanCount) {
    errors.testPlan = `Use at most ${bounds.testPlanCount} test plan entries.`;
  }
  const testPlan = task.testPlan.map((entry, index) => {
    if (
      !Number.isInteger(entry.criterion) ||
      entry.criterion < 1 ||
      entry.criterion > task.acceptance.length
    ) {
      errors[`testPlan.${index}.criterion`] = "Choose one of the task's acceptance criteria.";
    }
    const check = textFromDraft(entry.check, bounds.checkLength, `testPlan.${index}.check`, errors);
    const unsafe = entry.paths.find((path) => !isRepoPath(path));
    if (unsafe !== undefined) {
      errors[`testPlan.${index}.paths`] =
        `Use a normalized repository-relative path outside .git: ${unsafe}`;
    } else if (entry.paths.length > bounds.pathCount) {
      errors[`testPlan.${index}.paths`] = `Use at most ${bounds.pathCount} paths.`;
    }
    return { criterion: entry.criterion, check, paths: [...entry.paths] };
  });
  return { ...task.base, title: task.title, summary, acceptance, testPlan };
};

/**
 * The plan a draft submits for `destination`, or a message for each task field it cannot submit.
 * The fields the draft does not edit, and the plan's note, come from its base unchanged. A draft
 * made for another delivery, or one whose plan changed under its edits, submits nothing.
 */
export const factoryPlanFromDraft = (
  draft: FactoryPlanDraft,
  destination: FactoryPlanDestination,
): FactoryPlanDraftResult => {
  if (!sameDestination(draft, destination)) {
    return {
      _tag: "Mismatch",
      draft: { environmentId: draft.environmentId, deliveryId: draft.deliveryId },
      requested: { environmentId: destination.environmentId, deliveryId: destination.deliveryId },
    };
  }
  if (draft.current !== null) return { _tag: "Changed", current: draft.current };
  const errors: Record<string, FactoryPlanTaskErrors> = {};
  const tasks = draft.tasks.map((task) => {
    const taskErrors: FactoryPlanTaskErrors = {};
    const planned = taskFromDraft(task, taskErrors);
    if (Object.keys(taskErrors).length > 0) errors[task.base.id] = taskErrors;
    return planned;
  });
  if (Object.keys(errors).length > 0) return { _tag: "Invalid", errors };
  return { _tag: "Valid", plan: { ...draft.base, tasks } };
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// Criteria and test plan entries are one edit: entries name criteria by position.
const sameCriteria = (left: FactoryPlanTaskDraft, right: FactoryPlanTaskDraft) =>
  sameStrings(left.acceptance, right.acceptance) &&
  left.testPlan.length === right.testPlan.length &&
  left.testPlan.every((entry, index) => {
    const other = right.testPlan[index]!;
    return (
      entry.criterion === other.criterion &&
      entry.check === other.check &&
      sameStrings(entry.paths, other.paths)
    );
  });

const sameTask = (left: FactoryPlanTaskDraft, right: FactoryPlanTaskDraft) =>
  left.title === right.title && left.summary === right.summary && sameCriteria(left, right);

/** Whether the draft differs from its base in task order, membership or any edited field. */
export const factoryPlanDraftEdited = (draft: FactoryPlanDraft): boolean => {
  const unedited = factoryPlanDraft(draft, draft.base);
  return (
    draft.tasks.length !== unedited.tasks.length ||
    draft.tasks.some((task, index) => {
      const base = unedited.tasks[index]!;
      return task.base.id !== base.base.id || !sameTask(task, base);
    })
  );
};

/**
 * A draft once the server's plan for its delivery moves. An unedited draft follows the new plan.
 * An edited one keeps every edit over its base and holds the new plan as `current` until the
 * owner reapplies or discards the edits; a plan equal to the base clears `current`. A plan for
 * another delivery leaves the draft as it is.
 */
export const rebaseFactoryPlanDraft = (
  draft: FactoryPlanDraft,
  destination: FactoryPlanDestination,
  next: FactoryPlan,
): FactoryPlanDraft => {
  if (!sameDestination(draft, destination)) return draft;
  const atBase = Equal.equals(next, draft.base);
  if (!factoryPlanDraftEdited(draft)) {
    return atBase && draft.current === null ? draft : factoryPlanDraft(destination, next);
  }
  if (atBase) return draft.current === null ? draft : { ...draft, current: null };
  if (draft.current !== null && Equal.equals(next, draft.current)) return draft;
  return { ...draft, current: next };
};

/** Drops the edits of a draft whose plan changed, leaving the new plan unedited. */
export const discardFactoryPlanEdits = (draft: FactoryPlanDraft): FactoryPlanDraft =>
  draft.current === null ? draft : factoryPlanDraft(draft, draft.current);

/**
 * Moves a draft's edits onto the plan that changed under them. Each field the owner edited (the
 * title, the summary, or the criteria with their test plan entries) keeps the owner's value, and
 * every other field takes the new plan's. Edits of a task the new plan dropped are dropped, a task
 * the owner removed stays removed, and a task only the new plan has is added unedited, so the
 * task ids are always the new plan's. The owner's order holds when they reordered tasks, with
 * added tasks after it; otherwise the new plan's order does.
 */
export const reapplyFactoryPlanEdits = (draft: FactoryPlanDraft): FactoryPlanDraft => {
  const next = draft.current;
  if (next === null) return draft;
  const before = new Map(draft.base.tasks.map((task) => [task.id, taskDraft(task)]));
  const edited = new Map(draft.tasks.map((task) => [task.base.id, task]));
  const keptOrder = draft.base.tasks.filter((task) => edited.has(task.id));
  const reordered = draft.tasks.some((task, index) => task.base.id !== keptOrder[index]!.id);
  const order = reordered
    ? [
        ...draft.tasks.flatMap((mine) => next.tasks.filter((task) => task.id === mine.base.id)),
        ...next.tasks.filter((task) => !before.has(task.id)),
      ]
    : next.tasks;
  const tasks = order.flatMap((task): ReadonlyArray<FactoryPlanTaskDraft> => {
    const old = before.get(task.id);
    const fresh = taskDraft(task);
    if (old === undefined) return [fresh];
    const mine = edited.get(task.id);
    if (mine === undefined) return [];
    const criteria = sameCriteria(mine, old) ? fresh : mine;
    return [
      {
        base: task,
        title: mine.title === old.title ? fresh.title : mine.title,
        summary: mine.summary === old.summary ? fresh.summary : mine.summary,
        acceptance: criteria.acceptance,
        testPlan: criteria.testPlan,
      },
    ];
  });
  return { ...draft, base: next, tasks, current: null };
};
