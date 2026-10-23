import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";

/** Shared by every Factory store: any SQL or row-decoding failure, with the operation that hit it. */
export class FactoryStoreError extends Schema.TaggedError<FactoryStoreError>()(
  "FactoryStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Factory storage operation '${this.operation}' failed.`;
  }

  /** `Effect.catchTags` handlers that wrap the lower-level failures of `operation`. */
  static catchStorage(operation: string) {
    return {
      SqlError: (cause: SqlError.SqlError) =>
        Effect.fail(new FactoryStoreError({ operation, cause })),
      SchemaError: (cause: Schema.SchemaError) =>
        Effect.fail(new FactoryStoreError({ operation, cause })),
    };
  }
}
