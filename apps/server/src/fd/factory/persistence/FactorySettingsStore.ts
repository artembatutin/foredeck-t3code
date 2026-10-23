import { ProjectId } from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { FactoryStoreError } from "./errors.ts";

const SettingsJson = Schema.fromJsonString(FactoryProjectSettings);

/**
 * A project's Factory settings, one row per project. Keys a row lacks decode to their defaults,
 * so settings saved by an older server keep loading.
 */
export class FactorySettingsStore extends Context.Service<
  FactorySettingsStore,
  {
    /** None until the project's settings are first set. */
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<FactoryProjectSettings>, FactoryStoreError>;
    /** Replaces the project's settings. */
    readonly set: (
      projectId: ProjectId,
      settings: FactoryProjectSettings,
    ) => Effect.Effect<void, FactoryStoreError>;
  }
>()("t3/fd/factory/persistence/FactorySettingsStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectSettings = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: Schema.Struct({ settings: SettingsJson }),
    execute: (projectId) => sql`
      SELECT settings_json AS settings FROM fd_factory_settings WHERE project_id = ${projectId}
    `,
  });

  const upsertSettings = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      settings: SettingsJson,
      updatedAt: Schema.String,
    }),
    execute: ({ projectId, settings, updatedAt }) => sql`
      INSERT INTO fd_factory_settings (project_id, settings_json, updated_at)
      VALUES (${projectId}, ${settings}, ${updatedAt})
      ON CONFLICT (project_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `,
  });

  return FactorySettingsStore.of({
    get: (projectId) =>
      selectSettings(projectId).pipe(
        Effect.map(Option.map((row) => row.settings)),
        Effect.catchTags(FactoryStoreError.catchStorage("settings.get")),
      ),
    set: (projectId, settings) =>
      Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* upsertSettings({ projectId, settings, updatedAt });
      }).pipe(Effect.catchTags(FactoryStoreError.catchStorage("settings.set"))),
  });
});

export const layer = Layer.effect(FactorySettingsStore, make);
