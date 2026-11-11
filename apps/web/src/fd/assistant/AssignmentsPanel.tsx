import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { FACTORY_CANCEL_TEXT, type FactoryItemFact } from "@t3tools/client-runtime/fd/factory";
import { workItemLinkTarget } from "@t3tools/client-runtime/fd/work-management";
import type { AssistantOverview, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  BriefcaseBusinessIcon,
  ChevronRightIcon,
  ArrowUpRightIcon,
  EllipsisIcon,
  LightbulbIcon,
  WifiOffIcon,
} from "lucide-react";
import { useProjects, useThreadShell, useThreadShells } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  assignmentActions,
  availableWorkerThread,
  factoryAssignmentRow,
  ideaAssignment,
  ideaCaptureRow,
  ideaFacts,
  type IdeaStage,
  ideaStage,
  portfolioRowTitle,
  type AssignmentAction,
  type WorkItemTarget,
} from "./workNavigation";
import { useFactoryCancelFamily, useOverviewEpochs } from "./assignmentReads";
import { epochsMoved } from "./overviewEpochs";
import { readOverview, controlAssignment } from "./commands";
import { ReviewStartCard, type ReviewTarget } from "./ReviewStartCard";
import { PendingActionsList } from "../approvals";

type Assignment = AssistantOverview["assignments"][number];

/** What cancelling an assignment that runs outside Factory ends. */
const ASSIGNMENT_CANCEL_TEXT =
  "Its worker stops and the assignment ends. It cannot be resumed or retried afterwards; its conversation stays.";

/** How long a burst of Factory and Work changes settles before the overview is read again. */
export const OVERVIEW_CHANGE_SETTLE_MS = 400;

const statusLabels: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  launching: "Starting",
  "launch-uncertain": "Needs review",
  running: "Running",
  "needs-input": "Needs input",
  stopping: "Stopping",
  stopped: "Stopped",
  "awaiting-verification": "To verify",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STAGE_VARIANTS = {
  discussion: "outline",
  capturing: "secondary",
  captured: "secondary",
  unconfirmed: "warning",
  delivery: "info",
} as const satisfies Record<IdeaStage["stage"], string>;

const ACTION_LABELS: Record<AssignmentAction, string> = {
  stop: "Stop",
  resume: "Resume",
  retry: "Retry",
  cancel: "Cancel",
};

