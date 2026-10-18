import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isPermissionDenied = Schema.is(Schema.Struct({ code: Schema.Literals(["EPERM", "EACCES"]) }));

// Node can throw before spawning ps. Treat denied inspection as unavailable,
// while preserving unexpected defects instead of hiding implementation errors.
export const recoverDeniedInspection = Effect.catchDefect((defect) =>
  isPermissionDenied(defect) ? Effect.succeed("") : Effect.die(defect),
);
