import {
  OrchestratorMcpFailure,
  ProjectId,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Assistant from "./ProjectAssistant.ts";
import { BriefPatch } from "./portfolio.ts";

const common = {
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Assistant.ProjectAssistant,
    McpInvocationContext.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
export const AssistantToolkit = Toolkit.make(
  Tool.make("voice_reply", {
    ...common,
    description:
      "Save a separately composed owner-facing spoken answer for this turn. Use one or two natural sentences unless the owner asks for more. Lead with the outcome or focused question. No tool narration, progress, markup or technical logs. Call once when ready to give your final answer; the client plays it only after this run completes and only when voice is enabled.",
    parameters: Schema.Struct({ text: TrimmedNonEmptyString.check(Schema.isMaxLength(1600)) }),
  }),
  Tool.make("assistant_portfolio", {
    ...common,
    description:
      "Read the authoritative, bounded project portfolio. Pass projectId for its full brief, assignments and exact worker IDs. Only the project assistant can read the portfolio.",
    parameters: Schema.Struct({
      projectId: Schema.optionalKey(ProjectId),
      ideaId: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("assistant_revise_brief", {
    ...common,
    description:
      "Persist an agreed project brief or correction. Save goals, criteria, constraints, questions, priority rank/reason and explicit execution authorization. Ask about ambiguous priority. A change does not interrupt workers; queued work with changed scope needs a new assignment.",
    parameters: Schema.Struct({
      projectId: ProjectId,
      ideaId: TrimmedNonEmptyString,
      patch: BriefPatch,
      reason: Schema.optionalKey(Schema.String),
    }),
  }),
  Tool.make("assistant_assign", {
    ...common,
    description:
      "Queue authorized work using a stable assignmentId, reused after a lost reply. The server launches at most two assignments in priority order with fresh project-only contexts and isolated Git worktrees. Default executor is Foredeck. Pass an actual validated Looper configuration path only when the owner selected Looper. Returning queued does not mean launched.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      projectId: ProjectId,
      ideaId: TrimmedNonEmptyString,
      looperConfig: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  }),
  Tool.make("assistant_control", {
    ...common,
    description:
      "Stop, resume, retry or cancel the exact assignment. Stop waits for executor confirmation; cancel running work requests a stop first. Resume/retry uses a fresh attempt. Uncertain launches must be reconciled before retrying. Does not stop other projects.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      action: Schema.Literals(["stop", "resume", "retry", "cancel"]),
    }),
  }),
  Tool.make("assistant_answer", {
    ...common,
    description:
      "Route the owner's answer to the exact pending question on this assignment. Pass its requestId from the worker. Cannot approve permissions; use the worker approval UI for those.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      requestId: RuntimeRequestId,
      answers: ProviderUserInputAnswers,
    }),
  }),
  Tool.make("assistant_verify", {
    ...common,
    description:
      "After inspecting the worker's actual results, record acceptance-criterion verification evidence and mark the assignment complete. Evidence must distinguish implemented, tested, integrated and deployed, including limitations. A worker's completed turn alone is not sufficient.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      evidence: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
    }),
  }),
);
const manager = Effect.gen(function* () {
  const context = yield* readCaller();
  if (!context.caller || !isAssistantThread(context.caller.id))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This tool belongs to the persistent project assistant.",
    });
  return context.caller;
});
const result = <A, R>(effect: Effect.Effect<A, Assistant.AssistantError, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
export const toolLayer = McpToolAccess.toLayer(AssistantToolkit, {
  voice_reply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (!caller)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A conversation is required.",
        });
      yield* result((yield* Assistant.ProjectAssistant).saveSpeech(caller.id, input.text));
      return { saved: true };
    }),
  ),
  assistant_portfolio: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* manager;
      return yield* result(
        (yield* Assistant.ProjectAssistant).inspect(input.projectId, input.ideaId),
      );
    }),
  ),
  assistant_revise_brief: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* manager;
      return yield* result((yield* Assistant.ProjectAssistant).revise(input));
    }),
  ),
  assistant_assign: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const caller = yield* manager;
        return yield* result(
          (yield* Assistant.ProjectAssistant).enqueue({
            ...input,
            ...modes,
            managerThreadId: caller.id,
            modelSelection: caller.modelSelection,
            looperConfig: input.looperConfig ?? null,
          }),
        );
      }),
  ),
  assistant_control: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const caller = yield* manager;
        return yield* result(
          (yield* Assistant.ProjectAssistant).control({ ...input, managerThreadId: caller.id }),
        );
      }),
  ),
  assistant_answer: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const caller = yield* manager;
        yield* result(
          (yield* Assistant.ProjectAssistant).answer({ ...input, managerThreadId: caller.id }),
        );
        return { answered: true };
      }),
  ),
  assistant_verify: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* manager;
      return yield* result(
        (yield* Assistant.ProjectAssistant).verify({ ...input, managerThreadId: caller.id }),
      );
    }),
  ),
});
