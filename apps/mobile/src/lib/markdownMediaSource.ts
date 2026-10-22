import type { RepositoryTarget } from "@t3tools/contracts";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";

/** A project draft names its workspace explicitly because it has no thread. */
export function resolveMobileMarkdownMediaSource(
  href: string,
  input: ResolveMediaSourceInput & { readonly repositoryTarget?: RepositoryTarget | undefined },
) {
  const media = resolveMediaSource(href, input);
  if (input.repositoryTarget && media && media.access !== "direct") {
    const source = classifyMarkdownImageSource(href, input.workspaceRoot);
    if (source._tag === "WorkspaceFile")
      return {
        ...media,
        access: "environment" as const,
        resource: {
          _tag: "repository-file" as const,
          repositoryTarget: input.repositoryTarget,
          path: source.path,
        },
      };
  }
  if (media?.access !== "unavailable" || !input.workspaceRoot) return media;
  const source = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (source._tag !== "WorkspaceFile") return media;
  return {
    ...media,
    access: "environment" as const,
    resource: {
      _tag: "draft-workspace-file" as const,
      cwd: input.workspaceRoot,
      path: source.path,
    },
  };
}
