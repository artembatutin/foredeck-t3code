import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  beginWorkDraft,
  changedSinceLink,
  editWorkDraft,
  linkPrompts,
  mergeComposerText,
  rebaseWorkDraft,
  refreshWork,
  RUN_STATE_LABELS,
  runStateOf,
  settleWorkDraft,
  type WorkDraft,
  workDraftChanged,
  workDraftConflictReady,
  workDraftPatch,
  workItemReferenceText,
  workStatusInput,
  workStatusUndo,
  workUndoMessage,
  type WorkWriteOutcome,
  workWriteOutcome,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isWorkNativeStatus,
  type WorkItemDetail as WorkItemDetailValue,
  type WorkItemPatch,
  type WorkItemRef,
  type WorkItemSummary,
  type WorkNativeStatus,
  type WorkSetStatusInput,
  type WorkThreadLink,
  type WorkTransition,
} from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, LinkIcon, MessageSquarePlusIcon, PlayIcon, XIcon } from "lucide-react";
import { type ComponentType, useCallback, useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { LinkThreadDialog } from "./LinkThreadDialog";
import { STATUS_LABELS, WorkStatusBadge } from "./shared";
import { StartWorkThreadDialog, type StartWorkThreadTarget } from "./StartWorkThreadDialog";
import { useWorkWritable, workCommands, workEnvironment } from "./state";
import { WorkItemFieldControls, WorkRelationshipEditor } from "./WorkItemFields";

/**
 * A section another feature adds to the item detail, beside its linked threads. The route passes
 * it in, so Work never imports the feature.
 */
export type WorkItemSection = ComponentType<{
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: WorkItemDetailValue;
}>;

/** The inline detail of one Work item: everything an owner can do with it. */
export function WorkItemDetail({
  environmentId,
  projectId,
  itemRef,
  itemSection,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemRef: WorkItemRef;
  itemSection?: WorkItemSection | undefined;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    workEnvironment.detail({ environmentId, input: { ref: itemRef } }),
  );
  const requestRefresh = useAtomCommand(workCommands.refresh);
  const refreshQuery = query.refresh;
  // Explicit refresh drops the server's cached copy of this source, then reads again.
  const fullRefresh = useCallback(
    () =>
      void refreshWork({
        requestServerRefresh: () =>
          requestRefresh({ environmentId, input: { sourceId: itemRef.sourceId } }),
        refreshQueries: refreshQuery,
      }),
    [environmentId, itemRef.sourceId, refreshQuery, requestRefresh],
  );
  const item = query.data;
  if (item === null) {
    return (
      <aside className="flex min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          {query.error ? <p className="text-destructive text-sm">{query.error}</p> : <Spinner />}
          <Button size="icon-sm" variant="ghost" aria-label="Close item" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </aside>
    );
  }
  return (
    <LoadedWorkItem
      environmentId={environmentId}
      projectId={projectId}
      item={item}
      itemSection={itemSection}
      refreshing={query.isPending}
      onRefresh={query.refresh}
      onFullRefresh={fullRefresh}
      onClose={onClose}
    />
  );
}

function LoadedWorkItem({
  environmentId,
  projectId,
  item,
  itemSection: ItemSection,
  refreshing,
  onRefresh,
  onFullRefresh,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  item: WorkItemDetailValue;
  itemSection: WorkItemSection | undefined;
  refreshing: boolean;
  onRefresh: () => void;
  onFullRefresh: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const shells = useThreadShells();
  const updateItem = useAtomCommand(workCommands.updateItem);
  const setStatus = useAtomCommand(workCommands.setStatus);
  const comment = useAtomCommand(workCommands.comment);
  const setLink = useAtomCommand(workCommands.setLink);
  const canWrite = useWorkWritable(environmentId, workCommands.updateItem, "items.write");
  const canComment = useWorkWritable(environmentId, workCommands.comment, "comments");
  const canLink = useWorkWritable(environmentId, workCommands.setLink, "links");
  const canStart = useWorkWritable(environmentId, workCommands.startThread, "threads.start");
  // Each draft keeps the revision it was started from; refreshes below never touch it.
  const [titleDraft, setTitleDraft] = useState<WorkDraft | null>(null);
  const [bodyDraft, setBodyDraft] = useState<WorkDraft | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ReadonlyArray<WorkTransition> | null>(null);
  const [startTarget, setStartTarget] = useState<StartWorkThreadTarget | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  // The page keys this component by item, so drafts never carry over to another item.

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
  const writable = canWrite && item.invalid === null;
  const can = (field: WorkItemDetailValue["capabilities"]["fields"][number]) =>
    writable && item.capabilities.fields.includes(field);

  /** Shows a write's outcome inline; a stale write reloads the item so the owner sees why. */
  const report = <A,>(outcome: WorkWriteOutcome<A>): WorkWriteOutcome<A> => {
    switch (outcome._tag) {
      case "success":
        setError(null);
        break;
      case "stale":
        setError(`${item.key} changed since it was loaded. It has been reloaded; try again.`);
        onRefresh();
        break;
      case "candidates":
        setError(null);
        break;
      case "failed":
        setError(outcome.message);
        break;
    }
    return outcome;
  };

  const update = async (patch: Omit<WorkItemPatch, "ref">) =>
    report(
      workWriteOutcome(await updateItem({ environmentId, input: { ref: item.ref, ...patch } })),
    );

  const runUndo = async (input: WorkSetStatusInput) => {
    const message = workUndoMessage(
      item.key,
      workWriteOutcome(await setStatus({ environmentId, input })),
    );
    if (message !== null) {
      toastManager.add({ type: "error", title: "Undo not applied", description: message });
    }
  };

  /**
   * Changes status guarded by the revision on screen, then offers an Undo guarded by the
   * revision the change produced, so it cannot overwrite a later change by anyone else.
   */
  const changeStatus = async (
    change: { readonly status: WorkNativeStatus } | { readonly transitionId: string },
    title?: (after: WorkItemSummary) => string,
  ) => {
    setCandidates(null);
    const before = item;
    const outcome = report(
      workWriteOutcome(await setStatus({ environmentId, input: workStatusInput(before, change) })),
    );
    // An ambiguous status is answered with its transitions to choose from, not an error.
    if (outcome._tag === "candidates") setCandidates(outcome.candidates);
    if (outcome._tag !== "success") return;
    const undo = workStatusUndo(before, outcome.value);
    toastManager.add({
      type: "success",
      title:
        title?.(outcome.value) ??
        `${item.key}: ${outcome.value.nativeStatus?.name ?? STATUS_LABELS[outcome.value.status]}`,
      ...(undo === null
        ? {}
        : { actionProps: { children: "Undo", onClick: () => void runUndo(undo) } }),
    });
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
    if (outcome._tag === "stale") onRefresh();
    setDraft((current) => {
      if (current === null) return null;
      // Text typed while the save was in flight stays, based on the revision just written.
      if (outcome._tag === "success" && current.value !== draft.value) {
        return rebaseWorkDraft(current, outcome.value.revision);
      }
      return settleWorkDraft(current, outcome);
    });
  };

  const addComment = async () => {
    if (commentDraft.trim().length === 0) return;
    const outcome = report(
      workWriteOutcome(
        await comment({
          environmentId,
          input: { ref: item.ref, body: commentDraft, clientRequestId: randomUUID() },
        }),
      ),
    );
    if (outcome._tag === "success") setCommentDraft("");
  };

  const changeLabels = (patch: { add: ReadonlyArray<string>; remove: ReadonlyArray<string> }) =>
    update({ labels: patch });

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  const addToPrompt = async () => {
    const opened = await newThread({ environmentId, projectId });
    if (opened === null) return;
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(opened.draftId)?.prompt ?? "";
    store.setPrompt(opened.draftId, mergeComposerText(existing, workItemReferenceText(item)));
  };

  /**
   * Opens the thread with what changed added to its draft, for the owner to edit and send.
   * Anything the owner already typed there stays.
   */
  const sendUpdate = (link: WorkThreadLink) => {
    const ref = scopeThreadRef(environmentId, link.threadId);
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(ref)?.prompt ?? "";
    store.setPrompt(
      ref,
      mergeComposerText(
        existing,
        `${item.key} changed since this thread started. ${workItemReferenceText(item)}`,
      ),
    );
    openThread(link.threadId);
  };

  const backToTodo = () => changeStatus({ status: "todo" }, () => `${item.key} is back to To do`);

  const markDone = () => changeStatus({ status: "done" }, () => `${item.key} marked done`);

  const statusOptions: ReadonlyArray<WorkNativeStatus> = item.capabilities.statuses;
  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto" aria-label={`${item.key} details`}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-muted-foreground text-xs">{item.key}</p>
            {titleDraft !== null ? (
              <>
                <Input
                  aria-label="Title"
                  value={titleDraft.value}
                  autoFocus
                  onChange={(event) =>
                    setTitleDraft((current) =>
                      current === null ? null : editWorkDraft(current, event.target.value),
                    )
                  }
                  onBlur={() => {
                    // A conflicting draft waits for the owner's choice instead of saving again.
                    if (titleDraft.conflict === null) void saveDraft(titleDraft, setTitleDraft);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && titleDraft.conflict === null) {
                      void saveDraft(titleDraft, setTitleDraft);
                    }
                    if (event.key === "Escape") setTitleDraft(null);
                  }}
                />
                {titleDraft.conflict !== null ? (
                  <DraftConflict
                    draft={titleDraft}
                    item={item}
                    current={titleDraft.conflict.current?.title ?? item.title}
                    onReapply={(revision) =>
                      setTitleDraft((current) =>
                        current === null ? null : rebaseWorkDraft(current, revision),
                      )
                    }
                    onDiscard={() => setTitleDraft(null)}
                  />
                ) : null}
              </>
            ) : (
              <h2
                className="font-medium text-base"
                onDoubleClick={() =>
                  can("title") ? setTitleDraft(beginWorkDraft("title", item)) : undefined
                }
              >
                {item.title}
              </h2>
            )}
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Close item" onClick={onClose}>
            <XIcon />
          </Button>
        </div>

        {item.invalid ? (
          <p className="text-warning-foreground text-sm">Read-only: {item.invalid.message}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger
              disabled={!writable || (statusOptions.length === 0 && item.transitions.length === 0)}
              render={<Button size="sm" variant="outline" />}
            >
              {item.nativeStatus?.name ?? STATUS_LABELS[item.status]}
            </MenuTrigger>
            <MenuPopup align="start">
              {item.capabilities.transitions && item.transitions.length > 0 ? (
                item.transitions.map((transition) => (
                  <MenuItem
                    key={transition.id}
                    disabled={transition.requiresFields}
                    onClick={() => void changeStatus({ transitionId: transition.id })}
                  >
                    {transition.name} → {transition.toName}
                  </MenuItem>
                ))
              ) : (
                <MenuRadioGroup
                  value={item.status}
                  onValueChange={(value) => {
                    if (isWorkNativeStatus(value)) void changeStatus({ status: value });
                  }}
                >
                  {statusOptions.map((status) => (
                    <MenuRadioItem key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              )}
            </MenuPopup>
          </Menu>
          {item.blocked ? <Badge variant="warning">Blocked</Badge> : null}
          {item.priority && !can("priority") ? (
            <Badge variant="outline">{item.priority} priority</Badge>
          ) : null}
          {item.assignee && !can("assignee") ? (
            <Badge variant="secondary">{item.assignee.label}</Badge>
          ) : null}
          <WorkItemFieldControls
            environmentId={environmentId}
            item={item}
            can={can}
            update={update}
          />
          <div className="flex-1" />
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={onFullRefresh}>
            Refresh
          </Button>
        </div>

        {candidates !== null ? (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">Several transitions reach that status:</p>
            <div className="flex flex-wrap gap-1">
              {candidates.map((candidate) => (
                <Button
                  key={candidate.id}
                  size="xs"
                  variant="outline"
                  disabled={candidate.requiresFields}
                  onClick={() => void changeStatus({ transitionId: candidate.id })}
                >
                  {candidate.name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!canStart && !openLink}
            onClick={() =>
              setStartTarget({
                environmentId,
                projectId,
                item,
                openThreadId: openLink?.threadId ?? null,
              })
            }
          >
            <PlayIcon />
            {openLink ? "Continue" : "Start thread"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void addToPrompt()}>
            <MessageSquarePlusIcon />
            Add to prompt
          </Button>
          <Button size="sm" variant="outline" disabled={!canLink} onClick={() => setLinkOpen(true)}>
            <LinkIcon />
            Link to a thread
          </Button>
          {item.url ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={item.url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              Open in {item.kind === "github" ? "GitHub" : "Jira"}
            </Button>
          ) : null}
        </div>

        {error ? <p className="text-destructive text-sm">{error}</p> : null}

        {item.links.length > 0 ? (
          <section className="space-y-2" aria-label="Linked threads">
            <h3 className="font-medium text-sm">Linked threads</h3>
            {item.links.map((link) => {
              const shell = shellById.get(link.threadId);
              const prompts = linkPrompts(link, item);
              return (
                <div key={link.threadId} className="space-y-1 rounded-md border p-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                      onClick={() => openThread(link.threadId)}
                    >
                      {shell?.title ?? link.threadId}
                    </button>
                    <Badge variant="outline">{RUN_STATE_LABELS[runStateOf(shell)]}</Badge>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canLink}
                      onClick={async () => {
                        report(
                          workWriteOutcome(
                            await setLink({
                              environmentId,
                              input: { ref: item.ref, threadId: link.threadId, action: "unlink" },
                            }),
                          ),
                        );
                      }}
                    >
                      Unlink
                    </Button>
                  </div>
                  {link.run ? (
                    <p className="text-muted-foreground text-xs">
                      Last run {link.run.status} at {new Date(link.run.at).toLocaleString()}
                    </p>
                  ) : null}
                  {changedSinceLink(link, item) ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        Changed since the thread started.
                      </span>
                      <Button size="xs" variant="outline" onClick={() => sendUpdate(link)}>
                        Send update to thread
                      </Button>
                    </div>
                  ) : null}
                  {prompts.backToTodo && writable ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">The run stopped.</span>
                      <Button size="xs" variant="outline" onClick={() => void backToTodo()}>
                        Back to todo?
                      </Button>
                    </div>
                  ) : null}
                  {prompts.markDone && writable && statusOptions.includes("done") ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">The run completed.</span>
                      <Button size="xs" variant="outline" onClick={() => void markDone()}>
                        Mark {item.key} done?
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {ItemSection ? (
          <ItemSection environmentId={environmentId} projectId={projectId} item={item} />
        ) : null}

        <section className="space-y-2" aria-label="Description">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">Description</h3>
            {can("body") &&
            item.bodyFidelity === "exact" &&
            !item.bodyTruncated &&
            bodyDraft === null ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setBodyDraft(beginWorkDraft("body", item))}
              >
                Edit
              </Button>
            ) : null}
          </div>
          {item.bodyFidelity === "lossy" ? (
            <p className="text-muted-foreground text-xs">
              Some content could not be shown here; edit the description in{" "}
              {item.kind === "jira" ? "Jira" : "the source"}.
            </p>
          ) : null}
          {bodyDraft !== null ? (
            <div className="space-y-2">
              <Textarea
                aria-label="Description"
                value={bodyDraft.value}
                onChange={(event) =>
                  setBodyDraft((current) =>
                    current === null ? null : editWorkDraft(current, event.target.value),
                  )
                }
              />
              {bodyDraft.conflict !== null ? (
                <DraftConflict
                  draft={bodyDraft}
                  item={item}
                  current={item.body}
                  onReapply={(revision) =>
                    setBodyDraft((current) =>
                      current === null ? null : rebaseWorkDraft(current, revision),
                    )
                  }
                  onDiscard={() => setBodyDraft(null)}
                />
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="xs"
                  disabled={bodyDraft.conflict !== null}
                  onClick={() => void saveDraft(bodyDraft, setBodyDraft)}
                >
                  Save
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setBodyDraft(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">
              {item.body.trim().length === 0 ? "No description." : item.body}
            </p>
          )}
        </section>

        <section className="space-y-2" aria-label="Labels">
          <h3 className="font-medium text-sm">Labels</h3>
          <div className="flex flex-wrap items-center gap-1">
            {item.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
                {can("labels") ? (
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    onClick={() => void changeLabels({ add: [], remove: [label] })}
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </Badge>
            ))}
            {can("labels") ? (
              <Input
                aria-label="Add label"
                placeholder="Add label"
                value={labelDraft}
                size="sm"
                onChange={(event) => setLabelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || labelDraft.trim().length === 0) return;
                  void changeLabels({ add: [labelDraft.trim()], remove: [] }).then((result) => {
                    if (result._tag === "success") setLabelDraft("");
                  });
                }}
              />
            ) : null}
          </div>
        </section>

        {item.parent ||
        item.blockedBy.length > 0 ||
        item.children.length > 0 ||
        item.blocking.length > 0 ||
        can("parent") ||
        can("blockedBy") ? (
          <section className="space-y-1 text-sm" aria-label="Relationships">
            <h3 className="font-medium text-sm">Relationships</h3>
            {can("parent") ? (
              <WorkRelationshipEditor item={item} field="parent" update={update} />
            ) : item.parent ? (
              <p>Parent: {item.parent}</p>
            ) : null}
            {can("blockedBy") ? (
              <WorkRelationshipEditor item={item} field="blockedBy" update={update} />
            ) : item.blockedBy.length > 0 ? (
              <p>Blocked by: {item.blockedBy.join(", ")}</p>
            ) : null}
            {item.blocking.length > 0 ? <p>Blocking: {item.blocking.join(", ")}</p> : null}
            {item.children.map((child) => (
              <p key={child.itemId}>
                {child.key} {child.title} <WorkStatusBadge status={child.status} />
              </p>
            ))}
          </section>
        ) : null}

        <section className="space-y-2" aria-label="Comments">
          <h3 className="font-medium text-sm">Comments</h3>
          {item.comments.length === 0 ? (
            <p className="text-muted-foreground text-sm">No comments yet.</p>
          ) : (
            item.comments.map((entry) => (
              <div key={entry.id} className="space-y-0.5">
                <p className="text-muted-foreground text-xs">
                  {entry.author?.label ?? "Unknown"} · {new Date(entry.createdAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap text-sm">{entry.body}</p>
              </div>
            ))
          )}
          {item.commentsTruncated ? (
            <p className="text-muted-foreground text-xs">Older comments are not shown.</p>
          ) : null}
          {canComment && item.invalid === null && item.capabilities.comments === "add" ? (
            <div className="space-y-2">
              <Textarea
                aria-label="New comment"
                placeholder="Add a comment"
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  disabled={commentDraft.trim().length === 0}
                  onClick={() => void addComment()}
                >
                  Comment
                </Button>
                <span className="text-muted-foreground text-xs">
                  Comments are added only
                  {item.url ? `; edit them in ${item.kind === "github" ? "GitHub" : "Jira"}` : ""}.
                </span>
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <StartWorkThreadDialog
        target={startTarget}
        onOpenChange={(open) => (open ? undefined : setStartTarget(null))}
      />
      <LinkThreadDialog
        open={linkOpen}
        environmentId={environmentId}
        projectId={projectId}
        itemRef={item.ref}
        linkedThreadIds={item.links.map((link) => link.threadId)}
        onOpenChange={setLinkOpen}
      />
    </aside>
  );
}

/**
 * A save that came back stale: the owner sees the current version beside their edit and decides.
 * The draft stays editable throughout. Reapplying is offered once the item shown is newer than the
 * draft's base, so the owner overwrites exactly the version on screen.
 */
export function DraftConflict({
  draft,
  item,
  current,
  onReapply,
  onDiscard,
}: {
  draft: WorkDraft;
  item: Pick<WorkItemSummary, "revision" | "key">;
  current: string;
  onReapply: (revision: string) => void;
  onDiscard: () => void;
}) {
  const loaded = workDraftConflictReady(draft, item.revision);
  return (
    <div className="space-y-2 rounded-md border p-2 text-xs" role="alert">
      <p className="font-medium">{item.key} changed while you were editing.</p>
      {loaded ? (
        <>
          <p className="text-muted-foreground">Current version:</p>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap">
            {current.trim().length === 0 ? "(empty)" : current}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">Loading the current version...</p>
      )}
      <p className="text-muted-foreground">Your edit is kept above; keep editing or choose:</p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!loaded}
          onClick={() => onReapply(item.revision)}
        >
          Reapply my edit
        </Button>
        <Button size="xs" variant="ghost" onClick={onDiscard}>
          Discard my edit
        </Button>
      </div>
    </div>
  );
}
