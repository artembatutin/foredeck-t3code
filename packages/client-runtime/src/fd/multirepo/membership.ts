import type { OrchestrationProjectShell, ProjectRepositoryInputs } from "@t3tools/contracts";

/** The primary entry retains the existing working directory, including a subdirectory. */
export function repositoryDraft(
  project: Pick<OrchestrationProjectShell, "repositories" | "workspaceRoot" | "title">,
): ProjectRepositoryInputs {
  return project.repositories?.length
    ? project.repositories.map((repository) => ({ ...repository }))
    : [{ name: project.title, rootPath: project.workspaceRoot }];
}

export const repositoryMembershipHelp =
  "Add existing Git checkouts on this environment. New conversations use this list; existing conversations keep their saved repositories. Removing an entry keeps its files. Multiple repositories share their checkouts and disable worktrees and whole-turn undo.";

export function validRepositoryDraft(repositories: ProjectRepositoryInputs) {
  return (
    repositories.length > 0 &&
    repositories.length <= 16 &&
    repositories.every(
      (repository) => repository.name.trim().length > 0 && repository.rootPath.trim().length > 0,
    )
  );
}
