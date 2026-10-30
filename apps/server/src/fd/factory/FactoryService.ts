import { AuthWorkReadScope, type ProjectId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryPlanField,
  FactoryReplanNote,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemRef,
  workItemRefString,
  type WorkListResult,
  WorkSourceId,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Stream from "effect/Stream";

import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  type WorkActor,
  type WorkDomainError,
  WorkService,
  workBranchName,
} from "../work-management/index.ts";
import * as FactoryActivity from "./FactoryActivity.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import { type FactoryBranchUnavailableError, freshBranchName } from "./git/freshBranch.ts";
import { hasNoCommit } from "./git/headCommit.ts";
import { readSettle } from "./git/settleCheck.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import {
  acceptedPlan,
  acceptedReview,
  type FactoryAcceptedPlan,
  type FactoryAcceptedReview,
  type FactoryDeliveryKind,
  type FactoryEvent,
  type FactoryLaunchEffect,
  type FactoryResumeCheck,
  isTerminal,
  planAtGate,
  queuedDeliveryState,
  runsStages,
  unrecordedAuthorLaunch,
  unrecordedPlannerLaunch,
} from "./pipeline/state.ts";
import { uncreatableTasks } from "./plan/childItem.ts";
import { validatePlanEdit } from "./plan/edit.ts";

const FactoryReceiptRefusal = Schema.Literals(["head_changed", "tree_dirty"]);

/** A review submission refused before it was judged: nothing was recorded. */
export class FactoryReviewRefusedError extends Schema.TaggedError<FactoryReviewRefusedError>()(
  "FactoryReviewRefusedError",
  {
    threadId: ThreadId,
    /**
     * `not_reviewer`: no active delivery has this thread as its reviewer. `review_not_active`:
     * its delivery is not running the review or integrate stage, or not this thread's run (in
     * integrate, not the run the thread is live in). `already_accepted`: this round's review is
     * already accepted.
     */
    reason: Schema.Literals(["not_reviewer", "review_not_active", "already_accepted"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_reviewer":
        return `Thread ${this.threadId} is not the reviewer of an active Factory delivery.`;
      case "review_not_active":
        return `The Factory review of thread ${this.threadId} is not waiting for a submission.`;
      case "already_accepted":
        return `Factory already accepted this round's review from thread ${this.threadId}.`;
    }
  }
}

/** The submitted review is invalid. The first is the reviewer's to correct; a second blocks. */
export class FactoryReviewInvalidError extends Schema.TaggedError<FactoryReviewInvalidError>()(
  "FactoryReviewInvalidError",
  {
    deliveryId: FactoryDeliveryId,
    /** Bounded descriptions of what to correct. */
    problems: Schema.Array(Schema.String),
    /** The delivery blocked on this submission: no further one is taken. */
    blocked: Schema.Boolean,
  },
) {
  override get message(): string {
    const problems = this.problems.join(" ");
    return this.blocked
      ? `The review is invalid again, so Factory blocked the delivery: ${problems}`
      : `The review is invalid. Correct these problems and submit the whole review again: ${problems}`;
  }
}

/** The worktree no longer holds the verified commit, clean; the delivery blocked. */
export class FactoryReviewCodeChangedError extends Schema.TaggedError<FactoryReviewCodeChangedError>()(
  "FactoryReviewCodeChangedError",
  { deliveryId: FactoryDeliveryId, changes: Schema.Array(FactoryReceiptRefusal) },
) {
  override get message(): string {
    return `The code changed during review (${this.changes.join(", ")}), so Factory blocked the delivery.`;
  }
}

/** Why a review submission was not accepted. Refusals and judging failures record nothing. */
type FactorySubmitReviewError =
  | FactoryReviewRefusedError
  | FactoryReviewInvalidError
  | FactoryReviewCodeChangedError
  | FactoryReview.FactoryReviewJudgeError
  | ProjectionStore.ProjectionStoreV2Error
  | FactoryStoreError;

/** A plan submission refused before it was judged: nothing was recorded. */
export class FactoryPlanRefusedError extends Schema.TaggedError<FactoryPlanRefusedError>()(
  "FactoryPlanRefusedError",
  {
    threadId: ThreadId,
    /**
     * `not_planner`: no active delivery has this thread as its planner. `plan_not_active`: its
     * delivery is not running the plan stage, or awaits a run of the thread other than the one
     * the thread is live in. `already_accepted`: this plan round's plan is already accepted.
     */
    reason: Schema.Literals(["not_planner", "plan_not_active", "already_accepted"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_planner":
        return `Thread ${this.threadId} is not the planner of an active Factory delivery.`;
      case "plan_not_active":
        return `The Factory plan of thread ${this.threadId} is not waiting for a submission.`;
      case "already_accepted":
        return `Factory already accepted this round's plan from thread ${this.threadId}.`;
    }
  }
}

/** The submitted plan is invalid. The first is the planner's to correct; a second blocks. */
export class FactoryPlanInvalidError extends Schema.TaggedError<FactoryPlanInvalidError>()(
  "FactoryPlanInvalidError",
  {
    deliveryId: FactoryDeliveryId,
    /** Bounded descriptions of what to correct. */
    problems: Schema.Array(Schema.String),
    /** The delivery blocked on this submission: no further one is taken. */
    blocked: Schema.Boolean,
  },
) {
  override get message(): string {
    const problems = this.problems.join(" ");
    return this.blocked
      ? `The plan is invalid again, so Factory blocked the delivery: ${problems}`
      : `The plan is invalid. Correct these problems and submit the whole plan again: ${problems}`;
  }
}

/** Why a plan submission was not accepted. Refusals and judging failures record nothing. */
type FactorySubmitPlanError =
  | FactoryPlanRefusedError
  | FactoryPlanInvalidError
  | FactoryPlanning.FactoryPlanJudgeError
  | ProjectionStore.ProjectionStoreV2Error
  | FactoryStoreError;

/**
 * A parent's planned tasks become child items in its Work source, which only a Markdown source
 * can create; nothing was written.
 */
export class FactoryParentSourceUnsupportedError extends Schema.TaggedError<FactoryParentSourceUnsupportedError>()(
  "FactoryParentSourceUnsupportedError",
  { sourceId: WorkSourceId, sourceKind: WorkSourceKind },
) {
  override get message(): string {
    return `Factory plans a parent only from a Markdown Work source; source ${this.sourceId} is ${this.sourceKind}.`;
  }
}

/** No delivery id could be minted; nothing was written. */
export class FactoryDeliveryIdError extends Schema.TaggedError<FactoryDeliveryIdError>()(
  "FactoryDeliveryIdError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Factory could not mint a delivery id.";
  }
}

/** No delivery has this id. */
export class FactoryDeliveryNotFoundError extends Schema.TaggedError<FactoryDeliveryNotFoundError>()(
  "FactoryDeliveryNotFoundError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} does not exist.`;
  }
}

