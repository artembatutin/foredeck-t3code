import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Separator } from "../../components/ui/separator";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * The row the fd list pages (Work, Factory) share, in the pull request list's geometry: a glyph
 * column, then two lines. The first holds the reference, the title, quiet signals after it and the
 * status at the right edge; the second holds what the row belongs to, with the time at the right.
 */
export function FdListRow({
  glyph,
  reference,
  title,
  signals,
  status,
  meta,
  updatedAt,
  selected = false,
  onSelect,
}: {
  glyph: ReactNode;
  /** The item's key or id, set in the monospace the pull request numbers use. */
  reference?: ReactNode;
  title: ReactNode;
  /** Right after the title: labels and small state badges. */
  signals?: ReactNode;
  /** Right end of the first line: the status badge. */
  status?: ReactNode;
  /** Left of the second line: source, project, stage. */
  meta?: ReactNode;
  updatedAt?: string | null | undefined;
  selected?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="mt-0.75 flex w-4 shrink-0 justify-center self-start text-muted-foreground">
        {glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {reference ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {reference}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-sm">{title}</span>
          {signals ? <span className="flex shrink-0 items-center gap-1">{signals}</span> : null}
          {status ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{status}</span>
          ) : null}
        </span>
        {meta || updatedAt ? (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
            <span className="min-w-0 truncate">{meta}</span>
            {updatedAt ? (
              <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
                {formatRelativeTimeLabel(updatedAt)}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A relative time ("5m ago"), machine-readable through its `dateTime`. */
export function FdRelativeTime({ at, className }: { at: string; className?: string }) {
  return (
    <time dateTime={at} className={cn("shrink-0 whitespace-nowrap tabular-nums", className)}>
      {formatRelativeTimeLabel(at)}
    </time>
  );
}

/** A group's glyph, name and count, then a rule to the edge, as the pull request list groups. */
export function FdListGroupHeader({
  icon: Icon,
  label,
  count,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{label}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{count}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

/** The first load, drawn in the rows' own geometry so the list does not jump when it lands. */
export function FdListGhost({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="space-y-0.5" aria-busy aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2 px-3 py-2.5">
          <Skeleton className="mt-0.5 size-4" shape="pill" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-3/5" : "w-2/5")} />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
