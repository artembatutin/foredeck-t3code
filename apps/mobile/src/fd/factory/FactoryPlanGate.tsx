import {
  factoryPlanConfirmed,
  type FactoryPlanDecision,
  type FactoryPlanGate as FactoryPlanGateModel,
} from "@t3tools/client-runtime/fd/factory";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { FactoryDelivery, FactoryPlanTask } from "@t3tools/contracts/fd/factory";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { Control } from "./Control";
import { factoryCommandError } from "./itemSection";
import { mobilePlanActions, mobilePlanDecisionTarget, mobileReplanRequest } from "./planGate";
import { factoryEnvironment } from "./state";

type Pending = FactoryPlanDecision | "replan";

const INPUT_CLASS = "min-h-24 rounded-xl bg-card px-3 py-2 text-base text-foreground";

/**
 * The plan a delivery waits on at the plan gate, read-only: each task's title, summary, criteria
 * and test plan, in delivery order. Approve and reject ask first in a native alert, for the plan
 * shown then; replan sends a note to the planner. Nothing applies locally: the view changes when
 * the change epoch refetches the delivery. The parent keys it by destination, so a note never
 * outlives its delivery.
 */
export function FactoryPlanGate({
  gate,
  itemKey,
}: {
  readonly gate: FactoryPlanGateModel;
  readonly itemKey: string;
}) {
  const approvePlan = useAtomCommand(factoryEnvironment.approvePlan);
  const rejectPlan = useAtomCommand(factoryEnvironment.rejectPlan);
  const replan = useAtomCommand(factoryEnvironment.replan);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The replan note being written; null while replan is closed.
  const [note, setNote] = useState<string | null>(null);
  // An alert's press reads the gate as it is then, not as it was when the alert opened.
  const latestGate = useRef<FactoryPlanGateModel | null>(gate);
  useLayoutEffect(() => {
    latestGate.current = gate;
  });
  useLayoutEffect(
    () => () => {
      latestGate.current = null;
    },
    [],
  );

  /** Runs one command; the view changes only when the change stream refetches the deliveries. */
  const run = async (
    action: Pending,
    execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>,
  ) => {
    setPending(action);
    setError(null);
    const failure = factoryCommandError(await execute());
    setPending(null);
    if (failure !== null) setError(failure);
    return failure === null;
  };

  const confirm = (decision: FactoryPlanDecision) => {
    const openedFor = factoryPlanConfirmed(gate);
    const count = openedFor.plan.tasks.length;
    const press = () => {
      const request = mobilePlanDecisionTarget(latestGate.current, decision, openedFor);
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

  const writtenFor = gate.destination.deliveryId;
  const replanning = note === null ? null : mobileReplanRequest(gate, writtenFor, note);
  const sendReplan = async () => {
    if (note === null) return;
    const request = mobileReplanRequest(latestGate.current, writtenFor, note);
    if (request._tag !== "Send") return;
    if (await run("replan", () => replan(request.request))) setNote(null);
  };

  const actions = mobilePlanActions(gate);
  const { tasks, note: plannerNote } = gate.plan;
  return (
    <View className="gap-2" accessibilityLabel="Plan">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Plan</Text>
        <Text className="text-xs text-foreground-muted">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"}, delivered in this order
        </Text>
      </View>
      {plannerNote !== undefined ? (
        <Text selectable className="text-xs text-foreground-muted">
          {plannerNote}
        </Text>
      ) : null}
      {tasks.map((task, position) => (
        <PlanTask key={task.id} task={task} number={position + 1} />
      ))}
      {actions.approve || actions.reject || actions.replan ? (
        <View className="flex-row flex-wrap gap-2">
          {actions.approve ? (
            <Control
              label="Approve plan"
              disabled={pending !== null}
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
      {note !== null && replanning !== null && actions.replan ? (
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel="What the planner should change"
            className={INPUT_CLASS}
            placeholder="What should the planner change?"
            multiline
            textAlignVertical="top"
            editable={pending === null}
            value={note}
            onChangeText={setNote}
          />
          {replanning._tag === "Invalid" && note.trim().length > 0 ? (
            <Text className="text-sm text-destructive">{replanning.message}</Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Control
              label={pending === "replan" ? "Sending…" : "Send to planner"}
              disabled={pending !== null || replanning._tag !== "Send"}
              onPress={() => void sendReplan()}
            />
            <Control label="Cancel" disabled={pending !== null} onPress={() => setNote(null)} />
          </View>
        </View>
      ) : null}
      {error !== null ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}

/** One planned task. The planner's text is shown as plain text, never as markup. */
function PlanTask({ task, number }: { readonly task: FactoryPlanTask; readonly number: number }) {
  return (
    <View className="gap-1 rounded-xl bg-card p-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-foreground-muted">Task {number}</Text>
        <Text className="text-xs text-foreground-muted">{task.kind}</Text>
        {task.risk === "high" ? (
          <Text className="text-xs font-t3-medium text-warning">High risk</Text>
        ) : null}
      </View>
      <Text selectable className="text-sm font-t3-medium text-foreground">
        {task.title}
      </Text>
      <Text selectable className="text-xs text-foreground">
        {task.summary}
      </Text>
      <Text className="text-xs text-foreground-muted">Acceptance criteria and their tests</Text>
      {task.acceptance.map((criterion, index) => (
        // Criteria are numbered by position, and test plan entries name them by it.
        // oxlint-disable-next-line react/no-array-index-key -- a criterion is its position
        <View key={index} className="gap-0.5">
          <Text selectable className="text-xs text-foreground">
            {index + 1}. {criterion}
          </Text>
          {task.testPlan.map((entry, entryIndex) =>
            entry.criterion === index + 1 ? (
              // oxlint-disable-next-line react/no-array-index-key -- entries are positional
              <View key={entryIndex} className="ps-3">
                <Text selectable className="text-xs text-foreground-muted">
                  Test: {entry.check}
                </Text>
                {entry.paths.length > 0 ? (
                  <Text selectable className="text-xs text-foreground-muted">
                    {entry.paths.join(", ")}
                  </Text>
                ) : null}
              </View>
            ) : null,
          )}
        </View>
      ))}
      {task.likelyPaths.length > 0 ? (
        <Text selectable className="text-xs text-foreground-muted">
          Likely paths: {task.likelyPaths.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
