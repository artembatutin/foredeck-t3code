import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useState } from "react";
import { ChangedFilesCard } from "../../components/chat/ChangedFilesTree";
import { Button } from "../../components/ui/button";
import { useFileContextMenuHandler } from "../../fileContextMenu";

/** Same-turn snapshots stay grouped by their immutable checkout identity. */
export function RepositoryChangedFiles(props: {
  summary: ThreadCheckpointSummary;
  environmentId: EnvironmentId | null;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (runId: RunId, filePath?: string, repositoryId?: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const onFileContextMenu = useFileContextMenuHandler(props.environmentId);
  return (
    <div className="mt-4 space-y-3" aria-label="Changed files by repository">
      {props.summary.repositoryGroups?.map(({ repository, available, message, files }) => (
        <section key={repository.id}>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => props.onOpenTurnDiff(props.summary.runId, undefined, repository.id)}
            >
              {repository.name}
            </Button>
            <span
              className={available ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
            >
              {message}
            </span>
          </div>
          {available && files.length > 0 ? (
            <ChangedFilesCard
              runId={props.summary.runId}
              files={files}
              allDirectoriesExpanded={expanded[repository.id] ?? false}
              resolvedTheme={props.resolvedTheme}
              onToggleAllDirectories={() =>
                setExpanded((current) => ({ ...current, [repository.id]: !current[repository.id] }))
              }
              onOpenTurnDiff={(runId, filePath) =>
                props.onOpenTurnDiff(runId, filePath, repository.id)
              }
              onFileContextMenu={(filePath, event) =>
                onFileContextMenu(
                  {
                    environmentId: props.environmentId,
                    filePath,
                    workspaceRoot: repository.rootPath,
                    repositoryRoot: repository.rootPath,
                  },
                  event,
                )
              }
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}
