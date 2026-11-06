import { OrchestratorMcpFailure, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpCallerPolicy from "../../mcp/McpCallerPolicy.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import { FactoryAdmission, FactoryService } from "../factory/index.ts";
import { callerToolClass } from "./callerTools.ts";
import { readWorkWith } from "./FactoryAdmissionBridge.ts";

/** What a governed caller is told when the policy refuses a call (note 6.10). */
export const callerPolicyText = {
  active:
    "This thread belongs to a Factory delivery that the project assistant manages, so it cannot start, message, schedule, hand off or watch other work. Use delegate_task for a subtask (it runs under the delivery's slot), or ask the owner to do it.",
  retired:
    "This thread belongs to a Factory delivery whose assistant assignment has ended, so it cannot start, message, schedule, hand off or watch other work. Start new work from your own thread, or retry the assignment.",
  family: "A managed Factory delivery can answer only its own delegated agents' requests.",
  message: (threadId: string) =>
    `Answering this question starts a new turn, which a managed Factory delivery cannot do. Ask the owner to answer it in thread ${threadId}.`,
  liveOnly: (threadId: string) =>
    `A managed Factory delivery can answer only live questions of its own running agents. Ask the owner to answer it in thread ${threadId}.`,
  readFailure:
    "T3 could not confirm whether this thread belongs to a managed Factory delivery. Nothing was done; try again.",
  notHolding:
    "The delivery is not holding a project assistant slot now; resume it from the assistant or let its current step finish.",
} as const;

type Policy = typeof McpCallerPolicy.McpCallerPolicy.Service;

const allow: McpCallerPolicy.McpCallerScreen = { type: "allow" };
const refuse = (text: string): McpCallerPolicy.McpCallerScreen => ({ type: "refuse", text });

const RespondArguments = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  requestId: Schema.optional(RuntimeRequestId),
});
const decodeRespondArguments = Schema.decodeUnknownOption(RespondArguments);

/** A delegation the policy refuses, as `delegate_task` reports it. */
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const unconfirmed = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: callerPolicyText.readFailure,
  });

/** Why a managed root's delegation is refused, as its agent reads it. */
const delegationRefusal = (category: HandoffAdmission.Refusal | "not_holding") => {
  switch (category) {
    case "not_holding":
      return callerPolicyText.notHolding;
    case "ended":
      return callerPolicyText.retired;
    default:
      return `This delivery cannot delegate now. ${FactoryAdmission.admissionRefusalText[category]}`;
  }
};

/**
 * The project assistant's caller policy over MCP (see `McpCallerPolicy`), for the threads of the
 * Factory deliveries it manages: a caller is governed when its thread's family root (see
 * `FactoryService.familyRoot`) has a managed root, active, ending or retired. A governed caller
 * cannot run a tool that starts, messages, schedules, hands off or watches work (see
 * `callerTools`): its credential belongs to the thread, not to one run, so nothing tells the
 * owner's turn from Factory's there, and such a run would escape the delivery's slot. It can
 * answer only a pending live question of a run already counted under a slot its root holds,
 * which continues that run and starts none, and it delegates under that slot. Never-managed
 * deliveries, other threads and outside clients are unchanged. Whatever cannot be read refuses.
 */
