import { standardStages } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";
import { acceptedReview, issue } from "./state.ts";
import type {
  FactoryAcceptedReview,
  FactoryAdvance,
  FactoryBlock,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryReviewJudgment,
} from "./state.ts";
import { stageHandler } from "./stages/registry.ts";

/** Repairable settle problems get this many mechanical fix-commit turns before the delivery blocks. */
const FIX_COMMIT_TURNS = 1;

/** Invalid review submissions a round answers with a corrected retry before the delivery blocks. */
const REVIEW_RETRIES = 1;

/** A step that issues no effect; `issue` makes the steps that do. */
const step = (delivery: FactoryDeliveryState): FactoryAdvance => ({ delivery, effects: [] });

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

/** A new review round: a fresh retry budget, and no review accepted for it yet. */
const beginReview = (delivery: FactoryDeliveryState) =>
  begin(
    { ...delivery, reviewRound: delivery.reviewRound + 1, invalidSubmissions: 0 },
    standardStages.review,
  );

/** Acts on the round's accepted review once its run has completed. */
const concludeReview = (delivery: FactoryDeliveryState, review: FactoryAcceptedReview) =>
  review.summary.blocking
    ? blocked(delivery, { reason: "review_changes_required", summary: review.summary })
    : begin(delivery, standardStages.record);

/**
 * Folds a judged submission into the round. `accepted` continues with the recorded review and
 * `retry` with the counted first invalid submission; a second invalid one, or changed code,
 * blocks.
 */
const judge = (
  delivery: FactoryDeliveryState,
  judgment: FactoryReviewJudgment,
  next: {
    readonly accepted: (
      delivery: FactoryDeliveryState,
      review: FactoryAcceptedReview,
    ) => FactoryAdvance;
    readonly retry: (
      delivery: FactoryDeliveryState,
      problems: ReadonlyArray<string>,
    ) => FactoryAdvance;
  },
): FactoryAdvance => {
  switch (judgment.type) {
    case "accepted": {
      const review = { ...judgment.review, round: delivery.reviewRound };
      return next.accepted({ ...delivery, reviews: [...delivery.reviews, review] }, review);
    }
    case "invalid": {
      const counted = { ...delivery, invalidSubmissions: delivery.invalidSubmissions + 1 };
      return counted.invalidSubmissions > REVIEW_RETRIES
        ? blocked(counted, { reason: "invalid_submission", problems: judgment.problems })
        : next.retry(counted, judgment.problems);
    }
    case "code_changed":
      return blocked(delivery, { reason: "code_changed", changes: judgment.changes });
  }
};

const isEffectOf = <T extends FactoryEffect["type"]>(
  effect: FactoryEffect,
  type: T,
): effect is Extract<FactoryEffect, { readonly type: T }> => effect.type === type;

/** The awaited effect when a worker result of `type` names it; undefined when the result is stale. */
const awaitedEffect = <T extends FactoryEffect["type"]>(
  delivery: FactoryDeliveryState,
  effectId: number,
  type: T,
) => {
  const { awaiting } = delivery;
  return awaiting?.type === "effect" &&
    awaiting.effect.id === effectId &&
    isEffectOf(awaiting.effect, type)
    ? awaiting.effect
    : undefined;
};