/** A row's facts, each labelled as itself. */
function ItemFacts({ facts }: { facts: ReadonlyArray<FactoryItemFact> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 text-xs" aria-label="Item facts">
      {facts.map((fact) => (
        <div key={fact.key} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PortfolioPopover({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" size="xs" variant="ghost" />}>
        {icon}
        {title}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </PopoverTrigger>
      <PopoverPopup width="lg" side="top" align="start" padding="compact">
        <div className="py-1">
          <PopoverTitle>{title}</PopoverTitle>
        </div>
        <div className="max-h-80 divide-y divide-border overflow-y-auto">
          {children(() => setOpen(false))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function AssignmentsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const read = useAtomCommand(readOverview, { reportFailure: false });
  const control = useAtomCommand(controlAssignment);
  const allowed = useAtomValue(controlAssignment.permissionAtom(threadRef.environmentId));
  const projects = useProjects();
  const threads = useThreadShells();
  const manager = useThreadShell(threadRef);
  const connected = useEnvironment(threadRef.environmentId)?.connection.phase === "connected";
  const completedRunId = manager?.latestRun?.completedAt == null ? null : manager.latestRun.runId;
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<{
    environmentId: ScopedThreadRef["environmentId"];
    snapshot: AssistantOverview;
  } | null>(null);
  const snapshot = loaded?.environmentId === threadRef.environmentId ? loaded.snapshot : null;
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null);
  // Held with its environment, so switching away never confirms one environment's cancel in another.
  const [cancelTarget, setCancelTarget] = useState<{
    environmentId: ScopedThreadRef["environmentId"];
    assignmentId: string;
  } | null>(null);
  // The current row, while it still offers cancel. Anything else closes the confirmation, so it never
  // cancels what replaced the row it was opened from.
  const confirmingCancel =
    cancelTarget?.environmentId === threadRef.environmentId
      ? (snapshot?.assignments.find(
          (item) =>
            item.assignmentId === cancelTarget.assignmentId &&
            assignmentActions(item).includes("cancel"),
        ) ?? null)
      : null;
  if (cancelTarget !== null && confirmingCancel === null) setCancelTarget(null);
  // Only the latest read started may land: an older one, or one for the environment shown before,
  // finishing last would otherwise put back what the newer read replaced.
  const latestRead = useRef(0);
  const refresh = useCallback(async () => {
    const environmentId = threadRef.environmentId;
    const request = ++latestRead.current;
    const result = await read({ environmentId, input: {} });
    if (request !== latestRead.current) return;
    setError(result._tag === "Failure");
    if (result._tag === "Success") setLoaded({ environmentId, snapshot: result.value });
  }, [read, threadRef.environmentId]);
  const observed = useRef<{
    environmentId: ScopedThreadRef["environmentId"];
    threadId: ThreadId;
    connected: boolean;
    completedRunId: typeof completedRunId;
  } | null>(null);
  // Cached shells can mount before their connection. A completed assistant turn is the
  // milestone after its idea/capture tools have finished; streaming text does not trigger reads.
  useEffect(() => {
    const previous = observed.current;
    observed.current = {
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      connected,
      completedRunId,
    };
    if (!connected) {
      latestRead.current++;
      return;
    }
    if (
      previous === null ||
      !previous.connected ||
      previous.environmentId !== threadRef.environmentId ||
      previous.threadId !== threadRef.threadId ||
      (completedRunId !== null && completedRunId !== previous.completedRunId)
    )
      void refresh();
  }, [connected, completedRunId, refresh, threadRef.environmentId, threadRef.threadId]);
  useEffect(
    () => () => {
      observed.current = null;
      latestRead.current++;
    },
    [],
  );
  useLiveRefresh(connected ? () => void refresh() : null, { key: threadRef.environmentId });
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const { factory: factoryEpoch, work: workEpoch } = useOverviewEpochs(threadRef.environmentId);
  const seenEpochs = useRef({
    environmentId: threadRef.environmentId,
    epochs: { factory: factoryEpoch, work: workEpoch },
  });
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Epochs are compared by value, so a re-render with the same numbers reads nothing.
  useEffect(() => {
    const previous = seenEpochs.current;
    const epochs = { factory: factoryEpoch, work: workEpoch };
    seenEpochs.current = { environmentId: threadRef.environmentId, epochs };
    if (previous.environmentId !== threadRef.environmentId) return;
    if (!epochsMoved(previous.epochs, epochs)) return;
    // A burst of moves, such as a delivery blocking and its Work item updating, reads once.
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      void refreshRef.current();
    }, OVERVIEW_CHANGE_SETTLE_MS);
  }, [threadRef.environmentId, factoryEpoch, workEpoch]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    },
    [],
  );
  const cancelDeliveryId =
    confirmingCancel?.executor === "factory"
      ? (confirmingCancel.factory?.deliveryId ?? null)
      : null;
  const cancelFamily = useFactoryCancelFamily(threadRef.environmentId, cancelDeliveryId);
  const runAction = async (item: Assignment, action: AssignmentAction) => {
    setBusy(item.assignmentId);
    try {
      const result = await control({
        environmentId: threadRef.environmentId,
        input: {
          assignmentId: item.assignmentId,
          managerThreadId: threadRef.threadId,
          action,
        },
      });
      // Show the new state now rather than at the next slow refresh.
      if (result._tag === "Success") await refresh();
    } finally {
      setBusy(null);
    }
  };
  const projectName = (id: string) =>
    projects.find((p) => p.id === id && p.environmentId === threadRef.environmentId)?.title ?? id;
  const work = snapshot?.assignments ?? [];
  const ideas = snapshot?.ideas ?? [];
  if (!ideas.length && !work.length && !error) return null;

  const openWorker = (threadId: ThreadId, close: () => void) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId },
    });
    close();
  };
  const openWork = (target: WorkItemTarget, close: () => void) => {
    void navigate(target);
    close();
  };
  const workerThread = (item: Assignment | undefined) =>
    availableWorkerThread(item, threadRef.environmentId, threads);

  return (
    <section
      aria-label="Ideas and assignments"
      className="flex flex-wrap items-center gap-1 px-3 pt-2"
    >
      {ideas.length > 0 ? (
        <PortfolioPopover title="Ideas" count={ideas.length} icon={<LightbulbIcon />}>
          {(close) =>
            ideas.map((idea) => {
              const threadId = workerThread(ideaAssignment(idea, work));
              const capture = ideaCaptureRow(idea, threadRef.environmentId);
              const facts = ideaFacts(idea, ideaAssignment(idea, work));
              const stage = ideaStage(idea, ideaAssignment(idea, work));
              const review = (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={`Review and start: ${portfolioRowTitle(idea, idea.ideaId)}`}
                  onClick={() => {
                    setReviewing({ projectId: idea.projectId, ideaId: idea.ideaId });
                    close();
                  }}
                >
                  Review
                </Button>
              );
              const label = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{portfolioRowTitle(idea, idea.ideaId)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {projectName(idea.projectId)}
                    </p>
                  </div>
                  {idea.priority !== null ? (
                    <Badge variant="outline" size="sm">
                      Queue P{idea.priority}
                    </Badge>
                  ) : null}
                  <Badge variant={STAGE_VARIANTS[stage.stage]} size="sm">
                    {stage.label}
                  </Badge>
                </>
              );
              return threadId ? (
                <div key={`${idea.projectId}:${idea.ideaId}`} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Open work for ${portfolioRowTitle(idea, idea.ideaId)}`}
                    onClick={() => openWorker(threadId, close)}
                  >
                    {label}
                    <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                  {review}
                </div>
              ) : (
                <details key={`${idea.projectId}:${idea.ideaId}`} className="group/idea py-2">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-open/idea:rotate-90" />
                    {label}
                  </summary>
                  <div className="space-y-2 px-2 pb-1 text-sm">
                    {capture ? <p className="text-xs">{capture.text}</p> : null}
                    <p className="text-xs text-muted-foreground">{stage.detail}</p>
                    {idea.authorized ? (
                      <Badge variant="success" size="sm">
                        Approved to start
                      </Badge>
                    ) : null}
                    {idea.priorityReason ? (
                      <p className="text-xs text-muted-foreground">{idea.priorityReason}</p>
                    ) : null}
                    {facts ? <ItemFacts facts={facts} /> : null}
                    <div className="flex flex-wrap gap-1">
                      {review}
                      {capture?.work ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => openWork(capture.work!, close)}
                        >
                          Open in Work
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </details>
              );
            })
          }
        </PortfolioPopover>
      ) : null}
      {work.length > 0 ? (
        <PortfolioPopover title="Assignments" count={work.length} icon={<BriefcaseBusinessIcon />}>
          {(close) =>
            work.map((item) => {
              const threadId = workerThread(item);
              const title = portfolioRowTitle(item, item.assignmentId);
              const actions = assignmentActions(item);
              const row = factoryAssignmentRow(item, threadRef.environmentId);
              // A delivery's own state, which reads true whatever the chat said while it ran.
              const next = row?.nextAction ?? null;
              const label = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {projectName(item.projectId)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      next !== null
                        ? next.forYou
                          ? "warning"
                          : "secondary"
                        : item.state === "completed"
                          ? "success"
                          : item.state === "failed"
                            ? "error"
                            : ["needs-input", "launch-uncertain", "awaiting-verification"].includes(
                                  item.state,
                                )
                              ? "warning"
                              : "secondary"
                    }
                    size="sm"
                  >
                    {next?.title ?? statusLabels[item.state] ?? item.state}
                  </Badge>
                </>
              );
              return (
                <div key={item.assignmentId} className="flex items-start gap-1 py-1">
                  {row ? (
                    <div className="min-w-0 flex-1 space-y-1 px-2 py-2 text-sm">
                      <div className="flex items-center gap-2">{label}</div>
                      {next !== null && (next.readyForReview || !next.forYou) ? (
                        <p className="text-xs text-muted-foreground">{next.detail}</p>
                      ) : null}
                      <ItemFacts facts={row.facts} />
                      {row.reviewed ? (
                        <p className="text-xs text-muted-foreground">Runs on what you reviewed.</p>
                      ) : null}
                      <PendingActionsList
                        pending={row.pendingActions}
                        shownItem={null}
                        projectName={(id) =>
                          projects.find(
                            (project) =>
                              project.id === id &&
                              project.environmentId === threadRef.environmentId,
                          )?.title
                        }
                        threadName={(id) =>
                          threads.find(
                            (thread) =>
                              thread.id === id && thread.environmentId === threadRef.environmentId,
                          )?.title
                        }
                        onOpenThread={(id) => openWorker(id, close)}
                        onOpenItem={(ref, projectId) =>
                          openWork(
                            workItemLinkTarget({
                              environmentId: threadRef.environmentId,
                              projectId,
                              ref,
                            }),
                            close,
                          )
                        }
                      />
                      {row.reasons.map((reason) => (
                        <p key={reason} className="break-words">
                          {reason}
                        </p>
                      ))}
                      {[...row.waits, ...row.notices].map((line) => (
                        <p key={line} className="break-words text-xs text-muted-foreground">
                          {line}
                        </p>
                      ))}
                      {[...new Set(item.evidence)].map((e) => (
                        <p key={e} className="break-words text-xs">
                          {e}
                        </p>
                      ))}
                      <div className="flex flex-wrap gap-1 pt-1">
                        {row.work ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => openWork(row.work!, close)}
                          >
                            Open in Work
                          </Button>
                        ) : null}
                        {threadId ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => openWorker(threadId, close)}
                          >
                            Open thread
                          </Button>
                        ) : null}
                        {row.pullRequestUrl ? (
                          <Button
                            size="xs"
                            variant="outline"
                            render={
                              <a href={row.pullRequestUrl} target="_blank" rel="noreferrer" />
                            }
                          >
                            Pull request
                            <ArrowUpRightIcon />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : threadId ? (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-label={`Open work: ${title}`}
                      onClick={() => openWorker(threadId, close)}
                    >
                      {label}
                      <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  ) : (
                    <details className="group/work min-w-0 flex-1 py-2">
                      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-open/work:rotate-90" />
                        {label}
                      </summary>
                      <div className="space-y-2 px-2 pt-2 text-sm">
                        <p className="text-xs text-muted-foreground">
                          Worker conversation unavailable.
                        </p>
                        {item.notice ? <p>{item.notice}</p> : null}
                        {[...new Set(item.evidence)].map((e) => (
                          <p key={e} className="text-xs">
                            {e}
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                  {actions.length ? (
                    <div className="pt-2">
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Manage work: ${title}`}
                            />
                          }
                        >
                          <EllipsisIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          {actions.map((action) => (
                            <MenuItem
                              key={action}
                              disabled={!allowed || busy !== null}
                              onClick={() => {
                                // Cancelling ends the assignment, and a delivery's family with it,
                                // so it asks first as Factory's own section does.
                                if (action === "cancel") {
                                  setCancelTarget({
                                    environmentId: threadRef.environmentId,
                                    assignmentId: item.assignmentId,
                                  });
                                  close();
                                  return;
                                }
                                return runAction(item, action);
                              }}
                            >
                              {ACTION_LABELS[action]}
                            </MenuItem>
                          ))}
                        </MenuPopup>
                      </Menu>
                    </div>
                  ) : null}
                </div>
              );
            })
          }
        </PortfolioPopover>
      ) : null}
      <AlertDialog
        open={confirmingCancel !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cancelDeliveryId !== null ? "Cancel the delivery of " : "Cancel "}
              {confirmingCancel
                ? portfolioRowTitle(confirmingCancel, confirmingCancel.assignmentId)
                : ""}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancelDeliveryId !== null
                ? cancelFamily === null
                  ? "Checking what cancelling it ends…"
                  : FACTORY_CANCEL_TEXT[cancelFamily]
                : ASSIGNMENT_CANCEL_TEXT}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={
                !allowed || busy !== null || (cancelDeliveryId !== null && cancelFamily === null)
              }
              onClick={() => {
                if (confirmingCancel === null) return;
                const item = confirmingCancel;
                setCancelTarget(null);
                void runAction(item, "cancel");
              }}
            >
              {cancelDeliveryId !== null ? "Cancel delivery" : "Cancel assignment"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {reviewing !== null ? (
        <ReviewStartCard
          environmentId={threadRef.environmentId}
          managerThreadId={threadRef.threadId}
          target={reviewing}
          onClose={() => setReviewing(null)}
          onStarted={() => void refresh()}
        />
      ) : null}
      {error ? (
        <Popover>
          <PopoverTrigger render={<Button type="button" size="xs" variant="ghost" />}>
            <WifiOffIcon />
            Status unavailable
          </PopoverTrigger>
          <PopoverPopup width="sm" side="top">
            <p className="text-sm" role="status">
              Reconnect to refresh work status. Saved assignments are unchanged.
            </p>
          </PopoverPopup>
        </Popover>
      ) : null}
    </section>
  );
}