/** Only a running delivery can stop after its step; nothing changed. */
export class FactoryStopRefusedError extends Schema.TaggedError<FactoryStopRefusedError>()(
  "FactoryStopRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is ${this.status}; only a running delivery can stop after its step.`;
  }
}

/** Only a stopping, stopped or blocked delivery can resume; nothing changed. */
export class FactoryResumeRefusedError extends Schema.TaggedError<FactoryResumeRefusedError>()(
  "FactoryResumeRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is ${this.status}; only a stopping, stopped or blocked delivery can resume.`;
  }
}

/**
 * The delivery's PR stage published a pull request and started a watch on it, but a server
 * restart lost which pull request, and its records cannot tell: a resume would publish again and
 * could open a second one. Nothing changed; a cancel still ends the delivery, keeping its work.
 */
export class FactoryPullRequestUnknownError extends Schema.TaggedError<FactoryPullRequestUnknownError>()(
  "FactoryPullRequestUnknownError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} published a pull request a server restart lost track of, so it cannot resume.`;
  }
}

/** A done or cancelled delivery cannot be cancelled; nothing changed. */
export class FactoryCancelRefusedError extends Schema.TaggedError<FactoryCancelRefusedError>()(
  "FactoryCancelRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is already ${this.status}, so it cannot be cancelled.`;
  }
}

/**
 * Only a delivery waiting at the plan gate takes its owner's plan approval, edit, rejection or
 * replan; nothing changed.
 */
export class FactoryPlanGateRefusedError extends Schema.TaggedError<FactoryPlanGateRefusedError>()(
  "FactoryPlanGateRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is ${this.status} and not waiting at the plan gate, so its plan cannot be approved, edited, rejected or replanned.`;
  }
}

/**
 * The parent's Markdown source would refuse these tasks' child items: longer than a Work item
 * holds, or with a title or body its files cannot store as written. Nothing of a task is cut or
 * changed to fit; nothing changed.
 */
export class FactoryChildItemUncreatableError extends Schema.TaggedError<FactoryChildItemUncreatableError>()(
  "FactoryChildItemUncreatableError",
  { deliveryId: FactoryDeliveryId, taskIds: Schema.Array(FactoryTaskId) },
) {
  override get message(): string {
    return `The parent's Work source cannot hold the child items of tasks ${this.taskIds.join(", ")} of Factory delivery ${this.deliveryId} as written.`;
  }
}

/**
 * The owner's edit of the plan at the gate fails the plan validator or changes what an edit may
 * not; nothing changed.
 */
export class FactoryPlanEditInvalidError extends Schema.TaggedError<FactoryPlanEditInvalidError>()(
  "FactoryPlanEditInvalidError",
  {
    deliveryId: FactoryDeliveryId,
    /** Bounded descriptions of what to correct. */
    problems: Schema.Array(Schema.String),
    /** The parts of the recorded plan the problems are in, for the owner's client to show. */
    fields: Schema.Array(FactoryPlanField),
  },
) {
  override get message(): string {
    return `The edited plan of Factory delivery ${this.deliveryId} is invalid: ${this.problems.join(" ")}`;
  }
}

/** A replan note is blank or longer than the contract's bound; nothing changed. */
export class FactoryReplanNoteInvalidError extends Schema.TaggedError<FactoryReplanNoteInvalidError>()(
  "FactoryReplanNoteInvalidError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `A replan note for Factory delivery ${this.deliveryId} must be nonblank and at most ${FACTORY_REPLAN_NOTE_MAX_LENGTH} characters.`;
  }
}

/** Why a start was refused. Every refusal comes before the delivery's row is written. */
export type FactoryStartError =
  | WorkDomainError
  | FactoryParentSourceUnsupportedError
  | FactorySettings.FactorySettingsStorageError
  | FactorySettings.FactoryVerifyCommandMissingError
  | ProjectStore.ProjectStoreV2Error
  | FactoryThreadEffects.FactoryProjectMissingError
  | ThreadLaunch.ThreadLaunchBaseRefError
  | FactoryBranchUnavailableError
  | FactoryDeliveryIdError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryStoreError;

/**
 * A stored delivery with its newest stage attempts, as many as a snapshot carries, in the order
 * they started.
 */
export type FactoryDeliveryWithRuns = FactoryDeliveryStore.StoredFactoryDelivery & {
  readonly stageRuns: ReadonlyArray<FactoryStageRunStore.StoredFactoryStageRun>;
};

/**
 * What `startNext` did: started a delivery of the first Ready item, or found none it could start.
 * `incomplete` says a source could not be listed whole, so an item it did not show may be Ready.
 */
export type FactoryStartNextResult =
  | { readonly type: "started"; readonly delivery: FactoryDeliveryWithRuns }
  | { readonly type: "nothing_ready"; readonly incomplete: boolean };

/**
 * Factory's deliveries for transports, MCP tools and scheduled tasks. Each delivery it returns
 * carries the stage attempts of the same moment: a read takes both from one snapshot of the
 * database, and a control reads the attempts of its own step before any later step can store
 * more. A control whose attempt read fails fails, though its step stands and the change epoch has
 * moved for it.
 */
