import {
  addFactoryPlanCriterion,
  addFactoryTestPlanEntry,
  discardFactoryPlanEdits,
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  editFactoryTestPlanEntry,
  factoryPlanDraft,
  type FactoryPlanDraft,
  type FactoryPlanTaskDraft,
  type FactoryPlanTaskErrors,
  moveFactoryPlanTask,
  reapplyFactoryPlanEdits,
  removeFactoryPlanCriterion,
  removeFactoryPlanTask,
  removeFactoryTestPlanEntry,
} from "@t3tools/client-runtime/fd/factory";
import type { FactoryDeliveryId, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type FactoryPlanDecision,
  factoryPlanDecision,
  factoryPlanDraftState,
  type FactoryPlanGate as FactoryPlanGateModel,
  factoryPlanGateActions,
  type FactoryPlanRefusal,
  factoryPlanRefusal,
  factoryPlanSave,
  factoryPlanTaskErrors,
  factoryReplanRequest,
  followFactoryPlan,
} from "./planGate";
import { factoryEnvironment } from "./state";

type Pending = "save" | FactoryPlanDecision | "replan";

/** Edits one draft: each control passes the change it makes to the draft as it then stands. */
type EditDraft = (change: (draft: FactoryPlanDraft) => FactoryPlanDraft) => void;

/**
 * The plan a delivery waits on at the plan gate, editable in a draft pinned to that delivery:
 * task titles, summaries, criteria and test plans, their order and which stay. Save sends the
 * edited plan; approve and reject ask first; replan sends a note to the planner. Nothing applies
 * locally: the view changes when the change epoch refetches the delivery, and a plan changed on
 * the server while the owner edits is flagged for them to keep their edits over it or drop them.
 * The parent keys it by destination, so a draft never outlives its delivery.
 */