export const make = Effect.gen(function* () {
  const factory = yield* FactoryService.FactoryService;
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const readWork = readWorkWith(yield* HandoffBackend.HandoffBackend);

  /** The governed caller's root and its management, or none for a caller that is not governed. */
  const governing = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* factory.familyRoot(threadId);
      if (root === null) return undefined;
      const management = yield* admission.management(root);
      return management === "never" ? undefined : { root, management };
    });

  /** An answer to a request: only a pending live question of a counted run of the root's own. */
  const judgeAnswer = (
    caller: McpInvocationContext.McpThreadCaller,
    governed: {
      readonly root: FactoryDeliveryId;
      readonly management: HandoffAdmission.Management;
    },
    args: unknown,
  ) =>
    Effect.gen(function* () {
      // Every managed answer of an ended management is refused.
      if (governed.management === "retired") return callerPolicyText.retired;
      const { threadId, requestId } = Option.getOrElse(decodeRespondArguments(args), () => ({
        threadId: undefined,
        requestId: undefined,
      }));
      const target = threadId ?? caller.threadId;
      // An answer that names no request cannot be shown to continue a counted run.
      if (requestId === undefined) return callerPolicyText.liveOnly(target);
      const ownership = yield* factory.requestOwnership({ threadId: target, requestId });
      const slot = yield* admission.slot(governed.root);
      if (ownership.root !== governed.root) return callerPolicyText.family;
      const { request, run } = ownership;
      // Core would resolve it and start a turn with the answer: refused before anything moves.
      if (request?.capability === "message") return callerPolicyText.message(target);
      const live =
        slot === "held" &&
        request?.status === "pending" &&
        request.kind === "user_input" &&
        request.capability === "live" &&
        run !== null &&
        !isTerminalRunStatus(run.status) &&
        run.class !== "explicit";
      return live ? undefined : callerPolicyText.liveOnly(target);
    });

  const screen: Policy["screen"] = ({ caller, calls }) => {
    const classed = calls.map((call) => ({ call, toolClass: callerToolClass(call.tool) }));
    // Reads only for calls the policy may refuse.
    if (classed.every(({ toolClass }) => toolClass === "allow")) return Effect.succeed(allow);
    return Effect.gen(function* () {
      const governed = yield* governing(caller.threadId);
      if (governed === undefined) return allow;
      const active = governed.management === "active";
      // A batch is refused whole, by its first refused call.
      for (const { call, toolClass } of classed) {
        const refusal =
          toolClass === "allow"
            ? undefined
            : toolClass === "refuse"
              ? active
                ? callerPolicyText.active
                : callerPolicyText.retired
              : toolClass === "delegate"
                ? active
                  ? undefined
                  : callerPolicyText.retired
                : yield* judgeAnswer(caller, governed, call.arguments);
        if (refusal !== undefined) return refuse(refusal);
      }
      return allow;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("the caller policy could not read whose a thread is", error).pipe(
          Effect.as(refuse(callerPolicyText.readFailure)),
        ),
      ),
    );
  };

  const delegation: Policy["delegation"] = (scope, handler) =>
    Effect.gen(function* () {
      const thread = scope.thread;
      if (thread === undefined) return yield* handler;
      const governed = yield* governing(thread.threadId).pipe(Effect.mapError(unconfirmed));
      if (governed === undefined) return yield* handler;
      if (governed.management !== "active") return yield* denied(callerPolicyText.retired);
      const messageId = `mcp-delegation:${yield* randomUuidV4}`;
      const admit = (work?: HandoffAdmission.WorkRead) =>
        admission
          .admitDelegation({
            root: governed.root,
            threadId: thread.threadId,
            messageId,
            ...(work === undefined ? {} : { work }),
          })
          .pipe(Effect.mapError(unconfirmed));
      // The fresh read of the root's item, outside any SQL transaction, before admitting.
      const first = yield* admit();
      const decided =
        first.type === "needs_work"
          ? yield* admission.dispatchAdmitted(
              admit(yield* readWork(first.item)),
              // The handler commits the child's thread and run in its own fiber, so it stays
              // interruptible; the admission is marked dispatched once it ends, however it ends.
              () => handler,
              { interruptible: true },
            )
          : { decision: first, value: Option.none() };
      const { decision, value } = decided;
      switch (decision.type) {
        case "admitted":
          if (Option.isSome(value)) return value.value;
          return yield* unconfirmed();
        case "unmanaged":
          return yield* handler;
        case "refused":
          return yield* denied(delegationRefusal(decision.category));
        case "needs_work":
          return yield* unconfirmed();
      }
    });

  return { screen, delegation } satisfies Policy;
});
