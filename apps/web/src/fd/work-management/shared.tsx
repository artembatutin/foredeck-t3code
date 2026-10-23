import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { WorkSourceKind, WorkStatus } from "@t3tools/contracts/fd/work-management";
import { FileTextIcon, GithubIcon, TicketIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";

export const STATUS_LABELS: Record<WorkStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

const STATUS_VARIANTS: Record<
  WorkStatus,
  "outline" | "info" | "success" | "secondary" | "warning"
> = {
  todo: "outline",
  in_progress: "info",
  done: "success",
  cancelled: "secondary",
  unknown: "warning",
};

export function WorkStatusBadge({ status, label }: { status: WorkStatus; label?: string }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{label ?? STATUS_LABELS[status]}</Badge>;
}

export const SOURCE_KIND_LABELS: Record<WorkSourceKind, string> = {
  markdown: "Markdown",
  github: "GitHub",
  jira: "Jira",
};

export function WorkSourceGlyph({ kind, className }: { kind: WorkSourceKind; className?: string }) {
  const Icon = kind === "github" ? GithubIcon : kind === "jira" ? TicketIcon : FileTextIcon;
  return <Icon aria-label={SOURCE_KIND_LABELS[kind]} className={className ?? "size-4 shrink-0"} />;
}

/** The message a failed Work command shows: the server's own text, never a stack. */
export function workCommandError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Work request failed.";
}

/** Shown where a session paired before Work cannot read it; passive surfaces show nothing. */
export function WorkRepairNotice() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This connection cannot read Work</EmptyTitle>
        <EmptyDescription>
          It was paired before Work existed. Pair this device again from a session that has Work
          access to grant it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
