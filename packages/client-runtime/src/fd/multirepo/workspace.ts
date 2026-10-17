import type {
  EnvironmentId,
  ProjectId,
  ProjectRepository,
  RepositoryTarget,
  ThreadId,
  ThreadWorkspaceBinding,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export interface RepositoryProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly repositories?: readonly ProjectRepository[] | undefined;
}

export interface RepositoryThread {
  readonly id: ThreadId;
  readonly worktreePath: string | null;
  readonly workspaceBinding?: ThreadWorkspaceBinding | undefined;
}

const EMPTY_REPOSITORIES: readonly ProjectRepository[] = [];

export const repositorySelectionAtom = Atom.family((key: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`repository-selection:${key}`),
  ),
);

export function repositoryWorkspaceKey(
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
) {
  return JSON.stringify([
    project?.environmentId,
    thread ? "thread" : "project",
    thread?.id ?? project?.id,
  ]);
}

/** Bound conversations never inherit newly added repositories from project settings. */
export function repositoryWorkspace(
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
  selectedId: string | null,
  draftWorktreePath?: string | null,
) {
  const bindingRepositories = thread
    ? thread.workspaceBinding?.repositories
    : project?.repositories;
  const worktreePath = thread?.worktreePath ?? draftWorktreePath;
  const repositories =
    !worktreePath && (bindingRepositories?.length ?? 0) > 1
      ? bindingRepositories!
      : EMPTY_REPOSITORIES;
  const selected =
    selectedId === null ? repositories[0] : repositories.find((entry) => entry.id === selectedId);
  const repositoryTarget: RepositoryTarget | undefined =
    selected && project
      ? thread?.workspaceBinding
        ? { type: "thread", threadId: thread.id, repositoryId: selected.id }
        : { type: "project", projectId: project.id, repositoryId: selected.id }
      : undefined;
  return {
    repositories,
    selected: selected ?? null,
    repositoryTarget,
    isMultiRepository: repositories.length > 1,
    // An obsolete explicit selection must not silently open the primary checkout.
    cwd:
      repositories.length > 0
        ? (selected?.rootPath ?? null)
        : (worktreePath ?? thread?.workspaceBinding?.defaultCwd ?? project?.workspaceRoot ?? null),
  };
}
