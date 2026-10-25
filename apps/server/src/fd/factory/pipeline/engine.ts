import type { FactoryStageName } from "@t3tools/contracts/fd/factory";

import { standardStages } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";
import {
  acceptedPlan,
  acceptedReview,
  blocked,
  isTerminal,
  isTurnEffect,
  issue,
  receiptFailed,
  runsStages,
  unrecordedAuthorLaunch,
  unrecordedPlannerLaunch,
} from "./state.ts";
import type {
  FactoryAcceptedPlan,
  FactoryAcceptedReview,
  FactoryAdvance,
  FactoryBlock,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryPlanJudgment,
  FactoryRepairedStage,
  FactoryResumeCheck,
  FactoryReviewJudgment,
} from "./state.ts";
import { stageHandler } from "./stages/registry.ts";

/** Repairable settle problems get this many mechanical fix-commit turns before the delivery blocks. */
const FIX_COMMIT_TURNS = 1;

/**
 * Invalid plan or review submissions a round answers with a corrected retry before the delivery
 * blocks.
 */
const SUBMISSION_RETRIES = 1;

/** A step that issues no effect; `issue` makes the steps that do. */
const step = (delivery: FactoryDeliveryState): FactoryAdvance => ({ delivery, effects: [] });

/** A stale event's result: the very same state and no effects. */
const unchanged = (delivery: FactoryDeliveryState) => step(delivery);

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
 * Begins the next stage with `proceed`, unless the owner asked the delivery to stop after its
 * step: a stopping delivery is `stopped` here instead, awaiting nothing, with the stage it would
 * have begun as its checkpoint. A failure found first still blocks it, so call this only once the
 * delivery would go on.
 */
const enter = (
  delivery: FactoryDeliveryState,
  checkpoint: FactoryStageName,
  proceed: (delivery: FactoryDeliveryState) => FactoryAdvance,
): FactoryAdvance =>
  delivery.status === "stopping"
    ? step({ ...delivery, status: "stopped", awaiting: null, checkpoint })
    : proceed(delivery);

/**
 * A new plan round: a fresh retry budget, and no plan accepted for it yet. The first round
 * launches the planner, which creates the delivery's worktree.
 */
const beginPlan = (delivery: FactoryDeliveryState): FactoryAdvance =>
  begin(
    { ...delivery, planRound: delivery.planRound + 1, invalidSubmissions: 0 },
    standardStages.plan,
  );

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
  return enter(recorded, "repair", (current) =>
    issue(
      {
        ...current,
        stage: "repair",
        rounds: fixing ? { ...rounds, fix: round } : { ...rounds, review: round },
      },
      {
        type: "send_repair_turn",
        kind: fixing ? "fix-verify" : "fix-review",
        threadId: author,
        round,
      },
    ),
  );
};

/**
 * A resumed delivery's fresh retry allowance (owner decision): repair rounds, fix-commit turns
 * and failure fingerprints start over, and its limits stay. Receipts, reviews and approvals stay
 * as its history; none is taken for the commit the resume finds.
 */
const resumed = (delivery: FactoryDeliveryState): FactoryDeliveryState => ({
  ...delivery,
  status: "running",
  block: null,
  checkpoint: null,
  fixCommitTurns: 0,
  rounds: { fix: 0, review: 0 },
  fingerprints: [],
});

type FactoryResumedWorktree = NonNullable<FactoryResumeCheck["worktree"]>;

/**
 * Whether the worktree holds the commit the delivery's task was approved for: HEAD and its tree
 * are the last receipt's, which passed, and the round's accepted review passed it.
 */
const holdsApprovedCommit = (
  delivery: FactoryDeliveryState,
  { commit, approvedSha }: FactoryResumedWorktree,
) => {
  const receipt = delivery.receipts.at(-1);
  const review = acceptedReview(delivery);
  return (
    commit !== null &&
    receipt !== undefined &&
    !receiptFailed(receipt) &&
    review !== undefined &&
    !review.summary.blocking &&
    approvedSha === commit.headSha &&
    receipt.headSha === commit.headSha &&
    receipt.tree === commit.tree
  );
};

/**
 * Picks a stopped or blocked delivery up from its checkpoint, the stage it stopped before or the
 * one it blocked in, like Looper's `--finish`. A deleted thread of the delivery blocks it again,
 * and so does a branch that cannot be repaired. A settled branch is verified again, never trusting
 * an earlier receipt, then reviewed; only a delivery resuming the PR stage on the very commit its
 * task was approved for opens its pull request at once. A branch with repairable problems gets one
 * fix-commit turn naming the checkpoint, and is settled after it as after any author turn.
 *
 * An author launch the delivery issued but never recorded is issued again under its own id (see
 * `unrecordedAuthorLaunch`), so it replays the thread and checkout it made, if any. When that
 * thread's run had already ended, the replay settles the branch at once, as a resume settles a
 * recorded author's, whatever way the run ended; a run still going is awaited like any other.
 * Only a delivery that issued no author launch launches one, as `start` does.
 */
