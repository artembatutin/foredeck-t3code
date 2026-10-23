import { standardStages } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";
import type {
  FactoryAdvance,
  FactoryAwaiting,
  FactoryBlock,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
} from "./state.ts";
import { stageHandler } from "./stages/registry.ts";

/** Repairable settle problems get this many mechanical fix-commit turns before the delivery blocks. */
const FIX_COMMIT_TURNS = 1;

/** The awaited state each effect answers to, so a worker failure is matched to its effect. */
const AWAITING_BY_EFFECT: Readonly<Record<FactoryEffect["type"], FactoryAwaiting["type"]>> = {
  launch_thread: "launch",
  send_fix_commit_turn: "turn",
  check_settle: "settle",
  run_command: "command",
};

const step = (delivery: FactoryDeliveryState, ...effects: FactoryEffect[]): FactoryAdvance => ({
  delivery,
  effects,
});

/** A stale event's result: the very same state and no effects. */
const unchanged = (delivery: FactoryDeliveryState) => step(delivery);

const blocked = (delivery: FactoryDeliveryState, block: FactoryBlock) =>
  step({ ...delivery, status: "blocked", awaiting: null, block });

const begin = (delivery: FactoryDeliveryState, stage: FactoryStageDefinition): FactoryAdvance => {
  const lookup = stageHandler(stage.kind);
  return lookup.type === "supported"
    ? lookup.handler.begin(delivery, stage)
    : blocked(
        { ...delivery, stage: stage.name },
        { reason: "unsupported_stage", stage: stage.name },
      );
};

const sameRun = (
  awaiting: FactoryAwaiting | null,
  type: "run" | "settle",
  event: { readonly threadId: string; readonly runId: string },
) =>
  awaiting?.type === type && awaiting.threadId === event.threadId && awaiting.runId === event.runId;

/**
 * Folds one event into a delivery and returns the effects the worker must carry out. Pure: no
 * services, I/O or clock, and the input is never mutated, so a delivery's events replay to the
 * same state. An event that does not answer what the delivery awaits (another thread, run or
 * command attempt, a stage it is not in, a delivery that is not running) changes nothing.
 *
 * This covers a single item from start to a verified commit: the author thread, the branch
 * settle check with at most one fix-commit turn, then the verify command.
 */
export const advance = (delivery: FactoryDeliveryState, event: FactoryEvent): FactoryAdvance => {
  if (event.type === "start") {
    return delivery.status === "queued"
      ? begin({ ...delivery, status: "running" }, standardStages.author)
      : unchanged(delivery);
  }
  if (delivery.status !== "running") return unchanged(delivery);
  const { awaiting } = delivery;

  switch (event.type) {
    case "thread.launched": {
      if (awaiting?.type !== "launch") return unchanged(delivery);
      return step({
        ...delivery,
        worktreePath: delivery.worktreePath ?? event.worktreePath,
        baseline: event.baseline,
        threads: { ...delivery.threads, [awaiting.role]: event.threadId },
        awaiting: { type: "run", threadId: event.threadId, runId: event.runId },
      });
    }

    case "turn.started": {
      if (awaiting?.type !== "turn" || awaiting.threadId !== event.threadId) {
        return unchanged(delivery);
      }
      return step({
        ...delivery,
        awaiting: { type: "run", threadId: event.threadId, runId: event.runId },
      });
    }

    case "run.finished": {
      if (!sameRun(awaiting, "run", event)) return unchanged(delivery);
      if (event.status !== "completed") {
        return blocked(delivery, {
          reason: "run_ended",
          threadId: event.threadId,
          runId: event.runId,
          runStatus: event.status,
        });
      }
      return step(
        { ...delivery, awaiting: { type: "settle", threadId: event.threadId, runId: event.runId } },
        { type: "check_settle", threadId: event.threadId, runId: event.runId },
      );
    }

    case "thread.deleted":
      return Object.values(delivery.threads).includes(event.threadId)
        ? blocked(delivery, { reason: "thread_deleted", threadId: event.threadId })
        : unchanged(delivery);

    case "settle.checked": {
      if (!sameRun(awaiting, "settle", event)) return unchanged(delivery);
      const { result } = event;
      if (result.status === "settled") return begin(delivery, standardStages.verify);
      if (result.status === "repairable" && delivery.fixCommitTurns < FIX_COMMIT_TURNS) {
        return step(
          {
            ...delivery,
            awaiting: { type: "turn", threadId: event.threadId },
            fixCommitTurns: delivery.fixCommitTurns + 1,
          },
          { type: "send_fix_commit_turn", threadId: event.threadId, problems: result.problems },
        );
      }
      return blocked(delivery, { reason: "unsettled", problems: result.problems });
    }

    case "command.finished": {
      if (
        awaiting?.type !== "command" ||
        awaiting.attempt !== event.attempt ||
        event.stage !== delivery.stage
      ) {
        return unchanged(delivery);
      }
      const { outcome } = event;
      if (outcome.type === "refused") {
        return blocked(delivery, { reason: "receipt_refused", refusals: outcome.refusals });
      }
      const recorded = { ...delivery, receipts: [...delivery.receipts, outcome.receipt] };
      if (outcome.receipt.timedOut || outcome.receipt.code !== 0) {
        return blocked(recorded, { reason: "verify_failed" });
      }
      // The end of what this server runs: review is not built yet. No owner decision fixes the
      // status for a verified commit that review has not seen, so the delivery stops (operator
      // choice for this phase): not running and not terminal, with the verified checkpoint kept
      // as stage `verify` and the passing receipt last. This is neither review approval nor
      // delivery completion; review resumes from this checkpoint once it exists.
      return step({ ...recorded, status: "stopped", awaiting: null });
    }

    case "effect.failed":
      return awaiting?.type === AWAITING_BY_EFFECT[event.effect]
        ? blocked(delivery, { reason: "effect_failed", effect: event.effect, detail: event.detail })
        : unchanged(delivery);
  }
};
