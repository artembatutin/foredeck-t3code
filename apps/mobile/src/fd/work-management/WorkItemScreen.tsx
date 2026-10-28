import { usesSharedCheckouts } from "@t3tools/client-runtime/fd/multirepo";
import {
  beginWorkDraft,
  changedSinceLink,
  defaultWorkWorkspace,
  editWorkDraft,
  linkPrompts,
  mergeComposerText,
  parseWorkItemRouteRef,
  rebaseWorkDraft,
  refreshWork,
  RUN_STATE_LABELS,
  runStateOf,
  settleWorkDraft,
  workBranchPreview,
  type WorkDraft,
  workDraftChanged,
  workDraftConflictReady,
  workDraftPatch,
  workItemReferenceText,
  workLinkCandidates,
  workStatusInput,
  workStatusUndo,
  workUndoMessage,
  type WorkWriteOutcome,
  workWriteOutcome,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  WorkItemDetail,
  WorkItemPatch,
  WorkItemSummary,
  WorkNativeStatus,
  WorkSetStatusInput,
  WorkThreadLink,
  WorkThreadMode,
} from "@t3tools/contracts/fd/work-management";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { type ComponentType, useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListRow } from "../../components/ListRow";
import { ListFilterMenu } from "../../features/workspace/ListFilterMenu";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useProject, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobileStartInput, parseStatusActionId, statusActionId } from "./actions";
import { AssigneeEditor, PriorityControl, RelationshipEditor } from "./WorkItemFields";
import { Action, Chip, SectionTitle, STATUS_LABELS, STATUS_SYMBOLS } from "./shared";
import { useWorkWritable, workCommands, workEnvironment } from "./state";
import { useOpenWorkThread } from "./useOpenWorkThread";

export type WorkItemParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sourceId: string;
  readonly itemId: string;
};

const MODES: ReadonlyArray<{ readonly value: WorkThreadMode; readonly label: string }> = [
  { value: "implement", label: "Implement" },
  { value: "plan", label: "Plan" },
  { value: "scope", label: "Scope" },
];

/**
 * A section another feature adds to the item screen, below its linked threads. The app's Stack
 * passes it in when registering the screen, so Work never imports the feature.
 */
type WorkItemSection = ComponentType<{
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: WorkItemDetail;
}>;

/** One Work item: status, description, comments, linked threads and starting a thread. */
export function WorkItemScreen({
  route,
  itemSection,
}: StaticScreenProps<WorkItemParams> & { readonly itemSection?: WorkItemSection | undefined }) {
  const navigation = useNavigation();
  const ref = parseWorkItemRouteRef(route.params);
  const environmentId = route.params.environmentId;
  const query = useEnvironmentQuery(
    ref === undefined ? null : workEnvironment.detail({ environmentId, input: { ref } }),
  );
  const requestRefresh = useAtomCommand(workCommands.refresh);
  const refreshQuery = query.refresh;
  const sourceId = ref?.sourceId;
  // Pull to refresh drops the server's cached copy of this source, then reads again.
  const refresh = useCallback(
    () =>
      void refreshWork({
        requestServerRefresh: () =>
          requestRefresh({
            environmentId,
            input: sourceId === undefined ? {} : { sourceId },
          }),
        refreshQueries: refreshQuery,
      }),
    [environmentId, refreshQuery, requestRefresh, sourceId],
  );
  const item = query.data;

  useLayoutEffect(() => {
    navigation.setOptions({ title: item?.key ?? "Work item" });
  }, [item?.key, navigation]);

  if (ref === undefined) {
    return (
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title="Work item not found"
          detail="This link does not name a Work item."
        />
      </View>
    );
  }
  if (item === null) {
    return (
      <View className="flex-1 justify-center bg-screen">
        {query.error === null ? (
          <ActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading work item" />
        ) : (
          <EmptyState
            variant="plain"
            title="Couldn't load this item"
            detail={query.error}
            actionLabel="Try again"
            onAction={refreshQuery}
          />
        )}
      </View>
    );
  }
  return (
    <LoadedItem
      key={`${ref.sourceId}:${ref.itemId}`}
      environmentId={environmentId}
      projectId={route.params.projectId}
      item={item}
      itemSection={itemSection}
      refreshing={query.isPending}
      onReload={refreshQuery}
      onRefresh={refresh}
    />
  );
}

