import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type WorkThreadLink, workItemRefString } from "@t3tools/contracts/fd/work-management";
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
  return (
    <LinkedWorkRows environmentId={environmentId} threadId={threadId} projectId={shell.projectId} />
  );
}

function LinkedWorkRows({
  environmentId,
  threadId,
  projectId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(workEnvironment.links({ environmentId, input: { threadId } }));
  const setLink = useAtomCommand(workCommands.setLink);
  const canWrite = useWorkWritable(environmentId, workCommands.setLink, "links");
  const links = query.data?.links ?? [];
  const open = (link: WorkThreadLink) =>
    void navigate({
      to: "/work",
      search: {
        project: scopedProjectKey(scopeProjectRef(environmentId, projectId)),
        item: workItemRefString(link.ref),
      } as never,
    });
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
          {links.map((link) => (
            <li key={workItemRefString(link.ref)} className="flex items-center gap-1">
              <ThreadDetailsControl onClick={() => open(link)} className="min-w-0 flex-1">
                <ListChecksIcon aria-hidden className="size-4 shrink-0" />
                <span className="shrink-0 text-muted-foreground text-xs">{link.snapshot.key}</span>
                <span className="min-w-0 truncate">{link.snapshot.title}</span>
                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                  {STATUS_LABELS[link.snapshot.status]}
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
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
}
