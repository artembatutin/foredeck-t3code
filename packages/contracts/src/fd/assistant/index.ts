import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, RunId } from "../../baseSchemas.ts";
import { FactoryDelivery, FactoryStageRunSummary } from "../factory/index.ts";
import { WorkItemId, WorkSourceId } from "../work-management/index.ts";

export class AssistantOperationError extends Schema.TaggedError<AssistantOperationError>()(
  "AssistantOperationError",
  { message: Schema.String },
) {}

/** A Work item as its capture recorded it; `key` and `url` are null once a capture replaced it. */
const AssistantWorkItem = Schema.Struct({
  sourceId: WorkSourceId,
  itemId: WorkItemId,
  key: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});

/**
 * A Factory assignment's delivery, bounded however much work waits on it. `status` and `stage` are
 * the child a parent awaits while that child is what stopped or blocked it, otherwise the root's;
 * `status` is null while no delivery row exists, and `unknown` when it could not be read or this
 * build does not know it.
 */
const AssistantFactoryDelivery = Schema.Struct({
  deliveryId: Schema.String,
  status: Schema.NullOr(FactoryDelivery.fields.status),
  stage: Schema.NullOr(FactoryStageRunSummary.fields.stage),
  /** Why it waits on its owner, at the plan gate or blocked. */
  needsYou: Schema.NullOr(Schema.String),
  /** An awaited effect is marked as waiting for a project assistant slot. */
  capacityWait: Schema.Boolean,
  /** Automatic follow-ups of the delivery's threads that have not run. */
  automaticWaits: Schema.Struct({ waiting: NonNegativeInt, blocked: NonNegativeInt }),
  /** Automatic follow-ups declined after the delivery ended, or lost on a restart. */
  endedDispositions: NonNegativeInt,
  /** The newest of those waits and dispositions in their notices' words, a few of each. */
  notices: Schema.Array(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  /** The thread it awaits, or else its latest author's. */
  threadId: Schema.NullOr(ThreadId),
});

/**
 * What the assistant's panel shows. Everything past the original fields is optional: an older
 * server sends none of it, and an older client drops it.
 */
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
      /** The idea's Work capture; `item` stays null until a capture has named one. */
      capture: Schema.optionalKey(
        Schema.Struct({ state: Schema.String, item: Schema.NullOr(AssistantWorkItem) }),
      ),
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
      executor: Schema.optionalKey(Schema.String),
      /** Absent until a Factory assignment is claimed, and after a retry clears its delivery. */
      factory: Schema.optionalKey(AssistantFactoryDelivery),
      workItem: Schema.optionalKey(AssistantWorkItem),
    }),
  ),
});
export type AssistantOverview = typeof AssistantOverview.Type;
export const SpokenReply = Schema.NullOr(Schema.Struct({ runId: RunId, text: Schema.String }));