interface Notice {
  readonly message: string;
  readonly undo: WorkSetStatusInput | null;
}

function LoadedItem({
  environmentId,
  projectId,
  item,
  itemSection: ItemSection,
  refreshing,
  onReload,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  item: WorkItemDetail;
  itemSection: WorkItemSection | undefined;
  refreshing: boolean;
  onReload: () => void;
  onRefresh: () => void;
}) {
  const navigation = useNavigation();
  const openThread = useOpenWorkThread();
  const shells = useThreadShells();
  const markdownStyles = useMarkdownPreviewStyles();
  const setStatus = useAtomCommand(workCommands.setStatus);
  const updateItem = useAtomCommand(workCommands.updateItem);
  const setLink = useAtomCommand(workCommands.setLink);
  const start = useAtomCommand(workCommands.startThread);
  const canWrite = useWorkWritable(environmentId, workCommands.updateItem, "items.write");
  const canComment = useWorkWritable(environmentId, workCommands.comment, "comments");
  const canLink = useWorkWritable(environmentId, workCommands.setLink, "links");
  const canStart = useWorkWritable(environmentId, workCommands.startThread, "threads.start");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [titleDraft, setTitleDraft] = useState<WorkDraft | null>(null);
  const [bodyDraft, setBodyDraft] = useState<WorkDraft | null>(null);
  const [linking, setLinking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const writable = canWrite && item.invalid === null;
  const can = (field: WorkItemDetail["capabilities"]["fields"][number]) =>
    writable && item.capabilities.fields.includes(field);

  const project = useProject({ environmentId, projectId });
  const serverConfigs = useServerConfigs();
  const sharedCheckouts = usesSharedCheckouts(project ?? undefined);
  const defaultWorkspace = useMemo(() => {
    const settings = serverConfigs.get(environmentId)?.settings;
    if (settings === undefined || project === null) return "root" as const;
    return defaultWorkWorkspace({
      defaultThreadEnvMode: resolveProjectSettings(settings, project.id, project).settings
        .defaultThreadEnvMode,
      sharedCheckouts,
    });
  }, [environmentId, project, serverConfigs, sharedCheckouts]);
  const [workspaceChoice, setWorkspaceChoice] = useState<"root" | "worktree" | null>(null);
  const workspace = sharedCheckouts ? "root" : (workspaceChoice ?? defaultWorkspace);

  const shellById = useMemo(
    () =>
      new Map(
        shells
          .filter((shell) => shell.environmentId === environmentId)
          .map((shell) => [shell.id, shell] as const),
      ),
    [environmentId, shells],
  );
  const openLink = item.links.find((link) => {
    const state = runStateOf(shellById.get(link.threadId));
    return state === "working" || state === "needs-input" || state === "idle";
  });

  /** Shows a write's outcome; a stale write reloads the item so the owner sees why. */
  const report = <A,>(outcome: WorkWriteOutcome<A>): WorkWriteOutcome<A> => {
    if (outcome._tag === "failed") setError(outcome.message);
    else if (outcome._tag === "stale") {
      setError(`${item.key} changed since it was loaded. It has been reloaded; try again.`);
      onReload();
    } else setError(null);
    return outcome;
  };

  /** A field write; stale reloads the item through `report`. */
  const update = async (patch: Omit<WorkItemPatch, "ref">) =>
    report(
      workWriteOutcome(await updateItem({ environmentId, input: { ref: item.ref, ...patch } })),
    );

  const runUndo = async (input: WorkSetStatusInput) => {
    setNotice(null);
    const message = workUndoMessage(
      item.key,
      workWriteOutcome(await setStatus({ environmentId, input })),
    );
    if (message !== null) setError(message);
  };

  /**
   * Changes status guarded by the revision on screen and offers an Undo guarded by the revision
   * the change produced, so it cannot overwrite a later change by anyone else.
   */
  const changeStatus = async (
    change: { readonly status: WorkNativeStatus } | { readonly transitionId: string },
    message?: string,
  ) => {
    setNotice(null);
    const before = item;
    const outcome = report(
      workWriteOutcome(await setStatus({ environmentId, input: workStatusInput(before, change) })),
    );
    if (outcome._tag === "candidates") {
      // An ambiguous Jira status answers with the transitions that reach it.
      Alert.alert("Choose a transition", undefined, [
        ...outcome.candidates
          .filter((candidate) => !candidate.requiresFields)
          .map((candidate) => ({
            text: candidate.name,
            onPress: () => void changeStatus({ transitionId: candidate.id }, message),
          })),
        { text: "Cancel", style: "cancel" as const },
      ]);
      return;
    }
    if (outcome._tag !== "success") return;
    setNotice({
      message:
        message ??
        `${item.key}: ${outcome.value.nativeStatus?.name ?? STATUS_LABELS[outcome.value.status]}`,
      undo: workStatusUndo(before, outcome.value),
    });
  };

  const confirmStatus = (status: WorkNativeStatus) => {
    if (status !== "cancelled") return void changeStatus({ status });
    Alert.alert(`Cancel ${item.key}?`, "It stays in the source as cancelled.", [
      { text: "Keep", style: "cancel" },
      { text: "Cancel item", style: "destructive", onPress: () => void changeStatus({ status }) },
    ]);
  };

  const saveDraft = async (
    draft: WorkDraft,
    setDraft: (next: (current: WorkDraft | null) => WorkDraft | null) => void,
  ) => {
    if (!workDraftChanged(draft, item)) return setDraft(() => null);
    const outcome = workWriteOutcome(
      await updateItem({ environmentId, input: workDraftPatch(item.ref, draft) }),
    );
    if (outcome._tag === "failed") setError(outcome.message);
    else setError(null);
    if (outcome._tag === "stale") onReload();
    setDraft((current) => {
      if (current === null) return null;
      if (outcome._tag === "success" && current.value !== draft.value) {
        return rebaseWorkDraft(current, outcome.value.revision);
      }
      return settleWorkDraft(current, outcome);
    });
  };

  const startThread = async (mode: WorkThreadMode, force: boolean) => {
    setError(null);
    const result = await start({
      environmentId,
      input: mobileStartInput({ ref: item.ref, mode, workspace, force }),
    });
    const outcome = report(workWriteOutcome(result));
    if (outcome._tag === "success") openThread(environmentId, outcome.value.threadId);
  };

  const changeLink = async (threadId: ThreadId, action: "link" | "unlink") => {
    const outcome = report(
      workWriteOutcome(
        await setLink({ environmentId, input: { ref: item.ref, threadId, action } }),
      ),
    );
    if (outcome._tag === "success" && action === "link") setLinking(false);
  };

  /** Adds the item to a new task draft in its project, keeping the draft for the owner to send. */
  const attachToDraft = async () => {
    await waitForComposerDraftsLoaded();
    const draftKey = createNewTaskDraft({ environmentId, projectId });
    setComposerDraftText(
      draftKey,
      mergeComposerText(getComposerDraftSnapshot(draftKey).text, workItemReferenceText(item)),
    );
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: { draftId: draftKey, title: item.key },
    });
  };

  /** Adds what changed to the thread's draft, keeping anything the owner already typed. */
  const sendUpdate = async (link: WorkThreadLink) => {
    await waitForComposerDraftsLoaded();
    const draftKey = scopedThreadKey(environmentId, link.threadId);
    setComposerDraftText(
      draftKey,
      mergeComposerText(
        getComposerDraftSnapshot(draftKey).text,
        `${item.key} changed since this thread started. ${workItemReferenceText(item)}`,
      ),
    );
    openThread(environmentId, link.threadId);
  };

  const statusActions =
    item.capabilities.transitions && item.transitions.length > 0
      ? item.transitions.map((transition) => ({
          id: statusActionId({ transitionId: transition.id }),
          title: `${transition.name} → ${transition.toName}`,
          attributes: { disabled: transition.requiresFields },
        }))
      : item.capabilities.statuses.map((status) => ({
          id: statusActionId({ status }),
          title: STATUS_LABELS[status],
          state: status === item.status ? ("on" as const) : ("off" as const),
        }));

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="gap-1">
        <Text className="text-xs text-foreground-muted">
          {item.key}
          {item.updatedAt ? (
            <Text className="text-foreground-tertiary">
              {" "}
              · Updated {relativeTime(item.updatedAt)} ago
            </Text>
          ) : null}
        </Text>
        {titleDraft !== null ? (
          <DraftEditor
            label="Title"
            draft={titleDraft}
            item={item}
            current={titleDraft.conflict?.current?.title ?? item.title}
            onChange={setTitleDraft}
            onSave={() => void saveDraft(titleDraft, setTitleDraft)}
          />
        ) : (
          <Text selectable className="text-xl leading-7 font-t3-bold text-foreground">
            {item.title}
          </Text>
        )}
        {item.invalid ? (
          <Text className="text-sm text-warning">Read-only: {item.invalid.message}</Text>
        ) : null}
        {can("title") && titleDraft === null ? (
          <View className="flex-row pt-1">
            <Action
              label="Edit title"
              onPress={() => setTitleDraft(beginWorkDraft("title", item))}
            />
          </View>
        ) : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        {writable ? (
          <ListFilterMenu
            label={item.nativeStatus?.name ?? STATUS_LABELS[item.status]}
            accessibilityLabel="Change status"
            actions={statusActions}
            onSelect={(event) => {
              const choice = parseStatusActionId(event);
              if (choice === null) return;
              if ("transitionId" in choice) void changeStatus(choice);
              else confirmStatus(choice.status);
            }}
          />
        ) : (
          <Chip label={item.nativeStatus?.name ?? STATUS_LABELS[item.status]} />
        )}
        {item.blocked ? <Chip label="Blocked" tone="warning" /> : null}
        {can("priority") ? (
          <PriorityControl item={item} update={update} />
        ) : item.priority ? (
          <Chip label={`${item.priority} priority`} />
        ) : null}
        {can("assignee") ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Assignee: ${item.assignee?.label ?? "Unassigned"}`}
            hitSlop={6}
            className="active:opacity-70"
            onPress={() => setAssigning((open) => !open)}
          >
            <Chip label={item.assignee?.label ?? "Unassigned"} />
          </Pressable>
        ) : item.assignee ? (
          <Chip label={item.assignee.label} />
        ) : null}
      </View>
      {assigning && can("assignee") ? (
        <AssigneeEditor
          environmentId={environmentId}
          item={item}
          update={update}
          onClose={() => setAssigning(false)}
        />
      ) : null}

      {notice ? (
        <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3.5 py-2">
          <Text className="flex-1 text-sm font-t3-medium text-foreground">{notice.message}</Text>
          {notice.undo !== null && canWrite ? (
            <Action label="Undo" onPress={() => void runUndo(notice.undo!)} />
          ) : null}
        </View>
      ) : null}

      <View className="flex-row flex-wrap items-center gap-2">
        {openLink ? (
          <Action
            label="Continue thread"
            primary
            onPress={() => openThread(environmentId, openLink.threadId)}
          />
        ) : null}
        {canStart ? (
          <ListFilterMenu
            label={openLink ? "Start another" : "Start thread"}
            accessibilityLabel="Start a thread"
            active={openLink === undefined}
            actions={MODES.map((mode) => ({ id: mode.value, title: mode.label }))}
            onSelect={(event) => {
              const mode = MODES.find((entry) => entry.value === event);
              if (mode) void startThread(mode.value, openLink !== undefined);
            }}
          />
        ) : null}
        {canStart ? (
          <ListFilterMenu
            label={workspace === "root" ? "Project checkout" : "New worktree"}
            accessibilityLabel="Choose where the thread works"
            actions={[
              {
                id: "root",
                title: "Project checkout",
                state: workspace === "root" ? ("on" as const) : ("off" as const),
              },
              {
                id: "worktree",
                title: "New worktree",
                state: workspace === "worktree" ? ("on" as const) : ("off" as const),
                attributes: { disabled: sharedCheckouts },
              },
            ]}
            onSelect={(event) => {
              if (event === "root" || event === "worktree") setWorkspaceChoice(event);
            }}
          />
        ) : null}
        <Action label="Attach to draft" onPress={() => void attachToDraft()} />
        {canLink ? (
          <Action
            label={linking ? "Done linking" : "Link a thread"}
            onPress={() => setLinking((open) => !open)}
          />
        ) : null}
        {canComment && item.invalid === null && item.capabilities.comments === "add" ? (
          <Action
            label="Comment"
            onPress={() =>
              navigation.navigate("WorkComment", {
                environmentId,
                projectId,
                sourceId: item.ref.sourceId,
                itemId: item.ref.itemId,
              })
            }
          />
        ) : null}
        {item.url ? <Action label="Open" onPress={() => void Linking.openURL(item.url!)} /> : null}
      </View>
      {canStart ? (
        <Text className="text-xs text-foreground-muted">
          {workspace === "worktree"
            ? `New threads work on branch ${workBranchPreview(item)}.`
            : sharedCheckouts
              ? "This project's repositories use their shared checkouts."
              : "New threads work in the project's main checkout."}
        </Text>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {linking ? (
        <ThreadLinkPicker
          environmentId={environmentId}
          projectId={projectId}
          linked={item.links.map((link) => link.threadId)}
          onLink={(threadId) => void changeLink(threadId, "link")}
        />
      ) : null}

      {item.links.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Linked threads</SectionTitle>
          <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card android:rounded-[28px]">
            {item.links.map((link, index) => {
              const shell = shellById.get(link.threadId);
              const prompts = linkPrompts(link, item);
              const changed = changedSinceLink(link, item);
              const actions =
                canLink ||
                changed ||
                (writable && prompts.backToTodo) ||
                (writable && prompts.markDone && item.capabilities.statuses.includes("done"));
              return (
                <View
                  key={link.threadId}
                  className={index === 0 ? undefined : "border-t border-border-subtle"}
                >
                  <ListRow
                    label={shell?.title ?? link.threadId}
                    description={`${RUN_STATE_LABELS[runStateOf(shell)]}${link.run ? ` · last run ${link.run.status}` : ""}${changed ? " · changed since the thread started" : ""}`}
                    onPress={() => openThread(environmentId, link.threadId)}
                  />
                  {actions ? (
                    <View className="flex-row flex-wrap gap-2 px-4 pb-3">
                      {changed ? (
                        <Action
                          label="Send update to thread"
                          onPress={() => void sendUpdate(link)}
                        />
                      ) : null}
                      {writable && prompts.backToTodo ? (
                        <Action
                          label="Back to todo?"
                          onPress={() =>
                            void changeStatus({ status: "todo" }, `${item.key} is back to To do`)
                          }
                        />
                      ) : null}
                      {writable &&
                      prompts.markDone &&
                      item.capabilities.statuses.includes("done") ? (
                        <Action
                          label={`Mark ${item.key} done?`}
                          onPress={() =>
                            void changeStatus({ status: "done" }, `${item.key} marked done`)
                          }
                        />
                      ) : null}
                      {canLink ? (
                        <Action
                          label="Unlink"
                          onPress={() => void changeLink(link.threadId, "unlink")}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {ItemSection ? (
        <ItemSection environmentId={environmentId} projectId={projectId} item={item} />
      ) : null}

      <View className="gap-2">
        <SectionTitle
          trailing={
            can("body") &&
            item.bodyFidelity === "exact" &&
            !item.bodyTruncated &&
            bodyDraft === null ? (
              <Action label="Edit" onPress={() => setBodyDraft(beginWorkDraft("body", item))} />
            ) : null
          }
        >
          Description
        </SectionTitle>
        {item.bodyFidelity === "lossy" ? (
          <Text className="text-xs text-foreground-muted">
            Some content is only shown in the source.
          </Text>
        ) : null}
        {bodyDraft !== null ? (
          <DraftEditor
            label="Description"
            multiline
            draft={bodyDraft}
            item={item}
            current={item.body}
            onChange={setBodyDraft}
            onSave={() => void saveDraft(bodyDraft, setBodyDraft)}
          />
        ) : item.body.trim().length === 0 ? (
          <Text className="text-sm text-foreground-muted">No description.</Text>
        ) : (
          <SelectableMarkdownText
            markdown={item.body}
            textStyle={markdownStyles.nativeTextStyle}
            onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
          />
        )}
      </View>

      {item.labels.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Labels</SectionTitle>
          <View className="flex-row flex-wrap gap-1.5">
            {item.labels.map((label) => (
              <View key={label} className="rounded-md bg-subtle px-2 py-1">
                <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {item.parent ||
      item.blockedBy.length > 0 ||
      item.children.length > 0 ||
      can("parent") ||
      can("blockedBy") ? (
        <View className="gap-2">
          <SectionTitle>Relationships</SectionTitle>
          {can("parent") ? (
            <RelationshipEditor item={item} field="parent" update={update} />
          ) : item.parent ? (
            <Text className="text-sm text-foreground">Parent: {item.parent}</Text>
          ) : null}
          {can("blockedBy") ? (
            <RelationshipEditor item={item} field="blockedBy" update={update} />
          ) : item.blockedBy.length > 0 ? (
            <Text className="text-sm text-foreground">Blocked by: {item.blockedBy.join(", ")}</Text>
          ) : null}
          {item.children.map((child) => (
            <View
              key={child.itemId}
              className="flex-row items-center gap-2"
              accessibilityLabel={`${child.key}, ${child.title}, ${STATUS_LABELS[child.status]}`}
            >
              <SymbolView
                name={STATUS_SYMBOLS[child.status].icon}
                size={16}
                tintColorClassName={STATUS_SYMBOLS[child.status].tint}
              />
              <Text className="text-xs text-foreground-muted">{child.key}</Text>
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                {child.title}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <View className="gap-2">
        <SectionTitle>Comments</SectionTitle>
        {item.comments.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No comments yet.</Text>
        ) : (
          item.comments.map((comment, index) => (
            <View
              key={comment.id}
              className={index === 0 ? "gap-1" : "gap-1 border-t border-border-subtle pt-3"}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                {comment.author?.label ?? "Unknown"}
                <Text className="font-sans text-foreground-tertiary">
                  {" "}
                  · {relativeTime(comment.createdAt)} ago
                </Text>
              </Text>
              <SelectableMarkdownText
                markdown={comment.body}
                textStyle={markdownStyles.nativeTextStyle}
                onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
              />
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

/**
 * A title or body edit. A stale save keeps the text and shows the current version once it has
 * reloaded; the owner then reapplies their edit on top of it or discards it.
 */
function DraftEditor({
  label,
  multiline = false,
  draft,
  item,
  current,
  onChange,
  onSave,
}: {
  label: string;
  multiline?: boolean;
  draft: WorkDraft;
  item: Pick<WorkItemSummary, "key" | "revision">;
  current: string;
  onChange: (next: (current: WorkDraft | null) => WorkDraft | null) => void;
  onSave: () => void;
}) {
  const loaded = workDraftConflictReady(draft, item.revision);
  return (
    <View className="gap-2">
      <AppTextInput
        accessibilityLabel={label}
        className={multiline ? "min-h-32" : undefined}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        value={draft.value}
        onChangeText={(value) =>
          onChange((previous) => (previous === null ? null : editWorkDraft(previous, value)))
        }
      />
      {draft.conflict !== null ? (
        <View className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
          <Text className="text-sm font-t3-medium text-foreground">
            {item.key} changed while you were editing.
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {loaded
              ? `Current version: ${current.trim().length === 0 ? "(empty)" : current}`
              : "Loading the current version…"}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Action
              label="Reapply my edit"
              disabled={!loaded}
              onPress={() =>
                onChange((previous) =>
                  previous === null ? null : rebaseWorkDraft(previous, item.revision),
                )
              }
            />
            <Action label="Discard my edit" onPress={() => onChange(() => null)} />
          </View>
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <Action label="Save" primary disabled={draft.conflict !== null} onPress={onSave} />
        <Action label="Cancel" onPress={() => onChange(() => null)} />
      </View>
    </View>
  );
}

/** Threads of the item's project to link, filtered as the owner types. */
function ThreadLinkPicker({
  environmentId,
  projectId,
  linked,
  onLink,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  linked: ReadonlyArray<ThreadId>;
  onLink: (threadId: ThreadId) => void;
}) {
  const shells = useThreadShells();
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () => workLinkCandidates(shells, { environmentId, projectId, linked, query, limit: 20 }),
    [environmentId, linked, projectId, query, shells],
  );
  return (
    <View className="gap-1 overflow-hidden rounded-[24px] bg-grouped-card p-3">
      <AppTextInput
        accessibilityLabel="Search threads"
        placeholder="Search threads"
        value={query}
        autoFocus
        onChangeText={setQuery}
      />
      {candidates.length === 0 ? (
        <Text className="px-1 py-2 text-sm text-foreground-muted">No matching threads.</Text>
      ) : (
        candidates.map((shell) => (
          <Pressable
            key={shell.id}
            accessibilityRole="button"
            accessibilityLabel={`Link ${shell.title}`}
            className="flex-row items-center gap-2 rounded-xl px-1 py-2.5 active:bg-row-hover"
            onPress={() => onLink(shell.id)}
          >
            <SymbolView name="link" size={15} tintColorClassName="accent-icon-muted" />
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {shell.title}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}
