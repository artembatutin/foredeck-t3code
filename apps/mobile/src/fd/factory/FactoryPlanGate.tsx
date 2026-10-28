import {
  addFactoryPlanCriterion,
  addFactoryTestPlanEntry,
  discardFactoryPlanEdits,
  editFactoryPlanCriterion,
  editFactoryPlanTask,
  editFactoryTestPlanEntry,
  factoryPlanConfirmed,
  type FactoryPlanDecision,
  factoryPlanDraft,
  type FactoryPlanDraft,
  factoryPlanDraftState,
  type FactoryPlanGate as FactoryPlanGateModel,
  type FactoryPlanTaskDraft,
  type FactoryPlanTaskErrors,
  moveFactoryPlanTask,
  reapplyFactoryPlanEdits,
  removeFactoryPlanCriterion,
  removeFactoryPlanTask,
  removeFactoryTestPlanEntry,
} from "@t3tools/client-runtime/fd/factory";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { FactoryDelivery, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StatusPill } from "../../components/StatusPill";
import { useAtomCommand } from "../../state/use-atom-command";
import { Control, SectionTitle } from "./Control";
import {
  changeMobilePlanEdit,
  followMobilePlanEdit,
  mobilePlanEdit,
  mobilePlanSave,
  mobilePlanTaskErrors,
  refuseMobilePlanEdit,
  settleMobilePlanSave,
} from "./planEdit";
import { mobilePlanActions, mobilePlanDecisionTarget, mobileReplanRequest } from "./planGate";
import { factoryEnvironment } from "./state";

type Pending = "save" | FactoryPlanDecision | "replan";

/** Edits one draft: each control passes the change it makes to the draft as it then stands. */
type EditDraft = (change: (draft: FactoryPlanDraft) => FactoryPlanDraft) => void;

// The plan stacks many fields, so they sit a little shorter than a form's.
const INPUT_CLASS = "min-h-11 py-2.5";

