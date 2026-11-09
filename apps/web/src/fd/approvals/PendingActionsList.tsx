import {
  factoryPendingActionDestination,
  factoryPendingActionTarget,
  type FactoryPendingActionsView,
} from "@t3tools/client-runtime/fd/factory";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";

import { Button } from "~/components/ui/button";

/**
 * What a delivery waits on someone for, one place on each surface that follows it. Each row says
 * what kind of decision it is, why it is asked, who asks and where: it decides nothing itself, so
 * opening this list never answers or grants anything.
 */
export function PendingActionsList({
  pending,
  shownItem,
  projectName,
  threadName,
  onOpenThread,
  onOpenItem,
}: {
  readonly pending: FactoryPendingActionsView;
  /** The Work item this surface already shows, whose own delivery is decided right here. */
  readonly shownItem: WorkItemRef | null;
  readonly projectName: (projectId: ProjectId) => string | undefined;
  readonly threadName: (threadId: ThreadId) => string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenItem: (item: WorkItemRef, projectId: ProjectId) => void;
}) {
  if (pending.rows.length === 0 && pending.note === undefined) return null;
  return (
    <div className="space-y-1" role="group" aria-label="Pending actions">
      <p className="font-medium text-xs">Pending actions</p>
      <ul className="space-y-1">
        {pending.rows.map((row) => {
          const destination = factoryPendingActionDestination(row, shownItem);
          return (
            <li key={row.key} className="space-y-0.5 rounded-md border p-2 text-xs">
              <p className="font-medium">{row.label}</p>
              <p className="whitespace-pre-wrap break-words">{row.reason}</p>
              <p className="text-muted-foreground">{row.provenance}</p>
              <p className="text-muted-foreground">
                {factoryPendingActionTarget(row, { project: projectName, thread: threadName })}
              </p>
              {destination.type === "thread" ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenThread(destination.threadId)}
                >
                  Open thread to decide
                </Button>
              ) : destination.type === "item" ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenItem(destination.item, row.projectId)}
                >
                  Open its Work item to decide
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {pending.note === undefined ? null : (
        <p className="text-muted-foreground text-xs">{pending.note}</p>
      )}
    </div>
  );
}