const resume = (delivery: FactoryDeliveryState, check: FactoryResumeCheck): FactoryAdvance => {
  const lost = unrecordedAuthorLaunch(delivery);
  // Kept as the author launch whatever happens next, so every later resume finds it again.
  const known = lost === undefined ? delivery : { ...delivery, authorLaunch: lost };
  const { author } = known.threads;
  const deleted =
    author !== undefined && check.deletedThreads.includes(author)
      ? author
      : check.deletedThreads[0];
  if (deleted !== undefined) {
    return blocked(known, { reason: "thread_deleted", threadId: deleted });
  }
  const checkpoint = known.checkpoint ?? known.stage;
  if (author === undefined) {
    if (lost === undefined) return begin(resumed(known), standardStages.author);
    const launch = check.unrecordedAuthorRunEnded
      ? { ...lost, resumeCheckpoint: checkpoint ?? "author" }
      : lost;
    return {
      delivery: {
        ...resumed(known),
        stage: "author",
        awaiting: { type: "effect", effect: launch },
      },
      effects: [launch],
    };
  }
  const { worktree } = check;
  // The worktree is read whenever the author has launched; without it there is nothing to judge.
  if (worktree === null) return unchanged(delivery);
  const { settle } = worktree;
  if (settle.status === "unrepairable") {
    return blocked(delivery, { reason: "unsettled", problems: settle.problems });
  }
  if (settle.status === "repairable") {
    // The turn counts as the one fix-commit turn: a branch it leaves unsettled blocks.
    return issue(
      { ...resumed(delivery), stage: "repair", fixCommitTurns: FIX_COMMIT_TURNS },
      {
        type: "send_fix_commit_turn",
        threadId: author,
        problems: settle.problems,
        ...(checkpoint === null ? {} : { checkpoint }),
      },
    );
  }
  return checkpoint === "pr" && holdsApprovedCommit(delivery, worktree)
    ? begin({ ...resumed(delivery), status: "approved" }, standardStages.pr)
    : begin(resumed(delivery), standardStages.verify);
};

/**
 * Picks a parent that stopped or blocked while planning up again; it never begins the author
 * stage. A deleted thread of the delivery blocks it again. Stopped where it would have entered
 * the plan gate, it waits there again on the same plan, issuing nothing. A planner launch the
 * delivery issued but never recorded is issued again under its own id, as an author's is (see
 * `resume`); when that run had already ended, the planner gets its retry turn once the launch is
 * recorded. A recorded planner gets one plan retry turn in a new plan round, naming the problems
 * of the submission it blocked on. Only a parent that issued no planner launch launches one, as
 * `start` does.
 */
const resumePlanning = (
  delivery: FactoryDeliveryState,
  check: FactoryResumeCheck,
): FactoryAdvance => {
  const { planner } = delivery.threads;
  const deleted =
    planner !== undefined && check.deletedThreads.includes(planner)
      ? planner
      : check.deletedThreads[0];
  if (deleted !== undefined) {
    return blocked(delivery, { reason: "thread_deleted", threadId: deleted });
  }
  const plan = acceptedPlan(delivery);
  if (delivery.checkpoint === "approve_plan" && plan !== undefined && plan.tasks.length > 0) {
    return begin(resumed(delivery), standardStages.approve_plan);
  }
  if (planner === undefined) {
    const lost = unrecordedPlannerLaunch(delivery);
    if (lost === undefined) return beginPlan(resumed(delivery));
    const launch =
      check.unrecordedPlannerRunEnded === true
        ? { ...lost, resumeCheckpoint: "plan" as const }
        : lost;
    return {
      delivery: {
        ...resumed(delivery),
        stage: "plan",
        awaiting: { type: "effect", effect: launch },
      },
      effects: [launch],
    };
  }
  const { block } = delivery;
  return issue(
    {
      ...resumed(delivery),
      stage: "plan",
      planRound: delivery.planRound + 1,
      invalidSubmissions: 0,
    },
    {
      type: "send_plan_retry_turn",
      threadId: planner,
      problems: block?.reason === "invalid_submission" ? block.problems : [],
      checkpoint: "plan",
    },
  );
};

/**
 * Acts on the round's accepted plan once its run has completed. A plan with tasks enters the plan
 * gate, where the delivery waits for its owner; an empty one ends planning blocked, with the
 * planner's note.
 */
