import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandId,
  ThreadId,
  type EnvironmentId,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import { ASSISTANT_THREAD_PREFIX, isAssistantThread } from "@t3tools/shared/fd/assistant";
import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MessageCircleIcon } from "lucide-react";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useThreadShells, useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

export function AssistantEntry({
  environmentId,
  active = false,
}: {
  environmentId: EnvironmentId | null;
  active?: boolean;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const { openScratchProject } = useScratchProject();
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const inFlight = useRef(false);
  const [opening, setOpening] = useState(false);

  const open = async () => {
    if (!environmentId || !canOperate || !ready || inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    try {
      const existing = threads
        .filter((thread) => thread.environmentId === environmentId && isAssistantThread(thread.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (existing) {
        if (existing.archivedAt) {
          const restored = await unarchive({ environmentId, input: { threadId: existing.id } });
          if (restored._tag === "Failure") throw squashAtomCommandFailure(restored);
        }
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
      const subscriptionProviders = environment.serverConfig.providers.filter(
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
      const result = await create({
        environmentId,
        input: {
          commandId: CommandId.make("create:" + threadId),
          threadId,
          projectId: project.id,
          title: "Project assistant",
          modelSelection: selected.selection,
          runtimeMode: environment.serverConfig.settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the assistant",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      inFlight.current = false;
      setOpening(false);
    }
  };

  return (
    <div className="pt-1">
      <SidebarMenuButton
        type="button"
        isActive={active}
        aria-current={active ? "page" : undefined}
        disabled={!environmentId || !ready || !canOperate || opening}
        onClick={() => void open()}
      >
        <MessageCircleIcon />
        <span>{opening ? "Opening assistant…" : "Assistant"}</span>
      </SidebarMenuButton>
    </div>
  );
}
