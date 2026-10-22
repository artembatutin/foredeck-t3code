import * as Schema from "effect/Schema";
import { ProjectRepository, RepositoryTarget, type AssetResource } from "@t3tools/contracts";
import { repositoryWorkspace, type RepositoryProject, type RepositoryThread } from "./workspace.ts";

/** Saved with a navigation entry, so changing the active repository cannot retarget it. */
export interface RepositoryFileScope {
  readonly repository: ProjectRepository;
  readonly target: RepositoryTarget;
}

export function repositoryFileSurfaceId(
  path: string,
  scope?: RepositoryFileScope,
): `file:${string}` {
  return scope ? `file:${JSON.stringify([scope.target, path])}` : `file:${path}`;
}

export function repositoryRelativePath(path: string, repository: ProjectRepository): string | null {
  const root = repository.rootPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const candidate = path.replaceAll("\\", "/");
  const insensitive = /^[a-z]:\//i.test(root);
  const comparableRoot = insensitive ? root.toLowerCase() : root;
  const comparablePath = insensitive ? candidate.toLowerCase() : candidate;
  if (comparablePath === comparableRoot) return ".";
  return comparablePath.startsWith(`${comparableRoot}/`) ? candidate.slice(root.length + 1) : null;
}

/** Transcript paths use the immutable default cwd; UI file selections carry an explicit scope. */
export function resolveRepositoryFileReference(
  project: RepositoryProject | null,
  thread: RepositoryThread | null,
  path: string,
): { path: string; scope?: RepositoryFileScope } {
  const workspace = repositoryWorkspace(project, thread, null);
  const absolute = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
  const repository = absolute
    ? workspace.repositories.find((entry) => repositoryRelativePath(path, entry) !== null)
    : workspace.selected;
  if (repository && project) {
    const target = repositoryWorkspace(project, thread, repository.id).repositoryTarget;
    if (target) {
      const defaultCwd = thread?.workspaceBinding?.defaultCwd ?? project.workspaceRoot;
      const prefix = repositoryRelativePath(defaultCwd, repository);
      return {
        path: absolute
          ? repositoryRelativePath(path, repository)!
          : prefix && prefix !== "."
            ? `${prefix}/${path}`
            : path,
        scope: { repository, target },
      };
    }
  }
  // Preserve a scoped request outside the saved set so the server rejects it.
  return {
    path,
    ...(workspace.selected && workspace.repositoryTarget
      ? { scope: { repository: workspace.selected, target: workspace.repositoryTarget } }
      : {}),
  };
}

export const isRepositoryFileScope = Schema.is(
  Schema.Struct({ repository: ProjectRepository, target: RepositoryTarget }),
);

export function scopeRepositoryAssetResource(
  resource: AssetResource,
  target: RepositoryTarget | undefined,
): AssetResource {
  return target &&
    (resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file")
    ? { _tag: "repository-file", repositoryTarget: target, path: resource.path }
    : resource;
}

/** Read a project configuration file below its default cwd using checkout-root authority. */
export function repositoryFileRequest(cwd: string, path: string, scope?: RepositoryFileScope) {
  if (!scope) return { cwd, path, repositoryTarget: undefined };
  const prefix = repositoryRelativePath(cwd, scope.repository);
  return {
    cwd: scope.repository.rootPath,
    path: prefix === "." ? path : `${prefix ?? cwd}/${path}`,
    repositoryTarget: scope.target,
  };
}
