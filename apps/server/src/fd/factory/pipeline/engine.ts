import { standardStages } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";
import { acceptedReview, isTurnEffect, issue, receiptFailed } from "./state.ts";
import type {
  FactoryAcceptedReview,
  FactoryAdvance,
  FactoryBlock,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryRepairedStage,
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

/**
 * A new review round: a fresh retry budget, and no review accepted for it yet. The first round
 * launches a fresh reviewer that never sees the author's account; after a fix-review round the
 * reviewer thread goes on with a follow-up turn that carries the author's reply.
 */
const beginReview = (delivery: FactoryDeliveryState): FactoryAdvance => {
  const next = { ...delivery, reviewRound: delivery.reviewRound + 1, invalidSubmissions: 0 };
  const { reviewer } = delivery.threads;
  return reviewer !== undefined && delivery.reviewResponse !== null
    ? issue(
        { ...next, stage: "review" },
        { type: "send_review_follow_up_turn", threadId: reviewer, round: next.reviewRound },
      )
    : begin(next, standardStages.review);
};

/**
 * Answers a failed verify or a blocking review with the next repair round on the author thread.
 * The failure's fingerprint is recorded; one the task already recorded blocks instead, since the
 * round before saw the same failure on the same tree. With the stage's rounds spent, the delivery
 * blocks with `exhausted`.
 */
const repair = (
  delivery: FactoryDeliveryState,
  failure: {
    readonly stage: FactoryRepairedStage;
    readonly fingerprint: string | undefined;
    readonly exhausted: FactoryBlock;
  },
): FactoryAdvance => {
  const { fingerprint } = failure;
  if (fingerprint !== undefined && delivery.fingerprints.includes(fingerprint)) {
    return blocked(delivery, { reason: "repeated_failure", stage: failure.stage });
  }
  const recorded =
    fingerprint === undefined
      ? delivery
      : { ...delivery, fingerprints: [...delivery.fingerprints, fingerprint] };
  const { rounds, limits } = delivery;
  const fixing = failure.stage === "verify";
  const spent = fixing ? rounds.fix : rounds.review;
  // The author thread exists from the author stage on; verify and review come after it.
  const { author } = delivery.threads;
  if (spent >= (fixing ? limits.maxFixRounds : limits.maxReviewRounds) || author === undefined) {
    return blocked(recorded, failure.exhausted);
  }
  const round = spent + 1;
  return issue(
    {
      ...recorded,
      stage: "repair",
      rounds: fixing ? { ...rounds, fix: round } : { ...rounds, review: round },
    },
    {
      type: "send_repair_turn",
      kind: fixing ? "fix-verify" : "fix-review",
      threadId: author,
      round,
    },
  );
};

/** Acts on the round's accepted review once its run has completed. */
const concludeReview = (delivery: FactoryDeliveryState, review: FactoryAcceptedReview) =>
  review.summary.blocking
    ? repair(delivery, {
        stage: "review",
        fingerprint: review.fingerprint,
        exhausted: { reason: "review_changes_required", summary: review.summary },
      })
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
 * This covers a single item from start to a passing review: the author thread, the branch
 * settle check with at most one fix-commit turn, the verify command, then a reviewer thread
 * whose one accepted review per round is acted on once its run completes. A failed verify or a
 * blocking review gets a repair turn on the author thread while the task has rounds of that kind
 * left and the failure is new; the repaired branch is settled and verified again, and a review
 * round after a fix-review continues the same reviewer thread.
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
        awaiting?.type === "effect" && awaiting.effect.id === event.effectId
          ? awaiting.effect
          : undefined;
      if (turn === undefined || !isTurnEffect(turn)) return unchanged(delivery);
      const run = { threadId: turn.threadId, runId: event.runId };
      return step({
        ...delivery,
        // The reply to the findings is what the next review round checks.
        reviewResponse:
          turn.type === "send_repair_turn" && turn.kind === "fix-review"
            ? run
            : delivery.reviewResponse,
        awaiting: { type: "run", ...run },
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
      if (receiptFailed(outcome.receipt)) {
        return repair(recorded, {
          stage: "verify",
          fingerprint: outcome.fingerprint,
          exhausted: { reason: "verify_failed" },
        });
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