export class FactoryService extends Context.Service<
  FactoryService,
  {
    /**
     * Starts a delivery of a Work item: a single item (the default), or a parent, which plans
     * its children first. Its first thread works on a new worktree of the branch Work's thread
     * starts would name, created from the canonical checkout's HEAD; when an earlier delivery of
     * the item or any ref already holds that name, the first free one of `-2`, `-3`, … after it
     * (see `freshBranchName`), so an earlier delivery keeps its work. A single item is stored
     * queued with the item as its one task, a parent with no task until its plan is approved;
     * then the delivery is started, so its author or planner launch is queued once the running
     * state is stored. Refused, with nothing written: an item Work cannot read, a parent whose
     * source is not Markdown (the only kind that can hold its children), a project without a
     * verify command or not on this environment, a base the worktree cannot start from, or an
     * item that already has a delivery that is not done or cancelled. With `runtimeModeCeiling`,
     * which the delivery keeps, none of its threads ever launches or runs broader than that mode
     * (a caller's own, for an agent's start), and a launch on a provider that offers no mode
     * within it fails before anything runs; without one they launch with the project's default.
     */
    readonly start: (input: {
      readonly itemRef: WorkItemRef;
      /** Single when absent. A child is started by its parent, never on its own. */
      readonly kind?: Exclude<FactoryDeliveryKind, "child">;
      readonly runtimeModeCeiling?: RuntimeMode;
    }) => Effect.Effect<FactoryDeliveryWithRuns, FactoryStartError>;
    /**
     * Starts the project's next Ready item as a single delivery, through `start`, for MCP and
     * scheduled tasks. Ready is Work's Ready: a todo item that is not blocked and has no open
     * linked thread (a thread working, waiting for input or idle, or a launch Work has in flight),
     * and here also no delivery that is not done or cancelled. The first such item in Work's list
     * order, across the project's sources in order and every page of each, filtered by `label`
     * when given, is started with `runtimeModeCeiling` (see `start`); an item a concurrent start
     * took first is refused as active and the walk goes on to the next. Nothing Ready is a result,
     * not an error. A page that cannot be read, reports its listing stale, or lists an item Work
     * could not read, whatever its status or labels, ends the walk there: nothing past it is
     * started, since an item it did not show could be the first Ready one, and the result says the
     * listing was incomplete. Refused,
     * with nothing written, for a project not on this environment or without a verify command,
     * and as `start` refuses the item it picked.
     */
    readonly startNext: (input: {
      readonly projectId: ProjectId;
      readonly label?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
    }) => Effect.Effect<
      FactoryStartNextResult,
      FactoryStartError | ProjectionStore.ProjectionStoreV2Error
    >;
    readonly get: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<Option.Option<FactoryDeliveryWithRuns>, FactoryStoreError>;
    /**
     * Every delivery, or one project's, whatever its status, newest first. Their attempts are
     * one bounded read, however many deliveries there are.
     */
    readonly list: (input: {
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ReadonlyArray<FactoryDeliveryWithRuns>, FactoryStoreError>;
    /**
     * The item in Work's canonical spelling, which deliveries are stored under, and every
     * delivery of it, whatever its status, newest first. An item without deliveries has none,
     * and an item of an unknown source keeps the spelling given.
     */
    readonly listByItem: (itemRef: WorkItemRef) => Effect.Effect<
      {
        readonly itemRef: WorkItemRef;
        readonly deliveries: ReadonlyArray<FactoryDeliveryWithRuns>;
      },
      WorkDomainError | FactoryStoreError
    >;
    /**
     * Stops a running delivery after its current step. It is stored `stopping`, and the turn or
     * effect under way is not interrupted: it finishes the work of its stage and becomes
     * `stopped` where it would begin the next one, with that stage as its checkpoint (see
     * `advance`). Stopping already, nothing changes. Refused, with nothing changed, in any other
     * status.
     */
    readonly stop: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryStopRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Resumes a delivery, like Looper's `--finish`. A stopping one runs on as if never stopped,
     * awaiting what it awaited. A stopped or blocked one has its branch and threads read again
     * under its lock and picks up from its checkpoint (see `advance`): a settled branch is
     * verified again for a fresh receipt and then reviewed, without a new author turn; on the
     * commit its task was approved for, a delivery stopped at or blocked in the PR stage opens its
     * pull request at once. A branch that does not settle gets one fix-commit turn naming the
     * checkpoint, or blocks when it cannot be repaired; a deleted thread of the delivery blocks it
     * again, every time. A delivery that issued an author launch but never recorded its result
     * issues that launch again, which picks up the thread, run and worktree it made if it went
     * through, and never starts a second author; if that run had ended, however it ended, the
     * branch it left is settled and verified at once. A parent that stopped or blocked while
     * planning resumes into planning, its unrecorded planner launch replayed alike, and a
     * recorded planner asked for its plan again. A resume grants a fresh retry allowance
     * (owner decision): repair rounds and failure fingerprints start over, its limits do not.
     * Refused, with nothing changed, in any other status. A delivery blocked on a PR stage whose
     * result a restart lost first recovers what that stage published (see
     * `FactoryWorker.recoverPullRequest`), since the resume clears the only sign it did; a
     * recovery that cannot read the records fails the resume, and one that proves a pull request
     * was published but not which refuses it, both with nothing changed.
     */
    readonly resume: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      | FactoryResumeRefusedError
      | FactoryPullRequestUnknownError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
      | ProjectionStore.ProjectionStoreV2Error
    >;
    /**
     * Cancels a delivery that is not done or cancelled. It ends at once and issues nothing more,
     * and whatever its threads still run is interrupted; the worktree, branch and commits stay. A
     * parent's children that are not approved are cancelled with it, alike, and a child cancels
     * its parent so (owner decision); approved children keep their approvals. No later run end,
     * effect result or review submission changes it, and its item can be delivered again.
     * Refused, with nothing changed, once done or cancelled.
     */
    readonly cancel: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryCancelRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Runs an effect that waits for admission (see `FactoryAdmission`), once, for whoever admits
     * it: only while the delivery awaits effect `effectId`, it is marked waiting and no job of the
     * delivery is in flight, all read under the delivery's lock. Its job is counted, the mark
     * cleared and the job queued; it asks the admission port again before it runs. `stale`,
     * changing nothing, otherwise.
     */
    readonly redispatch: (
      deliveryId: FactoryDeliveryId,
      effectId: number,
    ) => Effect.Effect<"dispatched" | "stale", FactoryStoreError>;
    /**
     * Makes sure an awaited effect waits marked for admission, never running anything: `deferred`
     * once it is marked, storing the mark when the effect has neither mark nor job (a deferral
     * whose mark could not be stored); `running` while a job of the delivery is in flight;
     * `stale` when the delivery does not await effect `effectId`.
     */
    readonly ensureDeferred: (
      deliveryId: FactoryDeliveryId,
      effectId: number,
    ) => Effect.Effect<"deferred" | "running" | "stale", FactoryStoreError>;
    /**
     * The root delivery whose family the thread belongs to, read-only: a thread a Factory launch
     * made belongs to that delivery's root (a child's to its parent), and a thread delegated from
     * a family thread, an app-owned task's or a provider-native mirror, to its parent's family, at
     * most eight levels down. Null for any other thread. Fails when a record cannot be read or the
     * lineage goes deeper.
     */
    readonly familyRoot: (
      threadId: ThreadId,
    ) => Effect.Effect<FactoryDeliveryId | null, FactoryActivity.FactoryOwnershipReadError>;
    /**
     * What the root delivery's family is doing, read-only (see `FactoryActivity`): its phase,
     * whether work Factory cannot show to be the owner's is under way or about to start on its
     * threads, whether an effect waits for admission, what its runs wait for, and whether any of
     * that could not be read. An unknown delivery is `missing`.
     */
    readonly activity: (
      root: FactoryDeliveryId,
    ) => Effect.Effect<FactoryActivity.FactoryActivityReport, FactoryStoreError>;
    /**
     * The owner's edit of the plan a parent waits on at the plan gate: `plan`, any value as it
     * arrived, replaces it, and the delivery waits on. The edit is judged under the delivery's
     * lock by the planner's plan validator and the edit rules (see `validatePlanEdit`): it may
     * change the tasks' titles, summaries, acceptance criteria and test plans, reorder the tasks
     * and leave some out, but keeps at least one, adds none and keeps each one's id, kind, likely
     * paths and risk, and the planner's note. The plan's evidence stays what the planner
     * submitted. Refused, with nothing changed, for a value that is not such an edit (malformed
     * or not) or a delivery not waiting at the gate.
     */
    readonly updatePlan: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly plan: unknown;
    }) => Effect.Effect<
      FactoryDeliveryWithRuns,
      | FactoryPlanGateRefusedError
      | FactoryPlanEditInvalidError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
    >;
    /**
     * The owner's approval of the plan a parent waits on at the plan gate. The plan is frozen:
     * its tasks are stored in plan order with the approval, and no edit, replan or second
     * approval is taken after it. The running parent then creates, as a worker effect, one child
     * Work item per task in the parent item's Markdown source, under the parent item and blocked
     * by the previous task's, and stores the children's queued deliveries on its branch and
     * worktree (see `FactoryChildren`). A Work failure blocks it with every child recorded so far
     * kept, and a resume goes on after them. Then it runs its children in plan order, one at a
     * time, each with an author thread of its own on the parent's worktree, starting the next
     * once the one before is approved (see `FactoryWorker`). Refused, with nothing changed, for a
     * delivery not waiting at the gate, or a plan with a task whose child item the source would
     * refuse (see `uncreatableTasks`).
     */
    readonly approvePlan: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      | FactoryPlanGateRefusedError
      | FactoryChildItemUncreatableError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
    >;
    /**
     * The owner's rejection of the plan a parent waits on at the plan gate: the delivery ends
     * cancelled, issuing nothing; its planner thread, worktree and branch stay. Refused, with
     * nothing changed, for a delivery not waiting at the gate.
     */
    readonly rejectPlan: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryPlanGateRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * The owner's replan of the plan a parent waits on at the plan gate: the delivery returns to
     * the plan stage in a new plan round, with a fresh retry allowance, and the planner thread
     * gets `note` (trimmed) as a follow-up turn queued behind whatever it runs. The plan it then
     * submits is judged like its first, and one with tasks waits at the gate in place of this
     * one. Refused, with nothing changed, for a blank or overlong note or a delivery not waiting
     * at the gate.
     */
    readonly replan: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly note: string;
    }) => Effect.Effect<
      FactoryDeliveryWithRuns,
      | FactoryPlanGateRefusedError
      | FactoryReplanNoteInvalidError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
    >;
    /**
     * A reviewer's `factory_submit_review`. Taken only from the thread an active delivery
     * registered as its reviewer, while the review stage awaits that thread's run and before
     * the round has an accepted review; any other call is refused with nothing changed. A
     * parent's integrate reviewer is held to the run the thread is live in too, as a planner is:
     * a later turn of the thread is refused while the parent still awaits the run before it. The
     * review is judged (see `FactoryReview`) and the judgment recorded on the delivery: an
     * accepted review is acted on once the reviewer's run completes, an invalid one fails with
     * its problems (the second in a round blocks the delivery), and changed code blocks it.
     */
    readonly submitReview: (input: {
      readonly threadId: ThreadId;
      readonly review: unknown;
    }) => Effect.Effect<
      { readonly deliveryId: FactoryDeliveryId; readonly review: FactoryAcceptedReview },
      FactorySubmitReviewError
    >;
    /**
     * A planner's `factory_submit_plan`. Taken only from the thread an active delivery registered
     * as its planner, while the plan stage awaits the run that thread is live in and before the
     * plan round has an accepted plan; any other call is refused with nothing changed. A later
     * turn of the planner thread is refused while the delivery still awaits the run before it,
     * so no run's plan is recorded as another's. The plan is judged (see
     * `FactoryPlanning`) and the judgment recorded on the delivery: an accepted plan, with tasks
     * or without, is acted on once the planner's run completes, and an invalid one fails with its
     * problems (the second in a round blocks the delivery).
     */
    readonly submitPlan: (input: {
      readonly threadId: ThreadId;
      readonly plan: unknown;
    }) => Effect.Effect<
      { readonly deliveryId: FactoryDeliveryId; readonly plan: FactoryAcceptedPlan },
      FactorySubmitPlanError
    >;
    /**
     * Factory's change epoch: its value on subscribe, then each move. It moves after each write
     * commits (a delivery's start, each engine step, a stop, resume or cancel, a plan or review
     * submission, a plan approval, edit, rejection or replan, the child deliveries an approval
     * stores, a settings write) and never for a refusal, so a subscriber refetches what it shows
     * on each value.
     */
    readonly subscribe: Stream.Stream<number>;
  }