export function FactoryPlanGate({
  gate,
  itemKey,
}: {
  readonly gate: FactoryPlanGateModel;
  readonly itemKey: string;
}) {
  const updatePlan = useAtomCommand(factoryEnvironment.updatePlan);
  const approvePlan = useAtomCommand(factoryEnvironment.approvePlan);
  const rejectPlan = useAtomCommand(factoryEnvironment.rejectPlan);
  const replan = useAtomCommand(factoryEnvironment.replan);
  // The server plan the draft last followed.
  const [followed, setFollowed] = useState(gate.plan);
  const [draft, setDraft] = useState(() => followFactoryPlan(null, gate));
  const [refusal, setRefusal] = useState<FactoryPlanRefusal | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // The decision an open confirmation asks for, and the delivery it was opened for.
  const [confirming, setConfirming] = useState<{
    readonly decision: FactoryPlanDecision;
    readonly deliveryId: FactoryDeliveryId;
  } | null>(null);
  // The replan note being written; null while replan is closed.
  const [note, setNote] = useState<string | null>(null);
  if (gate.plan !== followed) {
    setFollowed(gate.plan);
    setDraft(followFactoryPlan(draft, gate));
    setRefusal(null);
  }

  const state = factoryPlanDraftState(draft);
  const save = factoryPlanSave(gate, draft);
  const actions = factoryPlanGateActions(gate, draft);
  // Adjusted during render: a confirmation closes once it could no longer send for its delivery.
  if (
    confirming !== null &&
    factoryPlanDecision(gate, draft, confirming.decision, confirming.deliveryId)._tag !== "Send"
  ) {
    setConfirming(null);
  }
  const replanning = note === null ? null : factoryReplanRequest(gate, note);
  const editable = gate.offered.update && pending === null;
  const ownErrors = save._tag === "Invalid" ? save.errors : {};
  const edit: EditDraft = (change) => setDraft((current) => change(current));

  const submit = async () => {
    if (save._tag !== "Save") return;
    setPending("save");
    setRefusal(null);
    const result = await updatePlan(save.request);
    setPending(null);
    if (result._tag === "Failure") setRefusal(factoryPlanRefusal(result.cause));
    else setDraft(factoryPlanDraft(gate.destination, save.plan));
  };
  const decide = async (decision: FactoryPlanDecision, deliveryId: FactoryDeliveryId) => {
    setConfirming(null);
    const outcome = factoryPlanDecision(gate, draft, decision, deliveryId);
    if (outcome._tag !== "Send") return;
    setPending(decision);
    setRefusal(null);
    const result = await (decision === "approve" ? approvePlan : rejectPlan)(outcome.request);
    setPending(null);
    if (result._tag === "Failure") setRefusal(factoryPlanRefusal(result.cause));
  };
  const ask = (decision: FactoryPlanDecision) => {
    if (factoryPlanDecision(gate, draft, decision, null)._tag === "Confirm") {
      setConfirming({ decision, deliveryId: gate.destination.deliveryId });
    }
  };
  const sendReplan = async () => {
    if (replanning?._tag !== "Send") return;
    setPending("replan");
    setRefusal(null);
    const result = await replan(replanning.request);
    setPending(null);
    if (result._tag === "Failure") setRefusal(factoryPlanRefusal(result.cause));
    else setNote(null);
  };

  const offered = gate.offered;
  const tasks = draft.tasks;
  return (
    <section className="space-y-2 rounded-md border p-2" aria-label="Plan">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium text-sm">Plan</h4>
        <span className="text-muted-foreground text-xs">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"}, delivered in this order
        </span>
      </div>
      {draft.base.note !== undefined ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
          {draft.base.note}
        </p>
      ) : null}
      {state === "changed" ? (
        <div className="space-y-1 text-xs">
          <p className="text-warning-foreground">
            The plan changed while you were editing it. Keep your edits over the new plan, or use
            the new plan as it is.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() => edit(reapplyFactoryPlanEdits)}
            >
              Keep my edits
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => edit(discardFactoryPlanEdits)}
            >
              Use the new plan
            </Button>
          </div>
        </div>
      ) : null}
      <ol className="space-y-2" aria-label="Planned tasks">
        {tasks.map((task, position) => (
          <PlanTask
            key={task.base.id}
            task={task}
            position={position}
            count={tasks.length}
            errors={factoryPlanTaskErrors(ownErrors, refusal, task.base.id)}
            refused={refusal?.tasks[task.base.id]}
            disabled={!editable}
            edit={edit}
          />
        ))}
      </ol>
      {refusal !== null ? <p className="text-destructive text-xs">{refusal.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        {offered.update ? (
          <>
            <Button
              size="xs"
              disabled={pending !== null || save._tag !== "Save"}
              onClick={() => void submit()}
            >
              {pending === "save" ? "Saving…" : "Save plan"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== null || state !== "edited"}
              onClick={() => edit((current) => factoryPlanDraft(gate.destination, current.base))}
            >
              Discard edits
            </Button>
          </>
        ) : null}
        {offered.approve ? (
          <Button
            size="xs"
            disabled={pending !== null || !actions.approve}
            onClick={() => ask("approve")}
          >
            Approve plan
          </Button>
        ) : null}
        {actions.replan ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null || note !== null}
            onClick={() => setNote("")}
          >
            Replan
          </Button>
        ) : null}
        {actions.reject ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => ask("reject")}
          >
            Reject plan
          </Button>
        ) : null}
      </div>
      {offered.approve && !actions.approve ? (
        <p className="text-muted-foreground text-xs">Save or discard your edits to approve.</p>
      ) : null}
      {!offered.update && !offered.approve && !offered.reject && !offered.replan ? (
        <p className="text-muted-foreground text-xs">
          Acting on the plan needs a live connection allowed to run agents.
        </p>
      ) : null}
      {note !== null && replanning !== null ? (
        <div className="space-y-1">
          <Textarea
            size="sm"
            aria-label="What the planner should change"
            placeholder="What should the planner change?"
            disabled={pending !== null}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {replanning._tag === "Invalid" && note.trim().length > 0 ? (
            <p className="text-destructive text-xs">{replanning.message}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={pending !== null || replanning._tag !== "Send"}
              onClick={() => void sendReplan()}
            >
              {pending === "replan" ? "Sending…" : "Send to planner"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => setNote(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.decision === "reject" ? "Reject" : "Approve"} the plan of {itemKey}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.decision === "reject"
                ? "The delivery ends cancelled and no child items are created. Its branch, worktree and commits stay; delivering the item again starts on a new branch."
                : `Factory creates ${tasks.length === 1 ? "a child item" : `${tasks.length} child items`} in the item's Work source, each blocked by the one before, and delivers them one at a time in this order on the item's branch. The plan cannot be changed after this.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep waiting</AlertDialogClose>
            <Button
              variant={confirming?.decision === "reject" ? "destructive" : "default"}
              disabled={confirming === null || pending !== null}
              onClick={() => {
                if (confirming !== null) void decide(confirming.decision, confirming.deliveryId);
              }}
            >
              {confirming?.decision === "reject" ? "Reject plan" : "Approve plan"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

/** A labelled control with the message of its field, if any. */
function Field({
  label,
  error,
  children,
}: {
  readonly label: string;
  readonly error: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {error !== undefined ? <span className="block text-destructive">{error}</span> : null}
    </label>
  );
}

/** One planned task. Its id, kind, risk and likely paths stay the planner's and show read-only. */
function PlanTask({
  task,
  position,
  count,
  errors,
  refused,
  disabled,
  edit,
}: {
  readonly task: FactoryPlanTaskDraft;
  readonly position: number;
  readonly count: number;
  readonly errors: FactoryPlanTaskErrors;
  readonly refused: string | undefined;
  readonly disabled: boolean;
  readonly edit: EditDraft;
}) {
  const id = task.base.id;
  const number = position + 1;
  const criteria = task.acceptance.length;
  // Entries naming no criterion of the task; the draft never makes one, a server plan could.
  const unassigned = task.testPlan.flatMap((entry, index) =>
    entry.criterion >= 1 && entry.criterion <= criteria ? [] : [index],
  );
  return (
    <li className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Task {number}</span>
        <span className="font-mono text-muted-foreground">{id}</span>
        <Badge variant="outline">{task.base.kind}</Badge>
        {task.base.risk === "high" ? <Badge variant="warning">High risk</Badge> : null}
        <div className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move task ${number} up`}
          disabled={disabled || position === 0}
          onClick={() => edit((draft) => moveFactoryPlanTask(draft, id, -1))}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move task ${number} down`}
          disabled={disabled || position === count - 1}
          onClick={() => edit((draft) => moveFactoryPlanTask(draft, id, 1))}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove task ${number} from the plan`}
          disabled={disabled || count === 1}
          onClick={() => edit((draft) => removeFactoryPlanTask(draft, id))}
        >
          <XIcon />
        </Button>
      </div>
      {refused !== undefined ? <p className="text-destructive">{refused}</p> : null}
      <Field label="Title" error={errors.title}>
        <Input
          size="sm"
          aria-invalid={errors.title !== undefined}
          disabled={disabled}
          value={task.title}
          onChange={(event) => {
            const title = event.target.value;
            edit((draft) => editFactoryPlanTask(draft, id, { title }));
          }}
        />
      </Field>
      <Field label="Summary" error={errors.summary}>
        <Textarea
          size="sm"
          aria-invalid={errors.summary !== undefined}
          disabled={disabled}
          value={task.summary}
          onChange={(event) => {
            const summary = event.target.value;
            edit((draft) => editFactoryPlanTask(draft, id, { summary }));
          }}
        />
      </Field>
      <div className="space-y-2">
        <span className="text-muted-foreground">Acceptance criteria and their tests</span>
        {task.acceptance.map((text, index) => {
          const criterion = index + 1;
          return (
            // Criteria are numbered by position, and test plan entries name them by it.
            // oxlint-disable-next-line react/no-array-index-key -- a criterion is its position
            <div key={index} className="space-y-1 rounded-md border p-2">
              <div className="flex items-start gap-2">
                <span className="pt-1">{criterion}.</span>
                <Textarea
                  size="sm"
                  aria-label={`Criterion ${criterion} of task ${number}`}
                  aria-invalid={errors[`acceptance.${criterion}`] !== undefined}
                  disabled={disabled}
                  value={text}
                  onChange={(event) => {
                    const value = event.target.value;
                    edit((draft) => editFactoryPlanCriterion(draft, id, criterion, value));
                  }}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove criterion ${criterion} and its tests`}
                  disabled={disabled}
                  onClick={() => edit((draft) => removeFactoryPlanCriterion(draft, id, criterion))}
                >
                  <XIcon />
                </Button>
              </div>
              {errors[`acceptance.${criterion}`] !== undefined ? (
                <p className="text-destructive">{errors[`acceptance.${criterion}`]}</p>
              ) : null}
              {task.testPlan.map((entry, entryIndex) =>
                entry.criterion === criterion ? (
                  <TestPlanEntry
                    // oxlint-disable-next-line react/no-array-index-key -- entries are positional
                    key={entryIndex}
                    taskId={id}
                    index={entryIndex}
                    entry={entry}
                    errors={errors}
                    disabled={disabled}
                    edit={edit}
                  />
                ) : null,
              )}
              {errors[`acceptance.${criterion}.testPlan`] !== undefined ? (
                <p className="text-destructive">{errors[`acceptance.${criterion}.testPlan`]}</p>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => edit((draft) => addFactoryTestPlanEntry(draft, id, criterion))}
              >
                Add a test for criterion {criterion}
              </Button>
            </div>
          );
        })}
        {unassigned.map((index) => (
          <TestPlanEntry
            key={`unassigned:${index}`}
            taskId={id}
            index={index}
            entry={task.testPlan[index]!}
            errors={errors}
            disabled={disabled}
            edit={edit}
          />
        ))}
        {errors.acceptance !== undefined ? (
          <p className="text-destructive">{errors.acceptance}</p>
        ) : null}
        {errors.testPlan !== undefined ? (
          <p className="text-destructive">{errors.testPlan}</p>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => edit((draft) => addFactoryPlanCriterion(draft, id))}
        >
          Add a criterion
        </Button>
      </div>
      {task.base.likelyPaths.length > 0 ? (
        <p className="break-words text-muted-foreground">
          Likely paths: <span className="font-mono">{task.base.likelyPaths.join(", ")}</span>
        </p>
      ) : null}
    </li>
  );
}

/** A test plan entry: its check, and the paths of its evidence, each in its own field. */
function TestPlanEntry({
  taskId,
  index,
  entry,
  errors,
  disabled,
  edit,
}: {
  readonly taskId: FactoryTaskId;
  readonly index: number;
  readonly entry: FactoryPlanTaskDraft["testPlan"][number];
  readonly errors: FactoryPlanTaskErrors;
  readonly disabled: boolean;
  readonly edit: EditDraft;
}) {
  const setPaths = (paths: ReadonlyArray<string>) =>
    edit((draft) => editFactoryTestPlanEntry(draft, taskId, index, { paths }));
  const check = errors[`testPlan.${index}.check`];
  const paths = errors[`testPlan.${index}.paths`];
  const criterion = errors[`testPlan.${index}.criterion`];
  return (
    <div className="space-y-1 ps-4">
      <div className="flex items-start gap-2">
        <Textarea
          size="sm"
          aria-label={`Test for criterion ${entry.criterion}`}
          aria-invalid={check !== undefined}
          placeholder="How the criterion is checked"
          disabled={disabled}
          value={entry.check}
          onChange={(event) => {
            const value = event.target.value;
            edit((draft) => editFactoryTestPlanEntry(draft, taskId, index, { check: value }));
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove this test for criterion ${entry.criterion}`}
          disabled={disabled}
          onClick={() => edit((draft) => removeFactoryTestPlanEntry(draft, taskId, index))}
        >
          <XIcon />
        </Button>
      </div>
      {check !== undefined ? <p className="text-destructive">{check}</p> : null}
      {criterion !== undefined ? <p className="text-destructive">{criterion}</p> : null}
      {entry.paths.map((path, at) => (
        // oxlint-disable-next-line react/no-array-index-key -- a path is its position
        <div key={at} className="flex items-center gap-2">
          <Input
            size="sm"
            font="mono"
            aria-label={`Evidence path ${at + 1}`}
            aria-invalid={paths !== undefined}
            disabled={disabled}
            value={path}
            onChange={(event) =>
              setPaths(
                entry.paths.map((value, other) => (other === at ? event.target.value : value)),
              )
            }
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove evidence path ${at + 1}`}
            disabled={disabled}
            onClick={() => setPaths(entry.paths.filter((_, other) => other !== at))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      {paths !== undefined ? <p className="text-destructive">{paths}</p> : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={() => setPaths([...entry.paths, ""])}
      >
        Add an evidence path
      </Button>
    </div>
  );
}
