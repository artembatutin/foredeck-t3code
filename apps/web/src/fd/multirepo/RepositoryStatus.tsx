import { useState } from "react";
import { type EnvironmentId } from "@t3tools/contracts";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import type { useRepositoryWorkspace } from "./useRepositoryWorkspace";

export function RepositoryStatus({
  environmentId,
  workspace,
  enabled,
}: {
  environmentId: EnvironmentId | null;
  workspace: ReturnType<typeof useRepositoryWorkspace>;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useEnvironmentQuery(
    open && enabled && environmentId && workspace.isMultiRepository && workspace.repositoryTarget
      ? vcsEnvironment.repositoryStatus({
          environmentId,
          input: { repositories: workspace.repositories, target: workspace.repositoryTarget },
        })
      : null,
  );
  if (!workspace.isMultiRepository || !enabled) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        Repository status
      </PopoverTrigger>
      <PopoverPopup>
        <div className="max-h-80 min-w-64 space-y-3 overflow-y-auto p-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Checkout snapshot</span>
            <Button size="xs" variant="ghost" disabled={query.isPending} onClick={query.refresh}>
              Refresh
            </Button>
          </div>
          {query.isPending ? (
            <p className="text-xs text-muted-foreground">Reading repositories…</p>
          ) : null}
          {query.error ? (
            <p role="alert" className="text-xs text-destructive">
              {query.error}
            </p>
          ) : null}
          {query.data?.map(({ repository, status, error }) => (
            <div key={repository.id} className="space-y-1">
              <Button
                size="xs"
                variant="link"
                onClick={() => {
                  workspace.selectRepository(repository.id);
                  setOpen(false);
                }}
              >
                {repository.name}
              </Button>
              {status ? (
                <p className="text-xs text-muted-foreground">
                  {status.branch ?? "Detached HEAD"} · {status.files} changed{" "}
                  {status.files === 1 ? "file" : "files"} · +{status.insertions} −{status.deletions}
                </p>
              ) : (
                <p role="status" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
