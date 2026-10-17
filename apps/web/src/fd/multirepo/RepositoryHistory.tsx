import { repositoryHistoryGroups } from "@t3tools/client-runtime/fd/multirepo";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";

export function RepositoryHistory({
  projection,
  runId,
  selectedId,
  onSelect,
}: {
  projection: OrchestrationV2ThreadProjection;
  runId: RunId | null;
  selectedId: string | undefined;
  onSelect: (repositoryId: string) => void;
}) {
  const history = repositoryHistoryGroups(projection, runId);
  if (history.groups.length < 2) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {runId === null ? "Conversation snapshots" : `Turn ${history.toTurnCount} snapshots`} ·
        select a repository to read its diff
      </p>
      <div
        className="flex gap-3 overflow-x-auto"
        role="tablist"
        aria-label="Historical repository groups"
      >
        {history.groups.map(({ repository, available, message }) => (
          <div key={repository.id} className="min-w-40 space-y-1">
            <Button
              size="xs"
              variant={selectedId === repository.id ? "secondary" : "ghost"}
              role="tab"
              aria-selected={selectedId === repository.id}
              onClick={() => onSelect(repository.id)}
            >
              {repository.name}
            </Button>
            <p className={available ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
              {message}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
