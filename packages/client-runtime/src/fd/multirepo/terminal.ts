import type { RepositoryTarget } from "@t3tools/contracts";
import { resolveRepositoryFileReference } from "./fileReference.ts";
import { repositoryWorkspace, type RepositoryProject, type RepositoryThread } from "./workspace.ts";

/** Resolve the launch directory, never the repository selected later in the UI. */
export function withRepositoryTerminalTarget<
  T extends {
    readonly cwd?: string | undefined;
    readonly repositoryTarget?: RepositoryTarget | undefined;
  },
>(
  input: T,
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
): T & { readonly repositoryTarget?: RepositoryTarget | undefined } {
  if (input.repositoryTarget || !input.cwd) return input;
  const target = resolveRepositoryFileReference(project, thread, input.cwd).scope?.target;
  return target ? { ...input, repositoryTarget: target } : input;
}

export function repositoryTerminalLabel(
  label: string,
  cwd: string | undefined,
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
) {
  if (!cwd || !repositoryWorkspace(project, thread, null).isMultiRepository) return label;
  const repository = resolveRepositoryFileReference(project, thread, cwd).scope?.repository;
  return repository ? `${repository.name} · ${label}` : label;
}
