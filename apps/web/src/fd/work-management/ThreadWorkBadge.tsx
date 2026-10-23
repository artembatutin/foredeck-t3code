import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useThreadWorkLinks, useWorkReadable } from "./state";

/** A thread row's linked Work items, read from one environment-wide links query. */
export function ThreadWorkBadge({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const readable = useWorkReadable(environmentId);
  const links = useThreadWorkLinks(environmentId, threadId, readable);
  if (links.length === 0) return null;
  const first = links[0]!;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Linked work: ${links.map((link) => link.snapshot.key).join(", ")}`}
            className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs"
          />
        }
      >
        <ListChecksIcon aria-hidden className="size-3.5" />
        {links.length === 1 ? first.snapshot.key : links.length}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {links.map((link) => `${link.snapshot.key}: ${link.snapshot.title}`).join("\n")}
      </TooltipPopup>
    </Tooltip>
  );
}
