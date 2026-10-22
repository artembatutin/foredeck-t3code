import type { OrchestrationProjectShell } from "@t3tools/contracts";

/** Reuse remote-request discovery for each configured checkout without changing project identity. */
export function projectCheckouts(
  project: OrchestrationProjectShell,
): readonly OrchestrationProjectShell[] {
  if ((project.repositories?.length ?? 0) < 2) return [project];
  return project.repositories!.map((repository, index) => ({
    ...project,
    workspaceRoot: repository.rootPath,
    title: `${project.title} · ${repository.name}`,
    repositoryIdentity: index === 0 ? project.repositoryIdentity : undefined,
  }));
}
