import { workLinkCandidates } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { workCommandError } from "./shared";
import { workCommands } from "./state";

/** Picks a thread of the item's project to link; the Work page has no current thread. */
export function LinkThreadDialog({
  open,
  environmentId,
  projectId,
  itemRef,
  linkedThreadIds,
  onOpenChange,
}: {
  open: boolean;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemRef: WorkItemRef;
  linkedThreadIds: ReadonlyArray<ThreadId>;
  onOpenChange: (open: boolean) => void;
}) {
  const shells = useThreadShells(open);
  const setLink = useAtomCommand(workCommands.setLink);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const candidates = useMemo(
    () => workLinkCandidates(shells, { environmentId, projectId, linked: linkedThreadIds, query }),
    [environmentId, linkedThreadIds, projectId, query, shells],
  );

  const link = async (threadId: ThreadId) => {
    setPending(true);
    const result = await setLink({
      environmentId,
      input: { ref: itemRef, threadId, action: "link" },
    });
    setPending(false);
    if (result._tag === "Success") onOpenChange(false);
    else setError(workCommandError(result));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link to a thread</DialogTitle>
          <DialogDescription>Choose a thread in this project.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <Input
              aria-label="Search threads"
              placeholder="Search threads"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul className="max-h-72 space-y-0.5 overflow-y-auto">
              {candidates.map((shell) => (
                <li key={shell.id}>
                  <button
                    type="button"
                    disabled={pending}
                    className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => void link(shell.id)}
                  >
                    {shell.title}
                  </button>
                </li>
              ))}
              {candidates.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground text-sm">No matching threads.</li>
              ) : null}
            </ul>
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
