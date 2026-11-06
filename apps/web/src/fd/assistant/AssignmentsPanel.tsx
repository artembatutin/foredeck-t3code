import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { AssistantOverview, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  BriefcaseBusinessIcon,
  ChevronRightIcon,
  ArrowUpRightIcon,
  EllipsisIcon,
  LightbulbIcon,
  WifiOffIcon,
} from "lucide-react";
import { useProjects, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  assignmentActions,
  availableWorkerThread,
  factoryAssignmentRow,
  ideaAssignment,
  ideaCaptureRow,
  type WorkItemTarget,
} from "./workNavigation";
import { readOverview, controlAssignment } from "./commands";

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
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<{
    environmentId: ScopedThreadRef["environmentId"];
    snapshot: AssistantOverview;
  } | null>(null);
  const snapshot = loaded?.environmentId === threadRef.environmentId ? loaded.snapshot : null;
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const environmentId = threadRef.environmentId;
    const result = await read({ environmentId, input: {} });
    setError(result._tag === "Failure");
    if (result._tag === "Success") setLoaded({ environmentId, snapshot: result.value });
  }, [read, threadRef.environmentId]);
  // The first read happens on mount; later ones follow focus, arrival and the shared live
  // interval instead of a fixed short loop.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useLiveRefresh(() => void refresh(), { key: threadRef.environmentId });
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
  const workerThread = (item: AssistantOverview["assignments"][number] | undefined) =>
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
              const label = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{idea.goal || idea.ideaId}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {projectName(idea.projectId)}
                    </p>
                  </div>
                  {idea.priority !== null ? (
                    <Badge variant="secondary" size="sm">
                      P{idea.priority}
                    </Badge>
                  ) : null}
                </>
              );
              return threadId ? (
                <button
                  key={`${idea.projectId}:${idea.ideaId}`}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  aria-label={`Open work for ${idea.goal || idea.ideaId}`}
                  onClick={() => openWorker(threadId, close)}
                >
                  {label}
                  <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ) : (
                <details key={`${idea.projectId}:${idea.ideaId}`} className="group/idea py-2">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-open/idea:rotate-90" />
                    {label}
                  </summary>
                  <div className="space-y-2 px-2 pb-1 text-sm">
                    <Badge variant={idea.authorized ? "success" : "secondary"} size="sm">
                      {idea.authorized ? "Approved" : "Draft"}
                    </Badge>
                    {idea.priorityReason ? (
                      <p className="text-xs text-muted-foreground">{idea.priorityReason}</p>
                    ) : null}
                    {capture ? (
                      <p className="text-xs text-muted-foreground">{capture.text}</p>
                    ) : null}
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
                    <p className="text-xs text-muted-foreground">
                      No worker conversation yet. Continue this idea with the assistant.
                    </p>
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
              const label = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{item.goal}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {projectName(item.projectId)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      item.state === "completed"
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
                    {statusLabels[item.state] ?? item.state}
                  </Badge>
                </>
              );
              const actions = assignmentActions(item);
              const row = factoryAssignmentRow(item, threadRef.environmentId);
              return (
                <div key={item.assignmentId} className="flex items-start gap-1 py-1">
                  {row ? (
                    <div className="min-w-0 flex-1 space-y-1 px-2 py-2 text-sm">
                      <div className="flex items-center gap-2">{label}</div>
                      {row.delivery ? (
                        <p className="text-xs text-muted-foreground">{row.delivery}</p>
                      ) : null}
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
                      aria-label={`Open work: ${item.goal}`}
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
                              aria-label={`Manage work: ${item.goal}`}
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
                              onClick={async () => {
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
                              }}
                            >
                              {
                                {
                                  stop: "Stop",
                                  resume: "Resume",
                                  retry: "Retry",
                                  cancel: "Cancel",
                                }[action]
                              }
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
