import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  workItemLinkTarget,
  workItemOwningProject,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon, PlusIcon } from "lucide-react";

import { ThreadDetailsControl } from "../../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { openLinkWorkItemDialog } from "./LinkWorkItemDialog";
import { STATUS_LABELS } from "./shared";
import { useWorkReadable, useWorkWritable, workCommands, workEnvironment } from "./state";

/** The Work items linked to a thread, with the way to open, unlink and link another. */
export function LinkedWorkSection({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const readable = useWorkReadable(environmentId);
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  if (!readable || shell === null) return null;
  return <LinkedWorkRows environmentId={environmentId} threadId={threadId} />;
}

function LinkedWorkRows({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(workEnvironment.links({ environmentId, input: { threadId } }));
  const setLink = useAtomCommand(workCommands.setLink);
  const canWrite = useWorkWritable(environmentId, workCommands.setLink, "links");
  const links = query.data?.links ?? [];
  // Disconnected sources too: a link outlives its source's connection, and still names its project.
  const sourcesQuery = useEnvironmentQuery(
    links.length === 0
      ? null
      : workEnvironment.sources({ environmentId, input: { includeDisconnected: true } }),
  );
  const sources = sourcesQuery.data?.sources ?? [];
  const sourcesRead = sourcesQuery.data !== null || sourcesQuery.error !== null;
  return (
    <ThreadDetailsSection
      headingId={`thread-work-${threadId}`}
      title="Work"
      actions={
        canWrite ? (
          <ThreadDetailsControl
            panel={false}
            size="icon-xs"
            variant="ghost"
            aria-label="Link work item"
            onClick={() => openLinkWorkItemDialog(scopeThreadRef(environmentId, threadId))}
          >
            <PlusIcon />
          </ThreadDetailsControl>
        ) : null
      }
    >
      {links.length === 0 ? (
        <p className="px-2 text-muted-foreground text-xs">No linked work items.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {links.map((link) => {
            const projectId = workItemOwningProject(sources, link.ref);
            return (
              <li key={workItemRefString(link.ref)} className="flex items-center gap-1">
                <ThreadDetailsControl
                  disabled={projectId === undefined}
                  onClick={() => {
                    if (projectId === undefined) return;
                    void navigate(workItemLinkTarget({ environmentId, projectId, ref: link.ref }));
                  }}
                  className="min-w-0 flex-1"
                >
                  <ListChecksIcon aria-hidden className="size-4 shrink-0" />
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {link.snapshot.key}
                  </span>
                  <span className="min-w-0 truncate">{link.snapshot.title}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                    {projectId === undefined && sourcesRead
                      ? "Project unavailable"
                      : STATUS_LABELS[link.snapshot.status]}
                  </span>
                </ThreadDetailsControl>
                {canWrite ? (
                  <ThreadDetailsControl
                    panel={false}
                    size="xs"
                    variant="ghost"
                    tone="muted"
                    onClick={() =>
                      void setLink({
                        environmentId,
                        input: { ref: link.ref, threadId, action: "unlink" },
                      })
                    }
                  >
                    Unlink
                  </ThreadDetailsControl>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}
