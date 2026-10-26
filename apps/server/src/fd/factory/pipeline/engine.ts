import type { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryStageName } from "@t3tools/contracts/fd/factory";

import { standardStages } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";
import {
  acceptedPlan,
  acceptedReview,
  blocked,
  followedThread,
  isTerminal,
  isTurnEffect,
  issue,
  nextChild,
  planAtGate,
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
  FactorySettleResult,
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
  // The owner's resume is the decision to watch the pull request again (see `pr.opened`).
  ...(delivery.followThrough === undefined
    ? {}
    : { followThrough: { ...delivery.followThrough, watchEnded: false } }),
});

type FactoryResumedWorktree = NonNullable<FactoryResumeCheck["worktree"]>;

/**
 * Judges a resumed delivery's branch as the resume read it: one that cannot be repaired blocks
 * again, a repairable one gets one fix-commit turn on `thread` naming the checkpoint, and a settled
 * one goes on with `settled`.
 */
const resumeBranch = (
  delivery: FactoryDeliveryState,
  settle: FactorySettleResult,
  thread: ThreadId,
  settled: () => FactoryAdvance,
): FactoryAdvance => {
  if (settle.status === "unrepairable") {
    return blocked(delivery, { reason: "unsettled", problems: settle.problems });
  }
  if (settle.status === "repairable") {
    const checkpoint = delivery.checkpoint ?? delivery.stage;
    // The turn counts as the one fix-commit turn: a branch it leaves unsettled blocks.
    return issue(
      { ...resumed(delivery), stage: "repair", fixCommitTurns: FIX_COMMIT_TURNS },
      {
        type: "send_fix_commit_turn",
        threadId: thread,
        problems: settle.problems,
        ...(checkpoint === null ? {} : { checkpoint }),
      },
    );
  }
  return settled();
};

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
  return resumeBranch(delivery, worktree.settle, author, () =>
    checkpoint === "pr" && holdsApprovedCommit(delivery, worktree)
      ? begin({ ...resumed(delivery), status: "approved" }, standardStages.pr)
      : begin(resumed(delivery), standardStages.verify),
  );
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
 * Goes on with a parent's per-child phase, one child at a time: it starts the first child that has
 * not reported its approval and waits for it, at the stage each child begins with, or begins
 * integrate once every one has, with a fresh verify of the whole branch: a child's receipt covers
 * the commits up to its own. A stopping parent is `stopped` where it would start the child or
 * begin integrate instead, with it as its checkpoint.
 */
const continueChildren = (delivery: FactoryDeliveryState): FactoryAdvance => {
  const child = nextChild(delivery);
  if (child === undefined) {
    return enter(delivery, standardStages.integrate.name, (current) =>
      begin(current, standardStages.verify),
    );
  }
  return enter(delivery, standardStages.author.name, (current) =>
    issue({ ...current, stage: standardStages.author.name }, { type: "start_child", child }),
  );
};

/**
 * A follow-through round answering the wake's run on the thread the pull request is linked to (see
 * `followedThread`): the delivery runs again and awaits that run. The answer to a wake is no
 * fix-review reply, so the round's review starts on a fresh reviewer thread, a parent's integrate
 * reviewer as always.
 */
const adoptWake = (delivery: FactoryDeliveryState, runId: RunId): FactoryAdvance => {
  const threadId = followedThread(delivery);
  return threadId === undefined
    ? unchanged(delivery)
    : step({
        ...delivery,
        // A stop the owner asked for still stops at the round's next boundary.
        status: delivery.status === "stopping" ? "stopping" : "running",
        stage: standardStages.follow_through.name,
        awaiting: { type: "run", threadId, runId },
        reviewResponse: null,
      });
};

/**
 * The delivery with its watch marked for release, when a Factory watch command may have started
 * one: once its PR stage watched the pull request, or while that stage's result is outstanding
 * or was lost. A cancelled delivery leaves no watch of its own to wake the thread its pull request
 * is linked to with new work (see `followedThread`); which watch is Factory's, and for a parent
 * whose PR stage result was lost which thread, the worker reads from the commands' own records.
 */
const releasingWatch = (delivery: FactoryDeliveryState): FactoryDeliveryState => {
  const { awaiting, block } = delivery;
  const watched =
    delivery.followThrough !== undefined ||
    (awaiting?.type === "effect" && awaiting.effect.type === "open_pr") ||
    (block?.reason === "effect_failed" && block.effect.type === "open_pr");
  // A child opens no pull request; its parent's watch is the parent's to release.
  return delivery.kind !== "child" && watched ? { ...delivery, releaseWatch: true } : delivery;
};