const concludePlan = (delivery: FactoryDeliveryState, plan: FactoryAcceptedPlan) =>
  plan.tasks.length === 0
    ? blocked(delivery, { reason: "plan_empty", note: plan.note ?? null })
    : enter(delivery, "approve_plan", (current) => begin(current, standardStages.approve_plan));

/** Acts on the round's accepted review once its run has completed. */
const concludeReview = (delivery: FactoryDeliveryState, review: FactoryAcceptedReview) =>
  review.summary.blocking
    ? repair(delivery, {
        stage: "review",
        fingerprint: review.fingerprint,
        exhausted: { reason: "review_changes_required", summary: review.summary },
      })
    : enter(delivery, "record", (current) => begin(current, standardStages.record));

/** Counts an invalid submission: the round's first continues with `retry`, a second blocks. */
const invalidSubmission = (
  delivery: FactoryDeliveryState,
  problems: ReadonlyArray<string>,
  retry: (delivery: FactoryDeliveryState, problems: ReadonlyArray<string>) => FactoryAdvance,
): FactoryAdvance => {
  const counted = { ...delivery, invalidSubmissions: delivery.invalidSubmissions + 1 };
  return counted.invalidSubmissions > SUBMISSION_RETRIES
    ? blocked(counted, { reason: "invalid_submission", problems })
    : retry(counted, problems);
};

/**
 * Folds a judged plan into the plan round. `accepted` continues with the recorded plan and
 * `retry` with the counted first invalid submission; a second invalid one blocks.
 */
const judgePlan = (
  delivery: FactoryDeliveryState,
  judgment: FactoryPlanJudgment,
  next: {
    readonly accepted: (
      delivery: FactoryDeliveryState,
      plan: FactoryAcceptedPlan,
    ) => FactoryAdvance;
    readonly retry: (
      delivery: FactoryDeliveryState,
      problems: ReadonlyArray<string>,
    ) => FactoryAdvance;
  },
): FactoryAdvance => {
  if (judgment.type === "invalid") {
    return invalidSubmission(delivery, judgment.problems, next.retry);
  }
  const plan = { ...judgment.plan, round: delivery.planRound };
  return next.accepted({ ...delivery, plan }, plan);
};

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
    case "invalid":
      return invalidSubmission(delivery, judgment.problems, next.retry);
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
 * is not in, a delivery that does not run its stages) changes nothing.
 *
 * A parent first plans: a planner thread on a new worktree of the delivery branch submits its
 * plan while its run goes on, and one accepted plan per plan round is acted on once that run
 * completes. A run that completes without one has its last message's fenced plan read, and the
 * round's first invalid submission is answered once (by the tool's reply in the same turn, or a
 * retry turn on the planner thread); a second blocks. A plan with tasks leaves the parent waiting
 * at `approve_plan` for its owner, awaiting nothing; an empty plan blocks it with the note.
 *
 * A single item runs from start to its pull request: the author thread, the branch settle
 * check with at most one fix-commit turn, the verify command, then a reviewer thread whose one
 * accepted review per round is acted on once its run completes. A failed verify or a blocking
 * review gets a repair turn on the author thread while the task has rounds of that kind left and
 * the failure is new; the repaired branch is settled and verified again, and a review round after
 * a fix-review continues the same reviewer thread. A passing review enters `record`, which
 * approves the reviewed commit. The approved delivery enters `pr` and opens its pull request,
 * then is `pr_open` with the pull request recorded, awaiting nothing.
 *
 * The owner can stop a running delivery after its step, or cancel any delivery that is not done
 * or cancelled. A stopping delivery still completes the work of its stage (the settle check and
 * its fix-commit turn, the fallback plan and review reads, plan and review submissions and their
 * retry) and blocks on a failure as a running one would; where it would begin verify, a review
 * round, a repair round, record, the PR stage or the plan gate, it is `stopped` instead. A
 * cancelled delivery awaits nothing, so no later event moves it. Resume undoes a stop that has not
 * yet taken effect, and picks a stopped or blocked delivery up from its checkpoint (see `resume`
 * and, for a parent, `resumePlanning`).
 */
