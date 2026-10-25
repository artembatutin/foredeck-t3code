import { useAtomValue } from "@effect/atom-react";
import type { FactoryReviewLine, FactoryThreadTarget } from "@t3tools/client-runtime/fd/factory";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemSummary } from "@t3tools/contracts/fd/work-management";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAndroidWorkspaceSelection } from "../../features/workspace/useAndroidWorkspaceSelection";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { mobileCancelTarget, mobileFactorySection } from "./itemSection";
import { factoryEnvironment } from "./state";

interface FactoryItemSectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: Pick<WorkItemSummary, "ref" | "key">;
}

/**
 * The Work item screen's Factory section: the item's current delivery with its timeline and
 * stop, resume and cancel. Renders nothing on a server without Factory or for an item without a
 * delivery. Registered with the Work item screen by the app's Stack.
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

/** A failed command's text: a Factory error's own fixed message, or a fallback. */
function commandError(result: AtomCommandResult<FactoryDelivery, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Factory could not complete the request. Try again.";
}

function ItemSection({ environmentId, projectId, item }: FactoryItemSectionProps) {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const environments = useWorkspaceEnvironments();
  const deliveriesQuery = useEnvironmentQuery(
    factoryEnvironment.deliveries({ environmentId, input: { projectId } }),
  );
  const permitted = {
    stop: useAtomValue(factoryEnvironment.stop.permissionAtom(environmentId)),
    resume: useAtomValue(factoryEnvironment.resume.permissionAtom(environmentId)),
    cancel: useAtomValue(factoryEnvironment.cancel.permissionAtom(environmentId)),
  };
  const stop = useAtomCommand(factoryEnvironment.stop);
  const resume = useAtomCommand(factoryEnvironment.resume);
  const cancel = useAtomCommand(factoryEnvironment.cancel);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const view = mobileFactorySection({
    environmentId,
    itemRef: item.ref,
    supported: useAtomValue(factoryEnvironment.supported(environmentId)),
    connectionState: environments.find((entry) => entry.environmentId === environmentId)
      ?.connectionState,
    deliveries: deliveriesQuery.data?.deliveries ?? null,
    permitted,
  });
  // The confirmation's press reads the view as it is then, not as it was when the alert opened.
  const latestView = useRef(view);
  useLayoutEffect(() => {
    latestView.current = view;
  });

  if (view === null) {
    return deliveriesQuery.error === null ? null : (
      <Text className="text-sm text-destructive">{deliveriesQuery.error}</Text>
    );
  }

  /** Runs one command; the view changes only when the change stream refetches the deliveries. */
  const run = async (
    action: Action,
    execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>,
  ) => {
    setPending(action);
    setError(null);
    const failure = commandError(await execute());
    setPending(null);
    if (failure !== null) setError(failure);
  };
  const control = (deliveryId: FactoryDeliveryId) => ({ environmentId, input: { deliveryId } });

  const confirmCancel = (openedFor: FactoryDeliveryId) => {
    Alert.alert(
      `Cancel the delivery of ${item.key}?`,
      "Its agents stop what they are working on and the delivery ends. Its branch, worktree and commits stay; delivering the item again starts on a new branch.",
      [
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
      ],
    );
  };

  const openThread = (thread: FactoryThreadTarget) => {
    const params = { environmentId: thread.environmentId, threadId: thread.threadId };
    if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params });
    else navigation.navigate("Thread", params);
  };

  const { controls } = view;
  return (
    <View className="gap-2" accessibilityLabel="Factory">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-t3-medium text-foreground">Factory</Text>
        <View className="rounded-full bg-subtle-strong px-3 py-1">
          <Text
            className={
              view.needsYou === undefined
                ? "text-xs font-t3-medium text-foreground"
                : "text-xs font-t3-medium text-warning"
            }
          >
            {view.label}
          </Text>
        </View>
        {view.stage !== undefined ? (
          <Text className="text-xs text-foreground-muted">{view.stage}</Text>
        ) : null}
      </View>
      {view.needsYou !== undefined ? (
        <Text className="text-sm text-warning">{view.needsYou}</Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        {view.branch === undefined ? "" : `${view.branch} · `}
        Fix rounds {view.rounds.fix} · Review rounds {view.rounds.review}
      </Text>
      {controls.stop || controls.resume || controls.cancel ? (
        <View className="flex-row flex-wrap gap-2">
          {controls.stop ? (
            <Control
              label="Stop after step"
              disabled={pending !== null}
              onPress={() => void run("stop", () => stop(control(view.deliveryId)))}
            />
          ) : null}
          {controls.resume ? (
            <Control
              label="Resume"
              disabled={pending !== null}
              onPress={() => void run("resume", () => resume(control(view.deliveryId)))}
            />
          ) : null}
          {controls.cancel ? (
            <Control
              label="Cancel delivery"
              disabled={pending !== null}
              onPress={() => confirmCancel(view.deliveryId)}
            />
          ) : null}
        </View>
      ) : null}
      {error !== null ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {deliveriesQuery.error !== null ? (
        <Text className="text-sm text-destructive">{deliveriesQuery.error}</Text>
      ) : null}
      {view.timeline.map(({ thread, ...row }) => (
        <View key={row.key} className="gap-0.5 rounded-xl bg-card p-3">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-t3-medium text-foreground">{row.stage}</Text>
            {row.round !== null ? (
              <Text className="text-xs text-foreground-muted">Round {row.round}</Text>
            ) : null}
            <Text className="flex-1 text-xs text-foreground-muted">{row.outcome}</Text>
            {thread !== null ? (
              <Control label="Open thread" onPress={() => openThread(thread)} />
            ) : null}
          </View>
          {row.startedAt !== undefined ? (
            <Text className="text-xs text-foreground-muted">
              Started {new Date(row.startedAt).toLocaleString()}
            </Text>
          ) : null}
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
      {view.receipts.length > 0 || view.reviews.length > 0 ? (
        <View className="gap-0.5 rounded-xl bg-card p-3">
          <Text className="text-xs text-foreground-muted">Receipts and reviews</Text>
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

function Control({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        disabled
          ? "rounded-full bg-subtle-strong px-3 py-1.5 opacity-40"
          : "rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}
