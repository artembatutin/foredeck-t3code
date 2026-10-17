import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  repositorySelectionAtom,
  repositoryWorkspace,
  repositoryWorkspaceKey,
  type RepositoryProject,
  type RepositoryThread,
} from "@t3tools/client-runtime/fd/multirepo";
import { useMemo } from "react";

export function useRepositoryWorkspace(
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
  draftWorktreePath?: string | null,
) {
  const atom = repositorySelectionAtom(repositoryWorkspaceKey(project, thread));
  const selectedId = useAtomValue(atom);
  const selectRepository = useAtomSet(atom);
  return useMemo(
    () => ({
      ...repositoryWorkspace(project, thread, selectedId, draftWorktreePath),
      selectRepository,
    }),
    [project, thread, selectedId, selectRepository, draftWorktreePath],
  );
}
