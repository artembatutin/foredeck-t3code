import { resolveRepositoryFileReference } from "@t3tools/client-runtime/fd/multirepo";
import {
  type EnvironmentId,
  type RepositoryTarget,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMessages } from "gt-react";
import { createContext, type ReactNode, useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  applyPendingScopedWrites,
  pendingScopedWritesAtom,
  resolveScopedSettingsTargets,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  cwd: string,
  physicalProjectKey: string,
  relativePath: string,
  repositoryTarget: RepositoryTarget | null,
];

const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
    const files = new Map<string, T3ProjectFile | null>();
    for (const [environmentId, cwd, physicalProjectKey, relativePath, target] of members) {
      const result = get(
        getProjectFileQueryAtom(environmentId, cwd, relativePath, target ?? undefined),
      );
      if (result.waiting) continue;
      const data =
        get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ??
        AsyncResult.getOrElse(result, () => null);
      files.set(
        physicalProjectKey,
        data === null || data.exists === false || data.truncated
          ? null
          : parseT3ProjectFile(data.contents),
      );
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => {
          // fd: read each member's file through its owning repository checkout.
          const file = resolveRepositoryFileReference(member, null, T3_PROJECT_FILE_NAME);
          return [
            member.environmentId,
            file.scope?.repository.rootPath ?? member.workspaceRoot,
            member.physicalProjectKey,
            file.path,
            file.scope?.target ?? null,
          ];
        }),
      ),
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const m = useMessages();
  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, groups, availableEnvironments, m),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : rawSearch;
  const scope = resolveSettingsScope(search, groups, availableEnvironments, m);
  const projectFiles = useMemberProjectFiles(scope);
  const pendingWrites = useAtomValue(pendingScopedWritesAtom);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(
    scope,
    applyPendingScopedWrites(selected.connectedEnvironments, pendingWrites),
    projectFiles,
  );
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return { scope, groups, search, ...selected, targets, target };
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      deviceOnly: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
  deviceOnly = false,
}: {
  singleEnvironment?: boolean;
  /** The page hides the scope picker, so its client settings save for this device. */
  deviceOnly?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = { ...resolved, singleEnvironment, deviceOnly, selectScope: onChange };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
