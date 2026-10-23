import * as Layer from "effect/Layer";

import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryMigrations from "./persistence/FactoryMigrations.ts";
import * as FactorySettingsStore from "./persistence/FactorySettingsStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";

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
