import { useAtomValue } from "@effect/atom-react";
import {
  createWorkCommands,
  createWorkEnvironmentAtoms,
  createWorkSupportAtom,
  WORK_READ_SCOPE,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId } from "@t3tools/contracts";
import type { WorkManagementSupport } from "@t3tools/contracts/fd/work-management";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";

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
