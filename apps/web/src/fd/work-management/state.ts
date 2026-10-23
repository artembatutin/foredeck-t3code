import { useAtomValue } from "@effect/atom-react";
import {
  createWorkCommands,
  createWorkEnvironmentAtoms,
  createWorkSupportAtom,
  linksByThread,
  WORK_READ_SCOPE,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkManagementSupport, WorkThreadLink } from "@t3tools/contracts/fd/work-management";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";

export const workEnvironment = createWorkEnvironmentAtoms(connectionAtomRuntime);
export const workCommands = createWorkCommands(connectionAtomRuntime);
export const workSupportAtom = createWorkSupportAtom(environmentServerConfigsAtom);

const EMPTY_LINKS: ReadonlyArray<WorkThreadLink> = [];

/** Every environment that advertises Work, whatever this session may do there. */
export function useWorkSupport(): ReadonlyMap<EnvironmentId, WorkManagementSupport> {
  return useAtomValue(workSupportAtom);
}

/** Environments that advertise Work and that this session may read Work on. */
export function useReadableWorkEnvironments(): ReadonlyArray<EnvironmentId> {
  const support = useWorkSupport();
  const environments = useMemo(
    () => [...support.keys()].toSorted().map((environmentId) => ({ environmentId })),
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

/** Whether any environment advertises Work: the gate for entry points (sidebar, palette). */
export function useWorkSupported(): boolean {
  return useWorkSupport().size > 0;
}

/** Whether Work can be shown for this environment; passive surfaces render nothing otherwise. */
export function useWorkReadable(environmentId: EnvironmentId | null): boolean {
  const support = useWorkSupport();
  const permitted = useEnvironmentScope(environmentId, WORK_READ_SCOPE);
  return environmentId !== null && support.has(environmentId) && permitted;
}

/** Open links of one environment grouped by thread, from one request per environment. */
const threadLinksAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(workEnvironment.links({ environmentId, input: {} }));
    const links = Option.getOrElse(AsyncResult.value(result), () => ({ links: EMPTY_LINKS }));
    return linksByThread(links.links);
  }).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`work:thread-links:${environmentId}`)),
);

const EMPTY_THREAD_LINKS_ATOM = Atom.make(
  new Map<ThreadId, ReadonlyArray<WorkThreadLink>>() as ReadonlyMap<
    ThreadId,
    ReadonlyArray<WorkThreadLink>
  >,
);

/** The open links of a thread, for badges that must not cost a request per row. */
export function useThreadWorkLinks(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  enabled: boolean,
): ReadonlyArray<WorkThreadLink> {
  const grouped = useAtomValue(enabled ? threadLinksAtom(environmentId) : EMPTY_THREAD_LINKS_ATOM);
  return grouped.get(threadId) ?? EMPTY_LINKS;
}
