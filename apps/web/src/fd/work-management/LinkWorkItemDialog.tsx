import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { WorkItemSummary, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkStatusBadge, workCommandError } from "./shared";
import { useWorkReadable, useWorkWritable, workCommands, workEnvironment } from "./state";

/**
 * Which thread has the link-work-item dialog open. Set by any entry point (palette, thread
 * details) and rendered once by the chat view, so it outlives a palette that closes on run.
 */
const linkWorkItemThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("work:link-dialog-thread"),
);

export function openLinkWorkItemDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkWorkItemThreadAtom, threadRef);
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkWorkItemDialogHost() {
  const threadRef = useAtomValue(linkWorkItemThreadAtom);
  const thread = useThreadShell(threadRef);
  const readable = useWorkReadable(threadRef?.environmentId ?? null);
  if (threadRef === null || thread === null || !readable) return null;
  return (
    <LinkWorkItemDialog
      threadRef={threadRef}
      projectId={thread.projectId}
      onClose={() => appAtomRegistry.set(linkWorkItemThreadAtom, null)}
    />
  );
}

function LinkWorkItemDialog({
  threadRef,
  projectId,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  projectId: string;
  onClose: () => void;
}) {
  const environmentId = threadRef.environmentId;
  const sources = useEnvironmentQuery(
    workEnvironment.sources({
      environmentId,
      input: { projectId: projectId as never, includeDisconnected: false },
    }),
  );
  const available = sources.data?.sources ?? [];
  const [sourceId, setSourceId] = useState<WorkSourceId | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const setLink = useAtomCommand(workCommands.setLink);
  const canLink = useWorkWritable(environmentId, workCommands.setLink, "links");
  const selected = sourceId ?? available[0]?.sourceId ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = useEnvironmentQuery(
    selected === null
      ? null
      : workEnvironment.list({
          environmentId,
          input: {
            sourceId: selected,
            limit: 30,
            ...(debounced.length === 0 ? {} : { search: debounced }),
          },
        }),
  );

  const link = async (item: WorkItemSummary) => {
    setPending(true);
    const result = await setLink({
      environmentId,
      input: { ref: item.ref, threadId: threadRef.threadId, action: "link" },
    });
    setPending(false);
    if (result._tag === "Success") onClose();
    else setError(workCommandError(result));
  };

  return (
    <Dialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link work item</DialogTitle>
          <DialogDescription>Attach a Work item of this project to the thread.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            {available.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {sources.isPending ? "Loading sources..." : "This project has no Work sources."}
              </p>
            ) : (
              <div className="flex gap-2">
                {available.length > 1 ? (
                  <Select
                    value={selected}
                    onValueChange={(value) => setSourceId(value as WorkSourceId)}
                  >
                    <SelectTrigger aria-label="Work source" className="w-44" size="sm">
                      <SelectValue>
                        {available.find((source) => source.sourceId === selected)?.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {available.map((source) => (
                        <SelectItem key={source.sourceId} value={source.sourceId}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Search items"
                    placeholder="Search items"
                    value={search}
                    autoFocus
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              </div>
            )}
            <ul className="max-h-72 space-y-0.5 overflow-y-auto">
              {(list.data?.items ?? []).map((item) => (
                <li key={item.ref.itemId}>
                  <button
                    type="button"
                    disabled={pending || !canLink}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => void link(item)}
                  >
                    <span className="shrink-0 text-muted-foreground text-xs">{item.key}</span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <WorkStatusBadge status={item.status} />
                  </button>
                </li>
              ))}
            </ul>
            {!canLink ? (
              <p className="text-muted-foreground text-xs">
                This connection cannot link Work items right now.
              </p>
            ) : null}
            {list.error ? <p className="text-destructive text-xs">{list.error}</p> : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
