import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { usesSharedCheckouts } from "@t3tools/client-runtime/fd/multirepo";
import {
  defaultWorkWorkspace,
  workBranchPreview,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkItemSummary, WorkThreadMode } from "@t3tools/contracts/fd/work-management";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useProjects, useServerConfigs } from "../../state/entities";
import { newThreadId } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { workCommandError } from "./shared";
import { useWorkWritable, workCommands } from "./state";

const MODES: ReadonlyArray<{ value: WorkThreadMode; label: string; help: string }> = [
  { value: "scope", label: "Scope", help: "Investigate and reply with a plan; no file changes." },
  { value: "plan", label: "Plan", help: "Write a plan, then stop and ask." },
  { value: "implement", label: "Implement", help: "Do the work and open one pull request." },
];

export interface StartWorkThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: Pick<WorkItemSummary, "ref" | "kind" | "key" | "title">;
  /** An open thread already linked to the item, offered as Continue. */
  readonly openThreadId: ThreadId | null;
}

export function StartWorkThreadDialog({
  target,
  onOpenChange,
}: {
  target: StartWorkThreadTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const start = useAtomCommand(workCommands.startThread);
  const permitted = useWorkWritable(
    target?.environmentId ?? null,
    workCommands.startThread,
    "threads.start",
  );
  const project =
    target === null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === target.environmentId && candidate.id === target.projectId,
        );
  const sharedCheckouts = usesSharedCheckouts(project);
  const defaultWorkspace = useMemo(() => {
    const settings =
      target === null ? undefined : serverConfigs.get(target.environmentId)?.settings;
    if (settings === undefined || project === undefined) return "root" as const;
    return defaultWorkWorkspace({
      defaultThreadEnvMode: resolveProjectSettings(settings, project.id, project).settings
        .defaultThreadEnvMode,
      sharedCheckouts,
    });
  }, [project, serverConfigs, sharedCheckouts, target]);
  const [mode, setMode] = useState<WorkThreadMode>("implement");
  const [workspace, setWorkspace] = useState<"root" | "worktree">(defaultWorkspace);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target === null) return;
    setMode("implement");
    setWorkspace(defaultWorkspace);
    setPrompt("");
    setError(null);
  }, [defaultWorkspace, target]);

  const openThread = (threadId: ThreadId) => {
    if (target === null) return;
    onOpenChange(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, threadId)),
    });
  };

  const submit = async (force: boolean) => {
    if (target === null) return;
    setPending(true);
    setError(null);
    const result = await start({
      environmentId: target.environmentId,
      input: {
        ref: target.item.ref,
        threadId: newThreadId(),
        creationSource: "web",
        mode,
        workspaceStrategy: workspace === "root" ? { type: "root" } : { type: "worktree" },
        ...(prompt.trim().length === 0 ? {} : { prompt: prompt.trim() }),
        force,
      },
    });
    setPending(false);
    if (result._tag === "Success") openThread(result.value.threadId);
    else setError(workCommandError(result));
  };

  const help = MODES.find((entry) => entry.value === mode)?.help;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a thread from {target?.item.key}</DialogTitle>
          <DialogDescription>{target?.item.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <ToggleGroup
                aria-label="Thread mode"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = MODES.find((entry) => entry.value === next[0]);
                  if (value) setMode(value.value);
                }}
              >
                {MODES.map((entry) => (
                  <Toggle key={entry.value} value={entry.value}>
                    {entry.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <p className="text-muted-foreground text-xs">{help}</p>
            </div>
            <div className="space-y-1.5">
              <ToggleGroup
                aria-label="Workspace"
                className="w-full *:flex-1"
                value={[workspace]}
                onValueChange={(next) => {
                  if (next[0] === "root" || next[0] === "worktree") setWorkspace(next[0]);
                }}
              >
                <Toggle value="root">Project checkout</Toggle>
                <Toggle value="worktree" disabled={sharedCheckouts}>
                  New worktree
                </Toggle>
              </ToggleGroup>
              <p className="truncate text-muted-foreground text-xs">
                {workspace === "worktree" && target !== null
                  ? `Branch ${workBranchPreview(target.item)}`
                  : sharedCheckouts
                    ? "This project's repositories use their shared checkouts."
                    : "Works in the project's main checkout."}
              </p>
            </div>
            <Textarea
              aria-label="Extra instructions"
              placeholder="Extra instructions (optional)"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            {target?.openThreadId ? (
              <p className="text-muted-foreground text-xs">
                A thread for this item is still open. Continue it, or start another attempt.
              </p>
            ) : null}
            {!permitted ? (
              <p className="text-muted-foreground text-xs">
                This connection cannot start threads on this environment right now.
              </p>
            ) : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {target?.openThreadId ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !permitted}
                onClick={() => void submit(true)}
              >
                Start another
              </Button>
              <Button size="sm" disabled={pending} onClick={() => openThread(target.openThreadId!)}>
                Continue
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={pending || !permitted} onClick={() => void submit(false)}>
              {pending ? "Starting..." : "Start thread"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
