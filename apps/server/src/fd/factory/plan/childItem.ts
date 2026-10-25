import type {
  FactoryDeliveryId,
  FactoryPlanTask,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemCreateInput, type WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Schema from "effect/Schema";

/**
 * The line that opens an approved task's child item: the parent delivery and the task the item
 * was created for. A run that stopped after creating a child but before recording it finds the
 * child again by it, so it never creates a second. Ids are slugs, which hold no backtick, so one
 * task's reference is never part of another's. It comes first, so a source that indexes only the
 * start of a long body still finds it.
 */
export const childReference = (deliveryId: FactoryDeliveryId, taskId: FactoryTaskId) =>
  `Planned by Factory delivery \`${deliveryId}\` as task \`${taskId}\`.`;

/**
 * A line Work's Markdown source reads as a merge conflict marker, which makes it refuse the whole
 * file: a run of `<` or `=`, or of seven or more `>`, alone or before a space or tab. A shorter run
 * of `>` counts only after such `<` and `=` lines, so a Markdown quote is left as it is.
 */
const CONFLICT_MARKER_LINE = /^(?:<+|=+|>{7,})(?:[ \t\r]|$)/;

/**
 * The task's text as Markdown its source stores as written: a line read as a conflict marker gets
 * a backslash first, which Markdown renders as the same text.
 */
const escapeConflictMarkers = (text: string) =>
  text
    .split("\n")
    .map((line) => (CONFLICT_MARKER_LINE.test(line) ? `\\${line}` : line))
    .join("\n");

/**
 * A line or paragraph separator, or half a surrogate pair: Markdown keeps a title on one line as
 * written, and refuses these where a Work title allows them.
 */
const MARKDOWN_TITLE_REFUSED = /[\u0085\p{Zl}\p{Zp}\p{Cs}]/u;

/** The child item's body: its reference, then the task's summary, criteria and test plan. */
const childItemBody = (deliveryId: FactoryDeliveryId, task: FactoryPlanTask) =>
  escapeConflictMarkers(
    [
      childReference(deliveryId, task.id),
      "",
      task.summary,
      "",
      "## Acceptance criteria",
      "",
      ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
      "",
      "## Test plan",
      "",
      ...task.testPlan.map(({ criterion, check, paths }) =>
        paths.length === 0
          ? `- Criterion ${criterion}: ${check}`
          : `- Criterion ${criterion}: ${check} (${paths.map((path) => `\`${path}\``).join(", ")})`,
      ),
      "",
    ].join("\n"),
  );

/** What Work is asked to create for a task: an item titled as the task, under the parent item. */
export const childItemInput = (input: {
  readonly parent: WorkItemRef;
  readonly deliveryId: FactoryDeliveryId;
  readonly task: FactoryPlanTask;
}): WorkItemCreateInput => ({
  sourceId: input.parent.sourceId,
  title: input.task.title,
  body: childItemBody(input.deliveryId, input.task),
  parent: input.parent.itemId,
});

const isCreatable = Schema.is(WorkItemCreateInput);

/**
 * The tasks whose child item the parent's Markdown source would refuse: a body past what a Work
 * item holds, or a title it cannot keep on one line. Nothing of a task is cut or changed to fit,
 * so approval refuses such a plan and the owner edits it.
 */
export const uncreatableTasks = (
  parent: WorkItemRef,
  deliveryId: FactoryDeliveryId,
  tasks: ReadonlyArray<FactoryPlanTask>,
): ReadonlyArray<FactoryTaskId> =>
  tasks
    .filter(
      (task) =>
        MARKDOWN_TITLE_REFUSED.test(task.title) ||
        !isCreatable(childItemInput({ parent, deliveryId, task })),
    )
    .map(({ id }) => id);
