import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { AssistantOverview, ScopedThreadRef } from "@t3tools/contracts";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { readOverview, controlAssignment } from "./commands";

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
  return (
    <section
      aria-label="Assistant memory and work"
      className="border-b border-border px-4 py-2 text-sm"
    >
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Persistent assistant ·{" "}
          {
            work.filter((w) =>
              ["running", "launching", "stopping", "launch-uncertain"].includes(w.state),
            ).length
          }{" "}
          active · {work.filter((w) => w.state === "queued").length} queued ·{" "}
          {work.filter((w) => w.state === "needs-input").length} need input ·{" "}
          {work.filter((w) => w.state === "awaiting-verification").length} to verify
        </summary>
        <p className="my-2 text-xs text-muted-foreground">
          Your discussion and ideas are saved on this environment. Workers continue while its host
          server runs, even when you leave this conversation or disconnect. Closing the desktop host
          can stop its server. A stopped host cannot execute; restarting reconciles saved
          identities.
        </p>
        {error ? (
          <p role="status">
            Work status is unavailable. Reconnect to refresh; saved work has not been cancelled.
          </p>
        ) : null}
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {snapshot?.ideas.map((idea) => (
            <details key={`${idea.projectId}:${idea.ideaId}`}>
              <summary className="cursor-pointer">
                {projectName(idea.projectId)} · {idea.goal || idea.ideaId} ·{" "}
                {idea.authorized ? "Authorized" : "Discussion"} · Priority{" "}
                {idea.priority ?? "unset"}
              </summary>
              <p>{idea.priorityReason}</p>
              <pre className="whitespace-pre-wrap text-xs">{idea.brief}</pre>
              <p className="text-xs text-muted-foreground">
                To correct this idea, refer to “{idea.ideaId}” in the conversation.
              </p>
            </details>
          ))}
          {work.map((item) => (
            <details key={item.assignmentId}>
              <summary className="cursor-pointer">
                {projectName(item.projectId)} · {item.goal} · {item.state.replaceAll("-", " ")}
              </summary>
              <p className="my-1">{item.notice}</p>
              <pre className="whitespace-pre-wrap text-xs">{item.brief}</pre>
              <p className="text-xs text-muted-foreground">
                {item.assignmentId} · {item.ideaId} · attempt {item.attempt} · run{" "}
                {item.runId ?? "unconfirmed"}
              </p>
              {[...new Set(item.evidence)].map((e) => (
                <p key={e} className="text-xs">
                  {e}
                </p>
              ))}
              <div className="my-2 flex flex-wrap items-center gap-2">
                {item.threadId ? (
                  <a
                    className="underline"
                    href={`/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(item.threadId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Inspect worker in another tab
                  </a>
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
                      variant="outline"
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
                      {action}
                    </Button>
                  ))}
              </div>
            </details>
          ))}
        </div>
      </details>
      {snapshot?.ideas.length === 0 ? (
        <p className="mt-1 text-muted-foreground">
          What would you like to explore? Nothing starts until you approve its scope.
        </p>
      ) : null}
    </section>
  );
}
