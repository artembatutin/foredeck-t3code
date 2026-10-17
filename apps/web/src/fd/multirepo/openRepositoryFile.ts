import {
  resolveRepositoryFileReference,
  type RepositoryFileScope,
} from "@t3tools/client-runtime/fd/multirepo";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { readProject, readThreadShell } from "../../state/entities";
import { useRightPanelStore } from "../../rightPanelStore";

/** Unqualified transcript paths use the conversation's default checkout, never a later UI selection. */
export function openRepositoryFile(
  ref: ScopedThreadRef,
  path: string,
  line?: number,
  scope?: RepositoryFileScope,
) {
  if (scope) {
    useRightPanelStore.getState().openFile(ref, path, line, scope);
    return;
  }
  const thread = readThreadShell(ref);
  const project = thread
    ? readProject({ environmentId: ref.environmentId, projectId: thread.projectId })
    : null;
  const resolved = resolveRepositoryFileReference(project, thread, path);
  useRightPanelStore.getState().openFile(ref, resolved.path, line, resolved.scope);
}
