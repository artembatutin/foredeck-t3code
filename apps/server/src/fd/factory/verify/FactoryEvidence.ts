import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";

/** Creating, listing, reading or writing a delivery's evidence failed; the failure stays in `cause`. */
export class FactoryEvidenceError extends Schema.TaggedError<FactoryEvidenceError>()(
  "FactoryEvidenceError",
  {
    operation: Schema.Literals(["create", "list", "read", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Factory could not ${this.operation} evidence at ${this.path}.`;
  }
}

/** One numbered run's evidence files, `<prefix>-<number>.<extension>`. */
export interface FactoryEvidenceRun {
  readonly number: number;
  readonly file: (extension: "log" | "json") => string;
}

/**
 * A delivery's evidence folder, `<stateDir>/fd-factory/<deliveryId>/` under T3 home. Evidence
 * never goes in the repository: an agent could edit it, and it would dirty the tree.
 */
export class FactoryEvidence extends Context.Service<
  FactoryEvidence,
  {
    /**
     * The next run number for `prefix` in the delivery's folder (created on demand): one more
     * than the highest number any file of that prefix already uses.
     */
    readonly nextRun: (
      deliveryId: FactoryDeliveryId,
      prefix: "verify" | "review",
    ) => Effect.Effect<FactoryEvidenceRun, FactoryEvidenceError>;
  }
>()("t3/fd/factory/verify/FactoryEvidence") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(config.stateDir, "fd-factory");

  return FactoryEvidence.of({
    nextRun: Effect.fn("FactoryEvidence.nextRun")(function* (deliveryId, prefix) {
      const directory = path.join(root, deliveryId);
      yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(new FactoryEvidenceError({ operation: "create", path: directory, cause })),
        }),
      );
      const names = yield* fileSystem.readDirectory(directory).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(new FactoryEvidenceError({ operation: "list", path: directory, cause })),
        }),
      );
      const pattern = new RegExp(`^${prefix}-(\\d+)\\.`);
      const number = Math.max(0, ...names.map((name) => Number(pattern.exec(name)?.[1] ?? 0))) + 1;
      return {
        number,
        file: (extension) => path.join(directory, `${prefix}-${number}.${extension}`),
      };
    }),
  });
});

export const layer = Layer.effect(FactoryEvidence, make);
