import { useAtomValue } from "@effect/atom-react";
import {
  createWorkCommands,
  createWorkEnvironmentAtoms,
  createWorkSupportAtom,
  WORK_READ_SCOPE,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  WorkManagementFeature,
  WorkManagementSupport,
} from "@t3tools/contracts/fd/work-management";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";

export const workEnvironment = createWorkEnvironmentAtoms(connectionAtomRuntime);
export const workCommands = createWorkCommands(connectionAtomRuntime);
export const workSupportAtom = createWorkSupportAtom(environmentServerConfigsAtom);

export function useWorkSupport(): ReadonlyMap<EnvironmentId, WorkManagementSupport> {
  return useAtomValue(workSupportAtom);
}

/** Environments that advertise Work and that this device may read Work on. */
export function useReadableWorkEnvironments(): ReadonlyArray<EnvironmentId> {
  const support = useWorkSupport();
  const environments = useMemo(
    () => [...support.keys()].sort().map((environmentId) => ({ environmentId })),
    [support],
  );
  const readable = useEnvironmentsWithScope(environments, WORK_READ_SCOPE);
  return useMemo(
    () =>
      environments
        .map(({ environmentId }) => environmentId)
        .filter((environmentId) => readable.has(environmentId)),
    [environments, readable],
  );
}

/** Whether a passive surface (a thread row) may show Work for this environment. */
export function useWorkReadable(environmentId: EnvironmentId | null): boolean {
  const support = useWorkSupport();
  const permitted = useEnvironmentScope(environmentId, WORK_READ_SCOPE);
  return environmentId !== null && support.has(environmentId) && permitted;
}

const DENIED_ATOM = Atom.make(false);

/**
 * Whether a Work write can run now: the environment advertises the feature, this device holds
 * the command's grant (rechecked on execution) and the environment is connected. There is no
 * offline outbox for Work, so every write control is gated on this.
 */
export function useWorkWritable(
  environmentId: EnvironmentId | null,
  command: { readonly permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean> },
  feature: WorkManagementFeature,
): boolean {
  const support = useWorkSupport();
  const environments = useWorkspaceEnvironments();
  const permitted = useAtomValue(
    environmentId === null ? DENIED_ATOM : command.permissionAtom(environmentId),
  );
  return (
    environmentId !== null &&
    permitted &&
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connectionState === "connected",
    ) &&
    support.get(environmentId)?.features.has(feature) === true
  );
}
