import { useAtomValue } from "@effect/atom-react";
import {
  FACTORY_CANCEL_TEXT,
  factoryExecutionView,
  type FactoryOutcomeTone,
  type FactoryReviewLine,
  type FactoryThreadTarget,
} from "@t3tools/client-runtime/fd/factory";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemSummary } from "@t3tools/contracts/fd/work-management";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { StatusPill } from "../../components/StatusPill";
import { useOpenWorkspaceDetail } from "../../features/layout/useOpenWorkspaceDetail";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { Control, SectionTitle } from "./Control";
import { FactoryPlanGate } from "./FactoryPlanGate";
import {
  factoryCommandError,
  type MobileCancelConfirmation,
  mobileCancelTarget,
  mobileFactorySection,
  mobilePendingActionRows,
} from "./itemSection";
import { mobilePlanGate } from "./planGate";
import { factoryEnvironment } from "./state";

interface FactoryItemSectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: Pick<WorkItemSummary, "ref" | "key">;
}

/**
 * The Work item screen's Factory section for the item's current delivery. Renders nothing on a
 * server without Factory or for an item without a delivery. Registered with the Work item screen
 * by the app's Stack.
 */
export function FactoryItemSection(props: FactoryItemSectionProps) {
  // A pending action or error belongs to one destination and item.
  const key = JSON.stringify([
    props.environmentId,
    props.projectId,
    props.item.ref.sourceId,
    props.item.ref.itemId,
  ]);
  return <ItemSection key={key} {...props} />;
}

type Action = "stop" | "resume" | "cancel";

const OUTCOME_CLASSES: Record<FactoryOutcomeTone, string> = {
  success: "text-sm font-t3-medium text-success",
  error: "text-sm font-t3-medium text-danger",
  warning: "text-sm font-t3-medium text-warning",
  active: "text-sm font-t3-medium text-primary-text",
  neutral: "text-sm text-foreground-muted",
};