/**
 * The plan a delivery waits on at the plan gate, editable in a draft pinned to that delivery:
 * task titles, summaries, criteria and test plans, their order and which stay. Save sends the
 * edited plan; approve and reject ask first in a native alert, for the plan shown then; replan
 * sends a note to the planner. Nothing applies locally: the view changes when the change epoch
 * refetches the delivery, and a plan changed on the server while the owner edits is flagged for
 * them to keep their edits over it or drop them. The parent keys it by destination, so a draft
 * or note never outlives its delivery.
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
  const [held, setHeld] = useState(() => mobilePlanEdit(gate));
  const [pending, setPending] = useState<Pending | null>(null);
  // The replan note being written; null while replan is closed.
  const [note, setNote] = useState<string | null>(null);
  const following = followMobilePlanEdit(held, gate);
  if (following !== held) setHeld(following);
  const draft = following.draft;
  // An alert's press reads the gate and draft as they are then, not as they were when it opened.
  const latest = useRef<{ gate: FactoryPlanGateModel; draft: FactoryPlanDraft } | null>(null);
  useLayoutEffect(() => {
    latest.current = { gate, draft };
  });
  useLayoutEffect(
    () => () => {
      latest.current = null;
    },
    [],
  );

  const { destination } = gate;
  const edit: EditDraft = (change) => setHeld((current) => changeMobilePlanEdit(current, change));

  /** Runs one plan command; a refusal shows on the fields it names and leaves the draft. */
  const run = async (
    action: Pending,
    execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>,
  ) => {
    setPending(action);
    setHeld((current) => ({ ...current, refusal: null }));
    const result = await execute();
    setPending(null);
    if (result._tag === "Failure") {
      setHeld((current) => refuseMobilePlanEdit(current, destination, result));
    }
    return result._tag === "Success";
  };

  const state = factoryPlanDraftState(draft);
  const save = mobilePlanSave(gate, draft);
  const submit = async () => {
    if (save._tag !== "Save") return;
    const sentOver = gate.plan;
    if (await run("save", () => updatePlan(save.request))) {
      setHeld((current) => settleMobilePlanSave(current, destination, sentOver, save.plan));
    }
  };

  const confirm = (decision: FactoryPlanDecision) => {
    const openedFor = factoryPlanConfirmed(gate);
    const count = openedFor.plan.tasks.length;
    const press = () => {
      const now = latest.current;
      if (now === null) return;
      const request = mobilePlanDecisionTarget(now.gate, now.draft, decision, openedFor);
      if (request === null) return;
      void run(decision, () => (decision === "approve" ? approvePlan : rejectPlan)(request));
    };
    if (decision === "approve") {
      Alert.alert(
        `Approve the plan of ${itemKey}?`,
        `Factory creates ${count === 1 ? "a child item" : `${count} child items`} in the item's Work source, each blocked by the one before, and delivers them one at a time in this order on the item's branch. The plan cannot be changed after this.`,
        [
          { text: "Keep waiting", style: "cancel" },
          { text: "Approve plan", onPress: press },
        ],
      );
    } else {
      Alert.alert(
        `Reject the plan of ${itemKey}?`,
        "The delivery ends cancelled and no child items are created. Its branch, worktree and commits stay; delivering the item again starts on a new branch.",
        [
          { text: "Keep waiting", style: "cancel" },
          { text: "Reject plan", style: "destructive", onPress: press },
        ],
      );
    }
  };

  const writtenFor = destination.deliveryId;
  const replanning = note === null ? null : mobileReplanRequest(gate, writtenFor, note);
  const sendReplan = async () => {
    if (note === null) return;
    const request = mobileReplanRequest(latest.current?.gate ?? null, writtenFor, note);
    if (request._tag !== "Send") return;
    if (await run("replan", () => replan(request.request))) setNote(null);
  };

  const { offered } = gate;
  const actions = mobilePlanActions(gate, draft);
  const { refusal } = following;
  const editable = offered.update && pending === null;
  const tasks = draft.tasks;
  return (
    <View className="gap-2" accessibilityLabel="Plan">
      <SectionTitle
        trailing={
          <Text className="text-xs text-foreground-muted">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}, delivered in this order
          </Text>
        }
      >
        Plan
      </SectionTitle>
      {draft.base.note !== undefined ? (
        <Text selectable className="text-xs text-foreground-muted">
          {draft.base.note}
        </Text>
      ) : null}
      {state === "changed" ? (
        <View className="gap-2 rounded-2xl bg-warning px-3.5 py-3">
          <Text className="text-sm font-t3-medium text-warning-foreground">
            The plan changed while you were editing it. Keep your edits over the new plan, or use
            the new plan as it is.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Control
              label="Keep my edits"
              disabled={pending !== null}
              onPress={() => edit(reapplyFactoryPlanEdits)}
            />
            <Control
              label="Use the new plan"
              disabled={pending !== null}
              onPress={() => edit(discardFactoryPlanEdits)}
            />
          </View>
        </View>
      ) : null}
      {tasks.map((task, position) => (
        <PlanTask
          key={task.base.id}
          task={task}
          position={position}
          count={tasks.length}
          errors={mobilePlanTaskErrors(save, refusal, task.base.id)}
          refused={refusal?.tasks[task.base.id]}
          editable={editable}
          edit={edit}
        />
      ))}
      {save._tag === "Empty" ? <ErrorBanner message={save.message} /> : null}
      {refusal !== null ? <ErrorBanner message={refusal.message} /> : null}
      {offered.update || offered.approve || actions.reject || actions.replan ? (
        <View className="flex-row flex-wrap gap-2">
          {offered.update ? (
            <>
              <Control
                label={pending === "save" ? "Saving…" : "Save plan"}
                disabled={pending !== null || save._tag !== "Save"}
                onPress={() => void submit()}
              />
              <Control
                label="Discard edits"
                disabled={pending !== null || state !== "edited"}
                onPress={() => edit((current) => factoryPlanDraft(destination, current.base))}
              />
            </>
          ) : null}
          {offered.approve ? (
            <Control
              label="Approve plan"
              primary
              disabled={pending !== null || !actions.approve}
              onPress={() => confirm("approve")}
            />
          ) : null}
          {actions.replan ? (
            <Control
              label="Replan"
              disabled={pending !== null || note !== null}
              onPress={() => setNote("")}
            />
          ) : null}
          {actions.reject ? (
            <Control
              label="Reject plan"
              disabled={pending !== null}
              onPress={() => confirm("reject")}
            />
          ) : null}
        </View>
      ) : (
        <Text className="text-xs text-foreground-muted">
          Acting on the plan needs a live connection allowed to run agents.
        </Text>
      )}
      {offered.approve && !actions.approve ? (
        <Text className="text-xs text-foreground-muted">
          {state === "unedited"
            ? "Approve once the saved plan has loaded."
            : "Save or discard your edits to approve."}
        </Text>
      ) : null}
      {note !== null && replanning !== null && actions.replan ? (
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel="What the planner should change"
            className="min-h-24"
            placeholder="What should the planner change?"
            multiline
            textAlignVertical="top"
            editable={pending === null}
            value={note}
            onChangeText={setNote}
          />
          {replanning._tag === "Invalid" && note.trim().length > 0 ? (
            <ErrorBanner message={replanning.message} />
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Control
              label={pending === "replan" ? "Sending…" : "Send to planner"}
              primary
              disabled={pending !== null || replanning._tag !== "Send"}
              onPress={() => void sendReplan()}
            />
            <Control label="Cancel" disabled={pending !== null} onPress={() => setNote(null)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A field's message, if any. */
function FieldError({ message }: { readonly message: string | undefined }) {
  return message !== undefined ? <Text className="text-xs text-destructive">{message}</Text> : null;
}

/**
 * One planned task. Its id, kind, risk and likely paths stay the planner's and show read-only;
 * the planner's text is shown as plain text, never as markup.
 */
function PlanTask({
  task,
  position,
  count,
  errors,
  refused,
  editable,
  edit,
}: {
  readonly task: FactoryPlanTaskDraft;
  readonly position: number;
  readonly count: number;
  readonly errors: FactoryPlanTaskErrors;
  readonly refused: string | undefined;
  readonly editable: boolean;
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
    <View className="gap-2 rounded-[24px] bg-grouped-card p-4 android:rounded-[28px]">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-t3-semibold text-foreground">Task {number}</Text>
        <Text className="text-xs text-foreground-muted">{task.base.kind}</Text>
        {task.base.risk === "high" ? (
          <StatusPill
            label="High risk"
            size="compact"
            pillClassName="bg-warning"
            textClassName="text-warning-foreground"
          />
        ) : null}
      </View>
      {editable ? (
        <View className="flex-row flex-wrap gap-2">
          <Control
            label="Move up"
            disabled={position === 0}
            onPress={() => edit((draft) => moveFactoryPlanTask(draft, id, -1))}
          />
          <Control
            label="Move down"
            disabled={position === count - 1}
            onPress={() => edit((draft) => moveFactoryPlanTask(draft, id, 1))}
          />
          <Control
            label="Remove task"
            disabled={count === 1}
            onPress={() => edit((draft) => removeFactoryPlanTask(draft, id))}
          />
        </View>
      ) : null}
      <FieldError message={refused} />
      <AppTextInput
        accessibilityLabel={`Title of task ${number}`}
        className={INPUT_CLASS}
        editable={editable}
        value={task.title}
        onChangeText={(title) => edit((draft) => editFactoryPlanTask(draft, id, { title }))}
      />
      <FieldError message={errors.title} />
      <AppTextInput
        accessibilityLabel={`Summary of task ${number}`}
        className={INPUT_CLASS}
        multiline
        textAlignVertical="top"
        editable={editable}
        value={task.summary}
        onChangeText={(summary) => edit((draft) => editFactoryPlanTask(draft, id, { summary }))}
      />
      <FieldError message={errors.summary} />
      <Text className="pt-1 text-sm font-t3-medium text-foreground-muted">
        Acceptance criteria and their tests
      </Text>
      {task.acceptance.map((text, index) => {
        const criterion = index + 1;
        return (
          // Criteria are numbered by position, and test plan entries name them by it.
          // oxlint-disable-next-line react/no-array-index-key -- a criterion is its position
          <View key={index} className="gap-1">
            <Text className="px-1 text-xs font-t3-medium text-foreground">
              Criterion {criterion}
            </Text>
            <AppTextInput
              accessibilityLabel={`Criterion ${criterion} of task ${number}`}
              className={INPUT_CLASS}
              multiline
              textAlignVertical="top"
              editable={editable}
              value={text}
              onChangeText={(value) =>
                edit((draft) => editFactoryPlanCriterion(draft, id, criterion, value))
              }
            />
            <FieldError message={errors[`acceptance.${criterion}`]} />
            {task.testPlan.map((entry, entryIndex) =>
              entry.criterion === criterion ? (
                <TestPlanEntry
                  // oxlint-disable-next-line react/no-array-index-key -- entries are positional
                  key={entryIndex}
                  taskId={id}
                  index={entryIndex}
                  entry={entry}
                  errors={errors}
                  editable={editable}
                  edit={edit}
                />
              ) : null,
            )}
            <FieldError message={errors[`acceptance.${criterion}.testPlan`]} />
            {editable ? (
              <View className="flex-row flex-wrap gap-2">
                <Control
                  label="Add a test"
                  onPress={() => edit((draft) => addFactoryTestPlanEntry(draft, id, criterion))}
                />
                <Control
                  label="Remove criterion"
                  onPress={() => edit((draft) => removeFactoryPlanCriterion(draft, id, criterion))}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {unassigned.map((index) => (
        <TestPlanEntry
          key={`unassigned:${index}`}
          taskId={id}
          index={index}
          entry={task.testPlan[index]!}
          errors={errors}
          editable={editable}
          edit={edit}
        />
      ))}
      <FieldError message={errors.acceptance} />
      <FieldError message={errors.testPlan} />
      {editable ? (
        <View className="flex-row flex-wrap gap-2">
          <Control
            label="Add a criterion"
            onPress={() => edit((draft) => addFactoryPlanCriterion(draft, id))}
          />
        </View>
      ) : null}
      {task.base.likelyPaths.length > 0 ? (
        <Text selectable className="text-xs text-foreground-muted">
          Likely paths: {task.base.likelyPaths.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** A test plan entry: its check, and the paths of its evidence, each in its own field. */
function TestPlanEntry({
  taskId,
  index,
  entry,
  errors,
  editable,
  edit,
}: {
  readonly taskId: FactoryTaskId;
  readonly index: number;
  readonly entry: FactoryPlanTaskDraft["testPlan"][number];
  readonly errors: FactoryPlanTaskErrors;
  readonly editable: boolean;
  readonly edit: EditDraft;
}) {
  const setPaths = (paths: ReadonlyArray<string>) =>
    edit((draft) => editFactoryTestPlanEntry(draft, taskId, index, { paths }));
  return (
    <View className="gap-1 ps-3">
      <AppTextInput
        accessibilityLabel={`Test for criterion ${entry.criterion}`}
        className={INPUT_CLASS}
        placeholder="How the criterion is checked"
        multiline
        textAlignVertical="top"
        editable={editable}
        value={entry.check}
        onChangeText={(check) =>
          edit((draft) => editFactoryTestPlanEntry(draft, taskId, index, { check }))
        }
      />
      <FieldError message={errors[`testPlan.${index}.check`]} />
      <FieldError message={errors[`testPlan.${index}.criterion`]} />
      {entry.paths.map((path, at) => (
        // oxlint-disable-next-line react/no-array-index-key -- a path is its position
        <View key={at} className="flex-row items-center gap-2">
          <AppTextInput
            accessibilityLabel={`Evidence path ${at + 1}`}
            className={`flex-1 ${INPUT_CLASS}`}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
            value={path}
            onChangeText={(value) =>
              setPaths(entry.paths.map((other, which) => (which === at ? value : other)))
            }
          />
          {editable ? (
            <Control
              label="Remove"
              onPress={() => setPaths(entry.paths.filter((_, which) => which !== at))}
            />
          ) : null}
        </View>
      ))}
      <FieldError message={errors[`testPlan.${index}.paths`]} />
      {editable ? (
        <View className="flex-row flex-wrap gap-2">
          <Control label="Add an evidence path" onPress={() => setPaths([...entry.paths, ""])} />
          <Control
            label="Remove test"
            onPress={() => edit((draft) => removeFactoryTestPlanEntry(draft, taskId, index))}
          />
        </View>
      ) : null}
    </View>
  );
}
