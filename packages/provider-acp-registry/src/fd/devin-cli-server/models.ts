import { readCommandOutput } from "./commandOutput.ts";
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { DevinSettings } from "../devin/index.ts";

const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      families: Schema.Array(
        Schema.Struct({
          variants: Schema.Array(
            Schema.Struct({
              model_uid: Schema.String,
              label: Schema.String,
              cost_summary: Schema.optional(Schema.String),
              is_new: Schema.optional(Schema.Boolean),
              max_context_tokens: Schema.optional(Schema.Number),
              max_output_tokens: Schema.optional(Schema.Number),
            }),
          ),
        }),
      ),
    }),
  ),
);

/** Native variants are ACP model IDs, including their reasoning and speed selections. */
export const readDevinModels = Effect.fn("DevinDriver.readModels")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* readCommandOutput(
    spawner,
    ChildProcess.make(settings.commandPath, ["models", "list", "--format", "json"], {
      env: environment,
    }),
  ).pipe(
    Effect.flatMap(decodeCatalog),
    Effect.map(({ families }): ReadonlyArray<ServerProviderModel> | null => {
      const models: Array<ServerProviderModel> = [];
      const seen = new Set<string>();
      for (const variant of families.flatMap((family) => family.variants)) {
        const slug = variant.model_uid;
        if (!slug || slug !== slug.trim() || slug.length > 128 || seen.has(slug)) continue;
        seen.add(slug);
        const label = variant.label.trim().slice(0, 160) || slug;
        const cost = variant.cost_summary?.trim().slice(0, 160);
        models.push({
          slug,
          name: label,
          ...(cost ? { costSummary: cost } : {}),
          ...(Number.isSafeInteger(variant.max_context_tokens) &&
          (variant.max_context_tokens ?? 0) > 0
            ? { contextWindow: variant.max_context_tokens }
            : {}),
          ...(Number.isSafeInteger(variant.max_output_tokens) &&
          (variant.max_output_tokens ?? 0) > 0
            ? { maxOutputTokens: variant.max_output_tokens }
            : {}),
          ...(variant.is_new ? { badge: "new" as const } : {}),
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        });
        if (models.length === 256) break;
      }
      return models;
    }),
    Effect.timeout("10 seconds"),
    // Older CLIs and signed-out accounts retain ACP discovery and the default selection.
    Effect.orElseSucceed(() => null),
  );
});