/** The oldest pending wake adopted as a round; undefined when none is pending. */
const adoptPending = (delivery: FactoryDeliveryState): FactoryAdvance | undefined => {
  const { followThrough } = delivery;
  const [next, ...rest] = followThrough?.pending ?? [];
  return followThrough === undefined || next === undefined
    ? undefined
    : adoptWake({ ...delivery, followThrough: { ...followThrough, pending: rest } }, next);
};

/** Whether the delivery blocked closing out its merged pull request. */
const closeOutFailed = ({ block }: FactoryDeliveryState) =>
  block?.reason === "effect_failed" && block.effect.type === "close_out";

/**
 * Picks up a parent whose plan its owner approved. It resumes no thread, so a deleted thread does
 * not hold it: its planner's work ended with the approval, and integrate launches a reviewer of
 * its own. Without its children it creates them again, keeping every child it recorded before.
 * With them it never creates one again: it starts the first child that has not reported its
 * approval, or once every one has integrates afresh, with a new verify and a new reviewer.
 * A parent whose pull request is linked to a thread resumes through `resumeFollowThrough`.
 */
const resumeApproved = (delivery: FactoryDeliveryState): FactoryAdvance =>
  delivery.children.length === 0
    ? issue(
        { ...resumed(delivery), stage: standardStages.approve_plan.name },
        { type: "create_children" },
      )
    : continueChildren(resumed(delivery));

/**
 * Picks up a parent that recorded the thread its pull request is linked to, as a single item's
 * resume picks up its author's work: its follow-through rounds' turns go to that thread, so the
 * thread's deletion blocks it again, and the branch as the resume read it is judged first (see
 * `resumeBranch`), with a fix-commit turn there when it is repairable. A settled branch integrates
 * afresh, with a new verify and a new reviewer, before the PR stage updates its pull request;
 * never on an earlier receipt, whatever checkpoint the parent stopped or blocked at.
 */
