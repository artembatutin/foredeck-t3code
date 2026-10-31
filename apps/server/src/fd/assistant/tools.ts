import {
  OrchestratorMcpFailure,
  ProjectId,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { readCaller } from "../../mcp/threadAccess.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Assistant from "./ProjectAssistant.ts";
import { BriefPatch } from "./portfolio.ts";
import * as WorkCapture from "./WorkCapture.ts";

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
const capturing = {
  ...common,
  dependencies: [
    WorkCapture.WorkCapture,
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
      "Queue authorized work using a stable assignmentId, reused after a lost reply. The server launches at most two assignments in priority order with fresh project-only contexts and isolated Git worktrees. Default executor is Foredeck. Pass an actual validated Looper configuration path only when the owner selected Looper. Pass executor factory to deliver the idea's captured Work item through Factory: it needs a saved capture the owner reviewed, their explicit authorization and the project's verify command, and Factory plans, verifies, reviews and opens the pull request. Returning queued does not mean launched.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      projectId: ProjectId,
      ideaId: TrimmedNonEmptyString,
      looperConfig: Schema.optionalKey(TrimmedNonEmptyString),
      executor: Schema.optionalKey(Schema.Literals(["foredeck", "factory"])),
    }),
  }),
  Tool.make("assistant_control", {
    ...common,
    description:
      "Stop, resume, retry or cancel the exact assignment. Stop waits for executor confirmation; cancel running work requests a stop first. Resume/retry uses a fresh attempt. Uncertain launches must be reconciled before retrying. For a Factory assignment, stop and resume act on its delivery, cancel shows stopping until Factory has ended and its threads are quiet, and retry starts a new delivery only after the old one ended. Does not stop other projects.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      action: Schema.Literals(["stop", "resume", "retry", "cancel"]),
    }),
  }),
  Tool.make("assistant_answer", {
    ...common,
    description:
      "Route the owner's answer to the exact pending question on this assignment. Pass its requestId from the worker. Cannot approve permissions; use the worker approval UI for those. For a Factory assignment, only a live question from Factory's own running agent can be answered here; any other is answered in its thread.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      requestId: RuntimeRequestId,
      answers: ProviderUserInputAnswers,
    }),
  }),
  Tool.make("assistant_verify", {
    ...common,
    description:
      "After inspecting the worker's actual results, record acceptance-criterion verification evidence and mark the assignment complete. Evidence must distinguish implemented, tested, integrated and deployed, including limitations. A worker's completed turn alone is not sufficient. Refused for a Factory assignment, which completes itself once its pull request merges and Factory closes it out.",
    parameters: Schema.Struct({
      assignmentId: TrimmedNonEmptyString,
      evidence: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
    }),
  }),
  Tool.make("assistant_capture_work", {
    ...capturing,
    description:
      "Only when the owner explicitly asks, create or update the one Work item that records an idea's saved brief: titled from the goal, with the goal, numbered acceptance criteria, constraints, decisions and open questions. Pass sourceId when the project has several Work sources (ask the owner which); kind parent, for a goal Factory should plan into tasks, needs a Markdown source. It never starts, queues or authorizes work, and a capture that changes the item clears execution authorization until the owner has reviewed it in Work. An item edited in Work since its capture is refused unless overwrite is true. For an uncertain capture, recoverItem adopts the item id the owner found.",
    parameters: Schema.Struct({
      projectId: ProjectId,
      ideaId: TrimmedNonEmptyString,
      kind: Schema.Literals(["single", "parent"]),
      sourceId: Schema.optionalKey(TrimmedNonEmptyString),
      overwrite: Schema.optionalKey(Schema.Boolean),
      recoverItem: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  }),
  Tool.make("assistant_abandon_capture", {
    ...capturing,
    description:
      "Drop an idea's Work capture, for an uncertain capture whose item cannot be found, or to capture the idea anew. The Work item and the capture's history stay; the next capture creates a new item. Refused while the capture is being written or a Factory assignment that has not ended uses it.",
    parameters: Schema.Struct({ projectId: ProjectId, ideaId: TrimmedNonEmptyString }),
  }),
);
const assistantCaller = Effect.gen(function* () {
  const context = yield* readCaller();
  if (!context.caller || !isAssistantThread(context.caller.id))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This tool belongs to the persistent project assistant.",
    });
  return { ...context, caller: context.caller };
});
const manager = Effect.map(assistantCaller, (context) => context.caller);
const result = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
const decodeSourceId = Schema.decodeUnknownOption(WorkSourceId);
const decodeItemId = Schema.decodeUnknownOption(WorkItemId);
/** An optional id parameter decoded, or the tool's refusal naming it. */
const optionalId = <A>(
  decode: (value: unknown) => Option.Option<A>,
  value: string | undefined,
  message: string,
): Effect.Effect<A | undefined, OrchestratorMcpFailure> =>
  value === undefined
    ? Effect.undefined
    : Effect.fromOption(decode(value)).pipe(
        Effect.mapError(() => new OrchestratorMcpFailure({ code: "invalid_request", message })),
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
  assistant_capture_work: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* assistantCaller;
      const sourceId = yield* optionalId(
        decodeSourceId,
        input.sourceId,
        `${input.sourceId} is not a Work source id.`,
      );
      const recoverItem = yield* optionalId(
        decodeItemId,
        input.recoverItem,
        `${input.recoverItem} is not a Work item id.`,
      );
      return yield* result(
        (yield* WorkCapture.WorkCapture).capture({
          caller,
          projectId: input.projectId,
          ideaId: input.ideaId,
          kind: input.kind,
          sourceId,
          overwrite: input.overwrite,
          recoverItem,
        }),
      );
    }),
  ),
  assistant_abandon_capture: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* assistantCaller;
      return yield* result((yield* WorkCapture.WorkCapture).abandon({ ...input, caller }));
    }),
  ),
});
