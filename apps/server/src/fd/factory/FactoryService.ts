import { AuthWorkReadScope, type ProjectId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemRef,
  workItemRefString,
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
  queuedDeliveryState,
  runsStages,
  unrecordedAuthorLaunch,
  unrecordedPlannerLaunch,
} from "./pipeline/state.ts";

const FactoryReceiptRefusal = Schema.Literals(["head_changed", "tree_dirty"]);

/** A review submission refused before it was judged: nothing was recorded. */
export class FactoryReviewRefusedError extends Schema.TaggedError<FactoryReviewRefusedError>()(
  "FactoryReviewRefusedError",
  {
    threadId: ThreadId,
    /**
     * `not_reviewer`: no active delivery has this thread as its reviewer. `review_not_active`:
     * its delivery is not running the review stage, or not this thread's run. `already_accepted`:
     * this round's review is already accepted.
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
  | FactoryStoreError;

/** A plan submission refused before it was judged: nothing was recorded. */
export class FactoryPlanRefusedError extends Schema.TaggedError<FactoryPlanRefusedError>()(
  "FactoryPlanRefusedError",
  {
    threadId: ThreadId,
    /**
     * `not_planner`: no active delivery has this thread as its planner. `plan_not_active`: its
     * delivery is not running the plan stage, or not this thread's run. `already_accepted`: this
     * plan round's plan is already accepted.
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

/** A done or cancelled delivery cannot be cancelled; nothing changed. */
export class FactoryCancelRefusedError extends Schema.TaggedError<FactoryCancelRefusedError>()(
  "FactoryCancelRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is already ${this.status}, so it cannot be cancelled.`;
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
      /** Single when absent. */
      readonly kind?: FactoryDeliveryKind;
      readonly runtimeModeCeiling?: RuntimeMode;
    }) => Effect.Effect<FactoryDeliveryWithRuns, FactoryStartError>;
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
     * Refused, with nothing changed, in any other status.
     */
    readonly resume: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      | FactoryResumeRefusedError
      | FactoryDeliveryNotFoundError
      | FactoryStoreError
      | ProjectionStore.ProjectionStoreV2Error
    >;
    /**
     * Cancels a delivery that is not done or cancelled. It ends at once and issues nothing more,
     * and whatever its threads still run is interrupted; the worktree, branch and commits stay. No
     * later run end, effect result or review submission changes it, and its item can be
     * delivered again. Refused, with nothing changed, once done or cancelled.
     */
    readonly cancel: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryWithRuns,
      FactoryCancelRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * A reviewer's `factory_submit_review`. Taken only from the thread an active delivery
     * registered as its reviewer, while the review stage awaits that thread's run and before
     * the round has an accepted review; any other call is refused with nothing changed. The
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
     * as its planner, while the plan stage awaits that thread's run and before the plan round has
     * an accepted plan; any other call is refused with nothing changed. The plan is judged (see
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
     * submission, a settings write) and never for a refusal, so a subscriber refetches what it
     * shows on each value.
     */
    readonly subscribe: Stream.Stream<number>;
  }
>()("t3/fd/factory/FactoryService") {}

/** Factory reads the item to start and writes nothing to Work under this actor. */
const itemReader: WorkActor = { id: "factory", grants: [AuthWorkReadScope], label: "Factory" };

/** A single item is its delivery's one task; its approval is `approval-item.json`. */
const SINGLE_ITEM_TASK = FactoryTaskId.make("item");

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
        // A stopping delivery still finishes its review round.
        if (
          !runsStages(state) ||
          state.stage !== "review" ||
          awaiting?.type !== "run" ||
          awaiting.threadId !== threadId
        ) {
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
   * its author has launched, its branch, HEAD and the commit its task was approved for.
   */
  const resumeCheck = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      const recorded = [...new Set(Object.values(state.threads))].filter(
        (threadId): threadId is ThreadId => threadId !== undefined,
      );
      const gone = yield* Effect.filter(recorded, (threadId) =>
        threads.threadState(threadId).pipe(Effect.map((found) => found !== "present")),
      );
      if (state.threads.author === undefined) {
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

  return FactoryService.of({
    start,
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
    submitPlan,
    submitReview,
    subscribe: changes.changes,
  });
});

export const layer = Layer.effect(FactoryService, make);