function ItemSection({ environmentId, projectId, item }: FactoryItemSectionProps) {
  const navigation = useNavigation();
  const openDetail = useOpenWorkspaceDetail();
  const environments = useWorkspaceEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const deliveriesQuery = useEnvironmentQuery(
    factoryEnvironment.deliveries({ environmentId, input: { projectId } }),
  );
  const permitted = {
    stop: useAtomValue(factoryEnvironment.stop.permissionAtom(environmentId)),
    resume: useAtomValue(factoryEnvironment.resume.permissionAtom(environmentId)),
    cancel: useAtomValue(factoryEnvironment.cancel.permissionAtom(environmentId)),
  };
  const planPermitted = {
    update: useAtomValue(factoryEnvironment.updatePlan.permissionAtom(environmentId)),
    approve: useAtomValue(factoryEnvironment.approvePlan.permissionAtom(environmentId)),
    reject: useAtomValue(factoryEnvironment.rejectPlan.permissionAtom(environmentId)),
    replan: useAtomValue(factoryEnvironment.replan.permissionAtom(environmentId)),
  };
  const planning = useAtomValue(factoryEnvironment.planning(environmentId));
  const stop = useAtomCommand(factoryEnvironment.stop);
  const resume = useAtomCommand(factoryEnvironment.resume);
  const cancel = useAtomCommand(factoryEnvironment.cancel);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectionState = environments.find(
    (entry) => entry.environmentId === environmentId,
  )?.connectionState;
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const view = mobileFactorySection({
    environmentId,
    itemRef: item.ref,
    supported: useAtomValue(factoryEnvironment.supported(environmentId)),
    connectionState,
    deliveries,
    permitted,
  });
  const gate = mobilePlanGate({
    environmentId,
    itemRef: item.ref,
    planning,
    connectionState,
    deliveries,
    permitted: planPermitted,
  });
  // The confirmation's press reads the view as it is then, not as it was when the alert opened.
  const latestView = useRef(view);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the committed view to an open native Alert's press callback
  useLayoutEffect(() => {
    latestView.current = view;
  });

  if (view === null) {
    return deliveriesQuery.error === null ? null : (
      <ErrorBanner message={`Couldn't read Factory deliveries: ${deliveriesQuery.error}`} />
    );
  }

  /** Runs one command; the view changes only when the change stream refetches the deliveries. */
  const run = async (
    action: Action,
    execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>,
  ) => {
    setPending(action);
    setError(null);
    const failure = factoryCommandError(await execute());
    setPending(null);
    if (failure !== null) setError(failure);
  };
  const control = (deliveryId: FactoryDeliveryId) => ({ environmentId, input: { deliveryId } });

  // The alert says what cancelling ends for the delivery's family, and the press acts only while
  // the delivery is still of that family.
  const confirmCancel = (openedFor: MobileCancelConfirmation) => {
    Alert.alert(`Cancel the delivery of ${item.key}?`, FACTORY_CANCEL_TEXT[openedFor.family], [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel delivery",
        style: "destructive",
        onPress: () => {
          const target = mobileCancelTarget(latestView.current, openedFor);
          if (target === null) return;
          void run("cancel", () => cancel(control(target)));
        },
      },
    ]);
  };

  const openThread = (thread: FactoryThreadTarget) =>
    openDetail({
      name: "Thread",
      params: { environmentId: thread.environmentId, threadId: thread.threadId },
    });

  const { controls } = view;
  const noteClassName = view.nextAction.forYou
    ? "text-xs text-warning-foreground"
    : "text-xs text-foreground-muted";
  return (
    <View className="gap-2" accessibilityLabel="Factory">
      <SectionTitle
        trailing={
          <>
            <StatusPill
              label={view.label}
              size="compact"
              // The same rule as the card below it, so the two never disagree.
              pillClassName={view.nextAction.forYou ? "bg-warning" : "bg-subtle"}
              textClassName={
                view.nextAction.forYou ? "text-warning-foreground" : "text-foreground-secondary"
              }
            />
            {view.stage !== undefined ? (
              <Text className="text-xs text-foreground-muted">{view.stage}</Text>
            ) : null}
          </>
        }
      >
        Factory
      </SectionTitle>
      <View
        accessibilityLabel="What this delivery needs next"
        className={
          view.nextAction.forYou
            ? "gap-1 rounded-2xl bg-warning px-3.5 py-3"
            : "gap-1 rounded-2xl bg-grouped-card px-3.5 py-3"
        }
      >
        <Text
          className={
            view.nextAction.forYou
              ? "text-sm font-t3-medium text-warning-foreground"
              : "text-sm font-t3-medium text-foreground"
          }
        >
          {view.nextAction.title}
        </Text>
        <Text
          className={
            view.nextAction.forYou
              ? "text-xs text-warning-foreground"
              : "text-xs text-foreground-muted"
          }
        >
          {view.nextAction.detail}
        </Text>
        {view.nextAction.evidence !== null ? (
          <>
            <Text selectable className="text-xs text-warning-foreground">
              Verified commit: {view.nextAction.evidence.verifiedCommit}
            </Text>
            <Text className="text-xs text-warning-foreground">
              Verify: {view.nextAction.evidence.verify}
            </Text>
            <Text className="text-xs text-warning-foreground">
              Independent review: {view.nextAction.evidence.review}
            </Text>
          </>
        ) : null}
        {view.nextAction.pullRequestUrl !== null ||
        view.nextAction.reviewThread !== null ||
        controls.stop ||
        controls.resume ||
        controls.cancel ? (
          // Everything the line above asks for is within reach of it.
          <View className="flex-row flex-wrap gap-2 pt-1">
            {view.nextAction.pullRequestUrl !== null ? (
              <Control
                label="Open pull request"
                primary
                onPress={() => {
                  const url = view.nextAction.pullRequestUrl;
                  if (url !== null) void tryOpenExternalUrl(url, "pull-request");
                }}
              />
            ) : null}
            {view.nextAction.reviewThread !== null ? (
              <Control
                label="Review changes"
                onPress={() => {
                  const thread = view.nextAction.reviewThread;
                  if (thread !== null) navigation.navigate("ThreadReview", thread);
                }}
              />
            ) : null}
            {controls.resume ? (
              <Control
                label={pending === "resume" ? "Resuming…" : "Resume"}
                primary={view.nextAction.forYou}
                disabled={pending !== null}
                onPress={() => void run("resume", () => resume(control(view.deliveryId)))}
              />
            ) : null}
            {controls.stop ? (
              <Control
                label={pending === "stop" ? "Stopping…" : "Stop after step"}
                disabled={pending !== null}
                onPress={() => void run("stop", () => stop(control(view.deliveryId)))}
              />
            ) : null}
            {controls.cancel ? (
              <Control
                label={pending === "cancel" ? "Cancelling…" : "Cancel delivery"}
                disabled={pending !== null}
                onPress={() => confirmCancel({ deliveryId: view.deliveryId, family: view.family })}
              />
            ) : null}
          </View>
        ) : null}
        {view.controlsNote !== undefined ? (
          <Text className={noteClassName}>{view.controlsNote}</Text>
        ) : null}
        {view.capacityNote !== undefined ? (
          <Text className={noteClassName}>{view.capacityNote}</Text>
        ) : null}
      </View>
      {error !== null ? <ErrorBanner message={error} /> : null}
      {view.pendingActions.rows.length > 0 || view.pendingActions.note !== undefined ? (
        <View className="gap-1" accessibilityLabel="Pending actions">
          <Text className="text-xs font-t3-bold text-foreground">Pending actions</Text>
          {mobilePendingActionRows({
            environmentId,
            view,
            shownItem: item.ref,
            projects,
            threads,
          }).map(({ key, label, reason, provenance, target, destination, projectId: owner }) => (
            <View key={key} className="gap-1 rounded-lg border border-border p-2">
              <Text className="text-xs font-t3-bold text-foreground">{label}</Text>
              <Text className="text-xs text-foreground">{reason}</Text>
              <Text className="text-xs text-foreground-muted">{provenance}</Text>
              <Text className="text-xs text-foreground-muted">{target}</Text>
              {destination.type === "thread" ? (
                <Control
                  label="Open thread to decide"
                  onPress={() => openThread({ environmentId, threadId: destination.threadId })}
                />
              ) : destination.type === "item" ? (
                <Control
                  label="Open its Work item to decide"
                  onPress={() =>
                    navigation.navigate("WorkItem", {
                      environmentId,
                      projectId: owner,
                      sourceId: destination.item.sourceId,
                      itemId: destination.item.itemId,
                    })
                  }
                />
              ) : null}
            </View>
          ))}
          {view.pendingActions.note === undefined ? null : (
            <Text className="text-xs text-foreground-muted">{view.pendingActions.note}</Text>
          )}
        </View>
      ) : null}
      {gate !== null ? (
        // A draft and a note belong to one delivery; another delivery's plan starts afresh.
        <FactoryPlanGate
          key={JSON.stringify([gate.destination.environmentId, gate.destination.deliveryId])}
          gate={gate}
          itemKey={item.key}
        />
      ) : null}
      {deliveriesQuery.error !== null ? <ErrorBanner message={deliveriesQuery.error} /> : null}
      <View
        className="gap-1 rounded-2xl bg-grouped-card px-3.5 py-3"
        accessibilityLabel="Allowances"
      >
        <Text className="text-sm font-t3-medium text-foreground-muted">Allowances</Text>
        {view.counters.lines.map((line) => (
          <View key={line.key} className="flex-row justify-between gap-3">
            <Text className="text-xs text-foreground-muted">{line.label}</Text>
            <Text className="min-w-0 shrink text-right text-xs tabular-nums text-foreground">
              {line.text}
            </Text>
          </View>
        ))}
        {view.counters.attempts !== undefined ? (
          <View className="flex-row justify-between gap-3">
            <Text className="text-xs text-foreground-muted">Attempts run</Text>
            <Text className="min-w-0 shrink text-right text-xs tabular-nums text-foreground">
              {view.counters.attempts}
            </Text>
          </View>
        ) : null}
        {view.counters.scope !== undefined ? (
          <Text className="pt-1 text-xs text-foreground-muted">{view.counters.scope}</Text>
        ) : null}
      </View>
      {view.timeline.length > 0 ? (
        <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card android:rounded-[28px]">
          {view.timeline.map(({ thread, ...row }, index) => (
            <View
              key={row.key}
              className={
                index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border-subtle px-4 py-3"
              }
            >
              <View className="flex-row items-center gap-2">
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-medium text-foreground">
                    {row.stage}
                    {row.round !== null ? (
                      <Text className="text-sm font-sans text-foreground-muted">
                        {" "}
                        · Attempt {row.round}
                      </Text>
                    ) : null}
                  </Text>
                  <Text className={OUTCOME_CLASSES[row.outcomeTone]}>
                    {row.outcome}
                    {row.startedAt !== undefined ? (
                      <Text className="text-foreground-tertiary">
                        {" "}
                        · started {relativeTime(row.startedAt)} ago
                      </Text>
                    ) : null}
                  </Text>
                </View>
                {thread !== null ? (
                  <Control label="Open thread" onPress={() => openThread(thread)} />
                ) : null}
              </View>
              {row.receipts.map((receipt) => (
                <Text key={receipt.key} className="text-xs text-foreground">
                  Verify: {receipt.text}
                </Text>
              ))}
              {row.reviews.map((review) => (
                <ReviewEvidence key={review.key} review={review} />
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {view.receipts.length > 0 || view.reviews.length > 0 ? (
        <View className="gap-1 rounded-[24px] bg-grouped-card px-4 py-3 android:rounded-[28px]">
          <Text className="text-sm font-t3-medium text-foreground-muted">Receipts and reviews</Text>
          {view.receipts.map((receipt) => (
            <Text key={receipt.key} className="text-xs text-foreground">
              Verify: {receipt.text}
            </Text>
          ))}
          {view.reviews.map((review) => (
            <ReviewEvidence key={review.key} review={review} />
          ))}
        </View>
      ) : null}
      {view.branch === undefined ? null : (
        <Text className="text-xs text-foreground-muted">
          Branch{" "}
          <Text selectable className="font-mono text-foreground">
            {view.branch}
          </Text>
        </Text>
      )}
      <DeliveryRoles environmentId={environmentId} deliveryId={view.deliveryId} />
    </View>
  );
}

/** A review's line and what it raised. Reviewer text is shown as plain text, never as markup. */
function ReviewEvidence({ review }: { readonly review: FactoryReviewLine }) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs text-foreground">Review: {review.text}</Text>
      {review.notes.map((note) => (
        <View key={note.key} className="ps-3">
          <Text className="text-xs font-t3-medium text-foreground">
            {note.label}
            {note.required ? " · Required" : ""}
            {note.blocking ? " · Blocking" : ""}
            {note.location !== undefined ? ` ${note.location}` : ""}
          </Text>
          <Text selectable className="text-xs text-foreground">
            {note.detail}
          </Text>
        </View>
      ))}
      {review.omitted !== undefined ? (
        <Text className="ps-3 text-xs text-foreground-muted">{review.omitted}</Text>
      ) : null}
    </View>
  );
}

/**
 * What each role of the delivery runs on, requested and as its provider reported it. It takes its own
 * read of the one delivery on screen, since a listing does not carry it; until that answers, and on a
 * server from before it, this shows nothing.
 */
function DeliveryRoles({
  environmentId,
  deliveryId,
}: {
  readonly environmentId: EnvironmentId;
  readonly deliveryId: FactoryDeliveryId;
}) {
  const { data } = useEnvironmentQuery(
    factoryEnvironment.delivery({ environmentId, input: { deliveryId } }),
  );
  const execution = data === null ? null : factoryExecutionView(data);
  if (execution === null) return null;
  return (
    <View className="gap-1">
      {execution.roles.map((role) => (
        <View key={role.key}>
          <Text className="text-xs text-foreground">
            {role.label} ({role.binding}): {role.reviewed ?? role.requested}
          </Text>
          {role.reviewed !== undefined ? (
            <Text className="text-xs text-foreground">Requested: {role.requested}</Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            Provider reported: {role.acknowledged}
          </Text>
        </View>
      ))}
      <Text className="text-xs text-foreground-muted">{execution.note}</Text>
    </View>
  );
}
