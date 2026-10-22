import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  createRepositoryCommands,
  repositoryDraft,
  repositoryMembershipHelp,
  supportsRepositories,
  validRepositoryDraft,
} from "@t3tools/client-runtime/fd/multirepo";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectRepositoryInputs, ServerConfig } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function RepositorySettings({
  project,
  serverConfig,
  environmentLabel,
}: {
  project: EnvironmentProject;
  serverConfig: ServerConfig | null;
  environmentLabel: string;
}) {
  const commands = useMemo(
    () => createRepositoryCommands(connectionAtomRuntime, createEnvironmentRpcCommand),
    [],
  );
  const permitted = useAtomValue(commands.setRepositories.permissionAtom(project.environmentId));
  const supported =
    serverConfig !== null && supportsRepositories(serverConfig.environment.capabilities);
  const [draft, setDraft] = useState<ProjectRepositoryInputs | null>(null);
  const [saving, setSaving] = useState(false);
  const repositories = draft ?? repositoryDraft(project);
  const disabled = !permitted || !supported || saving;
  const save = useAtomCommand(commands.setRepositories);
  const update = (index: number, patch: { name?: string; rootPath?: string }) =>
    setDraft(
      repositories.map((repository, i) => (i === index ? { ...repository, ...patch } : repository)),
    );
  const saveRepositories = async () => {
    if (disabled || !validRepositoryDraft(repositories)) return;
    setSaving(true);
    try {
      const result = await save({
        environmentId: project.environmentId,
        input: { projectId: project.id, repositories },
      });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title={`Repositories · ${environmentLabel}`}>
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{repositoryMembershipHelp}</p>
        {!supported ? (
          <p className="text-sm text-muted-foreground">
            Connect to an updated server to configure repositories.
          </p>
        ) : null}
        {!permitted ? (
          <p className="text-sm text-muted-foreground">
            This connection needs settings and conversation permissions to change repositories.
          </p>
        ) : null}
        {repositories.map((repository, index) => (
          <div key={repository.id ?? index} className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`Repository ${index + 1} name`}
                  value={repository.name}
                  disabled={disabled}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </div>
              {index === 0 ? (
                <span className="text-xs text-muted-foreground">Primary</span>
              ) : (
                <>
                  {index > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        setDraft(
                          repositories.map((entry, i) =>
                            i === index - 1
                              ? repositories[index]!
                              : i === index
                                ? repositories[index - 1]!
                                : entry,
                          ),
                        )
                      }
                    >
                      Move up
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setDraft(repositories.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            <Input
              aria-label={`Repository ${index + 1} path on ${environmentLabel}`}
              value={repository.rootPath}
              readOnly={repository.id !== undefined || index === 0}
              disabled={disabled}
              placeholder="Absolute path on this environment"
              onChange={(event) => update(index, { rootPath: event.target.value })}
            />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || repositories.length >= 16}
            onClick={() => setDraft([...repositories, { name: "", rootPath: "" }])}
          >
            Add repository
          </Button>
          <Button
            size="sm"
            disabled={disabled || draft === null || !validRepositoryDraft(repositories)}
            onClick={() => void saveRepositories()}
          >
            {saving ? "Saving…" : "Save repositories"}
          </Button>
          {draft !== null ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
