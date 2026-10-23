import type { EnvironmentId } from "@t3tools/contracts";
import type { WorkItemSummary, WorkSource } from "@t3tools/contracts/fd/work-management";
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
import { Textarea } from "../../components/ui/textarea";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { workCommandError } from "./shared";
import { workCommands } from "./state";

/** Creates an item in one source; cancel the item later instead of deleting it. */
export function CreateWorkItemDialog({
  environmentId,
  source,
  onOpenChange,
  onCreated,
}: {
  environmentId: EnvironmentId;
  source: WorkSource | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (item: WorkItemSummary) => void;
}) {
  const create = useAtomCommand(workCommands.createItem);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [requestId, setRequestId] = useState(() => randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source === null) return;
    setTitle("");
    setBody("");
    setLabels("");
    setError(null);
    setRequestId(randomUUID());
  }, [source]);

  const submit = async () => {
    if (source === null || title.trim().length === 0) return;
    setPending(true);
    const parsedLabels = labels
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const result = await create({
      environmentId,
      input: {
        sourceId: source.sourceId,
        title: title.trim(),
        ...(body.trim().length === 0 ? {} : { body }),
        ...(parsedLabels.length === 0 ? {} : { labels: parsedLabels }),
        // Reused on retry so a lost response cannot create the item twice.
        clientRequestId: requestId,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onOpenChange(false);
      onCreated(result.value);
    } else setError(workCommandError(result));
  };

  return (
    <Dialog
      open={source !== null}
      onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New work item</DialogTitle>
          <DialogDescription>In {source?.label}.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <Input
              aria-label="Title"
              placeholder="Title"
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="Description"
              placeholder="Description (Markdown)"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            {source?.capabilities.fields.includes("labels") ? (
              <Input
                aria-label="Labels"
                placeholder="Labels, comma-separated"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
              />
            ) : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending || title.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
