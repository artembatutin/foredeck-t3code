import { ProjectId } from "@t3tools/contracts";
import { type FactoryCommand, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as FactoryChanges from "./FactoryChanges.ts";
import * as FactorySettingsStore from "./persistence/FactorySettingsStore.ts";
import { pipelines } from "./pipeline/definitions.ts";

/** Reading or writing a project's settings failed; the store's failure stays in `cause`. */
export class FactorySettingsStorageError extends Schema.TaggedError<FactorySettingsStorageError>()(
  "FactorySettingsStorageError",
  {
    operation: Schema.Literals(["get", "set"]),
    projectId: ProjectId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Factory could not ${this.operation} the settings of project ${this.projectId}.`;
  }
}

export class FactoryUnknownPipelineError extends Schema.TaggedError<FactoryUnknownPipelineError>()(
  "FactoryUnknownPipelineError",
  { projectId: ProjectId, pipelineId: Schema.String },
) {
  override get message(): string {
    return `Factory pipeline '${this.pipelineId}' does not exist on this server.`;
  }
}

/** A delivery cannot start until the project has a verify command. */
export class FactoryVerifyCommandMissingError extends Schema.TaggedError<FactoryVerifyCommandMissingError>()(
  "FactoryVerifyCommandMissingError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Set a verify command in the Factory settings of project ${this.projectId} before starting a delivery.`;
  }
}

/** Settings a delivery can run with. */
export type FactoryDeliverySettings = FactoryProjectSettings & {
  readonly verifyCommand: FactoryCommand;
};

const defaults = Schema.decodeSync(FactoryProjectSettings)({});

/**
 * A project's Factory settings. Transports, the worker and `FactoryService` use this rather than
 * the store: it supplies the defaults for a project that has none and refuses settings this
 * server cannot run.
 */
export class FactorySettings extends Context.Service<
  FactorySettings,
  {
    /** The stored settings, or the defaults when the project has none. Never writes. */
    readonly get: (
      projectId: ProjectId,
    ) => Effect.Effect<FactoryProjectSettings, FactorySettingsStorageError>;
    /**
     * Replaces the project's settings. Once stored, the change epoch moves, so every client
     * showing them refetches; a refused write moves nothing.
     */
    readonly set: (
      projectId: ProjectId,
      settings: FactoryProjectSettings,
    ) => Effect.Effect<void, FactorySettingsStorageError | FactoryUnknownPipelineError>;
    /** The settings a delivery starts with; refuses a project without a verify command. */
    readonly requireDeliverySettings: (
      projectId: ProjectId,
    ) => Effect.Effect<
      FactoryDeliverySettings,
      FactorySettingsStorageError | FactoryVerifyCommandMissingError
    >;
  }
>()("t3/fd/factory/FactorySettings") {}

const make = Effect.gen(function* () {
  const store = yield* FactorySettingsStore.FactorySettingsStore;
  const changes = yield* FactoryChanges.FactoryChanges;

  const get: FactorySettings["Service"]["get"] = (projectId) =>
    store.get(projectId).pipe(
      Effect.map(Option.getOrElse(() => defaults)),
      Effect.catchTags({
        FactoryStoreError: (cause) =>
          Effect.fail(new FactorySettingsStorageError({ operation: "get", projectId, cause })),
      }),
    );

  return FactorySettings.of({
    get,
    set: (projectId, settings) =>
      pipelines.has(settings.pipelineId)
        ? changes.transact(store.set(projectId, settings)).pipe(
            Effect.catchTags({
              FactoryStoreError: (cause) =>
                Effect.fail(
                  new FactorySettingsStorageError({ operation: "set", projectId, cause }),
                ),
              SqlError: (cause) =>
                Effect.fail(
                  new FactorySettingsStorageError({ operation: "set", projectId, cause }),
                ),
            }),
          )
        : Effect.fail(
            new FactoryUnknownPipelineError({ projectId, pipelineId: settings.pipelineId }),
          ),
    requireDeliverySettings: (projectId) =>
      get(projectId).pipe(
        Effect.flatMap(({ verifyCommand, ...settings }) =>
          verifyCommand === null
            ? Effect.fail(new FactoryVerifyCommandMissingError({ projectId }))
            : Effect.succeed({ ...settings, verifyCommand }),
        ),
      ),
  });
});

/** The settings, with the change epoch their writes move. */
export const layer = Layer.effect(FactorySettings, make).pipe(
  Layer.provideMerge(FactoryChanges.layer),
);
