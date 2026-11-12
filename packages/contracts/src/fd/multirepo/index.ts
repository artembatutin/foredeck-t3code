import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "../../baseSchemas.ts";

/**
 * Identity is resolved on the destination server; a path never selects membership.
 * Kept in a leaf module: source control and project contracts both carry it, and they sit in an
 * import cycle through environment.ts that a top-level schema reference would break.
 */
export const RepositoryTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project"),
    projectId: ProjectId,
    repositoryId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: ThreadId,
    repositoryId: TrimmedNonEmptyString,
  }),
]);
export type RepositoryTarget = typeof RepositoryTarget.Type;

export class RepositoryTargetError extends Schema.TaggedError<RepositoryTargetError>()(
  "RepositoryTargetError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}
