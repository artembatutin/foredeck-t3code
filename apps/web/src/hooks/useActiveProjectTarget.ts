import { useRepositoryWorkspace } from "../fd/multirepo";
import type { RepositoryFileScope } from "@t3tools/client-runtime/fd/multirepo";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useProjects } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repositoryScope?: RepositoryFileScope;
  readonly repositoryWorkspace: ReturnType<typeof useRepositoryWorkspace>;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const workspace = useRepositoryWorkspace(project ?? null, activeThread);
  const cwd = thread?.worktreePath ?? workspace.cwd;
  const repositoryScope =
    !thread?.worktreePath && workspace.selected && workspace.repositoryTarget
      ? { repository: workspace.selected, target: workspace.repositoryTarget }
      : undefined;

  if (!thread || !threadId || !project || !cwd) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: repositoryScope
      ? `${project.title} / ${repositoryScope.repository.name}`
      : project.title,
    ...(repositoryScope ? { repositoryScope } : {}),
    repositoryWorkspace: workspace,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
  };
}
