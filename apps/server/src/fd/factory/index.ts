import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryMigrations from "./persistence/FactoryMigrations.ts";
import * as FactorySettingsStore from "./persistence/FactorySettingsStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
// Last: core's runtime layer cannot be the first module of its import cycle to load, and the
// Factory modules above enter that cycle where native ESM can initialize it (entry.test.ts).
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";

export * as FactoryReactor from "./FactoryReactor.ts";
export * as FactoryService from "./FactoryService.ts";
export * as FactorySettings from "./FactorySettings.ts";
export * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
export * as FactoryWorker from "./FactoryWorker.ts";
export { toolLayer as factoryToolLayer } from "./mcp/handlers.ts";
export { layerWsRpc, WS_METHOD_TAGS } from "./rpc/handlers.ts";
export { FactoryToolkit } from "./mcp/tools.ts";

/**
 * Factory persistence on the core-migrated SQL client. The `fd_factory_migrations` ledger
 * migrates first, so no Factory store is ever built against an older schema.
 */
export const layerPersistence = Layer.mergeAll(
  FactorySettingsStore.layer,
  FactoryDeliveryStore.layer,
  FactoryTaskStore.layer,
  FactoryStageRunStore.layer,
).pipe(Layer.provide(FactoryMigrations.layer));

/**
 * The Factory service, settings and worker over Factory persistence, for transports and the
 * reactor. Needs Work's service, the orchestration application (thread launches, management and
 * the orchestrator), the project store and service, server settings and config, the provider
 * registry (for model options), the Git workflow (for pull requests), the git driver and the
 * process runner. The thread, verify, review, record and pull request effects and the Work
 * comments on transitions stay private to the service and worker.
 * server.ts also mounts `layerPersistence` with core and Work persistence, so the ledger migrates
 * with theirs; one build shares the one instance.
 */
export const layerLive = FactoryService.layer.pipe(
  Layer.provideMerge(FactoryWorker.layer),
  Layer.provide(
    Layer.mergeAll(
      FactoryThreadEffects.layer,
      FactoryVerifyRunner.layer,
      FactoryReview.layer,
      FactoryRecord.layer,
      FactoryPullRequest.layer,
      FactoryWorkComments.layer,
    ),
  ),
  Layer.provide(FactoryEvidence.layer),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(layerPersistence),
  Layer.provide(ProjectionStore.layer),
);

/**
 * Starts the reactor over `layerLive`'s worker; its boot sweep and thread event tail park until
 * the server activates. The event sink is the orchestration runtime's own layer, which the
 * server's build shares, so the tail receives the events the orchestrator commits. A sink from
 * any other layer would be a second instance whose live tail never sees them.
 */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start;
  }),
).pipe(
  Layer.provideMerge(FactoryReactor.layer),
  Layer.provide(RuntimeLayer.layerEventSink),
  Layer.provide(ProjectionStore.layer),
);
