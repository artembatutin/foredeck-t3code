import { Prepared } from "./Looper.ts";
import {
  CommandId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ProjectBrief } from "./portfolio.ts";

export const Dispatch = Schema.Struct({
  assignmentId: Schema.String,
  managerThreadId: ThreadId,
  brief: ProjectBrief,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  cancelRequested: Schema.Boolean,
  resumeWorkspace: Schema.NullOr(
    Schema.Struct({ worktreePath: Schema.String, branch: Schema.NullOr(Schema.String) }),
  ),
  answeredRequestIds: Schema.Array(Schema.String),
  lastProgress: Schema.String,
  lastNotice: Schema.String,
  looper: Schema.NullOr(Prepared),
  looperRunId: Schema.NullOr(Schema.String),
  previousLooperRunId: Schema.NullOr(Schema.String),
  history: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      runId: Schema.NullOr(RunId),
      looperRunId: Schema.NullOr(Schema.String),
      brief: ProjectBrief,
      state: Schema.String,
      attempt: Schema.Int,
      evidence: Schema.Array(Schema.String),
    }),
  ),
  looperConfig: Schema.NullOr(Schema.String),
});
export type Dispatch = typeof Dispatch.Type;
export const OCCUPIED_STATES = [
  "launching",
  "launch-uncertain",
  "running",
  "needs-input",
  "stopping",
] as const;
