import { withRepositoryTerminalTarget } from "@t3tools/client-runtime/fd/multirepo";
import { ThreadId, type EnvironmentId, type TerminalAttachInput } from "@t3tools/contracts";
import { useCallback } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readProject, readThreadShell } from "../../state/entities";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";

export function repositoryTerminalInput<T extends TerminalAttachInput>(
  environmentId: EnvironmentId,
  input: T,
): T {
  const ref = { environmentId, threadId: ThreadId.make(input.threadId) };
  const thread = readThreadShell(ref);
  const draft = thread ? null : useComposerDraftStore.getState().getDraftThreadByRef(ref);
  const projectId = thread?.projectId ?? draft?.projectId;
  const project = projectId ? readProject({ environmentId, projectId }) : null;
  return withRepositoryTerminalTarget(
    input,
    project,
    thread ?? (draft?.worktreePath ? { id: ref.threadId, worktreePath: draft.worktreePath } : null),
  );
}

export function useRepositoryTerminalOpen() {
  const open = useAtomCommand(terminalEnvironment.open, "terminal open");
  return useCallback(
    (value: Parameters<typeof open>[0]) =>
      open({
        ...value,
        input: repositoryTerminalInput(value.environmentId, value.input),
      }),
    [open],
  );
}
