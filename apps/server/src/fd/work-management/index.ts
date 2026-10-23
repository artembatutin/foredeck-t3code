import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as WorkLinkStore from "./persistence/WorkLinkStore.ts";
import * as WorkMigrations from "./persistence/WorkMigrations.ts";
import * as WorkSourceStore from "./persistence/WorkSourceStore.ts";
import * as GitHubIssuesSource from "./sources/github/GitHubIssuesSource.ts";
import * as JiraSource from "./sources/jira/JiraSource.ts";
import * as MarkdownSource from "./sources/markdown/MarkdownSource.ts";
import { layerRegistry } from "./sources/WorkSourceAdapter.ts";
import * as WorkService from "./WorkService.ts";
import * as WorkSyncReactor from "./sync/WorkSyncReactor.ts";
import * as WorkThreads from "./WorkThreads.ts";

export type { WorkActor } from "./authority.ts";
export { actorFromSession, layerWsRpc, WS_METHOD_TAGS, wsHandlers } from "./rpc/handlers.ts";
export * as WorkService from "./WorkService.ts";
export * as WorkSyncReactor from "./sync/WorkSyncReactor.ts";
export * as WorkThreads from "./WorkThreads.ts";
export { toolLayer as workToolLayer } from "./mcp/handlers.ts";
export { WorkToolkit } from "./mcp/tools.ts";

/**
 * Work persistence on the core-migrated SQL client. The `fd_work_migrations` ledger migrates
 * first, so no Work store is ever built against an older schema.
 */
export const layerPersistence = Layer.mergeAll(WorkSourceStore.layer, WorkLinkStore.layer).pipe(
  Layer.provide(WorkMigrations.layer),
);

/**
 * The adapters this server ships. `WORK_MANAGEMENT_CAPABILITY` in the contracts advertises the
 * same kinds; `index.test.ts` keeps the two in step.
 */
export const layerAdapters = Layer.unwrap(
  Effect.all([MarkdownSource.make, GitHubIssuesSource.make(), JiraSource.make()]).pipe(
    Effect.map((adapters) => layerRegistry(adapters)),
  ),
);

/**
 * The Work service and thread starts for transports; needs the persistence layer, project
 * stores, secrets and the orchestration application (thread launches, settings).
 */
export const layerLive = WorkThreads.layer.pipe(
  Layer.provideMerge(WorkService.layer),
  Layer.provide(layerAdapters),
  Layer.provide(ProjectionStore.layer),
);

/**
 * Watchers, project retirement and thread lifecycle. The boot sweep and first reconcile run as the layer builds;
 * the refresh and project-event tails park until the server activates.
 */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* WorkSyncReactor.WorkSyncReactor;
    yield* reactor.start;
  }),
).pipe(Layer.provide(WorkSyncReactor.layer), Layer.provide(ProjectionStore.layer));
