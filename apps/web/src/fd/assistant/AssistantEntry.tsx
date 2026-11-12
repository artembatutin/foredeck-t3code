import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { ASSISTANT_THREAD_PREFIX, isAssistantThread } from "@t3tools/shared/fd/assistant";
import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MessageCircleIcon } from "lucide-react";
import { SidebarHeaderIconButton } from "~/components/sidebar/SidebarThreadHeader";
import { toastManager } from "~/components/ui/toast";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useThreadActions } from "~/hooks/useThreadActions";
import {
  readThreadShells,
  useAllEnvironmentShellsBootstrapped,
  waitForThreadShell,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import {
  beginAssistantOpen,
  dispatchAssistantCreate,
  endAssistantOpen,
  useAssistantOpening,
} from "./assistantOpening";
import { readArchivedThreads } from "./commands";

const refusal = (failure: unknown) =>
  new Error(
    `${failure instanceof Error ? failure.message : "The environment refused."} Check the connection to this environment and try again.`,
  );

export function AssistantEntry({
  environmentId,
  active = false,
}: {
  environmentId: EnvironmentId | null;
  active?: boolean;
}) {
  const navigate = useNavigate();
  const ready = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const { openScratchProject } = useScratchProject();
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const readArchived = useAtomCommand(readArchivedThreads, { reportFailure: false });
  const { unarchiveThread } = useThreadActions();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const opening = useAssistantOpening(environmentId);

  // An acknowledgement can beat the shell stream, and the thread route sends a thread it cannot
  // find to the index, which starts a draft in place of the Assistant.
  const openOnceShellArrives = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    if (!(await waitForThreadShell(scopeThreadRef(environmentId, threadId)))) {
      throw new Error(
        "The assistant was saved, but has not reached this window yet. Check the connection to this environment and try again.",
      );
    }
    await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };

  const open = async () => {
    if (!environmentId || !canOperate || !ready || !beginAssistantOpen(environmentId)) return;
    try {
      // Read now, not from this render: an open that just ended may have published it.
      const existing = readThreadShells()
        .filter((thread) => thread.environmentId === environmentId && isAssistantThread(thread.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (existing && !existing.archivedAt) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: existing.id },
        });
        return;
      }
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      if (environment?.connection.phase !== "connected" || !environment.serverConfig) {
        throw new Error("Connect to this environment before opening the assistant.");
      }
      // Archiving takes a thread out of the active shells, and replaying its create changes
      // nothing, so the archive decides whether to restore this Assistant or create it.
      const archive = await readArchived({ environmentId, input: {} });
      if (archive._tag === "Failure") throw refusal(squashAtomCommandFailure(archive));
      const archived = archive.value.threads.find((thread) => isAssistantThread(thread.id));
      if (archived) {
        const restored = await unarchiveThread(scopeThreadRef(environmentId, archived.id));
        if (restored._tag === "Failure") throw refusal(squashAtomCommandFailure(restored));
        await openOnceShellArrives(environmentId, archived.id);
        return;
      }
      const subscriptionProviders = (
        appAtomRegistry.get(serverEnvironment.providersValueAtom(environmentId)) ?? []
      ).filter(
        (provider) => provider.auth.status === "authenticated" && provider.auth.type === "chatgpt",
      );
      const selected = resolvePromptLinkModelSelection(subscriptionProviders, {
        provider: "codex",
        model: null,
      });
      if (!selected)
        throw new Error(
          "Set up your subscription-backed Codex provider in Settings → Providers first.",
        );
      const project = await openScratchProject(environmentId, "Could not open the assistant");
      if (!project) return;
      // One stable identity per destination environment, including concurrent clients.
      // Creating a shell does not enqueue a message or start a provider turn.
      const threadId = ThreadId.make(ASSISTANT_THREAD_PREFIX + "owner");
      const { defaultRuntimeMode } = environment.serverConfig.settings;
      const result = await dispatchAssistantCreate(environmentId, threadId, (commandId) =>
        create({
          environmentId,
          input: {
            commandId,
            threadId,
            projectId: project.id,
            title: "Project assistant",
            modelSelection: selected.selection,
            runtimeMode: defaultRuntimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        }),
      );
      if (result._tag === "Failure") throw refusal(squashAtomCommandFailure(result));
      await openOnceShellArrives(environmentId, threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the assistant",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      endAssistantOpen(environmentId);
    }
  };

  return (
    <SidebarHeaderIconButton
      label={opening ? "Opening assistant…" : "Assistant"}
      isActive={active}
      aria-current={active ? "page" : undefined}
      disabled={!environmentId || !ready || !canOperate || opening}
      onClick={() => void open()}
    >
      <MessageCircleIcon />
    </SidebarHeaderIconButton>
  );
}
