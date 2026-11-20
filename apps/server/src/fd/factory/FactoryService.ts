import {
  AuthWorkReadScope,
  type ProjectId,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  boundedPendingActions,
  type FactoryDeliveryExecution,
  FactoryDeliveryId,
  type FactoryDeliverySource,
  FactoryDeliveryStatus,
  type FactoryPendingAction,
  type FactoryPendingActions,
  FactoryPlanField,
  FactoryReplanNote,
  type FactoryReviewedExecution,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { isOwnerDecidedRequest } from "@t3tools/shared/fd/approvals";
import {
  type WorkItemId,
  type WorkItemRef,
  workItemRefString,
  type WorkListResult,
  WorkSourceId,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { exceededDispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
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
import {
  ownerPendingActions,
  refusedTurnPendingAction,
  requestPendingAction,
  withRefusedTurns,
} from "./pendingActions.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
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
  type FactoryReviewedAllowances,
  isTerminal,
  planAtGate,
  queuedDeliveryState,
  runsStages,
  unrecordedAuthorLaunch,
  unrecordedPlannerLaunch,
} from "./pipeline/state.ts";
import { uncreatableTasks } from "./plan/childItem.ts";
import { validatePlanEdit } from "./plan/edit.ts";
import {
  FactoryReviewedAmendmentRefusedError,
  FactoryReviewedExecutionInvalidError,
  isFactoryReviewedExecutionInvalid,
  isFactoryReviewedExecutionRefusedError,
  FactoryReviewedRebindRefusedError,
  parseReviewedExecution,
  sameReviewedExecution,
} from "./reviewedExecution.ts";

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

/**
 * A caller's intended delivery id already names a delivery of another item, kind, ceiling or
 * review; nothing was written.
 */
export class FactoryDeliveryIdConflictError extends Schema.TaggedError<FactoryDeliveryIdConflictError>()(
  "FactoryDeliveryIdConflictError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} already exists for another item, kind, runtime ceiling or review.`;
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
/** A review's resume that was taken already, or whose delivery ended. Nothing changed. */
class FactoryResumeNotOwedError extends Schema.TaggedError<FactoryResumeNotOwedError>()(
  "FactoryResumeNotOwedError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is not owed this review's resume.`;
  }
}

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
  | ThreadLaunch.ThreadLaunchBranchExistsError
  | ThreadLaunch.ThreadLaunchBranchConflictError
  | ThreadLaunch.ThreadLaunchNotRepositoryError
  | FactoryBranchUnavailableError
  | FactoryDeliveryIdError
  | FactoryDeliveryIdConflictError
  | FactoryReviewedExecutionInvalidError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryStoreError;

/**
 * A stored delivery with its newest stage attempts, as many as a snapshot carries, in the order
 * they started.
 */
/** A listing reads what its items say for at most this many deliveries, the newest. */
const LISTING_FACTS_MAX = 100;
/** How long a listing waits on a Work source before showing its deliveries without its facts. */
const LISTING_FACTS_TIMEOUT = "3 seconds";

export type FactoryDeliveryWithRuns = FactoryDeliveryStore.StoredFactoryDelivery & {
  /** The newest attempts, at most `FACTORY_SNAPSHOT_STAGE_RUNS_MAX`, for its timeline. */
  readonly stageRuns: ReadonlyArray<FactoryStageRunStore.StoredFactoryStageRun>;
  /** Its attempts per stage over its whole history, which that window cannot count. */
  readonly stageAttempts: FactoryStageRunStore.FactoryStageAttempts;
  /** What `listForClients` read of its Work item; absent elsewhere, or when it could not. */
  readonly source?: FactoryDeliverySource;
  /** What `listForClients` read of its queue rank; absent when nothing manages it. */
  readonly queuePriority?: number | null;
  /** What `listForClients` found it waiting on someone for; absent while nothing is. */
  readonly pendingActions?: FactoryPendingActions;
  /** What `getForClient` found its roles running on; absent elsewhere, or when it could not. */
  readonly execution?: FactoryDeliveryExecution;
};

/**
 * What `startNext` did: started a delivery of the first Ready item, or found none it could start.
 * `incomplete` says a source could not be listed whole, so an item it did not show may be Ready.
 */
export type FactoryStartNextResult =
  | { readonly type: "started"; readonly delivery: FactoryDeliveryWithRuns }
  | { readonly type: "nothing_ready"; readonly incomplete: boolean };

/**
 * Factory's deliveries for transports, MCP tools and scheduled tasks. Each returned delivery
 * carries its stage attempts from the same moment. A control whose attempt read fails fails,
 * though its step stands and the change epoch has moved.
 */
export class FactoryService extends Context.Service<
  FactoryService,
  {
    /**
     * Starts a delivery of a Work item (a parent plans its children first) on a new worktree whose
     * branch is the first free `freshBranchName`. No thread runs broader than `runtimeModeCeiling`.
     * `deliveryId` makes the start idempotent; `reviewedExecution` pins it to the owner's review.
     * Refused, writing nothing, for an unreadable item, a non-Markdown parent or an active delivery.
     */
    readonly start: (input: {
      readonly itemRef: WorkItemRef;
      /** Single when absent. A child is started by its parent, never on its own. */
      readonly kind?: Exclude<FactoryDeliveryKind, "child">;
      readonly runtimeModeCeiling?: RuntimeMode;
      /** The delivery's id, minted by the caller; a random one when absent. */
      readonly deliveryId?: FactoryDeliveryId;
      /** The review receipt's execution, as any value it was stored as; judged here. */
      readonly reviewedExecution?: unknown;
    }) => Effect.Effect<FactoryDeliveryWithRuns, FactoryStartError>;
    /**
     * What an owner would review for a delivery of the project, for a review receipt; see
     * `FactoryThreadEffects.resolveReviewedExecution`.
     */
    readonly resolveReviewedExecution: FactoryThreadEffects.FactoryThreadEffects["Service"]["resolveReviewedExecution"];
    /** What an owner reviewing the project sees; see `FactoryThreadEffects`. */
    readonly previewReviewedExecution: FactoryThreadEffects.FactoryThreadEffects["Service"]["previewReviewedExecution"];
    /** Whether a review still says what would be bound now; see `FactoryThreadEffects`. */
    readonly reviewedExecutionHolds: FactoryThreadEffects.FactoryThreadEffects["Service"]["reviewedExecutionHolds"];
    /**
     * Rebinds an idle reviewed delivery to a fresh owner review, keeping usage counted. Only a new
     * receipt of a later version takes effect; repeating one is harmless and an older one never
     * authorizes again. `resume` owes one resume, refused if effects ran since the confirmation.
     * Refused with `FactoryReviewedRebindRefusedError`, changing nothing, otherwise.
     */
    readonly rebindReviewed: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly execution: FactoryReviewedExecution;
      readonly resume?: { readonly effectsIssued: number };
    }) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryReviewedRebindRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Raises a reviewed delivery's allowances under a fresh receipt; usage so far stays counted.
     * Only a later receipt version can raise one, none can lower one, and repeating a receipt is
     * harmless. Refused with `FactoryReviewedAmendmentRefusedError`, changing nothing, otherwise.
     */
    readonly amendReviewedAllowance: (input: {
      readonly deliveryId: FactoryDeliveryId;
      readonly receiptId: FactoryReviewedExecution["receiptId"];
      readonly reviewVersion: number;
      readonly allowances: FactoryReviewedAllowances;
    }) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryReviewedAmendmentRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Starts the first Work-Ready item without an active delivery, optionally by `label`, through
     * `start`; one a concurrent start took is skipped. Nothing Ready is a result. An unreadable or
     * stale page ends the walk as incomplete, since an item it hid could be the first Ready one.
     * Refused as `start` refuses.
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
     * `get` for a client showing this one delivery, with what each role it uses runs on. A failed read
     * of that leaves it out rather than fail the delivery; it costs a read per thread, so no listing
     * asks.
     */
    readonly getForClient: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<Option.Option<FactoryDeliveryWithRuns>, FactoryStoreError>;
    /**
     * `list` as a client shows it: every delivery (only those not done or cancelled with
     * `activeOnly`) with its queue rank, and each not done or cancelled with what its Work item
     * says now. Those reads never fail or hold up the list: one that cannot answer in time leaves
     * its part out. It writes nothing, here or at any source.
     */
    readonly listForClients: (input: {
      readonly projectId?: ProjectId;
      readonly activeOnly?: boolean;
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
     * Stops a running delivery after its current step: stored `stopping`, nothing is interrupted,
     * and it becomes `stopped` where the next stage would begin, which is its checkpoint.
     * Refused, with nothing changed, unless running or stopping.
     */
    readonly stop: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryStopRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Resumes a stopping, stopped or blocked delivery from its checkpoint (see `advance`) with a
     * fresh retry allowance; a reviewed delivery keeps its counts. A delivery blocked on a lost PR
     * stage result first runs `FactoryWorker.recoverPullRequest`, since the resume clears the only
     * sign it published. Refused, with nothing changed, otherwise.
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
     * `resume`, as the one resume a fresh review's receipt owes the delivery (see `rebindReviewed`):
     * whether it still does is judged in the very step that resumes it and clears it, so a resume
     * that anyone else took first leaves none to take. None when it is not owed, changing nothing.
     */
    readonly resumeOwedByReview: (
      deliveryId: FactoryDeliveryId,
      receiptId: FactoryReviewedExecution["receiptId"],
    ) => Effect.Effect<
      FactoryDeliveryWithRuns | null,
      | FactoryResumeRefusedError
      | FactoryPullRequestUnknownError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
      | ProjectionStore.ProjectionStoreV2Error
    >;
    /**
     * Cancels a delivery at once and interrupts its threads' runs; worktree, branch and commits
     * stay. A parent cancels its unapproved children and a child its parent. Nothing later changes
     * it, and its item can be delivered again. Refused once done or cancelled.
     */
    readonly cancel: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryCancelRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Queues the admission-deferred effect `effectId` once (see `FactoryWorker.redispatch`); the
     * job asks `FactoryAdmission` again before it runs. `stale`, changing nothing, unless it is
     * awaited, marked waiting and no job is in flight.
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
     * The root delivery whose family the thread belongs to: one a Factory launch made, or one
     * delegated from a family thread at most eight levels down. Null for any other thread. Fails
     * when a record cannot be read or the lineage goes deeper.
     */
    readonly familyRoot: (
      threadId: ThreadId,
    ) => Effect.Effect<FactoryDeliveryId | null, FactoryActivity.FactoryOwnershipReadError>;
    /**
     * Why the review of the delivery whose family the thread belongs to no longer allows new work
     * from it, or the host's policy refuses the mode that work would run in, as text fit to show the
     * thread's agent, for a caller policy judging a delegation. None when neither holds, or for a
     * thread of no delivery. Fails, deciding nothing, when what it judges cannot be read.
     */
    readonly reviewedRefusal: (
      threadId: ThreadId,
    ) => Effect.Effect<string | undefined, { readonly _tag: string }>;
    /**
     * Whose the runtime request on the thread is, read-only, for a caller policy judging an
     * answer to it: the root of the thread's family (null for none, as `familyRoot` says), the
     * request's status, kind, response capability and run, and that run's status and class on the
     * root's family. Fails when a record cannot be read or the lineage goes deeper.
     */
    readonly requestOwnership: (input: {
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
    }) => Effect.Effect<
      FactoryActivity.FactoryRequestOwnership,
      FactoryActivity.FactoryOwnershipReadError
    >;
    /**
     * What the root delivery's family is doing, read-only (see `FactoryActivity`): its phase,
     * whether work Factory cannot show to be the owner's is under way or about to start on its
     * threads, whether an effect waits for admission, what its runs wait for, and whether any of
     * that could not be read. An unknown delivery is `missing`.
     */
    readonly activity: (
      root: FactoryDeliveryId,
    ) => Effect.Effect<FactoryActivity.FactoryActivityReport, FactoryStoreError>;
    /** Where the turn sent as the message is, read-only (see `FactoryActivity.turnRunState`). */
    readonly turnRunState: FactoryActivity.FactoryActivity["Service"]["turnRunState"];
    /** Every request still pending on the root's family's threads, read-only. */
    readonly familyRequests: FactoryActivity.FactoryActivity["Service"]["familyRequests"];
    /** The automatic turns the host refused on the delivery's threads, judged again now. */
    readonly refusedTurnActions: (delivery: {
      readonly deliveryId: FactoryDeliveryId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<ReadonlyArray<FactoryPendingAction>>;
    /** Every request pending on a delivery's thread, starting from the threads holding one. */
    readonly pendingRequests: FactoryActivity.FactoryActivity["Service"]["pendingRequests"];
    /**
     * The owner's edit of the plan waiting at the gate: `plan`, unvalidated as it arrived, replaces
     * it if `validatePlanEdit` accepts it under the delivery's lock. The planner's evidence stays.
     * Refused, with nothing changed, for an invalid edit or a delivery not at the gate.
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
     * The owner's approval of the plan at the gate, which freezes it. The parent then creates a
     * child item and delivery per task (see `FactoryChildren`) and runs them in plan order. Refused,
     * with nothing changed, for a delivery not at the gate or a task whose child item the source
     * would refuse (see `uncreatableTasks`).
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
     * The owner's replan at the gate: a new plan round with a fresh retry allowance, and `note`
     * (trimmed) queued as the planner's follow-up turn. Refused, with nothing changed, for a blank
     * or overlong note or a delivery not at the gate.
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
     * A reviewer's `factory_submit_review`, taken only from the registered reviewer's awaited run
     * before the round has an accepted review; anything else is refused unchanged. The judgment
     * (see `FactoryReview`) is recorded: accepted acts when the run completes, a second invalid one
     * in a round blocks, and changed code blocks.
     */
    readonly submitReview: (input: {
      readonly threadId: ThreadId;
      readonly review: unknown;
    }) => Effect.Effect<
      { readonly deliveryId: FactoryDeliveryId; readonly review: FactoryAcceptedReview },
      FactorySubmitReviewError
    >;
    /**
     * A planner's `factory_submit_plan`, taken only from the registered planner's awaited run before
     * the round has an accepted plan, so no run's plan is recorded as another's; anything else is
     * refused unchanged. The judgment (see `FactoryPlanning`) is recorded: accepted acts when the
     * run completes, and a second invalid one in a round blocks.
     */
    readonly submitPlan: (input: {
      readonly threadId: ThreadId;
      readonly plan: unknown;
    }) => Effect.Effect<
      { readonly deliveryId: FactoryDeliveryId; readonly plan: FactoryAcceptedPlan },
      FactorySubmitPlanError
    >;
    /**
     * Factory's change epoch: its value on subscribe, then each move. It moves after every
     * committed write and never for a refusal, so a subscriber refetches on each value.
     */
    readonly subscribe: Stream.Stream<number>;
    /**
     * What a client's reads follow: moves with `subscribe` and whenever what `listForClients` shows
     * beside a delivery may have changed. A sum of rising counters, so a new subscription with
     * nothing moved answers the same value and the client does not refetch.
     */
    readonly listingChanges: Stream.Stream<number>;
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
  const admission = yield* FactoryAdmission.FactoryAdmission;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();
  // Starts of one item, by its canonical spelling. One server owns a T3 home, so an in-process
  // lock is enough, as for Work's thread starts.
  const itemLocks = yield* KeyedLock.make<string>();

  /** What one source says of the items a listing shows, or nothing if it cannot say in time. */
  const listedSummaries = (sourceId: WorkSourceId, itemIds: ReadonlyArray<WorkItemId>) =>
    work.currentSummaries(sourceId, itemIds).pipe(
      Effect.timeoutOption(LISTING_FACTS_TIMEOUT),
      Effect.map(Option.getOrElse(() => [])),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.as(Effect.logWarning("factory listing read no Work facts", cause), []),
      ),
    );

  /**
   * The automatic turns the host refused on these deliveries' threads, judged again now: a thread
   * whose owner has since changed its mode shows nothing, even before its turn is asked for again.
   * One it cannot read shows nothing and says so in the log. Costs nothing while no turn was
   * refused, then a local read per refused thread of these deliveries, and writes nothing.
   */
  const refusedTurnActions = Effect.fn("FactoryService.refusedTurnActions")(function* (
    deliveries: ReadonlyArray<{
      readonly deliveryId: FactoryDeliveryId;
      readonly projectId: ProjectId;
    }>,
  ) {
    const byDelivery = new Map<FactoryDeliveryId, ReadonlyArray<FactoryPendingAction>>();
    const recorded = yield* changes.refusedTurns;
    if (recorded.size === 0) return byDelivery;
    const projectOf = new Map(
      deliveries.map((delivery) => [delivery.deliveryId, delivery.projectId]),
    );
    for (const [threadId, { root, launchedBy }] of recorded) {
      const projectId = projectOf.get(root) ?? projectOf.get(launchedBy);
      if (projectId === undefined) continue;
      const refusal = yield* threads.checkThreadHostPolicy(threadId, launchedBy).pipe(
        Effect.as(undefined),
        Effect.catch((cause) =>
          FactoryThreadEffects.isFactoryRuntimeModeRefusedError(cause)
            ? Effect.succeed(cause)
            : Effect.as(
                Effect.logWarning("factory listing read no refused turn", cause),
                undefined,
              ),
        ),
      );
      if (refusal === undefined) continue;
      const action = refusedTurnPendingAction(projectId, refusal);
      for (const deliveryId of new Set([root, launchedBy])) {
        byDelivery.set(deliveryId, [...(byDelivery.get(deliveryId) ?? []), action]);
      }
    }
    return byDelivery;
  });

  /**
   * What a listing shows beside its deliveries. Every delivery takes its local queue rank; only
   * active ones read their item, with one tracker request per source, since clients refetch the
   * list on every step and must not cost a read per delivery.
   */
  const withListingFacts = Effect.fn("FactoryService.withListingFacts")(function* (
    listed: ReadonlyArray<FactoryDeliveryWithRuns>,
  ) {
    const active = listed.filter(({ state }) => !isTerminal(state)).slice(0, LISTING_FACTS_MAX);
    const bySource = new Map<WorkSourceId, Array<WorkItemId>>();
    for (const { itemRef } of active) {
      bySource.set(itemRef.sourceId, [...(bySource.get(itemRef.sourceId) ?? []), itemRef.itemId]);
    }
    const summaries = yield* Effect.forEach(
      [...bySource],
      ([sourceId, itemIds]) => listedSummaries(sourceId, itemIds),
      { concurrency: "unbounded" },
    );
    const sources = new Map(
      summaries.flat().map((summary) => [workItemRefString(summary.ref), summary] as const),
    );
    const refusedTurns = yield* refusedTurnActions(active);
    const noRequests = (complete: boolean): FactoryActivity.FactoryPendingRequests => ({
      byDelivery: new Map(),
      complete,
    });
    const pending =
      active.length === 0
        ? noRequests(true)
        : yield* activity.pendingRequests.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.as(
                    Effect.logWarning("factory listing read no pending requests", cause),
                    noRequests(false),
                  ),
            ),
          );
    const rootOf = ({ deliveryId, parentId }: FactoryDeliveryWithRuns) => parentId ?? deliveryId;
    const priorities = yield* admission
      .queuePriorities([...new Set(listed.map(rootOf))])
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.as(
                Effect.logWarning("factory listing read no queue priority", cause),
                new Map<FactoryDeliveryId, number | null>(),
              ),
        ),
      );
    return listed.map((delivery) => {
      const summary = isTerminal(delivery.state)
        ? undefined
        : sources.get(workItemRefString(delivery.itemRef));
      const priority = priorities.get(rootOf(delivery));
      // A parent waiting on its child shows what that child waits on, or nothing would say why.
      const { awaiting } = delivery.state;
      const child =
        awaiting?.type === "child"
          ? listed.find(({ deliveryId }) => deliveryId === awaiting.deliveryId)
          : undefined;
      const actions = isTerminal(delivery.state)
        ? []
        : [
            ...withRefusedTurns(
              [
                ...ownerPendingActions(delivery),
                ...(child === undefined ? [] : ownerPendingActions(child)),
              ],
              refusedTurns.get(delivery.deliveryId) ?? [],
            ),
            ...(pending.byDelivery.get(delivery.deliveryId) ?? [])
              .filter(({ kind }) => isOwnerDecidedRequest(kind))
              .map(requestPendingAction),
          ];
      return {
        ...delivery,
        ...(isTerminal(delivery.state) || (actions.length === 0 && pending.complete)
          ? {}
          : { pendingActions: boundedPendingActions(actions, pending.complete) }),
        ...(summary === undefined
          ? {}
          : {
              source: {
                key: summary.key,
                title: summary.title,
                status: summary.status,
                statusName: summary.nativeStatus?.name ?? null,
                assignee: summary.assignee?.label ?? null,
              },
            }),
        ...(priority === undefined ? {} : { queuePriority: priority }),
      };
    });
  });

  /** The deliveries with their newest attempts, in one read however many there are. */
  const withRuns = (stored: ReadonlyArray<FactoryDeliveryStore.StoredFactoryDelivery>) => {
    const deliveryIds = stored.map(({ deliveryId }) => deliveryId);
    return Effect.all([
      stageRuns.listNewestByDeliveries({ deliveryIds, limit: FACTORY_SNAPSHOT_STAGE_RUNS_MAX }),
      stageRuns.attemptTotals(deliveryIds),
    ]).pipe(
      Effect.map(([runs, totals]) =>
        stored.map((delivery) => ({
          ...delivery,
          stageRuns: runs.get(delivery.deliveryId) ?? [],
          stageAttempts: totals.get(delivery.deliveryId) ?? {},
        })),
      ),
    );
  };

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
    readonly stageAttempts: FactoryStageRunStore.FactoryStageAttempts;
  }) => ({
    ...stepped.delivery,
    stageRuns: stepped.stageRuns,
    stageAttempts: stepped.stageAttempts,
  });

  const start: FactoryService["Service"]["start"] = Effect.fn("FactoryService.start")(
    function* (input) {
      // The active-item index keys on Work's spelling, so another spelling of the item cannot
      // hold a second delivery.
      const itemRef = yield* work.canonicalRef(input.itemRef);
      const kind = input.kind ?? "single";
      const { deliveryId: intended } = input;
      const parsed =
        input.reviewedExecution === undefined
          ? undefined
          : parseReviewedExecution(input.reviewedExecution);
      if (isFactoryReviewedExecutionInvalid(parsed)) return yield* parsed;
      const reviewed = parsed;
      // A review is a ceiling and never a grant: it cannot run broader than whoever starts it.
      if (
        reviewed !== undefined &&
        input.runtimeModeCeiling !== undefined &&
        exceededDispatchModeLimit(
          { runtimeMode: input.runtimeModeCeiling, interactionMode: "default" },
          { runtimeMode: reviewed.runtimeCeiling, interactionMode: "default" },
        ) !== undefined
      ) {
        return yield* new FactoryReviewedExecutionInvalidError({ reason: "runtime_ceiling" });
      }
      // A review's ceiling is the delivery's, so a replay is judged against the same one.
      const ceiling = reviewed?.runtimeCeiling ?? input.runtimeModeCeiling;
      /** The delivery the caller's id already names, if any; another item's is a conflict. */
      const named = Effect.gen(function* () {
        if (intended === undefined) return Option.none();
        const stored = yield* deliveries.get(intended);
        if (Option.isNone(stored)) return stored;
        const { itemRef: storedItem, state } = stored.value;
        return workItemRefString(storedItem) === workItemRefString(itemRef) &&
          state.kind === kind &&
          state.runtimeModeCeiling === ceiling &&
          sameReviewedExecution(state.reviewedExecution, reviewed)
          ? stored
          : yield* new FactoryDeliveryIdConflictError({ deliveryId: intended });
      });
      /**
       * The start step, for a queued delivery alone: the engine takes it once however many ask,
       * and one further along is returned as it is.
       */
      const started = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
        delivery.state.status !== "queued"
          ? withRuns([delivery]).pipe(
              Effect.map(([found]) => found ?? { ...delivery, stageRuns: [], stageAttempts: {} }),
            )
          : // A storage failure here leaves the delivery queued with nothing launched.
            worker
              .stepWith(delivery.deliveryId, () =>
                Effect.succeed({ event: { type: "start" } as const, value: undefined }),
              )
              .pipe(
                Effect.map(
                  Option.match({
                    onNone: () => ({ ...delivery, stageRuns: [], stageAttempts: {} }),
                    onSome: steppedWithRuns,
                  }),
                ),
              );
      // A delivery the id names needs nothing else to be true: what it was started from may be
      // gone by now, and a repeat still finds it.
      if (intended !== undefined) {
        const existing = yield* itemLocks.withLock(workItemRefString(itemRef), named);
        if (Option.isSome(existing)) return yield* started(existing.value);
      }
      const source = (yield* work.resolveSource(itemRef.sourceId)).stored;
      // Owner decision: a parent's tasks become child items only in a Markdown source.
      if (kind === "parent" && source.kind !== "markdown") {
        return yield* new FactoryParentSourceUnsupportedError({
          sourceId: source.sourceId,
          sourceKind: source.kind,
        });
      }
      const { projectId } = source;
      // A review carries its limits, whatever the settings say by now.
      const { limits } = reviewed ?? (yield* settings.requireDeliverySettings(projectId));
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) {
        return yield* new FactoryThreadEffects.FactoryProjectMissingError({ projectId });
      }
      if (reviewed !== undefined) {
        if (reviewed.repository.projectId !== projectId) {
          return yield* new FactoryReviewedExecutionInvalidError({ reason: "project" });
        }
        if (reviewed.repository.workspaceRoot !== project.workspaceRoot) {
          return yield* new FactoryReviewedExecutionInvalidError({ reason: "repository" });
        }
      }
      const item = yield* work.getItem(itemReader, { ref: itemRef });

      // From reading the item's earlier deliveries to storing this one, no other start of the
      // item runs: a delivery stored meanwhile, then cancelled before its launch made its
      // branch, would otherwise leave this start on the branch it chose.
      const queued = yield* Effect.gen(function* () {
        // A start of the same item and id that got here first holds its row by now.
        const raced = yield* named;
        if (Option.isSome(raced)) return raced.value;
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

        const deliveryId = intended ?? FactoryDeliveryId.make(yield* crypto.uuidV4());
        // The insert refuses an item with an active delivery in its transaction, so of two starts
        // only one is stored, and a single item's task row lands with it. The lock is the item's,
        // so another item's start may have stored this id since the check above; this
        // transaction's read holds until it commits.
        return yield* named.pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                deliveries
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
                      ...(ceiling === undefined ? {} : { runtimeModeCeiling: ceiling }),
                      ...(reviewed === undefined ? {} : { reviewedExecution: reviewed }),
                    }),
                  })
                  .pipe(
                    Effect.tap(() =>
                      kind === "single"
                        ? tasks.insert({ deliveryId, taskId: SINGLE_ITEM_TASK })
                        : Effect.void,
                    ),
                  ),
            }),
          ),
          (write) => changes.transact(write),
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(new FactoryStoreError({ operation: "service.start", cause })),
          }),
        );
      }).pipe((locked) => itemLocks.withLock(workItemRefString(itemRef), locked));
      return yield* started(queued);
    },
  );

  /**
   * Whether the item has an open linked thread, as Work's own starts judge one: a launch Work has
   * in flight, checked before the thread because it holds until the thread exists, or a thread
   * that is not deleted, settled or archived. A link with neither is a launch that died.
   */
  const hasOpenThread = Effect.fn("FactoryService.hasOpenThread")(function* (ref: WorkItemRef) {
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
        // Markdown lists unreadable task files as unlabeled items of unknown status, which its own
        // filters would hide, so it is listed whole and filtered here. GitHub and Jira fail the
        // page instead, so they filter at the source and skip reading every closed issue.
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
  const resumeCheck = Effect.fn("FactoryService.resumeCheck")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ) {
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
  const resumeStep = Effect.fn("FactoryService.resumeStep")(function* (
    deliveryId: FactoryDeliveryId,
    owedBy?: FactoryReviewedExecution["receiptId"],
  ) {
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
        if (
          owedBy !== undefined &&
          (current.state.reviewResumeOwed !== owedBy || isTerminal(current.state))
        ) {
          return yield* new FactoryResumeNotOwedError({ deliveryId });
        }
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
  });

  const resume: FactoryService["Service"]["resume"] = (deliveryId) =>
    resumeStep(deliveryId).pipe(
      Effect.catchTags({ FactoryResumeNotOwedError: (cause) => Effect.die(cause) }),
    );

  const resumeOwedByReview: FactoryService["Service"]["resumeOwedByReview"] = (
    deliveryId,
    receiptId,
  ) =>
    resumeStep(deliveryId, receiptId).pipe(
      Effect.catchTags({ FactoryResumeNotOwedError: () => Effect.succeed(null) }),
    );

  const amendReviewedAllowance: FactoryService["Service"]["amendReviewedAllowance"] = Effect.fn(
    "FactoryService.amendReviewedAllowance",
  )(function* ({ deliveryId, receiptId, reviewVersion, allowances }) {
    const refuse = (reason: FactoryReviewedAmendmentRefusedError["reason"]) =>
      new FactoryReviewedAmendmentRefusedError({ deliveryId, reason });
    const stepped = yield* worker.stepWith(deliveryId, ({ state }) =>
      Effect.gen(function* () {
        const { reviewedExecution: reviewed } = state;
        if (reviewed === undefined) return yield* refuse("not_reviewed");
        if (isTerminal(state)) return yield* refuse("ended");
        const { limits } = reviewed;
        if (state.supersededReceipts?.includes(receiptId) === true) {
          return yield* refuse("reused_receipt");
        }
        if (reviewed.receiptId === receiptId) {
          const same =
            limits.maxFixRounds === allowances.maxFixRounds &&
            limits.maxReviewRounds === allowances.maxReviewRounds &&
            limits.maxFixCommitTurns === allowances.maxFixCommitTurns;
          if (!same) return yield* refuse("same_receipt");
        } else {
          if (reviewVersion <= reviewed.reviewVersion) return yield* refuse("stale_version");
          if (
            allowances.maxFixRounds < limits.maxFixRounds ||
            allowances.maxReviewRounds < limits.maxReviewRounds ||
            allowances.maxFixCommitTurns < limits.maxFixCommitTurns
          ) {
            return yield* refuse("lower_allowance");
          }
        }
        const event: FactoryEvent = {
          type: "reviewed.amended",
          receiptId,
          reviewVersion,
          allowances,
        };
        return { event, value: undefined };
      }),
    );
    if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
    return steppedWithRuns(stepped.value);
  });

  const rebindReviewed: FactoryService["Service"]["rebindReviewed"] = Effect.fn(
    "FactoryService.rebindReviewed",
  )(function* ({ deliveryId, execution, resume }) {
    const refuse = (reason: FactoryReviewedRebindRefusedError["reason"]) =>
      new FactoryReviewedRebindRefusedError({ deliveryId, reason });
    const stepped = yield* worker.stepWith(deliveryId, ({ projectId, state }) =>
      Effect.gen(function* () {
        const { reviewedExecution: reviewed } = state;
        if (reviewed === undefined) return yield* refuse("not_reviewed");
        const event: FactoryEvent = {
          type: "reviewed.rebound",
          execution,
          owesResume: resume !== undefined,
        };
        if (reviewed.receiptId === execution.receiptId) return { event, value: undefined };
        if (state.supersededReceipts?.includes(execution.receiptId) === true) {
          return yield* refuse("reused_receipt");
        }
        if (isTerminal(state)) return yield* refuse("ended");
        if (execution.repository.projectId !== projectId) return yield* refuse("project");
        if (execution.reviewVersion <= reviewed.reviewVersion) {
          return yield* refuse("stale_version");
        }
        const atRest =
          state.status === "stopped" ||
          state.status === "blocked" ||
          state.status === "queued" ||
          state.awaiting?.type === "child";
        if (!atRest || (resume !== undefined && resume.effectsIssued !== state.effectsIssued)) {
          return yield* refuse("not_at_rest");
        }
        return { event, value: undefined };
      }),
    );
    if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
    return steppedWithRuns(stepped.value);
  });

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
    resolveReviewedExecution: threads.resolveReviewedExecution,
    amendReviewedAllowance,
    rebindReviewed,
    resumeOwedByReview,
    previewReviewedExecution: threads.previewReviewedExecution,
    reviewedExecutionHolds: threads.reviewedExecutionHolds,
    startNext,
    get: Effect.fn("FactoryService.get")((deliveryId) =>
      readWithRuns("service.get", deliveries.get(deliveryId).pipe(Effect.map(Option.toArray))).pipe(
        Effect.map(([delivery]) => Option.fromUndefinedOr(delivery)),
      ),
    ),
    getForClient: Effect.fn("FactoryService.getForClient")((deliveryId) =>
      readWithRuns("service.get", deliveries.get(deliveryId).pipe(Effect.map(Option.toArray))).pipe(
        Effect.flatMap(([delivery]) =>
          delivery === undefined
            ? Effect.succeedNone
            : threads.deliveryExecution(delivery).pipe(
                Effect.map((execution) => Option.some({ ...delivery, execution })),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.as(
                        Effect.logWarning("factory read no role execution", cause),
                        Option.some(delivery),
                      ),
                ),
              ),
        ),
      ),
    ),
    list: Effect.fn("FactoryService.list")((input) =>
      readWithRuns("service.list", deliveries.list(input)),
    ),
    listForClients: Effect.fn("FactoryService.listForClients")((input) =>
      readWithRuns("service.list", deliveries.list(input)).pipe(Effect.flatMap(withListingFacts)),
    ),
    listByItem: Effect.fn("FactoryService.listByItem")(function* (input) {
      const itemRef = yield* work.canonicalRef(input);
      const read = yield* readWithRuns("service.listByItem", deliveries.list({ itemRef }));
      return { itemRef, deliveries: read };
    }),
    stop,
    resume,
    cancel,
    redispatch: worker.redispatch,
    ensureDeferred: worker.ensureDeferred,
    familyRoot: Effect.fn("FactoryService.familyRoot")((threadId) =>
      activity.family(threadId).pipe(Effect.map((family) => family?.root ?? null)),
    ),
    reviewedRefusal: Effect.fn("FactoryService.reviewedRefusal")(
      function* (threadId) {
        const family = yield* activity.family(threadId);
        if (family === null) return undefined;
        yield* threads.checkReviewedThread(threadId, family.launchedBy);
        yield* threads.checkThreadHostPolicy(threadId, family.launchedBy);
        return undefined;
      },
      Effect.catchIf(
        (cause) =>
          isFactoryReviewedExecutionRefusedError(cause) ||
          FactoryThreadEffects.isFactoryRuntimeModeRefusedError(cause),
        (cause) => Effect.succeed(cause.message),
      ),
    ),
    requestOwnership: activity.requestOwnership,
    activity: activity.activity,
    turnRunState: activity.turnRunState,
    familyRequests: activity.familyRequests,
    pendingRequests: activity.pendingRequests,
    refusedTurnActions: Effect.fn("FactoryService.refusedTurnActions")((delivery) =>
      refusedTurnActions([delivery]).pipe(
        Effect.map((byDelivery) => byDelivery.get(delivery.deliveryId) ?? []),
      ),
    ),
    updatePlan,
    approvePlan,
    rejectPlan,
    replan,
    submitPlan,
    submitReview,
    subscribe: changes.changes,
    listingChanges: Stream.suspend(() =>
      Stream.zipLatestAll(changes.changes, work.subscribeRefreshes, admission.queueChanges),
    ).pipe(
      Stream.map(([factoryEpoch, workEpoch, queueEpoch]) => factoryEpoch + workEpoch + queueEpoch),
    ),
  });
});

/** The service, reading its family's activity through its own readers (see `FactoryActivity`). */
export const layer = Layer.effect(FactoryService, make).pipe(Layer.provide(FactoryActivity.layer));