export const advance = (delivery: FactoryDeliveryState, event: FactoryEvent): FactoryAdvance => {
  switch (event.type) {
    case "start":
      if (delivery.status !== "queued") return unchanged(delivery);
      return delivery.kind === "parent"
        ? beginPlan({ ...delivery, status: "running" })
        : begin({ ...delivery, status: "running" }, standardStages.author);
    case "stop":
      // Stopping already, the stop changes nothing; only a running delivery stops after its step.
      return delivery.status === "running"
        ? step({ ...delivery, status: "stopping" })
        : unchanged(delivery);
    case "resume":
      // Stopping, the delivery runs on: what it awaits is still coming, so nothing is issued.
      if (delivery.status === "stopping") return step({ ...delivery, status: "running" });
      if (
        (delivery.status !== "stopped" && delivery.status !== "blocked") ||
        event.check === null
      ) {
        return unchanged(delivery);
      }
      return delivery.kind === "parent"
        ? resumePlanning(delivery, event.check)
        : resume(delivery, event.check);
    case "cancel":
      return isTerminal(delivery)
        ? unchanged(delivery)
        : step({ ...delivery, status: "cancelled", awaiting: null, block: null, checkpoint: null });
  }
  // Approved, the delivery only opens its pull request: its threads' runs and deletions no
  // longer change it.
  const opensPullRequest =
    delivery.status === "approved" &&
    (event.type === "pr.opened" || event.type === "effect.failed");
  if (!runsStages(delivery) && !opensPullRequest) return unchanged(delivery);
  const { awaiting } = delivery;

  switch (event.type) {
    case "thread.launched": {
      const launch = awaitedEffect(delivery, event.effectId, "launch_thread");
      if (launch === undefined) return unchanged(delivery);
      const recorded = {
        ...delivery,
        worktreePath: delivery.worktreePath ?? event.worktreePath,
        // The task baseline is the author's; a reviewer starts at the commit it reviews.
        baseline: launch.role === "author" ? event.baseline : delivery.baseline,
        threads: { ...delivery.threads, [launch.role]: event.threadId },
      };
      const run = { threadId: event.threadId, runId: event.runId };
      if (launch.resumeCheckpoint === undefined) {
        return step({ ...recorded, awaiting: { type: "run", ...run } });
      }
      // A resume replayed this launch after its run had ended: no end is coming to await. The
      // branch an author left is settled now, however the run ended; a planner submits again.
      return launch.role === "planner"
        ? issue(recorded, {
            type: "send_plan_retry_turn",
            threadId: event.threadId,
            problems: [],
            checkpoint: launch.resumeCheckpoint,
          })
        : issue(recorded, { type: "check_settle", ...run, checkpoint: launch.resumeCheckpoint });
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
      if (delivery.stage === "plan") {
        // A plan is acted on only once its run completed, like a review.
        const accepted = acceptedPlan(delivery);
        return accepted === undefined
          ? issue(delivery, {
              type: "read_fallback_plan",
              threadId: event.threadId,
              runId: event.runId,
            })
          : concludePlan(delivery, accepted);
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
      if (result.status === "settled") {
        return enter(delivery, "verify", (current) => begin(current, standardStages.verify));
      }
      if (result.status === "repairable" && delivery.fixCommitTurns < FIX_COMMIT_TURNS) {
        return issue(
          { ...delivery, fixCommitTurns: delivery.fixCommitTurns + 1 },
          {
            type: "send_fix_commit_turn",
            threadId: check.threadId,
            problems: result.problems,
            ...(check.checkpoint === undefined ? {} : { checkpoint: check.checkpoint }),
          },
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
      return enter(recorded, "review", beginReview);
    }

    case "plan.submitted": {
      // Only the round's planner run, while it runs, and only until one plan is accepted.
      if (
        delivery.stage !== "plan" ||
        event.round !== delivery.planRound ||
        awaiting?.type !== "run" ||
        awaiting.threadId !== event.threadId ||
        awaiting.runId !== event.runId ||
        acceptedPlan(delivery) !== undefined
      ) {
        return unchanged(delivery);
      }
      // The planner is still in its turn: an accepted plan waits for the run to complete, and an
      // invalid one is corrected in the same turn from the tool's answer.
      return judgePlan(delivery, event.judgment, { accepted: step, retry: step });
    }

    case "plan.read": {
      const read = awaitedEffect(delivery, event.effectId, "read_fallback_plan");
      if (read === undefined) return unchanged(delivery);
      // The run has completed: act on an accepted plan now, or ask for a corrected one.
      return judgePlan(delivery, event.judgment, {
        accepted: concludePlan,
        retry: (counted, problems) =>
          issue(counted, { type: "send_plan_retry_turn", threadId: read.threadId, problems }),
      });
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

    case "approval.recorded": {
      if (awaitedEffect(delivery, event.effectId, "record_approval") === undefined) {
        return unchanged(delivery);
      }
      const { outcome } = event;
      if (outcome.type === "approved") {
        return enter(delivery, "pr", (current) =>
          begin({ ...current, status: "approved" }, standardStages.pr),
        );
      }
      const { expected, actual, differences } = outcome;
      return blocked(delivery, { reason: "record_mismatch", expected, actual, differences });
    }

    case "pr.opened":
      return awaitedEffect(delivery, event.effectId, "open_pr") === undefined
        ? unchanged(delivery)
        : step({
            ...delivery,
            status: "pr_open",
            awaiting: null,
            pullRequest: event.pullRequest,
          });

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