const resumeFollowThrough = (
  delivery: FactoryDeliveryState,
  check: FactoryResumeCheck,
  thread: ThreadId,
): FactoryAdvance => {
  if (check.deletedThreads.includes(thread)) {
    return blocked(delivery, { reason: "thread_deleted", threadId: thread });
  }
  const { worktree } = check;
  // The worktree is read once the thread is recorded; without it there is nothing to judge.
  if (worktree === null) return unchanged(delivery);
  return resumeBranch(delivery, worktree.settle, thread, () => resumeApproved(delivery));
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

/**
 * Acts on the round's accepted review once its run has completed. A passing one enters `record`,
 * which approves the commit it judged: a task's, or a parent's whole branch after its integrate
 * review. A parent's integrate review has no repair round (owner decision), so one that blocks
 * blocks the parent.
 */
const concludeReview = (delivery: FactoryDeliveryState, review: FactoryAcceptedReview) => {
  if (!review.summary.blocking) {
    return enter(delivery, "record", (current) => begin(current, standardStages.record));
  }
  return delivery.stage === standardStages.integrate.name
    ? blocked(delivery, { reason: "review_changes_required", summary: review.summary })
    : repair(delivery, {
        stage: "review",
        fingerprint: review.fingerprint,
        exhausted: { reason: "review_changes_required", summary: review.summary },
      });
};

/** Whether the delivery is in a review round: a task's review, or a parent's integrate review. */
const reviewing = (delivery: FactoryDeliveryState) =>
  delivery.stage === standardStages.review.name || delivery.stage === standardStages.integrate.name;

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
 * at `approve_plan` for its owner, awaiting nothing; an empty plan blocks it with the note. At the
 * gate the owner can replace the plan's tasks with an edit judged beforehand, reject the plan,
 * which cancels the delivery, or replan: the planner thread gets the owner's note as a follow-up
 * turn in a new plan round, and the plan it then submits waits at the gate in place of the old.
 * Or the owner approves it: the plan is frozen, and the running parent creates its children, then
 * runs them one at a time: it starts the first child that has not reported its approval and waits
 * on that child alone, and starts the next only once that one reports its approval. A parent
 * stored before planner launches recorded where its branch started takes a child's approval only
 * after taking that child's start again, which establishes it. After the last child the parent
 * integrates: it verifies its whole branch afresh, then a new reviewer thread reviews the branch
 * from where it started by every task's criteria, under a single item's review rules (one
 * accepted review per round, acted on once its run completes, the fenced read, one corrected
 * retry). Integrate has no repair round: a failed verify or a blocking review blocks the parent.
 * A passing review enters `record`, which approves the branch's reviewed commit, and the approved
 * parent opens its one pull request as a single item does; its children open none.
 *
 * A single item runs from start to its pull request: the author thread, the branch settle
 * check with at most one fix-commit turn, the verify command, then a reviewer thread whose one
 * accepted review per round is acted on once its run completes. A failed verify or a blocking
 * review gets a repair turn on the author thread while the task has rounds of that kind left and
 * the failure is new; the repaired branch is settled and verified again, and a review round after
 * a fix-review continues the same reviewer thread. A passing review enters `record`, which
 * approves the reviewed commit. The approved delivery enters `pr` and opens its pull request,
 * then is `pr_open` with the pull request recorded, awaiting nothing. A child runs as a single
 * item does, with its own rounds and fingerprints, but ends approved at record: its parent's pull
 * request carries its work.
 *
 * Once its pull request is open, the delivery follows that pull request, as core's sync stores it
 * on the thread it is linked to. A merge of that very pull request enters `follow_through` and
 * issues the close-out (its Work items done, its worktree removed when clean); the delivery stays
 * `pr_open` until that reports and is `done` then. A close without merging cancels it. Either is
 * taken once, whatever a follow-through round is doing then: a later report of either changes
 * nothing. Factory never merges. A merged parent's approved children are done once it is.
 *
 * The PR stage also has the worker watch the pull request on the thread it is linked to: a single
 * item's author thread, or a parent's last child's author thread, which the parent records. A
 * wake core's watch queues there for failed checks, new comments or a conflict, committed after
 * that watch started, makes a `pr_open` delivery run again: it awaits the wake's run at
 * `follow_through`. One that comes while the delivery runs a stage or waits on its owner is its
 * own too, and waits: it is adopted before the branch is next judged after an author turn, or
 * once the pull request is open again. A completed run is settled, with at most one fix-commit
 * turn on that thread, then verified, reviewed and recorded like any author turn, under the
 * task's rounds, limits and fingerprints so far, and the PR stage then publishes the newly
 * approved commit to the same pull request; a run that ends any other way blocks. A parent's
 * round verifies its whole branch and has a fresh integrate reviewer judge it, with no repair
 * round, as its integrate does, and records its approval. Every wake of the pull request after
 * the first watch is the delivery's to cancel, taken once by its run; one that only reports
 * passing checks starts no round. One that ends the watch blocks the delivery where it would wait
 * on its pull request, since no feedback reaches it any more; only a resume watches it again,
 * since a PR stage starts no watch over an end it has not taken. A cancel has the watch a Factory
 * command started released, and still takes the wakes that watch sent, only so their runs are
 * stopped. A pull request published but not watched is recorded, and the delivery blocks.
 *
 * The owner can stop a running delivery after its step, or cancel any delivery that is not done
 * or cancelled. A stopping delivery still completes the work of its stage (the settle check and
 * its fix-commit turn, the fallback plan and review reads, plan and review submissions and their
 * retry, a parent's child creation) and blocks on a failure as a running one would; where it
 * would begin verify, a review round, a repair round, record, the PR stage, the plan gate, a
 * parent's next child or the stage after its children, it is `stopped` instead. A cancelled
 * delivery awaits nothing, so no later event moves it. Resume undoes a stop that has not yet taken
 * effect, and picks a stopped or blocked delivery up from its checkpoint (see `resume` and, for a
 * parent, `resumePlanning`, `resumeApproved` and `resumeFollowThrough`); a parent past its
 * children integrates again, from a fresh verify. A delivery blocked closing out its merge closes
 * out again.
 */
export const advance = (delivery: FactoryDeliveryState, event: FactoryEvent): FactoryAdvance => {
  switch (event.type) {
    case "start": {
      if (delivery.status !== "queued") return unchanged(delivery);
      const started = {
        ...delivery,
        status: "running" as const,
        baseline: event.baseline ?? delivery.baseline,
      };
      return delivery.kind === "parent"
        ? beginPlan(started)
        : begin(started, standardStages.author);
    }
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
      // The pull request merged and nothing else is left to judge: the close-out runs again.
      if (closeOutFailed(delivery)) {
        return issue({ ...resumed(delivery), status: "pr_open" }, { type: "close_out" });
      }
      if (delivery.kind !== "parent") return resume(delivery, event.check);
      if (delivery.pullRequestThread !== undefined) {
        return resumeFollowThrough(delivery, event.check, delivery.pullRequestThread);
      }
      return delivery.planApproved
        ? resumeApproved(delivery)
        : resumePlanning(delivery, event.check);
    case "cancel":
      return isTerminal(delivery)
        ? unchanged(delivery)
        : step({
            ...releasingWatch(delivery),
            status: "cancelled",
            awaiting: null,
            block: null,
            checkpoint: null,
          });
    case "watch.ended": {
      // Bookkeeping of the watch Factory started, in any status: where it ended and on which
      // pull request, and for a delivery whose PR stage result was lost, where its first watch
      // command was, and for a parent the thread that command watched, where its wakes arrive.
      const { followThrough } = delivery;
      const linked =
        delivery.kind === "parent" && delivery.pullRequestThread === undefined
          ? event.threadId
          : undefined;
      if (
        followThrough?.watchStartedAt === event.startedAt &&
        followThrough.heldUntil === event.at &&
        followThrough.heldPullRequest?.number === event.number &&
        followThrough.heldPullRequest.url === event.url &&
        linked === undefined
      ) {
        return unchanged(delivery);
      }
      return step({
        ...delivery,
        ...(linked === undefined ? {} : { pullRequestThread: linked }),
        followThrough: {
          watchedAfter: followThrough?.watchedAfter ?? event.firstAt,
          armedAt: followThrough?.armedAt ?? event.firstAt,
          runs: followThrough?.runs ?? [],
          pending: followThrough?.pending ?? [],
          watchEnded: followThrough?.watchEnded ?? false,
          watchStartedAt: event.startedAt,
          heldUntil: event.at,
          heldPullRequest: { number: event.number, url: event.url },
        },
      });
    }
    case "watch.released": {
      if (delivery.releaseWatch !== true) return unchanged(delivery);
      const { releaseWatch: _, ...released } = delivery;
      return step(released);
    }
    case "pr.merged":
    case "pr.closed": {
      // Only the pull request the delivery opened, and only once: with its outcome recorded, a
      // later report of either changes nothing. Taken in a follow-through round too, whatever it
      // awaits: what the round would publish no longer matters to a pull request that left open.
      const { pullRequest } = delivery;
      if (
        isTerminal(delivery) ||
        pullRequest === null ||
        pullRequest.outcome !== undefined ||
        pullRequest.number !== event.number ||
        pullRequest.url !== event.url
      ) {
        return unchanged(delivery);
      }
      const merged = event.type === "pr.merged";
      const following = {
        ...delivery,
        stage: standardStages.follow_through.name,
        pullRequest: {
          ...pullRequest,
          outcome: merged ? ("merged" as const) : ("closed" as const),
        },
        block: null,
        checkpoint: null,
      };
      // Closed without merging, the delivery ends; its worktree, branch and commits stay.
      return merged
        ? issue({ ...following, status: "pr_open" }, { type: "close_out" })
        : step({ ...releasingWatch(following), status: "cancelled", awaiting: null });
    }
    case "pr.feedback": {
      // Only a wake on the thread its pull request is linked to, a single item's author thread or
      // a parent's last child's author thread, committed after its first watch command (one from
      // before that pull request was published answers nothing), and each run once.
      const { pullRequest, followThrough } = delivery;
      if (
        followedThread(delivery) !== event.threadId ||
        followThrough === undefined ||
        event.sequence <= followThrough.watchedAfter ||
        followThrough.runs.includes(event.runId)
      ) {
        return unchanged(delivery);
      }
      // Every wake of its pull request is the delivery's own, whatever it reports: a cancel
      // stops its run as Factory's turn.
      const owned = { ...followThrough, runs: [...followThrough.runs, event.runId] };
      // Cancelled, it takes only the work the watch Factory started set off, to stop it: a wake
      // that watch sent, or the end that removed it. A watch is its pull request and its start,
      // since a watch on another pull request of the thread can start at the same moment; the
      // release names that pull request when the PR stage's result was lost. Nothing revives the
      // delivery.
      if (delivery.status === "cancelled") {
        const started = followThrough.watchStartedAt;
        const watched = followThrough.heldPullRequest ?? pullRequest;
        const sentByFactory =
          started !== null &&
          watched?.number === event.number &&
          watched.url === event.url &&
          (event.watchStartedAt === started ||
            (event.watchStartedAt === null && followThrough.heldUntil === event.linkSequence));
        return sentByFactory ? step({ ...delivery, followThrough: owned }) : unchanged(delivery);
      }
      // Otherwise only a wake of the open pull request it recorded.
      if (
        isTerminal(delivery) ||
        pullRequest === null ||
        pullRequest.outcome !== undefined ||
        pullRequest.number !== event.number ||
        pullRequest.url !== event.url
      ) {
        return unchanged(delivery);
      }
      // Waiting on its pull request, the delivery takes feedback as a round at once; while it
      // runs a stage or waits on its owner, the wake waits for it.
      const idle = delivery.status === "pr_open" && delivery.awaiting === null;
      switch (event.kind) {
        // Every check passed: nothing to repair.
        case "notice":
          return step({ ...delivery, followThrough: owned });
        // Core stopped watching: the delivery no longer hears of its pull request's feedback.
        // The watch Factory started, when on, is the one that ended.
        case "ended": {
          const holding = owned.watchStartedAt !== null && owned.heldUntil === null;
          const ended = {
            ...delivery,
            followThrough: {
              ...owned,
              watchEnded: true,
              ...(holding ? { heldUntil: event.linkSequence } : {}),
            },
          };
          return idle ? blocked(ended, { reason: "watch_ended" }) : step(ended);
        }
        case "feedback":
          return idle
            ? adoptWake({ ...delivery, followThrough: owned }, event.runId)
            : step({
                ...delivery,
                followThrough: { ...owned, pending: [...owned.pending, event.runId] },
              });
      }
    }
    case "parent.done":
      // Its parent's pull request carried its work, and is merged and closed out.
      return delivery.kind === "child" && delivery.status === "approved"
        ? step({ ...delivery, status: "done" })
        : unchanged(delivery);
    // The owner's plan actions are taken only at the plan gate, where the delivery awaits nothing.
    case "plan.updated": {
      const plan = planAtGate(delivery);
      // The gate waits only on a plan with tasks.
      return plan === undefined || event.tasks.length === 0
        ? unchanged(delivery)
        : step({ ...delivery, plan: { ...plan, tasks: event.tasks } });
    }
    case "plan.approved":
      // The plan is frozen: no plan action is taken again, and the parent creates its children.
      return planAtGate(delivery) === undefined
        ? unchanged(delivery)
        : issue(
            { ...delivery, status: "running", planApproved: true },
            { type: "create_children" },
          );
    case "plan.rejected":
      return planAtGate(delivery) === undefined
        ? unchanged(delivery)
        : step({ ...delivery, status: "cancelled" });
    case "plan.replanned": {
      // A plan waits at the gate only with its planner recorded.
      const { planner } = delivery.threads;
      if (planAtGate(delivery) === undefined || planner === undefined) return unchanged(delivery);
      // A new plan round, with a fresh retry allowance and no plan accepted for it yet.
      return issue(
        {
          ...delivery,
          status: "running",
          stage: "plan",
          planRound: delivery.planRound + 1,
          invalidSubmissions: 0,
        },
        { type: "send_replan_turn", threadId: planner, note: event.note },
      );
    }
  }
  // Approved, the delivery only opens its pull request, and with it open only closes out its
  // merge: its threads' runs and deletions no longer change it.
  const answersPullRequest =
    (delivery.status === "approved" &&
      (event.type === "pr.opened" || event.type === "effect.failed")) ||
    (delivery.status === "pr_open" &&
      (event.type === "closed_out" || event.type === "effect.failed"));
  if (!runsStages(delivery) && !answersPullRequest) return unchanged(delivery);
  const { awaiting } = delivery;

  switch (event.type) {
    case "thread.launched": {
      const launch = awaitedEffect(delivery, event.effectId, "launch_thread");
      if (launch === undefined) return unchanged(delivery);
      const recorded = {
        ...delivery,
        worktreePath: delivery.worktreePath ?? event.worktreePath,
        // The task baseline is set once, by the first author or planner launch (a parent's is
        // where its branch started) unless a child's parent assigned it; a reviewer starts at the
        // commit it reviews.
        baseline: delivery.baseline ?? (launch.role === "reviewer" ? null : event.baseline),
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
      if (reviewing(delivery)) {
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
      // A wake queued for the author while it worked runs next: the branch is judged once the
      // author is done with it.
      return (
        adoptPending(delivery) ??
        issue(delivery, {
          type: "check_settle",
          threadId: event.threadId,
          runId: event.runId,
        })
      );
    }

    case "thread.deleted":
      // A parent's follow-through rounds run on the thread its pull request is linked to.
      return Object.values(delivery.threads).includes(event.threadId) ||
        followedThread(delivery) === event.threadId
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
      // A parent verifies only in integrate, its whole branch, which has no repair round (owner
      // decision): a failure blocks it, and a pass begins the integrate review.
      if (delivery.kind === "parent") {
        return receiptFailed(outcome.receipt)
          ? blocked(recorded, { reason: "verify_failed" })
          : enter(recorded, standardStages.integrate.name, (current) =>
              begin(current, standardStages.integrate),
            );
      }
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
        !reviewing(delivery) ||
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
        // A child ends here, stopping or not: no stage of its own is left, and its parent goes
        // on once it hears of the approval.
        return delivery.kind === "child"
          ? step({ ...delivery, status: "approved", awaiting: null })
          : enter(delivery, "pr", (current) =>
              begin({ ...current, status: "approved" }, standardStages.pr),
            );
      }
      const { expected, actual, differences } = outcome;
      return blocked(delivery, { reason: "record_mismatch", expected, actual, differences });
    }

    case "pr.opened": {
      const open = awaitedEffect(delivery, event.effectId, "open_pr");
      if (open === undefined) return unchanged(delivery);
      // Published either way: the pull request is the delivery's, so a resume publishes to it
      // again rather than open another, and its merge or close is taken. A parent keeps the
      // thread it is linked to, where its feedback wakes.
      const linked = event.pullRequestThread ?? delivery.pullRequestThread;
      const recorded = {
        ...delivery,
        pullRequest: event.pullRequest,
        ...(delivery.kind === "parent" && linked !== undefined
          ? { pullRequestThread: linked }
          : {}),
      };
      if (event.watchFailure !== undefined) {
        return blocked(recorded, {
          reason: "effect_failed",
          effect: open,
          detail: event.watchFailure,
        });
      }
      const { watch } = event;
      const previous = delivery.followThrough;
      const next: FactoryDeliveryState = {
        ...recorded,
        status: "pr_open",
        awaiting: null,
        ...(watch === undefined
          ? {}
          : {
              followThrough: {
                watchedAfter: previous?.watchedAfter ?? watch.firstAt,
                armedAt: watch.at,
                watchStartedAt: watch.held,
                heldUntil: null,
                runs: previous?.runs ?? [],
                pending: previous?.pending ?? [],
                // Only a watch this stage started clears an end core committed before.
                watchEnded: watch.armed ? false : (previous?.watchEnded ?? false),
              },
            }),
      };
      // A watch core ended is not started again on its own.
      if (next.followThrough?.watchEnded === true) {
        return blocked(next, { reason: "watch_ended" });
      }
      return adoptPending(next) ?? step(next);
    }

    case "closed_out":
      return awaitedEffect(delivery, event.effectId, "close_out") === undefined
        ? unchanged(delivery)
        : step({ ...delivery, status: "done", awaiting: null });

    case "children.created":
      return awaitedEffect(delivery, event.effectId, "create_children") === undefined
        ? unchanged(delivery)
        : continueChildren({ ...delivery, children: event.children });

    case "child.started": {
      const start = awaitedEffect(delivery, event.effectId, "start_child");
      return start === undefined
        ? unchanged(delivery)
        : step({
            ...delivery,
            // A parent stored before planner launches recorded where its branch started keeps
            // its first child's baseline, which is that commit.
            baseline: delivery.baseline ?? event.baseline ?? null,
            awaiting: { type: "child", deliveryId: start.child },
          });
    }

    case "child.approved":
      // Only the child the parent waits on: one it took before, or one it has not started, is
      // not.
      if (awaiting?.type !== "child" || awaiting.deliveryId !== event.deliveryId) {
        return unchanged(delivery);
      }
      // A parent stored before planner launches recorded where its branch started takes no
      // child's approval without it: it takes that child's start again, which establishes it
      // and holds the child to it, or blocks.
      if (delivery.baseline === null) {
        return issue(delivery, { type: "start_child", child: event.deliveryId });
      }
      return continueChildren({
        ...delivery,
        awaiting: null,
        approvedChildren: [...delivery.approvedChildren, event.deliveryId],
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
