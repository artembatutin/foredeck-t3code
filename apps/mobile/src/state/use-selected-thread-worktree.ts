import { useRepositoryWorkspace } from "../fd/multirepo";
import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: selectedThread?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });

  const repositoryWorkspace = useRepositoryWorkspace(selectedThreadProject, selectedThread);
  return {
    repositoryWorkspace,
    repositoryTarget: repositoryWorkspace.repositoryTarget,
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? repositoryWorkspace.cwd,
  };
}
