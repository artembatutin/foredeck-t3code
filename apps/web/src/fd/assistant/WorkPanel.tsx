import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { AssistantOverview, ScopedThreadRef } from "@t3tools/contracts";
import {
  BriefcaseBusinessIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  LightbulbIcon,
  WifiOffIcon,
} from "lucide-react";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
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

function WorkPopover({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" size="xs" variant="ghost" />}>
        {icon}
        {title}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </PopoverTrigger>
      <PopoverPopup width="lg" side="top" align="start" padding="compact">
        <div className="py-1">
          <PopoverTitle>{title}</PopoverTitle>
        </div>
        <div className="max-h-80 divide-y divide-border overflow-y-auto">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}

export function WorkPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const read = useAtomCommand(readOverview, { reportFailure: false });
  const control = useAtomCommand(controlAssignment);
  const allowed = useAtomValue(controlAssignment.permissionAtom(threadRef.environmentId));
  const projects = useProjects();
  const [snapshot, setSnapshot] = useState<AssistantOverview | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await read({ environmentId: threadRef.environmentId, input: {} });
      if (!alive) return;
      setError(result._tag === "Failure");
      if (result._tag === "Success") setSnapshot(result.value);
      timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [read, threadRef.environmentId]);
  const projectName = (id: string) =>
    projects.find((p) => p.id === id && p.environmentId === threadRef.environmentId)?.title ?? id;
  const work = snapshot?.assignments ?? [];
  const ideas = snapshot?.ideas ?? [];
  if (!ideas.length && !work.length && !error) return null;

  return (
    <section aria-label="Ideas and work" className="flex flex-wrap items-center gap-1 px-3 pt-2">
      {ideas.length > 0 ? (
        <WorkPopover title="Ideas" count={ideas.length} icon={<LightbulbIcon />}>
          {ideas.map((idea) => (
            <details key={`${idea.projectId}:${idea.ideaId}`} className="group/idea py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-open/idea:rotate-90" />
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
              </summary>
              <div className="space-y-2 pb-1 pl-5 text-sm">
                <Badge variant={idea.authorized ? "success" : "secondary"} size="sm">
                  {idea.authorized ? "Approved" : "Draft"}
                </Badge>
                {idea.priorityReason ? (
                  <p className="text-xs text-muted-foreground">{idea.priorityReason}</p>
                ) : null}
                <p className="whitespace-pre-wrap text-sm">{idea.brief}</p>
              </div>
            </details>
          ))}
        </WorkPopover>
      ) : null}
      {work.length > 0 ? (
        <WorkPopover title="Work" count={work.length} icon={<BriefcaseBusinessIcon />}>
          {work.map((item) => (
            <details key={item.assignmentId} className="group/work py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-open/work:rotate-90" />
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
              </summary>
              <div className="space-y-3 pb-1 pl-5 text-sm">
                {item.notice ? <p>{item.notice}</p> : null}
                <p className="whitespace-pre-wrap">{item.brief}</p>
                {item.evidence.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Evidence</p>
                    {[...new Set(item.evidence)].map((e) => (
                      <p key={e} className="text-xs">
                        {e}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {item.threadId ? (
                    <Button
                      size="xs"
                      variant="outline"
                      render={
                        <a
                          href={`/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(item.threadId)}`}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      <ExternalLinkIcon />
                      Open worker
                    </Button>
                  ) : null}
                  {(["stop", "resume", "retry", "cancel"] as const)
                    .filter((action) =>
                      action === "stop"
                        ? ["running", "needs-input"].includes(item.state)
                        : action === "resume"
                          ? item.state === "stopped"
                          : action === "retry"
                            ? item.state === "failed"
                            : [
                                "queued",
                                "running",
                                "needs-input",
                                "stopped",
                                "failed",
                                "awaiting-verification",
                              ].includes(item.state),
                    )
                    .map((action) => (
                      <Button
                        key={action}
                        size="xs"
                        variant="ghost"
                        disabled={!allowed || busy !== null}
                        onClick={async () => {
                          setBusy(item.assignmentId);
                          try {
                            await control({
                              environmentId: threadRef.environmentId,
                              input: {
                                assignmentId: item.assignmentId,
                                managerThreadId: threadRef.threadId,
                                action,
                              },
                            });
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        {
                          { stop: "Stop", resume: "Resume", retry: "Retry", cancel: "Cancel" }[
                            action
                          ]
                        }
                      </Button>
                    ))}
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Run details
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
                    <dt>Assignment</dt>
                    <dd>{item.assignmentId}</dd>
                    <dt>Idea</dt>
                    <dd>{item.ideaId}</dd>
                    <dt>Attempt</dt>
                    <dd>{item.attempt}</dd>
                    <dt>Run</dt>
                    <dd>{item.runId ?? "Unconfirmed"}</dd>
                  </dl>
                </details>
              </div>
            </details>
          ))}
        </WorkPopover>
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
