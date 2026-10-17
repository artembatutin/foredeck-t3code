import {
  repositoryWorkspace,
  resolveRepositoryFileReference,
} from "@t3tools/client-runtime/fd/multirepo";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useProject, useThreadShell } from "../../state/entities";
import { useRepositoryWorkspace } from "./useRepositoryWorkspace";

interface FileRouteWorkspace {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
  readonly projectId?: string | string[];
  readonly repositoryId?: string | string[];
  readonly cwd?: string | string[];
  readonly projectName?: string | string[];
}

const first = (value: string | string[] | undefined) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim() ? candidate : null;
};

export function useRepositoryFileWorkspace(
  params: FileRouteWorkspace,
  requestedPath?: string | null,
) {
  const environment = first(params.environmentId);
  const thread = first(params.threadId);
  const projectId = first(params.projectId);
  const repositoryId = first(params.repositoryId);
  const environmentId = environment === null ? null : EnvironmentId.make(environment);
  const threadId = thread === null ? null : ThreadId.make(thread);
  const selectedThread = useThreadShell(
    environmentId && threadId ? { environmentId, threadId } : null,
  );
  const project = useProject(
    environmentId && (selectedThread || projectId)
      ? { environmentId, projectId: selectedThread?.projectId ?? ProjectId.make(projectId!) }
      : null,
  );
  const draftWorktreePath =
    !selectedThread && !repositoryId && first(params.cwd) !== project?.workspaceRoot
      ? first(params.cwd)
      : null;
  const workspace = useRepositoryWorkspace(project, selectedThread, draftWorktreePath);
  const file = useMemo(
    () =>
      requestedPath == null
        ? null
        : draftWorktreePath
          ? { path: requestedPath }
          : repositoryId
            ? { path: requestedPath }
            : resolveRepositoryFileReference(project, selectedThread, requestedPath),
    [project, selectedThread, requestedPath, repositoryId, draftWorktreePath],
  );
  const explicitWorkspace = useMemo(
    () => (repositoryId ? repositoryWorkspace(project, selectedThread, repositoryId) : null),
    [project, selectedThread, repositoryId],
  );
  const target =
    explicitWorkspace?.repositoryTarget ??
    file?.scope?.target ??
    (file === null ? workspace.repositoryTarget : undefined);
  const repository =
    explicitWorkspace?.selected ??
    file?.scope?.repository ??
    (file === null ? workspace.selected : null);
  const cwd = repositoryId
    ? (explicitWorkspace?.cwd ?? null)
    : (repository?.rootPath ??
      selectedThread?.worktreePath ??
      selectedThread?.workspaceBinding?.defaultCwd ??
      first(params.cwd) ??
      project?.workspaceRoot ??
      null);
  return {
    cwd,
    environmentId,
    threadId,
    selectedThread,
    projectId: project?.id,
    projectName: repository?.name ?? first(params.projectName) ?? project?.title ?? "Files",
    repositoryTarget: target,
    repositoryId: repository?.id,
    repositoryWorkspace: workspace,
    relativePath: file?.path ?? requestedPath ?? null,
  };
}
