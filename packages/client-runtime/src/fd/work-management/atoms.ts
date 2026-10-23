import { type EnvironmentId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import {
  type WorkManagementSupport,
  WorkItemDetail,
  WorkLinksResult,
  WorkListResult,
  WorkSourceList,
} from "@t3tools/contracts/fd/work-management";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import { persistQuery } from "../../state/queryPersistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../../state/runtime.ts";
import { workSupport } from "./model.ts";

/**
 * Work reads for one client. Every query refetches when the environment's Work epoch moves, so
 * a change made anywhere (another client, an agent, a watched task file) reaches every list
 * without polling. Reads stay out of the client-guarded scope map; the server authorizes them.
 */
export function createWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:work:refreshes",
    tag: WS_METHODS.workSubscribeRefreshes,
  });
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    refreshes({ environmentId, input: {} });
  return {
    refreshes,
    sources: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:work:sources",
      persistence: persistQuery(WorkSourceList),
      tag: WS_METHODS.workSourcesList,
      staleTimeMs: 30_000,
      refreshTrigger,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:work:list",
      persistence: persistQuery(WorkListResult),
      tag: WS_METHODS.workItemsList,
      staleTimeMs: 30_000,
      refreshTrigger,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:work:detail",
      persistence: persistQuery(WorkItemDetail),
      tag: WS_METHODS.workItemsGet,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    people: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:work:people",
      tag: WS_METHODS.workItemsPeople,
      staleTimeMs: 60_000,
    }),
    links: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:work:links",
      persistence: persistQuery(WorkLinksResult),
      tag: WS_METHODS.workLinksList,
      staleTimeMs: 30_000,
      refreshTrigger,
    }),
  };
}

/**
 * Work writes. They run one at a time per environment, since edits to one item are order
 * sensitive, and each is rechecked against the destination's grants by `permissionAtom`.
 * Reads refresh through the epoch the server moves after every write.
 */
export function createWorkCommands<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const command = <
    Tag extends
      | typeof WS_METHODS.workSourcesSave
      | typeof WS_METHODS.workSourcesDisconnect
      | typeof WS_METHODS.workSourcesRestore
      | typeof WS_METHODS.workSourcesTest
      | typeof WS_METHODS.workItemsCreate
      | typeof WS_METHODS.workItemsUpdate
      | typeof WS_METHODS.workItemsSetStatus
      | typeof WS_METHODS.workItemsComment
      | typeof WS_METHODS.workLinksSet
      | typeof WS_METHODS.workRefresh
      | typeof WS_METHODS.workThreadsStart,
  >(
    label: string,
    tag: Tag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:work:${label}`,
      tag,
      scheduler,
      concurrency: serialPerEnvironment,
    });
  return {
    saveSource: command("save-source", WS_METHODS.workSourcesSave),
    disconnectSource: command("disconnect-source", WS_METHODS.workSourcesDisconnect),
    restoreSource: command("restore-source", WS_METHODS.workSourcesRestore),
    testSource: command("test-source", WS_METHODS.workSourcesTest),
    createItem: command("create-item", WS_METHODS.workItemsCreate),
    updateItem: command("update-item", WS_METHODS.workItemsUpdate),
    setStatus: command("set-status", WS_METHODS.workItemsSetStatus),
    comment: command("comment", WS_METHODS.workItemsComment),
    setLink: command("set-link", WS_METHODS.workLinksSet),
    refresh: command("refresh", WS_METHODS.workRefresh),
    startThread: command("start-thread", WS_METHODS.workThreadsStart),
  };
}

/**
 * The Work each connected environment advertises, from a client's own server-config map. A
 * factory because each app builds its config atoms itself.
 */
export function createWorkSupportAtom(
  serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  return Atom.make((get) => {
    const supported = new Map<EnvironmentId, WorkManagementSupport>();
    for (const [environmentId, config] of get(serverConfigsAtom)) {
      const support = workSupport(config);
      if (support !== undefined) supported.set(environmentId, support);
    }
    return supported as ReadonlyMap<EnvironmentId, WorkManagementSupport>;
  }).pipe(Atom.withLabel("work:support"));
}
