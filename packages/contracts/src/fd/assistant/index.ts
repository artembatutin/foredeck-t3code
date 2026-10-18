import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, RunId } from "../../baseSchemas.ts";

export class AssistantOperationError extends Schema.TaggedError<AssistantOperationError>()(
  "AssistantOperationError",
  { message: Schema.String },
) {}
export const AssistantOverview = Schema.Struct({
  ideas: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      ideaId: Schema.String,
      goal: Schema.String,
      brief: Schema.String,
      authorized: Schema.Boolean,
      priority: Schema.NullOr(Schema.Int),
      priorityReason: Schema.String,
    }),
  ),
  assignments: Schema.Array(
    Schema.Struct({
      assignmentId: Schema.String,
      projectId: ProjectId,
      ideaId: Schema.String,
      state: Schema.String,
      attempt: Schema.Int,
      goal: Schema.String,
      brief: Schema.String,
      threadId: Schema.NullOr(ThreadId),
      runId: Schema.NullOr(RunId),
      evidence: Schema.Array(Schema.String),
      notice: Schema.String,
    }),
  ),
});
export type AssistantOverview = typeof AssistantOverview.Type;
export const SpokenReply = Schema.NullOr(Schema.Struct({ runId: RunId, text: Schema.String }));