>()("t3/fd/factory/FactoryService") {}

/** Factory reads the item to start and writes nothing to Work under this actor. */
const itemReader: WorkActor = { id: "factory", grants: [AuthWorkReadScope], label: "Factory" };

/** A single item is its delivery's one task; its approval is `approval-item.json`. */
const SINGLE_ITEM_TASK = FactoryTaskId.make("item");

/** Every page `startNext` reads holds up to this many items, the most Work serves. */
const NEXT_PAGE = 100;

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const settings = yield* FactorySettings.FactorySettings;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const plans = yield* FactoryPlanning.FactoryPlanning;
  const reviews = yield* FactoryReview.FactoryReview;
  const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
  const changes = yield* FactoryChanges.FactoryChanges;
  const activity = yield* FactoryActivity.FactoryActivity;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();
  // Starts of one item, by its canonical spelling. One server owns a T3 home, so an in-process
  // lock is enough, as for Work's thread starts.
  const itemLocks = yield* KeyedLock.make<string>();

  /** The deliveries with their newest attempts, in one read however many there are. */
  const withRuns = (stored: ReadonlyArray<FactoryDeliveryStore.StoredFactoryDelivery>) =>
    stageRuns
      .listNewestByDeliveries({
        deliveryIds: stored.map(({ deliveryId }) => deliveryId),
        limit: FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
      })
      .pipe(
        Effect.map((runs) =>
          stored.map((delivery) => ({
            ...delivery,
            stageRuns: runs.get(delivery.deliveryId) ?? [],
          })),
        ),
      );

  /**
   * Reads deliveries and their attempts in one read-only transaction, a single snapshot of the
   * database: a step stored between the two reads would otherwise pair one state with the next
   * state's attempts.
   */
  const readWithRuns = (
    operation: string,
    read: Effect.Effect<
      ReadonlyArray<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >,
  ) =>
    sql.withTransaction(read.pipe(Effect.flatMap(withRuns))).pipe(
      NodeSqliteClient.readOnly,
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(new FactoryStoreError({ operation, cause })),
      }),
    );

  /** A stepped delivery with the attempts of that step. */
  const steppedWithRuns = (stepped: {
    readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
    readonly stageRuns: ReadonlyArray<FactoryStageRunStore.StoredFactoryStageRun>;
  }) => ({ ...stepped.delivery, stageRuns: stepped.stageRuns });

  const start: FactoryService["Service"]["start"] = Effect.fn("FactoryService.start")(
    function* (input) {
      // The active-item index keys on Work's spelling, so another spelling of the item cannot
      // hold a second delivery.
      const itemRef = yield* work.canonicalRef(input.itemRef);
      const kind = input.kind ?? "single";
      const source = (yield* work.resolveSource(itemRef.sourceId)).stored;
      // Owner decision: a parent's tasks become child items only in a Markdown source.
      if (kind === "parent" && source.kind !== "markdown") {
        return yield* new FactoryParentSourceUnsupportedError({
          sourceId: source.sourceId,
          sourceKind: source.kind,
        });
      }
      const { projectId } = source;
      const { limits } = yield* settings.requireDeliverySettings(projectId);
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) {
        return yield* new FactoryThreadEffects.FactoryProjectMissingError({ projectId });
      }
      const item = yield* work.getItem(itemReader, { ref: itemRef });

      // From reading the item's earlier deliveries to storing this one, no other start of the
      // item runs: a delivery stored meanwhile, then cancelled before its launch made its
      // branch, would otherwise leave this start on the branch it chose.
      const queued = yield* Effect.gen(function* () {
        // A new delivery starts over: a cancelled or finished one keeps its branch and worktree.
        const earlier = yield* deliveries.listByItem(itemRef);
        const branch = yield* freshBranchName({
          cwd: project.workspaceRoot,
          base: workBranchName(item),
          taken: earlier.map(({ state }) => state.branch),
        }).pipe(Effect.provideContext(gitContext));
        // The workspace the first launch asks for (see `agentStage`), checked before any row
        // exists: the launch itself would accept a base with no commit and fail inside the
        // thread. Core's check lets HEAD through in a repository with no commits yet, so Factory
        // looks for one itself.
        const workspace = { type: "worktree", baseRef: "HEAD", branch } as const;
        if (yield* hasNoCommit(project.workspaceRoot).pipe(Effect.provideContext(gitContext))) {
          return yield* new ThreadLaunch.ThreadLaunchBaseRefError({
            projectId,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
            baseRef: workspace.baseRef,
          });
        }
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });

        const deliveryId = FactoryDeliveryId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => new FactoryDeliveryIdError({ cause }))),
        );
        // The insert refuses an item with an active delivery inside its transaction, so of two
        // starts only one is stored, even from another spelling. A single item's task row is
        // written in the same transaction: a refused start adds none, and no stored single item
        // lacks it. A parent's tasks are its approved plan's.
        return yield* deliveries
          .insert({
            deliveryId,
            projectId,
            itemRef,
            // The round limits stay those the delivery started with.
            state: queuedDeliveryState({
              kind,
              branch: workspace.branch,
              baseRef: workspace.baseRef,
              limits: {
                maxFixRounds: limits.maxFixRounds,
                maxReviewRounds: limits.maxReviewRounds,
              },
              ...(input.runtimeModeCeiling === undefined
                ? {}
                : { runtimeModeCeiling: input.runtimeModeCeiling }),
            }),
          })
          .pipe(
            Effect.tap(() =>
              kind === "single"
                ? tasks.insert({ deliveryId, taskId: SINGLE_ITEM_TASK })
                : Effect.void,
            ),
            (write) => changes.transact(write),
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(new FactoryStoreError({ operation: "service.start", cause })),
            }),
          );
      }).pipe((locked) => itemLocks.withLock(workItemRefString(itemRef), locked));
      // A storage failure here leaves the delivery queued with nothing launched.
      const started = yield* worker.stepWith(queued.deliveryId, () =>
        Effect.succeed({ event: { type: "start" } as const, value: undefined }),
      );
      return Option.match(started, {
        onNone: () => ({ ...queued, stageRuns: [] }),
        onSome: steppedWithRuns,
      });
    },
  );

  /**
   * Whether the item has an open linked thread, as Work's own starts judge one: a launch Work has
   * in flight, checked before the thread because it holds until the thread exists, or a thread
   * that is not deleted, settled or archived. A link with neither is a launch that died.
   */
  const hasOpenThread = (ref: WorkItemRef) =>
    Effect.gen(function* () {
      const { links } = yield* work.listLinks(itemReader, { ref });
      for (const { threadId } of links) {
        if ((yield* work.isLaunching(threadId)) || (yield* threads.openThread(threadId))) {
          return true;
        }
      }
      return false;
    });

  const startNext: FactoryService["Service"]["startNext"] = Effect.fn("FactoryService.startNext")(
    function* ({ projectId, label, runtimeModeCeiling }) {
      if (Option.isNone(yield* projects.get(projectId))) {
        return yield* new FactoryThreadEffects.FactoryProjectMissingError({ projectId });
      }
      // Every start would be refused without one, so a scheduled run hears it even with nothing
      // Ready.
      yield* settings.requireDeliverySettings(projectId);
      const { sources } = yield* work.listSources(itemReader, {
        projectId,
        includeDisconnected: false,
      });
      // `start` refuses these too; skipping them first saves reading their items and branches.
      const active = new Set(
        (yield* deliveries.listActive()).map(({ itemRef }) => workItemRefString(itemRef)),
      );
      const incomplete: FactoryStartNextResult = { type: "nothing_ready", incomplete: true };
      for (const source of sources) {
        // A Markdown source lists each task file it could not read as an item of unknown status
        // without labels, and its own status and label filters would leave those out unseen. So
        // it is listed whole and filtered here, as it filters. GitHub and Jira list no such item
        // (a record they cannot read fails its page), and filter at the source, which spares
        // reading every closed issue.
        const filtered = source.kind === "github" || source.kind === "jira";
        let cursor: string | null = null;
        do {
          // A page Work cannot serve is a part of the listing nobody saw, never an empty one.
          const page: Option.Option<WorkListResult> = yield* Effect.option(
            work.listItems(itemReader, {
              sourceId: source.sourceId,
              ...(filtered
                ? { statuses: ["todo"], ...(label === undefined ? {} : { labels: [label] }) }
                : {}),
              limit: NEXT_PAGE,
              ...(cursor === null ? {} : { cursor }),
            }),
          );
          if (Option.isNone(page) || page.value.stale) return incomplete;
          for (const item of page.value.items) {
            // Work could not read it whole, so what it lists of the item may be wrong, and the
            // item may be the first Ready one.
            if (item.invalid !== null) return incomplete;
            if (item.status !== "todo" || item.blocked) continue;
            if (!filtered && label !== undefined && !item.labels.includes(label)) continue;
            if (active.has(workItemRefString(item.ref))) continue;
            if (yield* hasOpenThread(item.ref)) continue;
            const started = yield* start({
              itemRef: item.ref,
              ...(runtimeModeCeiling === undefined ? {} : { runtimeModeCeiling }),
            }).pipe(
              Effect.asSome,
              // A concurrent start took it first; the next Ready item is this call's.
              Effect.catchTags({ FactoryDeliveryActive: () => Effect.succeedNone }),
            );
            if (Option.isSome(started)) return { type: "started", delivery: started.value };
          }
          cursor = page.value.nextCursor;
        } while (cursor !== null);
      }
      return { type: "nothing_ready", incomplete: false };
    },
  );

  const submitReview: FactoryService["Service"]["submitReview"] = Effect.fn(
    "FactoryService.submitReview",
  )(function* ({ threadId, review }) {
    const refuse = (reason: FactoryReviewRefusedError["reason"]) =>
      Effect.fail(new FactoryReviewRefusedError({ threadId, reason }));
    // A reviewer thread belongs to the one delivery that launched it.
    const owner = (yield* deliveries.listActive()).find(
      ({ state }) => state.threads.reviewer === threadId,
    );
    if (owner === undefined) return yield* refuse("not_reviewer");
    const { deliveryId } = owner;

    // Judged and recorded under the delivery's lock, so the run cannot end in between: the
    // engine then takes the judgment exactly when these checks pass.
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      Effect.gen(function* () {
        const { state } = current;
        const { awaiting } = state;
        if (state.threads.reviewer !== threadId) return yield* refuse("not_reviewer");
        const integrating = state.stage === "integrate";
        // A stopping delivery still finishes its review round.
        if (
          !runsStages(state) ||
          (state.stage !== "review" && !integrating) ||
          awaiting?.type !== "run" ||
          awaiting.threadId !== threadId
        ) {
          return yield* refuse("review_not_active");
        }
        // As for a plan: a tool call names its thread, not its run, and a later turn of the
        // integrate reviewer can be live before the awaited run's end reaches the parent.
        if (integrating && (yield* threads.liveRun(threadId)) !== awaiting.runId) {
          return yield* refuse("review_not_active");
        }
        if (acceptedReview(state) !== undefined) return yield* refuse("already_accepted");
        const judgment = yield* reviews.judge(current, { source: "mcp", threadId, review });
        const event: FactoryEvent = {
          type: "review.submitted",
          round: state.reviewRound,
          threadId,
          runId: awaiting.runId,
          judgment,
        };
        return { event, value: { judgment, round: state.reviewRound } };
      }),
    );
    // Deliveries are never deleted, so this one is still stored.
    if (Option.isNone(stepped)) return yield* refuse("not_reviewer");
    const { delivery, value } = stepped.value;
    const { judgment } = value;
    switch (judgment.type) {
      case "accepted":
        return { deliveryId, review: { ...judgment.review, round: value.round } };
      case "invalid":
        return yield* new FactoryReviewInvalidError({
          deliveryId,
          problems: judgment.problems,
          blocked: delivery.state.status === "blocked",
        });
      case "code_changed":
        return yield* new FactoryReviewCodeChangedError({ deliveryId, changes: judgment.changes });
    }
  });

  const submitPlan: FactoryService["Service"]["submitPlan"] = Effect.fn(
    "FactoryService.submitPlan",
  )(function* ({ threadId, plan }) {
    const refuse = (reason: FactoryPlanRefusedError["reason"]) =>
      Effect.fail(new FactoryPlanRefusedError({ threadId, reason }));
    // A planner thread belongs to the one delivery that launched it.
    const owner = (yield* deliveries.listActive()).find(
      ({ state }) => state.threads.planner === threadId,
    );
    if (owner === undefined) return yield* refuse("not_planner");
    const { deliveryId } = owner;

    // Judged and recorded under the delivery's lock, so the run cannot end in between: the
    // engine then takes the judgment exactly when these checks pass.
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      Effect.gen(function* () {
        const { state } = current;
        const { awaiting } = state;
        if (state.threads.planner !== threadId) return yield* refuse("not_planner");
        // A stopping delivery still finishes its plan round.
        if (
          !runsStages(state) ||
          state.stage !== "plan" ||
          awaiting?.type !== "run" ||
          awaiting.threadId !== threadId
        ) {
          return yield* refuse("plan_not_active");
        }
        // A tool call names its thread, not its run, so the run the thread is live in is read
        // here, under the lock. A later turn of the thread can be live before the awaited run's
        // end reaches the delivery, and its plan must never stand as the awaited run's.
        if ((yield* threads.liveRun(threadId)) !== awaiting.runId) {
          return yield* refuse("plan_not_active");
        }
        if (acceptedPlan(state) !== undefined) return yield* refuse("already_accepted");
        const judgment = yield* plans.judge(current, { source: "mcp", threadId, plan });
        const event: FactoryEvent = {
          type: "plan.submitted",
          round: state.planRound,
          threadId,
          runId: awaiting.runId,
          judgment,
        };
        return { event, value: { judgment, round: state.planRound } };
      }),
    );
    // Deliveries are never deleted, so this one is still stored.
    if (Option.isNone(stepped)) return yield* refuse("not_planner");
    const { delivery, value } = stepped.value;
    const { judgment } = value;
    return judgment.type === "accepted"
      ? { deliveryId, plan: { ...judgment.plan, round: value.round } }
      : yield* new FactoryPlanInvalidError({
          deliveryId,
          problems: judgment.problems,
          blocked: delivery.state.status === "blocked",
        });
  });

  // Both decide and step under the delivery's lock, so no run end or effect result lands between
  // the status they check and the step.
  const stop: FactoryService["Service"]["stop"] = Effect.fn("FactoryService.stop")(
    function* (deliveryId) {
      const stepped = yield* worker.stepWith(deliveryId, ({ state }) =>
        runsStages(state)
          ? Effect.succeed({ event: { type: "stop" } as const, value: undefined })
          : Effect.fail(new FactoryStopRefusedError({ deliveryId, status: state.status })),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return steppedWithRuns(stepped.value);
    },
  );

  /**
   * What a resume of a stopped or blocked delivery finds: which of its threads are gone and, once
   * its author has launched, its branch, HEAD and the commit its task was approved for. A parent
   * has no author, but once it recorded the thread its pull request is linked to, its follow-through
   * rounds' turns go there, and its branch is read as an author's is.
   */
  const resumeCheck = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      const recorded = [
        ...new Set([...Object.values(state.threads), state.pullRequestThread]),
      ].filter((threadId): threadId is ThreadId => threadId !== undefined);
      const gone = yield* Effect.filter(recorded, (threadId) =>
        threads.threadState(threadId).pipe(Effect.map((found) => found !== "present")),
      );
      if (state.threads.author === undefined && state.pullRequestThread === undefined) {
        // An author or planner launch whose result was never recorded is issued again and
        // replays the thread it made, if any; a thread it made and the owner deleted since blocks
        // instead.
        const lostLaunch = (launch: FactoryLaunchEffect | undefined) =>
          launch === undefined
            ? Effect.succeed({ found: "missing" as const, deleted: [] })
            : threads.launchState(delivery, launch).pipe(
                Effect.map((found) => ({
                  found,
                  deleted:
                    found === "deleted"
                      ? [FactoryThreadEffects.launchThreadId(deliveryId, launch.id)]
                      : [],
                })),
              );
        const author = yield* lostLaunch(unrecordedAuthorLaunch(state));
        const plannerLaunch = unrecordedPlannerLaunch(state);
        const planner = yield* lostLaunch(plannerLaunch);
        return {
          deletedThreads: [...gone, ...author.deleted, ...planner.deleted],
          unrecordedAuthorRunEnded: author.found === "ended",
          ...(plannerLaunch === undefined
            ? {}
            : { unrecordedPlannerRunEnded: planner.found === "ended" }),
          worktree: null,
        } satisfies FactoryResumeCheck;
      }
      const settle = yield* readSettle(state).pipe(Effect.provideContext(gitContext));
      // A worktree that cannot be read does not settle, and is never the approved commit.
      const commit =
        state.worktreePath === null
          ? null
          : yield* readWorktreeState(state.worktreePath).pipe(
              Effect.map(({ headSha, tree }) => ({ headSha, tree })),
              Effect.catchTags({
                FactoryWorktreeMissingError: () => Effect.succeed(null),
                FactoryBranchReadError: () => Effect.succeed(null),
              }),
              Effect.provideContext(gitContext),
            );
      const stored = yield* tasks.listByDelivery(deliveryId);
      const approvedSha = stored.length === 1 ? (stored[0]?.lastReviewedSha ?? null) : null;
      return {
        deletedThreads: gone,
        unrecordedAuthorRunEnded: false,
        worktree: { settle, commit, approvedSha },
      } satisfies FactoryResumeCheck;
    });

  // Decided under the delivery's lock, like stop and cancel: the worktree is read and judged with
  // no run end or effect result landing in between.
  const resume: FactoryService["Service"]["resume"] = Effect.fn("FactoryService.resume")(
    function* (deliveryId) {
      // First, under the delivery's lock, what a PR stage a restart cut short published: the
      // resume clears its block, which is then all that says the stage ran, and a cancel after
      // it would leave that stage's watch on. Its records do not change, so what this found
      // still holds when the resume is decided.
      if ((yield* worker.recoverPullRequest(deliveryId)) === "unknown") {
        return yield* new FactoryPullRequestUnknownError({ deliveryId });
      }
      const stepped = yield* worker.stepWith(deliveryId, (current) =>
        Effect.gen(function* () {
          const { status } = current.state;
          if (status === "stopping") {
            return { event: { type: "resume", check: null } as const, value: undefined };
          }
          if (status !== "stopped" && status !== "blocked") {
            return yield* new FactoryResumeRefusedError({ deliveryId, status });
          }
          const check = yield* resumeCheck(current);
          return { event: { type: "resume", check } as const, value: undefined };
        }),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return steppedWithRuns(stepped.value);
    },
  );

  const cancel: FactoryService["Service"]["cancel"] = Effect.fn("FactoryService.cancel")(
    function* (deliveryId) {
      const stepped = yield* worker.stepWith(deliveryId, ({ state }) =>
        isTerminal(state)
          ? Effect.fail(new FactoryCancelRefusedError({ deliveryId, status: state.status }))
          : Effect.succeed({ event: { type: "cancel" } as const, value: undefined }),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return steppedWithRuns(stepped.value);
    },
  );

  // The plan gate's actions decide under the delivery's lock, like stop and cancel: the plan they
  // judge is the one stored when they step.
  const atGate = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) => {
    const plan = planAtGate(delivery.state);
    return plan === undefined
      ? Effect.fail(
          new FactoryPlanGateRefusedError({
            deliveryId: delivery.deliveryId,
            status: delivery.state.status,
          }),
        )
      : Effect.succeed(plan);
  };

  const updatePlan: FactoryService["Service"]["updatePlan"] = Effect.fn(
    "FactoryService.updatePlan",
  )(function* ({ deliveryId, plan }) {
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      Effect.gen(function* () {
        const recorded = yield* atGate(current);
        const used = (yield* tasks.listByDelivery(deliveryId)).map(({ taskId }) => taskId);
        const edit = validatePlanEdit(recorded, plan, used);
        if (edit.status === "invalid") {
          return yield* new FactoryPlanEditInvalidError({
            deliveryId,
            problems: edit.problems.map((problem) => problem.description),
            fields: edit.fields,
          });
        }
        return {
          event: { type: "plan.updated", tasks: edit.plan.tasks } as const,
          value: undefined,
        };
      }),
    );
    if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
    return steppedWithRuns(stepped.value);
  });

  const approvePlan: FactoryService["Service"]["approvePlan"] = Effect.fn(
    "FactoryService.approvePlan",
  )(function* (deliveryId) {
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      Effect.gen(function* () {
        const plan = yield* atGate(current);
        // The source would refuse such a child; the owner edits the plan rather than lose any of it.
        const taskIds = uncreatableTasks(current.itemRef, deliveryId, plan.tasks);
        if (taskIds.length > 0) {
          return yield* new FactoryChildItemUncreatableError({ deliveryId, taskIds });
        }
        return { event: { type: "plan.approved" } as const, value: undefined };
      }),
    );
    if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
    return steppedWithRuns(stepped.value);
  });

  const rejectPlan: FactoryService["Service"]["rejectPlan"] = Effect.fn(
    "FactoryService.rejectPlan",
  )(function* (deliveryId) {
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      atGate(current).pipe(
        Effect.as({ event: { type: "plan.rejected" } as const, value: undefined }),
      ),
    );
    if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
    return steppedWithRuns(stepped.value);
  });

  const decodeReplanNote = Schema.decodeUnknownOption(FactoryReplanNote);

  const replan: FactoryService["Service"]["replan"] = Effect.fn("FactoryService.replan")(
    function* (input) {
      const { deliveryId } = input;
      const note = decodeReplanNote(input.note);
      if (Option.isNone(note)) return yield* new FactoryReplanNoteInvalidError({ deliveryId });
      const stepped = yield* worker.stepWith(deliveryId, (current) =>
        atGate(current).pipe(
          Effect.as({
            event: { type: "plan.replanned", note: note.value } as const,
            value: undefined,
          }),
        ),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return steppedWithRuns(stepped.value);
    },
  );

  return FactoryService.of({
    start,
    startNext,
    get: (deliveryId) =>
      readWithRuns("service.get", deliveries.get(deliveryId).pipe(Effect.map(Option.toArray))).pipe(
        Effect.map(([delivery]) => Option.fromUndefinedOr(delivery)),
      ),
    list: (input) => readWithRuns("service.list", deliveries.list(input)),
    listByItem: (input) =>
      Effect.gen(function* () {
        const itemRef = yield* work.canonicalRef(input);
        const read = yield* readWithRuns("service.listByItem", deliveries.list({ itemRef }));
        return { itemRef, deliveries: read };
      }),
    stop,
    resume,
    cancel,
    redispatch: worker.redispatch,
    ensureDeferred: worker.ensureDeferred,
    familyRoot: (threadId) =>
      activity.family(threadId).pipe(Effect.map((family) => family?.root ?? null)),
    activity: activity.activity,
    updatePlan,
    approvePlan,
    rejectPlan,
    replan,
    submitPlan,
    submitReview,
    subscribe: changes.changes,
  });
});

/** The service, reading its family's activity through its own readers (see `FactoryActivity`). */
export const layer = Layer.effect(FactoryService, make).pipe(Layer.provide(FactoryActivity.layer));
