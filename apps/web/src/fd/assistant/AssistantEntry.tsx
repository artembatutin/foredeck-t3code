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
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useScratchProject } from "~/hooks/useScratchProject";
import { newMessageId, randomUUID } from "~/lib/utils";
import { useThreadShells, useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

export function AssistantEntry({ environmentId }: { environmentId: EnvironmentId | null }) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const { openScratchProject } = useScratchProject();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const inFlight = useRef(false);
  const attempt = useRef<Parameters<typeof startTurn>[0] | null>(null);
  const [opening, setOpening] = useState(false);

  const open = async () => {
    if (!environmentId || !canOperate || !ready || inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    try {
      const existing = threads
        .filter(
          (thread) =>
            thread.environmentId === environmentId &&
            isAssistantThread(thread.id) &&
            !thread.archivedAt,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (existing) {
        attempt.current = null;
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
      // Keep the entire request after an uncertain launch, including its receipt and message IDs.
      if (attempt.current?.environmentId !== environmentId) {
        const threadId = ThreadId.make(ASSISTANT_THREAD_PREFIX + randomUUID());
        const runtimeMode = environment.serverConfig.settings.defaultRuntimeMode;
        const createdAt = new Date().toISOString();
        attempt.current = {
          environmentId,
          input: {
            commandId: CommandId.make("start:" + threadId),
            threadId,
            createdAt,
            runtimeMode,
            interactionMode: "default",
            modelSelection: selected.selection,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: "Help me review my projects, clarify what matters most, and coordinate the work we agree to start.",
              attachments: [],
            },
            bootstrap: {
              createThread: {
                projectId: project.id,
                title: "Project assistant",
                modelSelection: selected.selection,
                runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
          },
        };
      }
      const { threadId } = attempt.current.input;
      const result = await startTurn(attempt.current);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      attempt.current = null;
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
    <div className="px-2 pb-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={!environmentId || !ready || !canOperate || opening}
        onClick={() => void open()}
      >
        <MessageCircleIcon />
        {opening ? "Opening assistant…" : "Assistant"}
      </Button>
    </div>
  );
}