/**
 * Folds one event into a delivery and returns the effects the worker must carry out. Pure: no
 * services, I/O or clock, and the input is never mutated, so a delivery's events replay to the
 * same state. An event that does not answer what the delivery awaits (a result for another
 * effect, a run of another thread or an earlier run, a submission for another round, a stage it
 * is not in, a delivery that is not running) changes nothing.
 *
 * This covers a single item from start to the first review's verdict: the author thread, the
 * branch settle check with at most one fix-commit turn, the verify command, then a reviewer
 * thread whose one accepted review per round is acted on once its run completes.
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
      const launch = awaitedEffect(delivery, event.effectId, "launch_thread");
      if (launch === undefined) return unchanged(delivery);
      return step({
        ...delivery,
        worktreePath: delivery.worktreePath ?? event.worktreePath,
        // The task baseline is the author's; a reviewer starts at the commit it reviews.
        baseline: launch.role === "author" ? event.baseline : delivery.baseline,
        threads: { ...delivery.threads, [launch.role]: event.threadId },
        awaiting: { type: "run", threadId: event.threadId, runId: event.runId },
      });
    }

    case "turn.started": {
      const turn =
        awaitedEffect(delivery, event.effectId, "send_fix_commit_turn") ??
        awaitedEffect(delivery, event.effectId, "send_review_retry_turn");
      if (turn === undefined) return unchanged(delivery);
      return step({
        ...delivery,
        awaiting: { type: "run", threadId: turn.threadId, runId: event.runId },
      });
    }

    case "run.finished": {
      if (
        awaiting?.type !== "run" ||
        awaiting.threadId !== event.threadId ||
        awaiting.runId !== event.runId
      ) {
        return unchanged(delivery);
      }
      if (event.status !== "completed") {
        return blocked(delivery, {
          reason: "run_ended",
          threadId: event.threadId,
          runId: event.runId,
          runStatus: event.status,
        });
      }
      if (delivery.stage === "review") {
        // A review is acted on only once its run completed; without one, the run's last
        // message may hold it in a fenced block.
        const accepted = acceptedReview(delivery);
        return accepted === undefined
          ? issue(delivery, {
              type: "read_fallback_review",
              threadId: event.threadId,
              runId: event.runId,
            })
          : concludeReview(delivery, accepted);
      }
      return issue(delivery, {
        type: "check_settle",
        threadId: event.threadId,
        runId: event.runId,
      });
    }

    case "thread.deleted":
      return Object.values(delivery.threads).includes(event.threadId)
        ? blocked(delivery, { reason: "thread_deleted", threadId: event.threadId })
        : unchanged(delivery);

    case "settle.checked": {
      const check = awaitedEffect(delivery, event.effectId, "check_settle");
      if (check === undefined) return unchanged(delivery);
      const { result } = event;
      if (result.status === "settled") return begin(delivery, standardStages.verify);
      if (result.status === "repairable" && delivery.fixCommitTurns < FIX_COMMIT_TURNS) {
        return issue(
          { ...delivery, fixCommitTurns: delivery.fixCommitTurns + 1 },
          { type: "send_fix_commit_turn", threadId: check.threadId, problems: result.problems },
        );
      }
      return blocked(delivery, { reason: "unsettled", problems: result.problems });
    }

    case "command.finished": {
      if (awaitedEffect(delivery, event.effectId, "run_command") === undefined) {
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
      return beginReview(recorded);
    }

    case "review.submitted": {
      // Only the round's reviewer run, while it runs, and only until one review is accepted.
      if (
        delivery.stage !== "review" ||
        event.round !== delivery.reviewRound ||
        awaiting?.type !== "run" ||
        awaiting.threadId !== event.threadId ||
        awaiting.runId !== event.runId ||
        acceptedReview(delivery) !== undefined
      ) {
        return unchanged(delivery);
      }
      // The reviewer is still in its turn: an accepted review waits for the run to complete, and
      // an invalid one is corrected in the same turn from the tool's answer.
      return judge(delivery, event.judgment, { accepted: step, retry: step });
    }

    case "review.read": {
      const read = awaitedEffect(delivery, event.effectId, "read_fallback_review");
      if (read === undefined) return unchanged(delivery);
      // The run has completed: act on an accepted review now, or ask for a corrected one.
      return judge(delivery, event.judgment, {
        accepted: concludeReview,
        retry: (counted, problems) =>
          issue(counted, { type: "send_review_retry_turn", threadId: read.threadId, problems }),
      });
    }

    case "effect.failed":
      return awaiting?.type === "effect" && awaiting.effect.id === event.effectId
        ? blocked(delivery, {
            reason: "effect_failed",
            effect: awaiting.effect,
            detail: event.detail,
          })
        : unchanged(delivery);
  }
};
