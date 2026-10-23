import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  changedSinceLink,
  linkPrompts,
  RUN_STATE_LABELS,
  runStateOf,
  workItemReferenceText,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isWorkNativeStatus,
  type WorkItemDetail as WorkItemDetailValue,
  type WorkItemRef,
  type WorkNativeStatus,
  type WorkThreadLink,
  type WorkTransition,
} from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { ExternalLinkIcon, LinkIcon, MessageSquarePlusIcon, PlayIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
import { STATUS_LABELS, WorkStatusBadge, workCommandError } from "./shared";
import { StartWorkThreadDialog, type StartWorkThreadTarget } from "./StartWorkThreadDialog";
import { workCommands, workEnvironment } from "./state";

/** The inline detail of one Work item: everything an owner can do with it. */
export function WorkItemDetail({
  environmentId,
  projectId,
  itemRef,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemRef: WorkItemRef;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    workEnvironment.detail({ environmentId, input: { ref: itemRef } }),
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
      refreshing={query.isPending}
      onRefresh={query.refresh}
      onClose={onClose}
    />
  );
}

function LoadedWorkItem({
  environmentId,
  projectId,
  item,
  refreshing,
  onRefresh,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  item: WorkItemDetailValue;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const shells = useThreadShells();
  const updateItem = useAtomCommand(workCommands.updateItem);
  const setStatus = useAtomCommand(workCommands.setStatus);
  const comment = useAtomCommand(workCommands.comment);
  const setLink = useAtomCommand(workCommands.setLink);
  const canWrite = useAtomValue(workCommands.updateItem.permissionAtom(environmentId));
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
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

  /** Shows a failed command's message; every write goes through this. */
  const report = <R extends { readonly _tag: "Success" | "Failure" }>(result: R): R => {
    if (result._tag === "Failure") {
      setError(workCommandError(result as R & { readonly cause: Cause.Cause<unknown> }));
    } else setError(null);
    return result;
  };

  const changeStatus = async (input: { status?: WorkNativeStatus; transitionId?: string }) => {
    setCandidates(null);
    const result = await setStatus({
      environmentId,
      // No revision guard: a status write is idempotent, and an Undo toast outlives the
      // revision it was created with.
      input: { ref: item.ref, ...input },
    });
    const failure =
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null;
    // An ambiguous status is answered with its transitions to choose from, not an error.
    if (failure?._tag === "WorkError" && failure.candidates !== undefined) {
      setCandidates(failure.candidates);
      return result;
    }
    return report(result);
  };

  const saveTitle = async () => {
    if (titleDraft === null || titleDraft.trim() === item.title) return setTitleDraft(null);
    const result = report(
      await updateItem({
        environmentId,
        input: { ref: item.ref, title: titleDraft.trim(), expectedRevision: item.revision },
      }),
    );
    if (result._tag === "Success") setTitleDraft(null);
  };

  const saveBody = async () => {
    if (bodyDraft === null) return;
    const result = report(
      await updateItem({
        environmentId,
        input: { ref: item.ref, body: bodyDraft, expectedRevision: item.revision },
      }),
    );
    if (result._tag === "Success") setBodyDraft(null);
  };

  const addComment = async () => {
    if (commentDraft.trim().length === 0) return;
    const result = report(
      await comment({
        environmentId,
        input: { ref: item.ref, body: commentDraft, clientRequestId: randomUUID() },
      }),
    );
    if (result._tag === "Success") setCommentDraft("");
  };

  const changeLabels = async (patch: {
    add: ReadonlyArray<string>;
    remove: ReadonlyArray<string>;
  }) => report(await updateItem({ environmentId, input: { ref: item.ref, labels: patch } }));

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
    const text = workItemReferenceText(item);
    store.setPrompt(opened.draftId, existing.trim().length === 0 ? text : `${existing}\n\n${text}`);
  };

  /** Opens the thread with a draft telling it what changed, for the owner to edit and send. */
  const sendUpdate = (link: WorkThreadLink) => {
    const ref = scopeThreadRef(environmentId, link.threadId);
    useComposerDraftStore
      .getState()
      .setPrompt(
        ref,
        `${item.key} changed since this thread started. ${workItemReferenceText(item)}`,
      );
    openThread(link.threadId);
  };

  const backToTodo = async () => {
    const result = await changeStatus({ status: "todo" });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `${item.key} is back to To do`,
        actionProps: {
          children: "Undo",
          onClick: () => void changeStatus({ status: "in_progress" }),
        },
      });
    }
  };

  const markDone = async () => {
    const previous = item.status;
    const result = await changeStatus({ status: "done" });
    if (result._tag === "Success" && isWorkNativeStatus(previous)) {
      toastManager.add({
        type: "success",
        title: `${item.key} marked done`,
        actionProps: { children: "Undo", onClick: () => void changeStatus({ status: previous }) },
      });
    }
  };

  const statusOptions: ReadonlyArray<WorkNativeStatus> = item.capabilities.statuses;
  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto" aria-label={`${item.key} details`}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-muted-foreground text-xs">{item.key}</p>
            {titleDraft !== null ? (
              <Input
                aria-label="Title"
                value={titleDraft}
                autoFocus
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveTitle();
                  if (event.key === "Escape") setTitleDraft(null);
                }}
              />
            ) : (
              <h2
                className="font-medium text-base"
                onDoubleClick={() => (can("title") ? setTitleDraft(item.title) : undefined)}
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
          {item.priority ? <Badge variant="outline">{item.priority} priority</Badge> : null}
          {item.assignee ? <Badge variant="secondary">{item.assignee.label}</Badge> : null}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
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
          <Button
            size="sm"
            variant="outline"
            disabled={!writable}
            onClick={() => setLinkOpen(true)}
          >
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
                      disabled={!writable}
                      onClick={async () => {
                        report(
                          await setLink({
                            environmentId,
                            input: { ref: item.ref, threadId: link.threadId, action: "unlink" },
                          }),
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

        <section className="space-y-2" aria-label="Description">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">Description</h3>
            {can("body") &&
            item.bodyFidelity === "exact" &&
            !item.bodyTruncated &&
            bodyDraft === null ? (
              <Button size="xs" variant="ghost" onClick={() => setBodyDraft(item.body)}>
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
                value={bodyDraft}
                onChange={(event) => setBodyDraft(event.target.value)}
              />
              <div className="flex gap-2">
                <Button size="xs" onClick={() => void saveBody()}>
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
                    if (result._tag === "Success") setLabelDraft("");
                  });
                }}
              />
            ) : null}
          </div>
        </section>

        {item.parent ||
        item.blockedBy.length > 0 ||
        item.children.length > 0 ||
        item.blocking.length > 0 ? (
          <section className="space-y-1 text-sm" aria-label="Relationships">
            <h3 className="font-medium text-sm">Relationships</h3>
            {item.parent ? <p>Parent: {item.parent}</p> : null}
            {item.blockedBy.length > 0 ? <p>Blocked by: {item.blockedBy.join(", ")}</p> : null}
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
          {writable && item.capabilities.comments === "add" ? (
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
